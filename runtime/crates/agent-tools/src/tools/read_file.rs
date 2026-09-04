//! `read_file` — the whole file by default, or the line slice the model asked for.
//!
//! There is no size ceiling here: no byte cap on the file, no character cap on the result, and no default
//! line window. A bare `read_file {path}` returns the entire file, whatever its size. Until 2026-09-04 three
//! caps applied — files over 2 MB were refused, results were trimmed at 200,000 characters, and a bare read
//! stopped after 2,000 lines — and each one turned "read this file" into a partial answer the model then had
//! to page through. The renderer has since been made safe for a result the size of a file (the transcript
//! clips what it lays out, the token estimator samples), so the tool no longer has to protect it.
//!
//! What remains is opt-in paging through `offset`/`limit`, with its trailing note ("showing lines A-B of N;
//! read on with offset:X"). The note is not decoration. The renderer's stale-read dedup parses reads as line
//! *spans* and only stubs an earlier read when a later one provably covers it — the note is how a span
//! becomes visible to the model in the first place, and the `offset`/`limit` semantics here (absent `limit`
//! = to the end of the file) are mirrored in `contextCompress.ts` for the same computation. Change the wording
//! and you change what the model asks for next; change the semantics and dedup starts stubbing live content.

use agent_core::Result;
use serde_json::{json, Value};

use crate::nodeerr::{fs_error, path_arg, stat_error};
use crate::tool::{args, ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

pub struct ReadFile;

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "read_file",
            description: "Read the UTF-8 text content of a file. Without offset/limit the whole file comes back, whatever its size; pass them to read a slice of a large file instead.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path." },
                    "offset": { "type": "number", "description": "First line to read, 1-based. Defaults to 1 (start of file)." },
                    "limit": { "type": "number", "description": "How many lines to read from offset. Omit to read to the end of the file." }
                },
                "required": ["path"]
            }),
            capabilities: &["filesystem.read"],
            risk_level: RiskLevel::ReadOnly,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let p = path_arg(args_v, "path")?;
        let abs = ctx.workspace.resolve(&p)?;

        // Nothing is done with the metadata any more — the size check that needed it is gone — but the
        // stat stays so a missing path fails with the same `stat` wording it always has, which the model
        // has seen and the smoke harness pins.
        tokio::fs::metadata(&abs).await.map_err(|e| stat_error(&e, &abs))?;

        ctx.check_cancelled()?;
        let bytes = tokio::fs::read(&abs).await.map_err(|e| fs_error(&e, "open", &abs))?;
        // `fs.readFile(abs, "utf8")` in Node replaces invalid sequences rather than failing, so a
        // binary file comes back as mojibake instead of an error. Matching that keeps a model's
        // mistaken read of a `.png` behaving as it always has.
        let text = String::from_utf8_lossy(&bytes);

        // Split on "\n" only — not on \r\n. A CRLF file therefore keeps its \r at the end of each
        // line, exactly as the original JS handler left it.
        let mut lines: Vec<&str> = text.split('\n').collect();
        // A trailing newline yields a final "" element; dropping it keeps the reported total honest.
        if lines.len() > 1 && lines[lines.len() - 1].is_empty() {
            lines.pop();
        }
        let total = lines.len();

        let start = positive_int(args::opt_num(args_v, "offset")).unwrap_or(1);
        let count = positive_int(args::opt_num(args_v, "limit"));

        if start > total {
            return Ok(ToolOutput::text(format!(
                "[read_file] offset {start} is past the end of {p} — the file has {total} lines."
            )));
        }
        let end = match count {
            Some(c) => total.min(start.saturating_add(c - 1)),
            None => total,
        };

        let body = lines[start - 1..end].join("\n");

        if start == 1 && end == total {
            return Ok(ToolOutput::text(body));
        }

        let mut notes = vec![format!("showing lines {start}-{end} of {total}")];
        if end < total {
            notes.push(format!("read on with offset:{}", end + 1));
        }
        Ok(ToolOutput::text(format!("{body}\n\n[read_file] {p}: {}.", notes.join("; "))))
    }
}

