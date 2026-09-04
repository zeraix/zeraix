//! `edit_file` — mirrors the handler in aiToolkit.mjs.
//!
//! Matching and splicing happen in LF-space and the file's own newline style is restored on write, so a match
//! succeeds whether the model supplied `\n` or `\r\n`. It has no way to know which the file uses, and failing
//! over it would be a fault the model cannot correct.
//!
//! ## The error messages are the feature
//!
//! A bare "not found" gives the model nothing to act on, so it re-guesses and fails the same way — the most
//! expensive failure this tool has, because each attempt costs a full round trip. The two misses need opposite
//! fixes and are therefore reported differently:
//!
//!  - **The text IS there, with different whitespace.** By far the most common, and it means the model
//!    retyped instead of copying. The fix is to read the range and copy it byte-for-byte, and the message says
//!    roughly which line to look at.
//!  - **The text is genuinely absent.** The fix is to read first. Saying how many lines the file has stops the
//!    model editing a file it has confused with another.

use agent_core::{Result, RuntimeError};
use serde_json::{json, Value};

use crate::edittext::{is_context_placeholder, PLACEHOLDER_REFUSED, encode, read_for_edit, to_lf, unified_diff};
use crate::nodeerr::{coerce_string, fs_error, path_arg};
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

pub struct EditFile;

#[async_trait::async_trait]
impl Tool for EditFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "edit_file",
            description: "Replace exact text in a file. The old text must match byte-for-byte.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path." },
                    "old_string": { "type": "string", "description": "Exact text to replace, copied verbatim from the file." },
                    "new_string": { "type": "string", "description": "Replacement text." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of requiring a unique match." }
                },
                "required": ["path", "old_string", "new_string"]
            }),
            capabilities: &["filesystem.write"],
            risk_level: RiskLevel::Mutating,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let p = path_arg(args_v, "path")?;
        let abs = ctx.workspace.resolve(&p)?;

        let old_str = to_lf(&coerce_string(args_v.get("old_string")));
        let new_str = to_lf(&coerce_string(args_v.get("new_string")));
        if is_context_placeholder(&new_str) {
            return Err(RuntimeError::invalid("tool.placeholder_content", format!("new_string: {PLACEHOLDER_REFUSED}")));
        }
        if old_str.is_empty() {
            return Err(RuntimeError::invalid("tool.invalid_args", "old_string must not be empty"));
        }
        if old_str == new_str {
            return Err(RuntimeError::invalid(
                "tool.invalid_args",
                "old_string and new_string are identical",
            ));
        }
        let replace_all = args_v.get("replace_all").and_then(Value::as_bool).unwrap_or(false);

        let Some(file) = read_for_edit(&abs).await? else {
            return Err(fs_error(
                &std::io::Error::from(std::io::ErrorKind::NotFound),
                "open",
                &abs,
            ));
        };
        let text = file.text;

        // A literal count, not a regex one: `old_string` is text the model copied out of the file, and any
        // regex metacharacter in it would otherwise change what "the same text" means.
        let count = text.matches(&old_str).count();
        if count == 0 {
            return Err(no_match(&p, &text, &old_str));
        }
        if !replace_all && count > 1 {
            return Err(RuntimeError::invalid(
                "tool.ambiguous_edit",
                format!("old_string is not unique ({count} occurrences); set replace_all or add more context"),
            ));
        }

        let next = if replace_all {
            text.replace(&old_str, &new_str)
        } else {
            // `replacen` rather than `replace`: the uniqueness check above only ran when `replace_all` is
            // false, so replacing everything here would silently ignore it in the one-occurrence case and
            // differ from the JS handler in the many-occurrence case that is already refused.
            text.replacen(&old_str, &new_str, 1)
        };

        tokio::fs::write(&abs, encode(&next, file.newline, file.has_bom))
            .await
            .map_err(|e| fs_error(&e, "open", &abs))?;

        let summary = if replace_all {
            format!("Replaced {count} occurrence(s) in {}.", ctx.workspace.rel(&abs))
        } else {
            format!("Replaced 1 occurrence in {}.", ctx.workspace.rel(&abs))
        };
        Ok(ToolOutput::text(format!("{summary}{}", unified_diff(&text, &next))))
    }
}

