//! Summarisation: folding the older part of a conversation into one message, by a model call.
//!
//! The only technique that keeps what a conversation MEANT rather than merely what fitted — provided the
//! summariser is shown what happened and asked for what matters. It used to be shown neither: every message
//! reached it cut to its first 400 tokens, tool results reached it as the stubs eliding had just left behind,
//! a turn with an image reached it as nothing, and it was asked for "under 400 words". The brief is now the
//! TypeScript summariser's, and the source is the span as it was, cut only as far as the request must be.

use std::borrow::Cow;

use agent_loop::Message;
use serde_json::Value;

use crate::estimate::{estimate, truncate_to};
use crate::{ContextItem, ContextManager};

/// User turns kept verbatim at the end. The tail is where the current task lives, and summarising it is how a
/// run forgets what it was just asked. Matches `KEEP_TAIL_TURNS` in the TypeScript path.
const KEEP_TAIL_TURNS: usize = 4;

/// What the summariser is asked to keep: `summarize.ts`'s brief, so a conversation is summarised to the same
/// standard whichever side compacts it. Its task-state capture is left out — that is the host's task memory,
/// which this summary never stands in for. The last sentence is this side's own: the summary is sent as a
/// system message, and a summariser that answered the conversation would put a reply where history belongs.
const BRIEF: &str = concat!(
    "You are a conversation summarizer. Compress the following earlier AI-assistant conversation into a concise ",
    "but information-complete summary, so the subsequent conversation can seamlessly continue the context. ",
    "Be sure to preserve completely (better a bit long than to lose anything): ",
    "① the goal and key requirements of each user question; ",
    "② the conclusion / solution for each question — what was ultimately done and how it turned out; ",
    "③ the reasons and basis for reaching that conclusion and choosing that approach — why it was done this way, ",
    "which alternatives were ruled out, and based on which findings; ",
    "④ key analysis findings and important data — do not just write \"read/checked some file\", write the ",
    "concrete conclusions / key content / values derived from it; ",
    "⑤ the files / paths / commands involved; ⑥ what is done and what is still pending; ⑦ any pitfalls and caveats. ",
    "Do not fabricate information that did not appear; do not restate irrelevant intermediate steps sentence by ",
    "sentence. Do not answer the conversation or address the user.",
);

/// A tool call's arguments, as the transcript shows them: enough for the name and the target; an edit's full
/// payload is in the file by now. Matches `summarize.ts`.
const CALL_ARGUMENT_CHARS: usize = 300;

/// A tool result's head and tail in a verbatim transcript — `capToolOutput`'s split, so this summariser sees
/// what the chat path's sees.
const RESULT_HEAD_CHARS: usize = 5_000;
const RESULT_TAIL_CHARS: usize = 2_000;

/// The same when the verbatim transcript does not fit: enough to say what a result was about. Tool output is
/// most of any span's size and the least of its meaning, so it gives first.
const BRIEF_RESULT_HEAD_CHARS: usize = 800;
const BRIEF_RESULT_TAIL_CHARS: usize = 200;

/// Below this a summary is too short to be worth asking for: see `summarize_head`.
const MIN_SUMMARY_TOKENS: u64 = 200;

/// What each transcript line costs beyond its cut text — its label, the cut marker, the line break — so an even
/// per-line cap still adds up to the ceiling.
const LINE_OVERHEAD_TOKENS: u64 = 16;

/// The most the summariser is sent, in tokens, however large the window.
///
/// The request is on the turn's critical path, and its cost is paid again each time a longer span is
/// re-summarised from the originals. Past this, a summary of a few thousand words is dropping detail anyway.
const MAX_SOURCE_TOKENS: u64 = 100_000;

/// How much of each message the transcript keeps. Tried in order until the transcript fits.
#[derive(Clone, Copy)]
enum Fit {
    /// Every message whole; tool results to `capToolOutput`'s size.
    Verbatim,
    /// Tool results cut to a glimpse; everything else whole.
    BriefResults,
    /// Every line cut evenly to this many tokens: the shape of the span survives when nothing else can.
    Even(u64),
}

