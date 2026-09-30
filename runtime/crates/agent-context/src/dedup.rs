//! Stale-read deduplication: stubbing a read the conversation already holds a newer copy of.
//!
//! The one compaction technique that loses nothing, and so the one safe to run before the others.

use crate::{ContextManager, STALE_READ_PREFIX};

/// Tools whose result is a snapshot of a file, and can therefore go stale.
const READ_TOOLS: [&str; 1] = ["read_file"];

/// Tools that change a file, making every earlier read of it stale.
///
/// `copy_file` and `move_file` are deliberately absent: their destination argument is `source`/`destination`
/// rather than `path`, and a rule that half-reads their arguments would stub the wrong file. Missing a
/// staleness is a wasted opportunity; stubbing a read that is still current is a lie to the model.
const WRITE_TOOLS: [&str; 4] = ["write_file", "edit_file", "append_file", "delete_file"];

/// Below this, a stub saves nothing worth the cache churn of rewriting the message.
const MIN_STUB_CHARS: usize = 400;

/// Compare paths the way a model writes them: `./src/a.rs`, `src/a.rs` and `src/a.rs/` are one file.
///
/// Deliberately lexical. Resolving against the workspace would be more accurate and would need the filesystem,
/// which this crate does not touch — and the cost of being wrong is asymmetric: a missed match wastes an
/// opportunity, a false match tells the model a still-current read has been superseded.
fn normalize_path(raw: &str) -> String {
    raw.trim().trim_start_matches("./").trim_end_matches('/').to_owned()
}

impl ContextManager {
    /// Replace reads that a later read or write has superseded. Returns how many were stubbed.
    ///
    /// ## Why this is not just "drop old tool output"
    ///
    /// Eliding does that, and it loses something: the model may still need what that call returned. This step
    /// only touches results the conversation *already contains a newer version of* — the same file read again,
    /// or written to. The model loses no information it could not read further down, which is what makes this
    /// the one technique safe to run before the others rather than after.
    ///
    /// Spans, not paths. `read_file` takes `offset`/`limit` and returns a 1-based inclusive line window, so an
    /// agent walking a large file emits reads like {460,+90}, {550,+90}, {640,+50} — DISJOINT windows, none of
    /// which supersedes another. Comparing paths alone would stub all but the last and tell the model its
    /// earlier pages had been superseded by a page that does not contain them.
    pub(crate) fn dedup_stale_reads(&mut self) -> usize {
        // A tool result carries only its `tool_call_id`; the name and arguments live on the assistant turn
        // that asked for it. This is the join between the two.
        let mut calls: std::collections::HashMap<&str, (&str, serde_json::Value)> =
            std::collections::HashMap::new();
        for item in &self.items {
            for call in &item.message.tool_calls {
                let args = serde_json::from_str(&call.arguments).unwrap_or(serde_json::Value::Null);
                calls.insert(call.id.as_str(), (call.name.as_str(), args));
            }
        }

        // What each tool result was: a read of a span, a write, or neither.
        enum Touch {
            Read { path: String, from: u64, to: u64 },
            Wrote { path: String },
        }
        let touches: Vec<Option<Touch>> = self
            .items
            .iter()
            .map(|item| {
                if item.message.role != "tool" {
                    return None;
                }
                let id = item.message.tool_call_id.as_deref()?;
                let (name, args) = calls.get(id)?;
                let path = normalize_path(args.get("path")?.as_str()?);
                if READ_TOOLS.contains(name) {
                    let from = args.get("offset").and_then(serde_json::Value::as_u64).unwrap_or(1).max(1);
                    // An absent or zero `limit` reads to the end of the file, which supersedes everything.
                    let to = match args.get("limit").and_then(serde_json::Value::as_u64) {
                        Some(n) if n > 0 => from.saturating_add(n - 1),
                        _ => u64::MAX,
                    };
                    Some(Touch::Read { path, from, to })
                } else if WRITE_TOOLS.contains(name) {
                    Some(Touch::Wrote { path })
                } else {
                    None
                }
            })
            .collect();

        let mut stale: Vec<usize> = Vec::new();
        for (i, touch) in touches.iter().enumerate() {
            let Some(Touch::Read { path, from, to }) = touch else { continue };
            if self.items[i].message.text().len() < MIN_STUB_CHARS {
                continue;
            }
            let superseded = touches[i + 1..].iter().flatten().any(|later| match later {
                // Any later write makes the file different from what this read saw.
                Touch::Wrote { path: p } => p == path,
                // A later read supersedes this one only if it COVERS it.
                Touch::Read { path: p, from: f, to: t } => p == path && f <= from && t >= to,
            });
            if superseded {
                stale.push(i);
            }
        }

        for &i in &stale {
            let path = match &touches[i] {
                Some(Touch::Read { path, .. }) => path.clone(),
                _ => continue,
            };
            self.items[i].message.content = serde_json::Value::String(format!(
                "{STALE_READ_PREFIX}{path} removed to make room; the current contents are shown by a later \
                 read or write in this conversation]"
            ));
            self.items[i].recount();
        }
        stale.len()
    }
}
