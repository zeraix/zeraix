//! The Context Runtime — deciding what the model is allowed to see.
//!
//! TODO §8, and milestone M7. The workspace manifest said "still to come: context" from the first stage until
//! this one.
//!
//! ## The problem this exists for
//!
//! A conversation grows until it does not fit, and something has to go. Doing that badly has a characteristic
//! failure: the agent keeps talking, fluently, having forgotten what it was asked to do. §8.3 names the
//! requirement plainly — *the Agent must not lose its task state after compaction* — and the way to satisfy it
//! is structural rather than careful.
//!
//! ## Two ideas
//!
//! **Tiers ([`Tier`]).** Every item carries what it is worth losing, assigned by whoever created it rather than
//! inferred from its text. Compaction then has an order to work in instead of a heuristic to apply.
//!
//! **Task memory ([`TaskMemory`]) lives outside the conversation.** The goal, the plan, the phase, what is done
//! and what is left, the decisions and the constraints are a structured record beside the messages, re-rendered
//! into the wire on every request. Compaction operates on the conversation; the memory was never a candidate,
//! so "did the goal survive?" is not a question about which messages were dropped.
//!
//! ## The order of operations is the reverse of §8.3's list, on purpose
//!
//! §8.3 reads: preserve CRITICAL → preserve HIGH → compress NORMAL → remove EPHEMERAL. That is a statement of
//! **preservation priority**, and running it as a sequence of operations would be backwards — it would compress
//! the conversation before dropping the tool output that is far larger and worth far less.
//!
//! So [`compact`](ContextManager::compact) works from the cheapest loss upward and stops the moment it is under budget: drop EPHEMERAL,
//! then compress NORMAL, and never touch HIGH or CRITICAL. The priority is identical; only the traversal
//! differs, and it differs so that a turn that only needed to lose one tool result does not also lose the
//! shape of its conversation.
//!
//! ## Ephemeral removal is a stub, not a deletion
//!
//! A tool result cannot simply be dropped: providers reject a request whose `assistant.tool_calls` has no
//! matching `tool` message, so deleting one turns a compaction into a 400. The content is replaced by a marker
//! instead. That also tells the model something true and useful — the call happened, its output is gone, and
//! it can be run again — which a silent deletion does not.

mod dedup;
pub mod estimate;
pub mod memory;
mod summarize;
pub mod tier;

use agent_loop::Message;
use estimate::truncate_to;
use serde::{Deserialize, Serialize};

pub use estimate::{IMAGE_TOKENS, estimate, estimate_message};
pub use memory::TaskMemory;
pub use summarize::Summarizer;
pub use tier::Tier;

/// The loop's context seam, implemented by [`ContextManager`].
///
/// The loop hands over the conversation as it stands and receives the array to send, plus whether anything was
/// compacted to produce it. Rebuilding from the loop's array each round rather than holding the items across
/// rounds is deliberate: the loop is the one that knows what happened — which message is a tool result and
/// which is the model reasoning — and a manager that tried to track that separately would be a second, quieter
/// record of the same conversation.
#[async_trait::async_trait]
impl agent_loop::ContextStrategy for ContextManager {
    async fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool) {
        self.sync_from(messages);
        let report = self.compact().await;
        (self.wire(), report.ran)
    }
}

/// What replaces an elided tool result. Names the elision so the model can act on it.
const ELIDED: &str = "[tool output removed to make room; re-run the call if you still need it]";

/// Marker appended to a compressed item, for the same reason.
const TRUNCATED: &str = "\n[… trimmed to make room …]";

/// How the summary is introduced to the model. It has to read as *history*, not as instruction, or the model
/// answers the summary instead of the conversation.
const SUMMARY_PREFIX: &str = "Summary of the earlier part of this conversation:";

/// How a deduplicated read begins. Matched as well as written: eliding must recognise it as already-stubbed,
/// or it replaces a message that says WHICH file went stale and why with one that says only "removed".
const STALE_READ_PREFIX: &str = "[earlier read of ";

/// One piece of context, with what it is worth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextItem {
    pub message: Message,
    pub tier: Tier,
    /// Estimated tokens. Recomputed whenever the item changes, so a compaction cannot leave a stale figure
    /// behind and then decide it is still over budget.
    pub tokens: u64,
    /// Folded into the summary, and therefore not sent.
    ///
    /// The message itself is KEPT, verbatim. Only the wire view loses it — which is what lets a later, larger
    /// compaction re-summarise from the originals instead of summarising a summary. A summary of a summary
    /// drifts a little further from the truth every time, and nothing downstream can tell that it has.
    #[serde(default)]
    pub summarized: bool,
    /// A fingerprint of the message as the LOOP handed it over, before this manager changed anything.
    ///
    /// How `sync_from` tells its own compaction of a message from the loop's amendment of it. The loop used to
    /// only ever append, so matching by position and role was enough; it now amends the latest tool result —
    /// a host's nudge rides it into the next request — and a manager that kept its held copy sent the model
    /// the result without the nudge the host had just delivered.
    #[serde(default)]
    pub source: u64,
}

