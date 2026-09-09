//! `delete_file`, `copy_file`, `move_file`, `create_directory` — mirror the handlers in aiToolkit.mjs.
//!
//! Four one-syscall tools in one file, because separately they would be four copies of the same twelve lines
//! and the thing worth reading is not any one of them but how they differ from each other:
//!
//!   * `copy_file` resolves its SOURCE for reading. That is deliberate and is how an asset is used — copying
//!     a clip out of the read-only media library into the workspace is the intended way to work with one.
//!   * `move_file` resolves BOTH ends for writing, because a move removes the source. That is exactly what
//!     the asset root must refuse, and resolving the source as a read would quietly permit it.
//!   * `delete_file` and `move_file` declare `filesystem.delete` rather than `filesystem.write`. It is an
//!     elevated capability (`CapabilityKind::is_elevated`), so neither is granted implicitly to a delegated
//!     sub-agent. A move destroys the bytes at the source as surely as a delete does; declaring it a plain
//!     write would let a sub-agent reach the outcome the elevated list exists to withhold.

use agent_core::Result;
use serde_json::{json, Value};

use crate::nodeerr::{fs_error, path_arg};
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

/// The two-path schema `copy_file` and `move_file` share.
fn two_path_schema(verb: &str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "source": { "type": "string", "description": format!("Path to {verb}.") },
            "destination": { "type": "string", "description": "Destination path (overwritten if it exists)." }
        },
        "required": ["source", "destination"]
    })
}

fn one_path_schema(what: &str) -> Value {
    json!({
        "type": "object",
        "properties": { "path": { "type": "string", "description": what } },
        "required": ["path"]
    })
}

/// Create the destination's parent, as every JS handler here did before writing.
async fn ensure_parent(abs: &std::path::Path) -> Result<()> {
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| fs_error(&e, "mkdir", parent))?;
    }
    Ok(())
}

// ── delete_file ─────────────────────────────────────────────────────────────────────────────────

pub struct DeleteFile;

#[async_trait::async_trait]
impl Tool for DeleteFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "delete_file",
            description: "Delete a file.",
            input_schema: one_path_schema("File path."),
            capabilities: &["filesystem.delete"],
            risk_level: RiskLevel::Mutating,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let p = path_arg(args_v, "path")?;
        let abs = ctx.workspace.resolve_write(&p)?;
        tokio::fs::remove_file(&abs).await.map_err(|e| fs_error(&e, "unlink", &abs))?;
        Ok(ToolOutput::mutating(format!("Deleted {}.", ctx.workspace.rel(&abs))))
    }
}

// ── copy_file ───────────────────────────────────────────────────────────────────────────────────

pub struct CopyFile;

#[async_trait::async_trait]
impl Tool for CopyFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "copy_file",
            description: "Copy a file to a new path (overwrites the destination).",
            input_schema: two_path_schema("copy from"),
            capabilities: &["filesystem.write"],
            risk_level: RiskLevel::Mutating,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        // Read for the source: copying an asset INTO the workspace is the point of the asset root.
        let src = ctx.workspace.resolve(&path_arg(args_v, "source")?)?;
        let dst = ctx.workspace.resolve_write(&path_arg(args_v, "destination")?)?;
        ensure_parent(&dst).await?;
        tokio::fs::copy(&src, &dst).await.map_err(|e| fs_error(&e, "copyfile", &src))?;
        Ok(ToolOutput::mutating(format!(
            "Copied {} -> {} ({}).",
            ctx.workspace.rel(&src),
            ctx.workspace.rel(&dst),
            dst.display()
        )))
    }
}

// ── move_file ───────────────────────────────────────────────────────────────────────────────────

pub struct MoveFile;

