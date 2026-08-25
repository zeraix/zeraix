//! `search_files` — mirrors the handler in aiToolkit.mjs.
//!
//! The truncation notice is worded the way it is deliberately. "… and N more" reads as a footnote, and
//! a model skimming it acts on the first page as though it were the whole set; naming the cap and the
//! way past it turns a partial list into a next step instead of a wrong conclusion.

use agent_core::Result;
use serde_json::{json, Value};

use crate::glob::glob_to_regex;
use crate::nodeerr::coerce_string;
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};
use crate::MAX_MATCHES;

pub struct SearchFiles;

#[async_trait::async_trait]
impl Tool for SearchFiles {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "search_files",
            description: "Find files whose name matches a glob.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob matched against the file name, e.g. *.ts" }
                },
                "required": ["pattern"]
            }),
            capabilities: &["filesystem.read"],
            risk_level: RiskLevel::ReadOnly,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(60_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        // `String(pattern)`, not a validated string — see coerce_string's note.
        let pattern = coerce_string(args_v.get("pattern"));
        let re = glob_to_regex(&pattern)?;

        let files = {
            let cache = ctx.file_cache.clone();
            let root = ctx.root().to_path_buf();
            let cancel = ctx.cancel.clone();
            // The walk is blocking filesystem work; keeping it off the async worker is what stops one
            // large tree from stalling every other task on the runtime (spec §24: no blocking IO on a
            // Tokio worker).
            tokio::task::spawn_blocking(move || cache.get_or_walk(&root, &cancel))
                .await
                .map_err(|e| agent_core::RuntimeError::internal(format!("walk task failed: {e}")))?
        };
        ctx.check_cancelled()?;

        let hits: Vec<String> = files
            .iter()
            .filter(|f| {
                f.file_name()
                    .map(|n| re.is_match(&n.to_string_lossy()))
                    .unwrap_or(false)
            })
            .map(|f| ctx.workspace.rel(f))
            .collect();

        if hits.is_empty() {
            return Ok(ToolOutput::text(format!("No files match \"{pattern}\".")));
        }

        let shown = hits.len().min(MAX_MATCHES);
        let truncated = hits.len() > shown;
        let more = if truncated {
            format!(
                "\n\n[…TRUNCATED — showing the first {shown} of {} matches; {} not listed. \
                 This list is incomplete: narrow the glob to see the rest, and do not act on it as if it were every match.]",
                hits.len(),
                hits.len() - shown
            )
        } else {
            String::new()
        };
        let count_note = if truncated { format!(", showing {shown}") } else { String::new() };

        Ok(ToolOutput::text(format!(
            "{} match(es){count_note}:\n{}{more}",
            hits.len(),
            hits[..shown].join("\n")
        )))
    }
}