/// `Math.max(1, Math.floor(Number(v)))`, or `None` where JS's `Number(v) || default` would have fallen
/// through to the default: absent, `0`, `NaN`, infinite.
///
/// The leniency is deliberate. A caller passing `offset: 0` gets line 1 rather than an error, and
/// `limit: 0` reads to the end — a model that learned that from the JS handler keeps getting it.
fn positive_int(v: Option<f64>) -> Option<usize> {
    let n = v.filter(|f| f.is_finite() && *f != 0.0)?;
    let floored = n.floor();
    Some(if floored < 1.0 { 1 } else { floored as usize })
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

    async fn read(dir: &std::path::Path, args: Value) -> Result<ToolOutput> {
        ReadFile.execute(&ctx(dir), &args).await
    }

    #[tokio::test]
    async fn a_bare_read_returns_the_whole_file_however_long() {
        let dir = tempfile::tempdir().unwrap();
        // Well past the 2,000-line window that used to apply by default.
        let text: String = (1..=5000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.path().join("long.txt"), &text).unwrap();
        let out = read(dir.path(), json!({ "path": "long.txt" })).await.expect("the read");
        assert_eq!(out.content, text.trim_end_matches('\n'));
        assert!(!out.content.contains("[read_file]"), "a complete read carries no note");
    }

    #[tokio::test]
    async fn a_multi_megabyte_single_line_file_is_neither_refused_nor_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        // Over the old 2 MB byte cap and the old 200,000-character trim at once, on one line, so
        // neither a line window nor a byte ceiling could have let it through.
        let text = "x".repeat(3 * 1024 * 1024);
        std::fs::write(dir.path().join("blob.txt"), &text).unwrap();
        let out = read(dir.path(), json!({ "path": "blob.txt" })).await.expect("the read");
        assert_eq!(out.content.len(), text.len());
        assert!(!out.content.contains("trimmed"));
    }

    #[tokio::test]
    async fn offset_and_limit_still_page_with_the_cursor_note() {
        let dir = tempfile::tempdir().unwrap();
        let text: String = (1..=10).map(|i| format!("l{i}\n")).collect();
        std::fs::write(dir.path().join("f.txt"), &text).unwrap();

        let out = read(dir.path(), json!({ "path": "f.txt", "offset": 3, "limit": 2 })).await.unwrap();
        assert_eq!(out.content, "l3\nl4\n\n[read_file] f.txt: showing lines 3-4 of 10; read on with offset:5.");

        // An offset with no limit reads to the end: the note names the span but offers no cursor.
        let out = read(dir.path(), json!({ "path": "f.txt", "offset": 8 })).await.unwrap();
        assert_eq!(out.content, "l8\nl9\nl10\n\n[read_file] f.txt: showing lines 8-10 of 10.");

        // A limit past the end is clipped to the file, not an error.
        let out = read(dir.path(), json!({ "path": "f.txt", "offset": 9, "limit": 1e18 })).await.unwrap();
        assert_eq!(out.content, "l9\nl10\n\n[read_file] f.txt: showing lines 9-10 of 10.");

        let out = read(dir.path(), json!({ "path": "f.txt", "offset": 11 })).await.unwrap();
        assert_eq!(out.content, "[read_file] offset 11 is past the end of f.txt — the file has 10 lines.");
    }

    #[tokio::test]
    async fn zero_and_nan_arguments_fall_back_like_the_js_handler_did() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "a\nb\nc\n").unwrap();
        // `offset: 0` is line 1 and `limit: 0` is "to the end", so this is a complete read with no note.
        let out = read(dir.path(), json!({ "path": "f.txt", "offset": 0, "limit": 0 })).await.unwrap();
        assert_eq!(out.content, "a\nb\nc");
        assert_eq!(positive_int(Some(f64::NAN)), None);
        assert_eq!(positive_int(Some(f64::INFINITY)), None);
        assert_eq!(positive_int(Some(0.4)), Some(1));
        assert_eq!(positive_int(Some(2.9)), Some(2));
    }

    #[tokio::test]
    async fn a_missing_file_still_fails_on_stat() {
        let dir = tempfile::tempdir().unwrap();
        let err = read(dir.path(), json!({ "path": "nope.txt" })).await.expect_err("missing");
        assert_eq!(err.code, "tool.fs_error");
        assert!(err.message.contains("stat"), "{}", err.message);
    }
}