/// Turns a span of conversation into a summary.
///
/// Held as a seam rather than a concrete client so this crate stays testable without a network, and so the
/// summary can be produced by a *different*, cheaper model than the one running the turn.
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
    /// Never past `limit`, the start of the turn in progress: that turn is the model's working memory, and the
    /// working-set budget that brings a summary about has no claim on it (see the crate header).
    ///
    /// Re-summarising a longer span later reads the ORIGINALS again, not the previous summary. That costs a
    /// few more tokens in the summariser's own request and buys the property that matters: the error cannot
    /// compound. A summary of a summary drifts further from the truth each time and nothing downstream can
    /// see that it has — which is why the TypeScript path needs `MAX_SUMMARY_REUSE` to bound it and this one
    /// does not.
    pub(crate) async fn summarize_head(&mut self, limit: usize) -> usize {
        let Some(summarizer) = self.summarizer.clone() else { return 0 };
        // `limit` is a user message (or 0), so stopping there cannot orphan a tool result the way
        // `summary_split` guards against.
        let split = self.summary_split().min(limit);
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
        // Already declined for exactly this span. Within a run the span cannot grow past the turn in progress, so
        // every later round over budget would otherwise pay for the same refusal again — up to MAX_SOURCE_TOKENS
        // of input each time. A longer span, in a later run, is asked about afresh.
        if self.summary_declined == Some(split) {
            return 0;
        }

        // What the span costs on the wire now. A summary has to come in under it to be worth sending, so it is asked
        // for at most half of that — and not asked for at all when even that is too short to say anything: the
        // request reads the span's ORIGINALS, which can be large where the wire now carries only stubs, to save a
        // few hundred tokens at best.
        let replaced: u64 = foldable
            .iter()
            .filter(|&&i| !self.items[i].summarized)
            .map(|&i| self.items[i].tokens)
            .sum::<u64>()
            + self.summary.as_deref().map_or(0, estimate);
        let aim = self.summary_aim().min(replaced / 2);
        if aim < MIN_SUMMARY_TOKENS {
            return 0;
        }

        let source = self.fitted_source(&foldable);
        let request = agent_loop::ModelRequest {
            model: summarizer.model_id.clone(),
            messages: vec![Message::system(brief(aim)), Message::user(source)],
            tools: Vec::new(),
            reasoning_effort: None,
        };

        match summarizer.model.complete(&request).await {
            Ok(turn) if !turn.content.trim().is_empty() => {
                let summary = turn.content.trim();
                // A summariser that ignored the length it was given can produce something larger than what it
                // replaces: a compaction that grew the context. Treated as a failure, for the same fallback.
                if estimate(summary) >= replaced {
                    tracing::warn!(
                        summary = estimate(summary),
                        replaced,
                        "the summary is no smaller than the span it replaces; falling back to compression"
                    );
                    self.summary_declined = Some(split);
                    return 0;
                }
                self.summary = Some(summary.to_owned());
                self.summary_declined = None;
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
                self.summary_declined = Some(split);
                0
            }
            Err(e) => {
                tracing::warn!(error = %e, "summarising failed; falling back to compression");
                self.summary_declined = Some(split);
                0
            }
        }
    }

    /// The length to aim a summary at, in tokens: a tenth of what settled history is brought down to, between 500
    /// and 4,000. Room for what the brief lists, without the summary becoming the next thing a compaction has to
    /// make room for.
    fn summary_aim(&self) -> u64 {
        (self.settled_target() / 10).clamp(500, 4_000)
    }

    /// The span as a transcript, as close to verbatim as the request allows.
    ///
    /// The summariser is the session's own model unless the host named another, so its request has to fit the
    /// same window; the window's target leaves room for the brief and the reply. Each step down gives up the
    /// least meaning for the most room: tool output first, then every line evenly.
    fn fitted_source(&self, indices: &[usize]) -> String {
        let ceiling = self.budget.target_tokens().min(MAX_SOURCE_TOKENS);
        let verbatim = self.render_span(indices, Fit::Verbatim);
        if estimate(&verbatim) <= ceiling {
            return verbatim;
        }
        let brief = self.render_span(indices, Fit::BriefResults);
        if estimate(&brief) <= ceiling {
            return brief;
        }
        // Counted as rendered — an assistant turn is a line for its text and one per call — and net of what a line
        // costs beyond its cut text, so the lines add up to the ceiling. The floor can still overrun it for a span
        // of thousands of lines; past that point no transcript of it fits.
        let lines = indices.iter().map(|&i| rendered_lines(&self.items[i])).sum::<u64>().max(1);
        self.render_span(indices, Fit::Even((ceiling / lines).saturating_sub(LINE_OVERHEAD_TOKENS).max(32)))
    }

    /// The span, rendered for the summariser in `summarize.ts`'s labels.
    fn render_span(&self, indices: &[usize], fit: Fit) -> String {
        let mut out = String::new();
        for &i in indices {
            render_item(&self.items[i], fit, &mut out);
        }
        out
    }
}