#[async_trait::async_trait]
impl Tool for MoveFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "move_file",
            description: "Move or rename a file (overwrites the destination).",
            input_schema: two_path_schema("move"),
            capabilities: &["filesystem.delete"],
            risk_level: RiskLevel::Mutating,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        // BOTH ends are writes: a move removes the source, which the asset folder must never permit.
        let src = ctx.workspace.resolve_write(&path_arg(args_v, "source")?)?;
        let dst = ctx.workspace.resolve_write(&path_arg(args_v, "destination")?)?;
        ensure_parent(&dst).await?;
        // Clear the destination first: `rename` refuses an existing directory on Unix and an existing file on
        // Windows, and the JS handler's `rm(d, { force: true })` is what made "overwrites the destination"
        // true on both. `force` semantics: a destination that was not there is not an error.
        match tokio::fs::remove_file(&dst).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(fs_error(&e, "unlink", &dst)),
        }
        tokio::fs::rename(&src, &dst).await.map_err(|e| fs_error(&e, "rename", &src))?;
        Ok(ToolOutput::mutating(format!(
            "Moved {} -> {} ({}).",
            ctx.workspace.rel(&src),
            ctx.workspace.rel(&dst),
            dst.display()
        )))
    }
}

// ── create_directory ────────────────────────────────────────────────────────────────────────────

pub struct CreateDirectory;

#[async_trait::async_trait]
impl Tool for CreateDirectory {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "create_directory",
            description: "Create a directory (including parents).",
            input_schema: one_path_schema("Directory path to create."),
            capabilities: &["filesystem.write"],
            risk_level: RiskLevel::Mutating,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let p = path_arg(args_v, "path")?;
        let abs = ctx.workspace.resolve_write(&p)?;
        tokio::fs::create_dir_all(&abs).await.map_err(|e| fs_error(&e, "mkdir", &abs))?;
        Ok(ToolOutput::mutating(format!(
            "Created directory {} ({}).",
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

    /// A workspace with the read-only media library beside it.
    fn ctx_assets(root: &std::path::Path, assets: &std::path::Path) -> ToolContext {
        ToolContext::new(
            Workspace::new(root).with_assets(assets),
            CancellationToken::new(),
            CallId::from_host("c1"),
            Arc::new(FileListCache::new()),
        )
    }

    // ── delete_file ─────────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn deleting_removes_the_file_and_reports_the_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gone.txt"), "x").unwrap();
        let out = DeleteFile
            .execute(&ctx(dir.path()), &json!({ "path": "gone.txt" }))
            .await
            .expect("the delete");
        assert_eq!(out.content, "Deleted gone.txt.");
        assert!(!dir.path().join("gone.txt").exists());
        assert!(out.invalidates_file_list);
    }

    #[tokio::test]
    async fn deleting_an_asset_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(assets.path().join("clip.mp4"), "footage").unwrap();
        let err = DeleteFile
            .execute(&ctx_assets(dir.path(), assets.path()), &json!({ "path": "/assets/clip.mp4" }))
            .await
            .expect_err("the asset folder is read-only");
        assert_eq!(err.code, "tool.asset_read_only");
        assert!(assets.path().join("clip.mp4").exists(), "the asset survived");
    }

    #[tokio::test]
    async fn deleting_is_an_elevated_capability_so_a_sub_agent_does_not_get_it_by_default() {
        // The claim the metadata is making; `CapabilityKind::is_elevated` is what acts on it.
        assert_eq!(DeleteFile.metadata().capabilities, &["filesystem.delete"]);
        assert_eq!(MoveFile.metadata().capabilities, &["filesystem.delete"]);
    }

    // ── copy_file ───────────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn copying_creates_the_destinations_parents_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        std::fs::create_dir_all(dir.path().join("out")).unwrap();
        std::fs::write(dir.path().join("out/b.txt"), "stale").unwrap();
        CopyFile
            .execute(&ctx(dir.path()), &json!({ "source": "a.txt", "destination": "deep/out/b.txt" }))
            .await
            .expect("the copy");
        assert_eq!(std::fs::read_to_string(dir.path().join("deep/out/b.txt")).unwrap(), "one");
        // The source is untouched, and an existing destination elsewhere is overwritten rather than refused.
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one");
        CopyFile
            .execute(&ctx(dir.path()), &json!({ "source": "a.txt", "destination": "out/b.txt" }))
            .await
            .expect("the overwrite");
        assert_eq!(std::fs::read_to_string(dir.path().join("out/b.txt")).unwrap(), "one");
    }

