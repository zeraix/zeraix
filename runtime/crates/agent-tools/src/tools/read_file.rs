//! `read_file` — mirrors the handler in aiToolkit.mjs.
//!
//! The trailing note ("showing lines A-B of N; read on with offset:X") is not decoration. The renderer's
//! stale-read dedup parses reads as line *spans* and only stubs an earlier read when a later one
//! provably covers it — the note is how a span becomes visible to the model in the first place, and the
//! `offset`/`limit` defaults here are mirrored in `contextCompress.ts` for the same computation. Change
//! the wording and you change what the model asks for next; change the defaults and dedup starts
//! stubbing live content.

use agent_core::{Result, RuntimeError};
use serde_json::{json, Value};

use crate::nodeerr::{fs_error, path_arg, stat_error};
use crate::text::{utf16_len, utf16_truncate};
use crate::tool::{args, ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};
use crate::{MAX_READ_BYTES, READ_DEFAULT_MAX_LINES, READ_MAX_CHARS};

pub struct ReadFile;

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "read_file",
            description: "Read the UTF-8 text content of a file.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path." },
                    "offset": { "type": "number", "description": "First line to read, 1-based. Defaults to 1 (start of file)." },
                    "limit": { "type": "number", "description": format!("How many lines to read from offset. Defaults to {READ_DEFAULT_MAX_LINES}.") }
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

        let meta = tokio::fs::metadata(&abs).await.map_err(|e| stat_error(&e, &abs))?;
        if meta.len() > MAX_READ_BYTES {
            return Err(RuntimeError::invalid(
                "tool.file_too_large",
                format!("file too large ({} bytes > {MAX_READ_BYTES})", meta.len()),
            ));
        }

        ctx.check_cancelled()?;
        let bytes = tokio::fs::read(&abs).await.map_err(|e| fs_error(&e, "open", &abs))?;
        // `fs.readFile(abs, "utf8")` in Node replaces invalid sequences rather than failing, so a
        // binary file comes back as mojibake instead of an error. Matching that keeps a model's
        // mistaken read of a `.png` behaving identically in both runtimes.
        let text = String::from_utf8_lossy(&bytes);

        // Split on "\n" only — not on \r\n. A CRLF file therefore keeps its \r at the end of each
        // line, exactly as the JS handler leaves it.
        let mut lines: Vec<&str> = text.split('\n').collect();
        // A trailing newline yields a final "" element; dropping it keeps the reported total honest.
        if lines.len() > 1 && lines[lines.len() - 1].is_empty() {
            lines.pop();
        }
        let total = lines.len();

        // `Math.max(1, Math.floor(Number(offset) || 1))`: NaN, 0 and absent all collapse to the
        // default, which is why this is `unwrap_or` on a filtered value rather than a plain parse.
        let start = clamp_arg(args::opt_num(args_v, "offset"), 1.0);
        let count = clamp_arg(args::opt_num(args_v, "limit"), READ_DEFAULT_MAX_LINES as f64);

        if start > total {
            return Ok(ToolOutput::text(format!(
                "[read_file] offset {start} is past the end of {p} — the file has {total} lines."
            )));
        }
        let end = total.min(start + count - 1);

        let mut body = lines[start - 1..end].join("\n");
        let mut char_trimmed = false;
        if utf16_len(&body) > READ_MAX_CHARS {
            body = utf16_truncate(&body, READ_MAX_CHARS).to_owned();
            char_trimmed = true;
        }

        if start == 1 && end == total && !char_trimmed {
            return Ok(ToolOutput::text(body));
        }

        let mut notes = vec![format!("showing lines {start}-{end} of {total}")];
        if char_trimmed {
            notes.push(format!("trimmed at {READ_MAX_CHARS} characters"));
        }
        if end < total {
            notes.push(format!("read on with offset:{}", end + 1));
        }
        Ok(ToolOutput::text(format!("{body}\n\n[read_file] {p}: {}.", notes.join("; "))))
    }
}

/// `Math.max(1, Math.floor(Number(v) || default))`.
///
/// The `|| default` in JS fires for `0` and `NaN` alike, so a caller passing `offset: 0` gets line 1
/// rather than an error — reproduced here rather than "fixed", because a model that has learned the
/// lenient behaviour would otherwise start seeing failures only on the new runtime.
fn clamp_arg(v: Option<f64>, default: f64) -> usize {
    let n = v.filter(|f| f.is_finite() && *f != 0.0).unwrap_or(default);
    let floored = n.floor();
    if floored < 1.0 { 1 } else { floored as usize }
}
