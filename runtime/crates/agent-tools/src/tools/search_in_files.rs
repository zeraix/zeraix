//! `search_in_files` — mirrors the handler in aiToolkit.mjs.
//!
//! ## The regex divergence, and why it falls back instead of failing
//!
//! With `regex: true` the JS handler compiles the model's pattern with `new RegExp`, which supports
//! backreferences and lookaround. Rust's `regex` crate deliberately does not — it guarantees linear
//! time, which is why it cannot. A pattern using those features is therefore *unsupported here but
//! valid there*.
//!
//! Failing would be a regression: a query that worked yesterday would start erroring. So an
//! uncompilable pattern returns `tool.unsupported_pattern`, which the host bridge treats as "fall back
//! to the JS handler for this call" — the same mechanism that covers any not-yet-ported tool. The model
//! sees no difference; only the timing does.
//!
//! ## Why the cap message refuses to state a total
//!
//! When the cap is hit, `total` is the cap, not the number of matches in the tree — the walk stops
//! there, so the real total is unknown and unknowable from this call. Printing a count would read as
//! complete.

use agent_core::{Result, RuntimeError};
use regex::Regex;
use serde_json::{json, Value};
use std::path::Path;

use crate::glob::glob_to_regex;
use crate::text::clip;
use crate::tool::{args, ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};
use crate::{MAX_LINE_LEN, MAX_MATCHES, MAX_READ_BYTES};

pub struct SearchInFiles;

/// How a line is tested for a match.
enum Matcher {
    Regex(Regex),
    Insensitive(String),
    Literal(String),
}

impl Matcher {
    fn is_match(&self, line: &str) -> bool {
        match self {
            Matcher::Regex(re) => re.is_match(line),
            Matcher::Insensitive(low) => line.to_lowercase().contains(low),
            Matcher::Literal(s) => line.contains(s),
        }
    }
}