/// The brief, with the length to aim for given in words.
fn brief(aim_tokens: u64) -> String {
    format!("{BRIEF} Aim for at most about {} words.", aim_tokens * 3 / 4)
}

/// How many lines `render_item` writes for an item, at most: an assistant turn's text and each of its calls.
fn rendered_lines(item: &ContextItem) -> u64 {
    if item.message.role == "assistant" { 1 + item.message.tool_calls.len() as u64 } else { 1 }
}

/// One message as transcript lines.
///
/// From the item's ORIGINAL content when this manager replaced it: a summary of a stub says only that something
/// was removed, which is exactly what summarising exists to avoid.
fn render_item(item: &ContextItem, fit: Fit, out: &mut String) {
    let message = &item.message;
    let text = content_text(item.original.as_ref().unwrap_or(&message.content));
    match message.role.as_str() {
        "assistant" => {
            if !text.is_empty() {
                push_line(out, "[Assistant]", &text, fit);
            }
            for call in &message.tool_calls {
                let args: String = call.arguments.chars().take(CALL_ARGUMENT_CHARS).collect();
                push_line(out, "[Assistant · tool call]", &format!("{}({args})", call.name), fit);
            }
        }
        "tool" => {
            let result = match fit {
                Fit::Verbatim => head_and_tail(&text, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS),
                Fit::BriefResults | Fit::Even(_) => head_and_tail(&text, BRIEF_RESULT_HEAD_CHARS, BRIEF_RESULT_TAIL_CHARS),
            };
            push_line(out, "[Tool result]", &result, fit);
        }
        "user" if !text.is_empty() => push_line(out, "[User]", &text, fit),
        role if !text.is_empty() => push_line(out, &format!("[{role}]"), &text, fit),
        _ => {}
    }
}

fn push_line(out: &mut String, label: &str, text: &str, fit: Fit) {
    let text = match fit {
        Fit::Even(tokens) => Cow::Owned(truncate_to(text, tokens)),
        Fit::Verbatim | Fit::BriefResults => Cow::Borrowed(text),
    };
    out.push_str(label);
    out.push(' ');
    out.push_str(&text);
    out.push('\n');
}

/// A message's content as text: the string, or a parts array's text with each image marked.
///
/// `Message::text` is empty for a parts array, so a turn with an image used to reach the summariser as nothing —
/// the user's question with it. `summarize.ts` fixed the same loss on its side.
fn content_text(content: &Value) -> Cow<'_, str> {
    match content {
        Value::String(s) => Cow::Borrowed(s.as_str()),
        Value::Array(parts) => Cow::Owned(
            parts
                .iter()
                .filter_map(|p| match p.get("type").and_then(Value::as_str) {
                    Some("text") => p.get("text").and_then(Value::as_str).map(str::to_owned),
                    Some("image_url" | "input_image" | "image") => Some("[image]".to_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => Cow::Borrowed(""),
    }
}

/// The first `head` and last `tail` characters of `text`, the cut marked — or `text` itself when it is short
/// enough. Counted in characters, so a cut never lands inside one.
fn head_and_tail(text: &str, head: usize, tail: usize) -> Cow<'_, str> {
    let total = text.chars().count();
    if total <= head + tail {
        return Cow::Borrowed(text);
    }
    let head_end = text.char_indices().nth(head).map_or(text.len(), |(at, _)| at);
    let tail_start = text.char_indices().nth(total - tail).map_or(text.len(), |(at, _)| at);
    Cow::Owned(format!(
        "{}\n[… {} characters elided …]\n{}",
        &text[..head_end],
        total - head - tail,
        &text[tail_start..]
    ))
}