/// Collapse runs of whitespace, for the "same text, different whitespace" check.
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Say which kind of miss this was. See the module header for why the distinction is load-bearing.
fn no_match(shown_path: &str, text: &str, old_str: &str) -> RuntimeError {
    let loose = collapse(old_str);
    if !loose.is_empty() && collapse(text).contains(&loose) {
        // Report roughly where it starts, so the fix is one targeted read away.
        let first_line = old_str.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let at = if first_line.is_empty() { None } else { text.find(first_line) };
        let where_ = match at {
            Some(idx) => format!(" (starts around line {})", text[..idx].lines().count() + 1),
            None => String::new(),
        };
        return RuntimeError::invalid(
            "tool.no_match",
            format!(
                "old_string not found in {shown_path}, but the same text IS present with different \
                 whitespace{where_}. Do not retype it: read_file that range and copy the text exactly as \
                 returned, keeping its indentation and line breaks byte-for-byte."
            ),
        );
    }
    RuntimeError::invalid(
        "tool.no_match",
        format!(
            "old_string not found in {shown_path} — that text is not in the file (the file has {} lines). \
             Do not guess at another variation: read_file the relevant part first, then copy the exact text \
             to replace.",
            text.lines().count()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk::FileListCache;
    use crate::workspace::Workspace;
    use agent_core::{CallId, CancellationToken};
    use std::sync::Arc;

    fn ctx(root: &std::path::Path) -> ToolContext {
        ToolContext::new(
            Workspace::new(root),
            CancellationToken::new(),
            CallId::from_host("c1"),
            Arc::new(FileListCache::new()),
        )
    }

    async fn edit(dir: &std::path::Path, args: Value) -> Result<ToolOutput> {
        EditFile.execute(&ctx(dir), &args).await
    }

    #[tokio::test]
    async fn a_unique_match_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let out = edit(dir.path(), json!({ "path": "f.txt", "old_string": "beta", "new_string": "BETA" }))
            .await
            .expect("the edit");
        assert!(out.content.starts_with("Replaced 1 occurrence"), "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "alpha\nBETA\ngamma\n");
    }

    #[tokio::test]
    async fn an_ambiguous_match_is_refused_unless_replace_all_is_set() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x\nx\nx\n").unwrap();

        let err = edit(dir.path(), json!({ "path": "f.txt", "old_string": "x", "new_string": "y" }))
            .await
            .expect_err("ambiguity must be refused");
        assert_eq!(err.code, "tool.ambiguous_edit");
        assert!(err.message.contains("3 occurrences"), "{}", err.message);
        // Nothing was written.
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "x\nx\nx\n");

        let out = edit(
            dir.path(),
            json!({ "path": "f.txt", "old_string": "x", "new_string": "y", "replace_all": true }),
        )
        .await
        .expect("replace_all");
        assert!(out.content.contains("Replaced 3 occurrence"), "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "y\ny\ny\n");
    }

    /// The most common miss, and the one whose message has to say the opposite of the other.
    #[tokio::test]
    async fn text_present_with_different_whitespace_says_so_and_points_at_the_line() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "fn main() {\n    let x   =  1;\n}\n").unwrap();

        let err = edit(
            dir.path(),
            json!({ "path": "f.txt", "old_string": "let x = 1;", "new_string": "let x = 2;" }),
        )
        .await
        .expect_err("the match should fail");
        assert_eq!(err.code, "tool.no_match");
        assert!(err.message.contains("different whitespace"), "{}", err.message);
        assert!(err.message.contains("Do not retype it"), "{}", err.message);
    }

    #[tokio::test]
    async fn genuinely_absent_text_is_reported_differently_and_names_the_file_length() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "one\ntwo\nthree\n").unwrap();

        let err = edit(
            dir.path(),
            json!({ "path": "f.txt", "old_string": "nowhere at all", "new_string": "x" }),
        )
        .await
        .expect_err("the match should fail");
        assert!(err.message.contains("not in the file"), "{}", err.message);
        assert!(err.message.contains("3 lines"), "{}", err.message);
        assert!(!err.message.contains("different whitespace"), "{}", err.message);
    }

    /// The model cannot know the file's newline style, so the match must not depend on it.
    #[tokio::test]
    async fn an_edit_matches_a_crlf_file_with_lf_text_and_keeps_the_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        std::fs::write(&path, "one\r\ntwo\r\nthree\r\n").unwrap();

        edit(dir.path(), json!({ "path": "crlf.txt", "old_string": "one\ntwo", "new_string": "one\nTWO" }))
            .await
            .expect("the edit should match across newline styles");

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "one\r\nTWO\r\nthree\r\n");
    }

    #[tokio::test]
    async fn a_regex_metacharacter_is_treated_as_literal_text() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "cost is $1.50 (approx)\n").unwrap();
        edit(
            dir.path(),
            json!({ "path": "f.txt", "old_string": "$1.50 (approx)", "new_string": "$2.00" }),
        )
        .await
        .expect("literal matching");
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "cost is $2.00\n");
    }

    /// `$` is special in JavaScript's replacement strings; it must not be here either.
    #[tokio::test]
    async fn a_dollar_sign_in_the_replacement_is_not_expanded() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "PLACEHOLDER\n").unwrap();
        edit(dir.path(), json!({ "path": "f.txt", "old_string": "PLACEHOLDER", "new_string": "$& and $1" }))
            .await
            .expect("the edit");
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "$& and $1\n");
    }

    #[tokio::test]
    async fn an_empty_or_identical_edit_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "a\n").unwrap();
        for args in [
            json!({ "path": "f.txt", "old_string": "", "new_string": "x" }),
            json!({ "path": "f.txt", "old_string": "a", "new_string": "a" }),
        ] {
            let err = edit(dir.path(), args.clone()).await.expect_err("must be refused");
            assert_eq!(err.code, "tool.invalid_args", "{args}");
        }
    }

    #[tokio::test]
    async fn editing_a_missing_file_reports_it_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = edit(dir.path(), json!({ "path": "gone.txt", "old_string": "a", "new_string": "b" }))
            .await
            .expect_err("a missing file must be reported");
        assert!(err.message.contains("ENOENT"), "{}", err.message);
    }

    #[tokio::test]
    async fn a_placeholder_new_string_is_refused_and_the_file_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "alpha\nbeta\n").unwrap();
        let marker = "[…… 2 lines elided: this text was written to f.txt; read_file it if you need it ……]";
        let err = edit(dir.path(), json!({ "path": "f.txt", "old_string": "beta", "new_string": marker }))
            .await
            .expect_err("placeholder replacement must be refused");
        assert_eq!(err.code, "tool.placeholder_content");
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "alpha\nbeta\n");
    }
}