#[async_trait::async_trait]
impl Tool for SearchInFiles {
    fn metadata(&self) -> ToolMetadata {
        ToolMetadata {
            name: "search_in_files",
            description: "Search file contents, returning matches with surrounding context lines.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text or regular expression to find." },
                    "pattern": { "type": "string", "description": "Optional glob limiting which file names are searched." },
                    "regex": { "type": "boolean", "description": "Treat query as a regular expression." },
                    "ignore_case": { "type": "boolean", "description": "Case-insensitive match." },
                    "context": { "type": "number", "description": "Context lines around each match, 0-5. Defaults to 2." }
                },
                "required": ["query"]
            }),
            capabilities: &["filesystem.read"],
            risk_level: RiskLevel::ReadOnly,
            execution_mode: ExecutionMode::InProcess,
            timeout_ms: Some(120_000),
        }
    }

    async fn execute(&self, ctx: &ToolContext, args_v: &Value) -> Result<ToolOutput> {
        let needle = args::opt_str(args_v, "query").unwrap_or_default();
        if needle.is_empty() {
            return Err(RuntimeError::invalid("tool.invalid_argument", "query must not be empty"));
        }
        let ignore_case = args::opt_bool(args_v, "ignore_case");
        let use_regex = args::opt_bool(args_v, "regex");

        // `Number.isFinite(context) ? clamp(0,5) : 2`
        let ctx_lines = args::opt_num(args_v, "context")
            .filter(|n| n.is_finite())
            .map(|n| n.floor().clamp(0.0, 5.0) as usize)
            .unwrap_or(2);

        let name_re = match args::opt_str(args_v, "pattern").filter(|s| !s.is_empty()) {
            Some(p) => Some(glob_to_regex(&p)?),
            None => None,
        };

        let matcher = if use_regex {
            let pat = if ignore_case { format!("(?i){needle}") } else { needle.clone() };
            match Regex::new(&pat) {
                Ok(re) => Matcher::Regex(re),
                Err(e) => {
                    // See the module header: this is a capability gap, not a user error, so it is
                    // reported as one the bridge can route around.
                    return Err(RuntimeError::new(
                        "tool.unsupported_pattern",
                        agent_core::ErrorClass::Invalid,
                        "This regular expression uses features the Rust engine does not support.",
                    )
                    .with_cause(e));
                }
            }
        } else if ignore_case {
            Matcher::Insensitive(needle.to_lowercase())
        } else {
            Matcher::Literal(needle.clone())
        };

        let files = {
            let cache = ctx.file_cache.clone();
            let root = ctx.root().to_path_buf();
            let cancel = ctx.cancel.clone();
            tokio::task::spawn_blocking(move || cache.get_or_walk(&root, &cancel))
                .await
                .map_err(|e| RuntimeError::internal(format!("walk task failed: {e}")))?
        };

        let mut blocks: Vec<String> = Vec::new();
        let mut total = 0usize;

        for f in files.iter() {
            if total >= MAX_MATCHES {
                break;
            }
            // Checked per file rather than per line: a cancelled search must not read the next file,
            // and one file's lines are a bounded amount of work.
            ctx.check_cancelled()?;

            if let Some(re) = &name_re {
                let matches_name = f
                    .file_name()
                    .map(|n| re.is_match(&n.to_string_lossy()))
                    .unwrap_or(false);
                if !matches_name {
                    continue;
                }
            }

            let Some(text) = read_searchable(f).await else { continue };
            // `split(/\r?\n/)` — CRLF and LF alike, and the \r is not left on the line.
            let lines: Vec<&str> = split_lines(&text);

            let mut hits: Vec<usize> = Vec::new();
            for (i, line) in lines.iter().enumerate() {
                if total + hits.len() >= MAX_MATCHES {
                    break;
                }
                if matcher.is_match(line) {
                    hits.push(i);
                }
            }
            if hits.is_empty() {
                continue;
            }

            // Merge matched lines into hunks by ±ctx; adjacent or overlapping hunks combine.
            let mut hunks: Vec<(usize, usize)> = Vec::new();
            for &h in &hits {
                let start = h.saturating_sub(ctx_lines);
                let end = (h + ctx_lines).min(lines.len().saturating_sub(1));
                match hunks.last_mut() {
                    Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
                    _ => hunks.push((start, end)),
                }
            }

            let parts: Vec<String> = hunks
                .iter()
                .map(|(s, e)| {
                    (*s..=*e)
                        .map(|i| {
                            let marker = if hits.contains(&i) { ':' } else { '-' };
                            format!("{}{marker} {}", i + 1, clip(lines[i], MAX_LINE_LEN))
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .collect();

            blocks.push(format!("{}:\n{}", ctx.workspace.rel(f), parts.join("\n--\n")));
            total += hits.len();
        }

        if blocks.is_empty() {
            let what = if use_regex { format!("/{needle}/") } else { format!("\"{needle}\"") };
            let ci = if ignore_case { " (case-insensitive)" } else { "" };
            return Ok(ToolOutput::text(format!("No matches for {what}{ci}.")));
        }

        let capped = if total >= MAX_MATCHES {
            format!(
                "\n\n[…TRUNCATED — stopped at the {MAX_MATCHES}-match cap. There are more matches than shown and the true \
                 total is unknown. Narrow the query or add a name pattern; do not treat these as every match.]"
            )
        } else {
            String::new()
        };

        Ok(ToolOutput::text(format!(
            "{total} match(es) with ±{ctx_lines} context lines \
             (working-directory-relative paths; \"N:\" = match line, \"N-\" = context):\n\n{}{capped}",
            blocks.join("\n\n")
        )))
    }
}

/// Read a file for searching, skipping anything oversized or unreadable — the JS `try/catch` plus its
/// `st.size > MAX_READ_BYTES` guard, which exists to skip binaries as much as large text.
async fn read_searchable(path: &Path) -> Option<String> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    if meta.len() > MAX_READ_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}