impl ContextItem {
    pub fn new(message: Message, tier: Tier) -> Self {
        let tokens = estimate_message(&message);
        let source = fingerprint(&message);
        Self { message, tier, tokens, summarized: false, source }
    }

    fn recount(&mut self) {
        self.tokens = estimate_message(&self.message);
    }
}

/// How much room there is, and when to start making some.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Budget {
    /// The model's context window, in tokens.
    pub max_tokens: u64,
    /// Fraction of the window at which compaction begins.
    ///
    /// Below 1.0 on purpose: compacting exactly at the limit leaves no room for the reply, and a request that
    /// fits by one token still fails when the model answers.
    pub compact_at: f64,
    /// Fraction to come down to once compaction runs.
    ///
    /// Meaningfully below `compact_at` so that one compaction buys several rounds. Coming down to just under
    /// the threshold means compacting again next round, and again the round after — the behaviour that makes
    /// a long task feel like it is thrashing.
    pub target: f64,
}

impl Default for Budget {
    fn default() -> Self {
        Self { max_tokens: 128_000, compact_at: 0.85, target: 0.6 }
    }
}

impl Budget {
    pub fn with_window(max_tokens: u64) -> Self {
        Self { max_tokens, ..Self::default() }
    }

    /// A window with a working-set budget below it: compact above `trigger`, down to `target` — the numbers the
    /// host's context-budget setting resolves to, so a turn is held to the same size mid-turn as between turns.
    ///
    /// The window stays `max_tokens`, because "still over budget" and the stop policy's context limit are about
    /// what the MODEL can take, not about the cap. Values the host should never send are made safe rather than
    /// trusted: a trigger above the window is the window's own threshold, and a target at or above the trigger —
    /// which would compact again every round — comes down to the same proportion `Default` keeps between them.
    pub fn with_thresholds(max_tokens: u64, trigger: u64, target: u64) -> Self {
        let window = Self::with_window(max_tokens);
        if max_tokens == 0 || trigger == 0 {
            return window;
        }
        let trigger = trigger.min(window.compact_threshold());
        let target = if target > 0 && target < trigger {
            target
        } else {
            (trigger as f64 * window.target / window.compact_at).round() as u64
        };
        Self {
            max_tokens,
            compact_at: trigger as f64 / max_tokens as f64,
            target: target as f64 / max_tokens as f64,
        }
    }

    // Rounded rather than truncated: a threshold that went in as a token count (see `with_thresholds`) comes back
    // as the same count, not one less for the floating-point round trip.
    pub fn compact_threshold(&self) -> u64 {
        (self.max_tokens as f64 * self.compact_at).round() as u64
    }

    pub fn target_tokens(&self) -> u64 {
        (self.max_tokens as f64 * self.target).round() as u64
    }
}

/// What one compaction did. Returned rather than logged, so a caller can report it and a test can assert it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CompactionReport {
    pub ran: bool,
    pub tokens_before: u64,
    pub tokens_after: u64,
    /// Ephemeral items whose content was replaced by a marker.
    pub elided: usize,
    /// Normal items shortened in place.
    pub compressed: usize,
    /// Messages folded into a summary. Zero when no summariser is configured, which is the default.
    pub summarized: usize,
    /// Reads stubbed because a later read or write supersedes them.
    pub deduped: usize,
    /// True when everything removable was removed and it was still not enough.
    ///
    /// Not a failure — the run continues — but the caller should know, because the next thing to give is the
    /// conversation itself and that is a decision this crate will not make silently.
    pub still_over_budget: bool,
}

/// The conversation, plus the state that outlives it.
#[derive(Clone, Default)]
pub struct ContextManager {
    budget: Budget,
    items: Vec<ContextItem>,
    memory: TaskMemory,
    /// How to summarise, when there is something worth summarising. `None` keeps the pre-2026-09-22 behaviour
    /// exactly: elide, then truncate.
    summarizer: Option<Summarizer>,
    /// The summary standing in for every item flagged `summarized`.
    summary: Option<String>,
}

// Hand-written because a model client is not `Debug`. Whether a summariser is configured is reported, since
// "why did this only truncate?" has exactly that answer.
impl std::fmt::Debug for ContextManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContextManager")
            .field("budget", &self.budget)
            .field("items", &self.items.len())
            .field("memory", &self.memory)
            .field("summarizer", &self.summarizer.as_ref().map(|s| s.model_id.as_str()))
            .field("summary", &self.summary.is_some())
            .finish()
    }
}

