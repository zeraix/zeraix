//! `write_file` — mirrors the handler in aiToolkit.mjs.
//!
//! The first mutating tool in this crate, and the reason it was left until now: a tool that can overwrite a
//! file needs the capability check in `agent-dispatch` to exist before it is reachable, which it did not until
//! stage 6c.
//!
//! What makes this more than `fs::write` is in `edittext.rs`: a rewrite keeps the file's encoding, BOM and
//! newline style rather than forcing LF/no-BOM UTF-8 onto it. A model handed a CRLF file returns LF every
//! time, and accepting that would show every line of the file as changed in the user's next `git diff`.

use agent_core::{Result, RuntimeError};
use serde_json::{json, Value};

use crate::edittext::{is_context_placeholder, PLACEHOLDER_REFUSED, Newline, encode, read_for_edit, to_lf, unified_diff};
use crate::nodeerr::{coerce_string, fs_error, path_arg};
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

pub struct WriteFile;

#[async_trait::async_trait]
impl Tool for WriteFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "write_file",
            description: "Write text content to a file, creating it and any missing parent directories.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path." },
                    "content": { "type": "string", "description": "The complete new contents of the file." }
                },
                "required": ["path", "content"]
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
        let after = to_lf(&coerce_string(args_v.get("content")));
        if is_context_placeholder(&after) {
            return Err(RuntimeError::invalid("tool.placeholder_content", format!("content: {PLACEHOLDER_REFUSED}")));
        }

        // Read the existing file's traits so the rewrite keeps them. A missing file is a new file: LF, no BOM.
        // A non-UTF-8 file is refused by `read_for_edit`, because rewriting it as UTF-8 would convert it —
        // exactly what "preserve encoding" forbids.
        let existing = read_for_edit(&abs).await?;
        let (before, has_bom, newline) = match &existing {
            Some(f) => (f.text.as_str(), f.has_bom, f.newline),
            None => ("", false, Newline::detect(&after)),
        };

        if let Some(parent) = abs.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| fs_error(&e, "mkdir", parent))?;
        }
        let bytes = encode(&after, newline, has_bom);
        tokio::fs::write(&abs, &bytes).await.map_err(|e| fs_error(&e, "open", &abs))?;

        let verb = if before.is_empty() { "Created" } else { "Wrote" };
        let diff = unified_diff(before, &after);
        Ok(ToolOutput::mutating(format!(
            "{verb} {} bytes to {} ({}).{diff}",
            bytes.len(),
            ctx.workspace.rel(&abs),
            abs.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::ToolContext;
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

    #[tokio::test]
    async fn a_new_file_is_created_with_its_parents() {
        let dir = tempfile::tempdir().unwrap();
        let out = WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "a/b/c.txt", "content": "hello\n" }))
            .await
            .expect("the write");
        assert!(out.content.starts_with("Created"), "{}", out.content);
        assert!(out.invalidates_file_list, "a new file changes the workspace listing");
        assert_eq!(std::fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap(), "hello\n");
    }

    /// The guarantee this tool exists to keep.
    #[tokio::test]
    async fn rewriting_a_crlf_file_keeps_its_crlf_even_though_the_model_sent_lf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        std::fs::write(&path, "one\r\ntwo\r\n").unwrap();

        WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "crlf.txt", "content": "one\nthree\n" }))
            .await
            .expect("the write");

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "one\r\nthree\r\n", "the file's newline style was lost");
    }

    #[tokio::test]
    async fn rewriting_a_file_with_a_bom_keeps_the_bom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bom.txt");
        let mut original = vec![0xef, 0xbb, 0xbf];
        original.extend_from_slice(b"before\n");
        std::fs::write(&path, &original).unwrap();

        WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "bom.txt", "content": "after\n" }))
            .await
            .expect("the write");

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..3], &[0xef, 0xbb, 0xbf], "the BOM was dropped");
    }

    /// Rewriting it as UTF-8 would convert it, which is what "preserve encoding" forbids.
    #[tokio::test]
    async fn a_non_utf8_file_is_refused_rather_than_converted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gbk.txt");
        std::fs::write(&path, [b'a', 0xc4, 0xe3]).unwrap();

        let err = WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "gbk.txt", "content": "new\n" }))
            .await
            .expect_err("a non-UTF-8 file must be refused");
        assert_eq!(err.code, "tool.not_utf8");
        // And the original bytes are untouched.
        assert_eq!(std::fs::read(&path).unwrap(), vec![b'a', 0xc4, 0xe3]);
    }

    #[tokio::test]
    async fn an_overwrite_reports_the_diff_of_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "a\nb\nc\n").unwrap();
        let out = WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "f.txt", "content": "a\nB\nc\n" }))
            .await
            .expect("the write");
        assert!(out.content.starts_with("Wrote"), "{}", out.content);
        assert!(out.content.contains("-b"), "{}", out.content);
        assert!(out.content.contains("+B"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_path_outside_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let err = WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "../escape.txt", "content": "x" }))
            .await
            .expect_err("an escape must be refused");
        assert_eq!(err.code, "tool.path_escapes_workspace");
    }

    #[tokio::test]
    async fn the_context_placeholder_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let marker = "[…… 19 lines elided: this text was written to out.csv; read_file it if you need it ……]";
        let err = WriteFile
            .execute(&ctx(dir.path()), &json!({ "path": "out.csv", "content": marker }))
            .await
            .expect_err("placeholder content must be refused");
        assert_eq!(err.code, "tool.placeholder_content");
        assert!(err.message.contains("not file content"), "{}", err.message);
        assert!(!dir.path().join("out.csv").exists(), "no file was created");
    }
}
