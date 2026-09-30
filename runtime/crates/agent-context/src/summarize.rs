//! Summarisation: folding the older part of a conversation into one message, by a model call.
//!
//! The only technique that keeps what a conversation MEANT rather than merely what fitted.

use agent_loop::Message;

use crate::estimate::truncate_to;
use crate::ContextManager;

/// User turns kept verbatim at the end. The tail is where the current task lives, and summarising it is how a
/// run forgets what it was just asked. Matches `KEEP_TAIL_TURNS` in the TypeScript path.
const KEEP_TAIL_TURNS: usize = 4;

/// Per-item ceiling when rendering a span for the summariser. A span can be enormous — that is why it is being
/// summarised — and handing the whole of it over would spend more tokens than the compaction saves.
const SUMMARY_SOURCE_TOKENS: u64 = 400;

/// Turns a span of conversation into a few sentences.
///
/// Held as a seam rather than a concrete client so this crate stays testable without a network, and so the
/// summary can be produced by a *different*, cheaper model than the one running the turn — which is usually
/// what you want, since summarising is the one call in a run that nobody reads.
#[derive(Clone)]
pub struct Summarizer {
    model: std::sync::Arc<dyn agent_loop::ModelClient>,
    /// The model id sent on the wire. Separate from the client because one client can serve several.
    pub model_id: String,
}

impl Summarizer {
    pub fn new(model: std::sync::Arc<dyn agent_loop::ModelClient>, model_id: impl Into<String>) -> Self {
        Self { model, model_id: model_id.into() }
    }
}

impl ContextManager {
    /// Where the verbatim tail begins: everything before it may be folded into the summary.
    ///
    /// Counted in USER turns rather than messages, because a turn is the unit a person thinks in and a
    /// message count would keep four tool results and call it four turns. Returns 0 — fold nothing — when the
    /// conversation is not yet that long, which is the conservative answer.
    fn summary_split(&self) -> usize {
        let mut seen = 0;
        let mut split = 0;
        for (i, item) in self.items.iter().enumerate().rev() {
            if item.message.role == "user" {
                seen += 1;
                if seen == KEEP_TAIL_TURNS {
                    split = i;
                    break;
                }
            }
        }
        // A `tool` message at the head of the kept tail would be an orphan: the assistant turn that called it
        // is inside the folded span, and a provider rejects a tool result with no matching `tool_calls`.
        // Extending the span forward takes the whole group rather than splitting it.
        while split < self.items.len() && self.items[split].message.role == "tool" {
            split += 1;
        }
        split
    }

    /// Fold everything before the kept tail into one summary. Returns how many messages were folded.
    ///
    /// Re-summarising a longer span later reads the ORIGINALS again, not the previous summary. That costs a
    /// few more tokens in the summariser's own request and buys the property that matters: the error cannot
    /// compound. A summary of a summary drifts further from the truth each time and nothing downstream can
    /// see that it has — which is why the TypeScript path needs `MAX_SUMMARY_REUSE` to bound it and this one
    /// does not.
    pub(crate) async fn summarize_head(&mut self) -> usize {
        let Some(summarizer) = self.summarizer.clone() else { return 0 };
        let split = self.summary_split();
        // Critical items are never folded, so a span of nothing but those is not worth a model call.
        let foldable: Vec<usize> =
            (0..split).filter(|&i| !self.items[i].tier.is_preserved()).collect();
        if foldable.is_empty() {
            return 0;
        }
        // Already folded exactly this far. Re-asking would spend a model call to produce the same summary.
        if foldable.iter().all(|&i| self.items[i].summarized) {
            return 0;
        }

        let source = self.render_span(&foldable);
        let request = agent_loop::ModelRequest {
            model: summarizer.model_id.clone(),
            messages: vec![
                Message::system(
                    "You are compacting an agent's conversation so it fits in a smaller context window. \
                     Write a factual summary of the exchange below, in prose, under 400 words. Preserve: what \
                     the user asked for, decisions taken and why, files and identifiers touched, what has been \
                     done, and what is still outstanding. Omit pleasantries and tool mechanics. Do not answer \
                     the conversation, address the user, or add anything that is not in it.",
                ),
                Message::user(source),
            ],
            tools: Vec::new(),
            reasoning_effort: None,
        };

        match summarizer.model.complete(&request).await {
            Ok(turn) if !turn.content.trim().is_empty() => {
                self.summary = Some(turn.content.trim().to_owned());
                for &i in &foldable {
                    self.items[i].summarized = true;
                }
                foldable.len()
            }
            // A summariser that fails must not fail the run. The caller falls through to compression, which
            // is worse but always available — and the warning says which happened, because "the context got
            // shorter" looks identical either way from outside.
            Ok(_) => {
                tracing::warn!("the summariser returned nothing; falling back to compression");
                0
            }
            Err(e) => {
                tracing::warn!(error = %e, "summarising failed; falling back to compression");
                0
            }
        }
    }

    /// The span, rendered for the summariser: one line per message, each bounded.
    fn render_span(&self, indices: &[usize]) -> String {
        let mut out = String::new();
        for &i in indices {
            let item = &self.items[i];
            let text = item.message.text();
            if text.is_empty() {
                continue;
            }
            out.push_str(&item.message.role);
            out.push_str(": ");
            out.push_str(&truncate_to(text, SUMMARY_SOURCE_TOKENS));
            out.push('\n');
        }
        out
    }
}
