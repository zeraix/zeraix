//! `list_directory` — mirrors the handler in aiToolkit.mjs.
//!
//! The cap is the interesting part of this tool. An uncapped listing was not actually uncapped: a
//! `node_modules`-sized directory blew past the renderer's 8,000-character tool-output limit and came
//! back head+tail with the middle silently eaten — the worst possible shape for a list, because the
//! entries that vanish are unnamed and the notice talks about characters rather than files. Cutting at
//! `MAX_ENTRIES` here instead means the count is honest and the omission is stated.

use agent_core::Result;
use serde_json::{json, Value};

use crate::nodeerr::{fs_error, path_arg};
use crate::text::locale_compare;
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};
use crate::MAX_ENTRIES;

pub struct ListDirectory;

#[async_trait::async_trait]
impl Tool for ListDirectory {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "list_directory",
            description: "List the entries of a directory.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path. Defaults to the working directory." }
                },
                "required": []
            }),
            capabilities: &["filesystem.read"],
            risk_level: RiskLevel::ReadOnly,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(30_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        // `p ? resolveInside(p) : WORKDIR` — a falsy path means the working directory, and anything
        // truthy that is not a string is rejected by resolveInside's type check.
        let abs = match args_v.get("path") {
            None | Some(Value::Null) => ctx.root().to_path_buf(),
            Some(Value::String(s)) if s.is_empty() => ctx.root().to_path_buf(),
            Some(Value::Bool(false)) => ctx.root().to_path_buf(),
            Some(Value::Number(n)) if n.as_f64() == Some(0.0) => ctx.root().to_path_buf(),
            Some(Value::String(s)) => ctx.workspace.resolve(s)?,
            Some(_) => return Err(path_arg(args_v, "path").unwrap_err()),
        };

        // The whole listing happens inside ONE blocking task rather than awaiting per entry.
        //
        // The obvious async version — `tokio::fs::read_dir` and `entry.file_type().await` in a loop —
        // measured *4.8x slower than the JS handler* on a 320-entry directory. Each of those awaits is
        // a separate hop onto the blocking pool, so a cheap `d_type` read from the already-fetched
        // dirent turns into hundreds of thread handoffs. Reading the directory synchronously inside a
        // single `spawn_blocking` keeps the Tokio worker free (spec §24: no blocking IO on a worker)
        // without paying that per-entry cost.
        let read_dir = {
            let dir = abs.clone();
            let cancel = ctx.cancel.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(bool, String)>> {
                let mut out = Vec::new();
                for entry in std::fs::read_dir(&dir)? {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let entry = entry?;
                    // `Dirent.isDirectory()` does not follow symlinks, and neither does this — a link
                    // to a directory is listed without the `[dir]` marker in both runtimes.
                    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    out.push((is_dir, entry.file_name().to_string_lossy().into_owned()));
                }
                Ok(out)
            })
            .await
            .map_err(|e| agent_core::RuntimeError::internal(format!("listing task failed: {e}")))?
        };
        ctx.check_cancelled()?;
        let mut entries = read_dir.map_err(|e| fs_error(&e, "scandir", &abs))?;

        let rel_path = ctx.workspace.rel(&abs);
        if entries.is_empty() {
            return Ok(ToolOutput::text(format!("(empty) {rel_path}")));
        }

        // Directories first, then by name. `Number(b.isDirectory()) - Number(a.isDirectory())` in JS.
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_compare(&a.1, &b.1)));

        let lines: Vec<String> = entries
            .iter()
            .map(|(is_dir, name)| format!("{}{name}", if *is_dir { "[dir] " } else { "      " }))
            .collect();

        let shown = lines.len().min(MAX_ENTRIES);
        let truncated = lines.len() > shown;
        let capped = if truncated {
            format!(
                "\n\n[…TRUNCATED — showing the first {shown} of {} entries; {} not listed. \
                 Use search_files with a glob to find specific names in here.]",
                lines.len(),
                lines.len() - shown
            )
        } else {
            String::new()
        };
        let header = if truncated {
            format!("{rel_path} ({} entries, showing {shown}):", lines.len())
        } else {
            format!("{rel_path}:")
        };

        Ok(ToolOutput::text(format!("{header}\n{}{capped}", lines[..shown].join("\n"))))
    }
}
