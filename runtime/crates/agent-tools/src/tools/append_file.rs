//! `append_file` — mirrors the handler in aiToolkit.mjs.
//!
//! The last of the text-editing tools to move, and the only one whose write is not a rewrite: it must add
//! bytes at EOF and leave every byte already in the file exactly as it was. So the file's newline style is
//! detected and applied to the ADDITION only, and a BOM is never written — an existing file already has one
//! if it wants one, and a new file created by an append gets none, which is what `fs.appendFile(…, "utf8")`
//! did.
//!
//! Moving it here also retires `electron/tools/placeholder.mjs`, which existed only because this was the one
//! file tool the runtime did not serve and so needed a JavaScript copy of the marker guard.

use agent_core::{Result, RuntimeError};
use serde_json::{json, Value};

use crate::edittext::{is_context_placeholder, placeholder_refusal, Newline, encode, read_for_edit, to_lf, unified_diff};
use crate::nodeerr::{coerce_string, fs_error, path_arg};
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

pub struct AppendFile;

#[async_trait::async_trait]
impl Tool for AppendFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "append_file",
            description: "Append UTF-8 text to a file, creating it and any missing parent directories.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path." },
                    "content": { "type": "string", "description": "Text to append." }
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
        let abs = ctx.workspace.resolve_write(&p)?;
        let add = to_lf(&coerce_string(args_v.get("content")));
        if is_context_placeholder(&add) {
            return Err(RuntimeError::invalid(
                "tool.placeholder_content",
                placeholder_refusal("content", &ctx.workspace.rel(&abs)),
            ));
        }

        // A missing file is a new file, and its style is whatever the addition itself uses. A non-UTF-8 file
        // is refused by `read_for_edit` rather than appended to, because the diff below would be nonsense and
        // the "preserve encoding" guarantee could not be met for the bytes already there.
        let existing = read_for_edit(&abs).await?;
        let (before, newline) = match &existing {
            Some(f) => (f.text.as_str(), f.newline),
            None => ("", Newline::detect(&add)),
        };

        if let Some(parent) = abs.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| fs_error(&e, "mkdir", parent))?;
        }
        // `has_bom: false` always: the addition goes at EOF, and a BOM belongs only at byte zero.
        let bytes = encode(&add, newline, false);
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&abs)
            .await
            .map_err(|e| fs_error(&e, "open", &abs))?;
        {
            use tokio::io::AsyncWriteExt;
            f.write_all(&bytes).await.map_err(|e| fs_error(&e, "write", &abs))?;
            f.flush().await.map_err(|e| fs_error(&e, "write", &abs))?;
        }

        // The diff is of LF-space text either side, so a CRLF file does not report every line as changed.
        let after = format!("{before}{add}");
        let diff = unified_diff(before, &after);
        Ok(ToolOutput::mutating(format!(
            "Appended {} bytes to {} ({}).{diff}",
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
    async fn appending_to_a_missing_file_creates_it_with_its_parents() {
        let dir = tempfile::tempdir().unwrap();
        let out = AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "a/b/log.txt", "content": "one\n" }))
            .await
            .expect("the append");
        assert!(out.content.starts_with("Appended 4 bytes"), "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("a/b/log.txt")).unwrap(), "one\n");
    }

    #[tokio::test]
    async fn appending_adds_at_eof_and_leaves_what_was_there() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("log.txt"), "one\n").unwrap();
        AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "log.txt", "content": "two\n" }))
            .await
            .expect("the append");
        assert_eq!(std::fs::read_to_string(dir.path().join("log.txt")).unwrap(), "one\ntwo\n");
    }

    #[tokio::test]
    async fn the_addition_takes_the_files_newline_style_and_the_file_keeps_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        // BOM + CRLF, the combination a naive append destroys.
        std::fs::write(dir.path().join("w.txt"), b"\xef\xbb\xbfone\r\ntwo\r\n").unwrap();
        AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "w.txt", "content": "three\n" }))
            .await
            .expect("the append");
        let raw = std::fs::read(dir.path().join("w.txt")).unwrap();
        // One BOM, still at byte zero, and the addition arrived as CRLF like the rest of the file.
        assert_eq!(&raw[..3], b"\xef\xbb\xbf");
        assert_eq!(&raw[3..], b"one\r\ntwo\r\nthree\r\n");
    }

    #[tokio::test]
    async fn a_new_file_never_gains_a_bom() {
        let dir = tempfile::tempdir().unwrap();
        AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "fresh.txt", "content": "x\n" }))
            .await
            .expect("the append");
        assert_eq!(std::fs::read(dir.path().join("fresh.txt")).unwrap(), b"x\n");
    }

    #[tokio::test]
    async fn a_non_utf8_file_is_refused_rather_than_appended_to() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gbk.txt"), b"\xc4\xe3\xba\xc3").unwrap();
        let err = AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "gbk.txt", "content": "x" }))
            .await
            .expect_err("a legacy encoding must be refused");
        assert_eq!(err.code, "tool.not_utf8");
        assert_eq!(std::fs::read(dir.path().join("gbk.txt")).unwrap(), b"\xc4\xe3\xba\xc3");
    }

    #[tokio::test]
    async fn the_context_placeholder_is_refused_and_nothing_is_appended() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("out.csv").as_path(), "a\n").unwrap();
        let marker = "[…… dropped from your context to save space: the text you wrote to out.csv ……]";
        let err = AppendFile
            .execute(&ctx(dir.path()), &json!({ "path": "out.csv", "content": marker }))
            .await
            .expect_err("placeholder content must be refused");
        assert_eq!(err.code, "tool.placeholder_content");
        assert_eq!(std::fs::read_to_string(dir.path().join("out.csv")).unwrap(), "a\n");
    }

    #[tokio::test]
    async fn an_asset_cannot_be_appended_to() {
        let dir = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(assets.path().join("notes.txt"), "keep\n").unwrap();
        let c = ToolContext::new(
            Workspace::new(dir.path()).with_assets(assets.path()),
            CancellationToken::new(),
            CallId::from_host("c1"),
            Arc::new(FileListCache::new()),
        );
        let err = AppendFile
            .execute(&c, &json!({ "path": "/assets/notes.txt", "content": "x" }))
            .await
            .expect_err("the asset folder is read-only");
        assert_eq!(err.code, "tool.asset_read_only");
        assert_eq!(std::fs::read_to_string(assets.path().join("notes.txt")).unwrap(), "keep\n");
    }
}