    #[tokio::test]
    async fn an_asset_can_be_copied_into_the_workspace() {
        // The whole reason the asset root is readable: this is how the model works with footage it was given.
        let dir = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(assets.path().join("clip.mp4"), "footage").unwrap();
        let out = CopyFile
            .execute(
                &ctx_assets(dir.path(), assets.path()),
                &json!({ "source": "/assets/clip.mp4", "destination": "media/clip.mp4" }),
            )
            .await
            .expect("copying an asset in must work");
        assert_eq!(std::fs::read_to_string(dir.path().join("media/clip.mp4")).unwrap(), "footage");
        // Named by its alias, so the path the model reads back is one it can use again.
        assert!(out.content.starts_with("Copied /assets/clip.mp4 -> media/clip.mp4"), "{}", out.content);
    }

    #[tokio::test]
    async fn copying_onto_an_asset_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let err = CopyFile
            .execute(
                &ctx_assets(dir.path(), assets.path()),
                &json!({ "source": "a.txt", "destination": "/assets/a.txt" }),
            )
            .await
            .expect_err("the asset folder is read-only");
        assert_eq!(err.code, "tool.asset_read_only");
    }

    // ── move_file ───────────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn moving_removes_the_source_and_overwrites_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("from.txt"), "payload").unwrap();
        std::fs::write(dir.path().join("to.txt"), "stale").unwrap();
        MoveFile
            .execute(&ctx(dir.path()), &json!({ "source": "from.txt", "destination": "to.txt" }))
            .await
            .expect("the move");
        assert_eq!(std::fs::read_to_string(dir.path().join("to.txt")).unwrap(), "payload");
        assert!(!dir.path().join("from.txt").exists(), "the source was removed");
    }

    #[tokio::test]
    async fn moving_to_a_destination_that_does_not_exist_is_not_an_error() {
        // `rm -f` semantics: clearing a destination that was never there must not fail the move.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("from.txt"), "payload").unwrap();
        MoveFile
            .execute(&ctx(dir.path()), &json!({ "source": "from.txt", "destination": "new/to.txt" }))
            .await
            .expect("the move");
        assert_eq!(std::fs::read_to_string(dir.path().join("new/to.txt")).unwrap(), "payload");
    }

    #[tokio::test]
    async fn an_asset_cannot_be_moved_out_even_though_it_can_be_read() {
        // The asymmetry that makes move different from copy: a move REMOVES the source.
        let dir = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        std::fs::write(assets.path().join("clip.mp4"), "footage").unwrap();
        let err = MoveFile
            .execute(
                &ctx_assets(dir.path(), assets.path()),
                &json!({ "source": "/assets/clip.mp4", "destination": "clip.mp4" }),
            )
            .await
            .expect_err("moving an asset out would delete it");
        assert_eq!(err.code, "tool.asset_read_only");
        assert!(assets.path().join("clip.mp4").exists(), "the asset survived");
    }

    // ── create_directory ────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn creating_a_directory_makes_parents_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..2 {
            let out = CreateDirectory
                .execute(&ctx(dir.path()), &json!({ "path": "a/b/c" }))
                .await
                .expect("mkdir -p never fails on an existing directory");
            assert!(out.content.starts_with("Created directory a/b/c"), "{}", out.content);
        }
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn every_one_of_these_refuses_a_path_outside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());
        let escapes = [
            DeleteFile.execute(&c, &json!({ "path": "../x" })).await.unwrap_err(),
            CreateDirectory.execute(&c, &json!({ "path": "/etc/x" })).await.unwrap_err(),
            CopyFile.execute(&c, &json!({ "source": "a", "destination": "../x" })).await.unwrap_err(),
            MoveFile.execute(&c, &json!({ "source": "../x", "destination": "a" })).await.unwrap_err(),
        ];
        for e in escapes {
            assert_eq!(e.code, "tool.path_escapes_workspace", "{}", e.message);
        }
    }
}