impl ContextManager {
    pub fn new(budget: Budget) -> Self {
        Self { budget, items: Vec::new(), memory: TaskMemory::new(), summarizer: None, summary: None }
    }

    /// Summarise, rather than truncate, once eliding is not enough.
    pub fn with_summarizer(mut self, summarizer: Summarizer) -> Self {
        self.summarizer = Some(summarizer);
        self
    }

    /// The summary currently standing in for the folded span, if any.
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    pub fn memory(&self) -> &TaskMemory {
        &self.memory
    }

    pub fn memory_mut(&mut self) -> &mut TaskMemory {
        &mut self.memory
    }

    pub fn items(&self) -> &[ContextItem] {
        &self.items
    }

    /// Add a message at a tier.
    pub fn push(&mut self, message: Message, tier: Tier) {
        self.items.push(ContextItem::new(message, tier));
    }

    /// Take on the messages the loop has, keeping what this manager already knows about the ones it has seen.
    ///
    /// New messages are tiered by role, which is the one place a tier IS derivable without guessing: a `tool`
    /// message is tool output and nothing else, and a `system` message is instruction. Messages already held
    /// keep their tier and — importantly — their compacted content, so a round that compacted does not have
    /// its work undone by the next round handing back the original text.
    pub fn sync_from(&mut self, messages: &[Message]) {
        // Everything the loop still has, in its order. Anything this manager compacted keeps its stub, matched
        // by position: the loop only ever appends, so position is a stable identity within a run.
        let mut next: Vec<ContextItem> = Vec::with_capacity(messages.len());
        for (i, message) in messages.iter().enumerate() {
            match self.items.get(i) {
                // Already known and unchanged by the loop: keep this manager's version, which may be a stub.
                Some(existing) if same_origin(&existing.message, message) && existing.source == fingerprint(message) => {
                    next.push(existing.clone())
                }
                // New, or amended by the loop since it was taken in: the loop's version wins. Compaction may
                // shorten it again next time; what it must never do is send the model an older copy.
                _ => next.push(ContextItem::new(message.clone(), tier_for(message))),
            }
        }
        self.items = next;
    }

    /// Total tokens the wire would carry, task memory included.
    pub fn tokens(&self) -> u64 {
        let memory = if self.memory.is_empty() { 0 } else { estimate(&self.memory.render()) + 4 };
        // The summary is what a folded span actually costs; the originals are held for re-summarising and
        // cost nothing on the wire.
        let summary = self.summary.as_ref().map_or(0, |t| estimate(t) + estimate(SUMMARY_PREFIX) + 4);
        memory + summary + self.items.iter().filter(|i| !i.summarized).map(|i| i.tokens).sum::<u64>()
    }

    pub fn needs_compaction(&self) -> bool {
        self.tokens() > self.budget.compact_threshold()
    }

    /// Bring the conversation under budget, if it is over.
    ///
    /// See the module header for why the traversal runs from the cheapest loss upward rather than in §8.3's
    /// listed order.
    pub async fn compact(&mut self) -> CompactionReport {
        let before = self.tokens();
        let mut report = CompactionReport { tokens_before: before, tokens_after: before, ..Default::default() };
        if before <= self.budget.compact_threshold() {
            return report;
        }
        report.ran = true;
        let target = self.budget.target_tokens();

        // 0. Stale reads, before anything else. It is the only step here that costs nothing and loses
        //    nothing: the file's current contents are already in the conversation, in a later read or a
        //    later write, so the earlier snapshot is redundant rather than merely cheap. Running it first
        //    means the steps that DO lose something have less to do, and may stop before reaching a tool
        //    result the model still needs.
        report.deduped = self.dedup_stale_reads();
        let mut running = if report.deduped > 0 { self.tokens() } else { before };
        if running <= target {
            report.tokens_after = running;
            return report;
        }
        // Tracked as a running total rather than recomputed per item: `tokens()` walks every item, so calling
        // it inside the loop would make one compaction quadratic in the length of the conversation — which is
        // exactly the conversation that triggers compaction in the first place.

        // 1. Ephemeral first: the largest items with the least worth. Oldest first, because the most recent
        //    tool output is the one the current round is reasoning about.
        for item in self.items.iter_mut() {
            if running <= target {
                break;
            }
            // Already a stub, by either technique. Re-stubbing saves nothing and would overwrite dedup's
            // wording — which names the file and says a newer copy is further down — with this one's, which
            // does not.
            if !item.tier.is_removable() || is_stub(item.message.text()) {
                continue;
            }
            // A stub, not a deletion — see the module header.
            let was = item.tokens;
            item.message.content = serde_json::Value::String(ELIDED.to_owned());
            item.recount();
            running = running.saturating_sub(was.saturating_sub(item.tokens));
            report.elided += 1;
        }

        // 2. Summarise the head, if eliding was not enough and a summariser was configured.
        //
        //    Placed between the two blunt techniques on purpose. Eliding tool output is cheaper — it costs no
        //    model call and loses something the model can re-fetch. Truncation is worse: it keeps the first N
        //    characters of a message and throws away whatever the point was. Summarising sits where it does
        //    because it is the only step that preserves MEANING, so it should run before the step that does
        //    not, and after the step that costs nothing.
        if running > target && self.summarizer.is_some() {
            report.summarized = self.summarize_head().await;
            if report.summarized > 0 {
                running = self.tokens();
            }
        }

        // 3. Then compress what is left, if that was still not enough.
        if running > target {
            let allowance = compression_allowance(&self.items, target, running);
            for item in self.items.iter_mut() {
                if !item.tier.is_compressible() {
                    continue;
                }
                let Some(text) = item.message.content.as_str() else { continue };
                if estimate(text) <= allowance {
                    continue;
                }
                let was = item.tokens;
                item.message.content = serde_json::Value::String(truncate_to(text, allowance));
                item.recount();
                running = running.saturating_sub(was.saturating_sub(item.tokens));
                report.compressed += 1;
            }
        }

        report.tokens_after = self.tokens();
        report.still_over_budget = report.tokens_after > self.budget.max_tokens;
        if report.still_over_budget {
            tracing::warn!(
                tokens = report.tokens_after,
                max = self.budget.max_tokens,
                "context is still over budget after compaction; everything removable has been removed"
            );
        }
        report
    }

