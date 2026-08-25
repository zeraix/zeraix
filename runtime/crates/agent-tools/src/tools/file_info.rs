//! `file_info` — mirrors the handler in aiToolkit.mjs.
//!
//! Output is `JSON.stringify(info, null, 2)`: two-space indent, and the field order below is the
//! insertion order of the JS object literal. `serde` preserves struct field order, so the struct
//! definition *is* the format — do not reorder the fields.

use agent_core::{Result, RuntimeError};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::SystemTime;

use crate::nodeerr::{path_arg, stat_error};
use crate::tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

pub struct FileInfo;

#[derive(Serialize)]
struct Info {
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
    modified: String,
    created: String,
}

#[async_trait::async_trait]
impl Tool for FileInfo {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "file_info",
            description: "Report a path's type, size and timestamps.",
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "File or directory path." } },
                "required": ["path"]
            }),
            capabilities: &["filesystem.read"],
            risk_level: RiskLevel::ReadOnly,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(10_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let p = path_arg(args_v, "path")?;
        let abs = ctx.workspace.resolve(&p)?;
        let st = tokio::fs::metadata(&abs).await.map_err(|e| stat_error(&e, &abs))?;

        let info = Info {
            path: ctx.workspace.rel(&abs),
            kind: if st.is_dir() {
                "directory"
            } else if st.is_file() {
                "file"
            } else {
                "other"
            },
            size: st.len(),
            modified: iso(st.modified().ok()),
            // Node reports the Unix epoch for `birthtime` on filesystems that do not record one;
            // `created()` returns an error in the same situation, so both degrade to the same string.
            created: iso(st.created().ok()),
        };

        Ok(ToolOutput::text(
            serde_json::to_string_pretty(&info).map_err(|e| RuntimeError::internal(e.to_string()))?,
        ))
    }
}

/// `Date.prototype.toISOString()` on a Node `Stats` timestamp: UTC, three fractional digits, `Z`.
///
/// The millisecond value is **rounded, not truncated**, and it is computed through an `f64` first —
/// both of which matter, and neither of which is obvious.
///
/// Node derives `mtimeMs` as `sec * 1000 + nsec / 1e6` in double precision and rounds that to the
/// nearest millisecond. Formatting the nanosecond field directly (chrono's `%.3f`) truncates instead,
/// so a file at `…533.9ms` came back as `.533` here and `.534` from Node — a one-millisecond
/// disagreement on roughly every second file, found by the A/B harness rather than by reading the code.
///
/// Reproducing the `f64` step is not pedantry either: at present-day epoch values a double cannot hold
/// sub-microsecond precision, so Node sees `533.499999` as exactly `533.5` and rounds it *up*. Doing
/// the arithmetic in integers would round that case down and disagree on it alone.
fn iso(t: Option<SystemTime>) -> String {
    let t = t.unwrap_or(SystemTime::UNIX_EPOCH);
    let ms_f = match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as f64) * 1000.0 + f64::from(d.subsec_nanos()) / 1e6,
        // Pre-epoch: same magnitude, negated, so the rounding stays symmetric.
        Err(e) => {
            let d = e.duration();
            -((d.as_secs() as f64) * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
        }
    };
    // `f64::round` is half-away-from-zero, which is what Node does for these values.
    let dt: DateTime<Utc> =
        DateTime::from_timestamp_millis(ms_f.round() as i64).unwrap_or(DateTime::UNIX_EPOCH);
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