    /// The array to send.
    ///
    /// Task memory is rendered as a system message at the FRONT, ahead of the conversation. Position matters
    /// for two reasons: a model attends most reliably to the beginning of its context, and a prefix that is
    /// stable across rounds is what a provider's cache can reuse.
    pub fn wire(&self) -> Vec<Message> {
        let mut out = Vec::with_capacity(self.items.len() + 2);
        if !self.memory.is_empty() {
            out.push(Message::system(self.memory.render()));
        }
        // The summary stands exactly where the span it replaces stood, so the conversation still reads in
        // order. `system` rather than `user`: it is context about the conversation, not a turn in it, and a
        // model handed it as a user turn tends to answer the summary instead of the question.
        let mut emitted = false;
        for item in &self.items {
            if item.summarized {
                if !emitted {
                    if let Some(text) = &self.summary {
                        out.push(Message::system(format!("{SUMMARY_PREFIX}\n\n{text}")));
                        emitted = true;
                    }
                }
                continue;
            }
            out.push(item.message.clone());
        }
        out
    }

}

/// Has this message already been replaced by a marker, by any technique?
fn is_stub(text: &str) -> bool {
    text == ELIDED || text.starts_with(STALE_READ_PREFIX)
}

/// The tier a message gets when this manager first sees it.
///
/// Role is the only signal used, and it is used because it is a fact rather than an inference: a `tool` message
/// IS tool output. Anything a caller knows better — that a particular assistant turn recorded a decision — it
/// can set with [`ContextManager::push`], which is the path that exists precisely so tiers are assigned by
/// whoever knows, not by whoever guesses.
fn tier_for(message: &Message) -> Tier {
    match message.role.as_str() {
        "tool" => Tier::Ephemeral,
        "system" => Tier::Critical,
        _ => Tier::Normal,
    }
}

/// The content a message arrived with, reduced to a number `sync_from` can compare cheaply.
fn fingerprint(message: &Message) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    message.content.to_string().hash(&mut h);
    h.finish()
}

/// Is this the same message this manager already holds, allowing for its own compaction of it?
///
/// Compared by role and pairing rather than by content, because content is exactly what compaction changes.
fn same_origin(held: &Message, incoming: &Message) -> bool {
    held.role == incoming.role && held.tool_call_id == incoming.tool_call_id
}

/// How many tokens each compressible item may keep.
///
/// Spread evenly rather than trimming the longest: an even allowance keeps the *shape* of the conversation,
/// and it is the shape that lets a reply stay coherent once the detail has gone. Never returns zero — an item
/// compressed to nothing is a deletion wearing a different name, and would break the same tool pairing the
/// ephemeral stub exists to protect.
fn compression_allowance(items: &[ContextItem], target: u64, current: u64) -> u64 {
    let compressible: Vec<&ContextItem> = items.iter().filter(|i| i.tier.is_compressible()).collect();
    if compressible.is_empty() {
        return u64::MAX;
    }
    let compressible_total: u64 = compressible.iter().map(|i| i.tokens).sum();
    let overshoot = current.saturating_sub(target);
    let keep = compressible_total.saturating_sub(overshoot);
    (keep / compressible.len() as u64).max(32)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
