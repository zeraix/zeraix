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
//! So [`compact`] works from the cheapest loss upward and stops the moment it is under budget: drop EPHEMERAL,
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

pub mod memory;
pub mod tier;

use agent_loop::Message;
use serde::{Deserialize, Serialize};

pub use memory::TaskMemory;
pub use tier::Tier;

/// The loop's context seam, implemented by [`ContextManager`].
///
/// The loop hands over the conversation as it stands and receives the array to send, plus whether anything was
/// compacted to produce it. Rebuilding from the loop's array each round rather than holding the items across
/// rounds is deliberate: the loop is the one that knows what happened — which message is a tool result and
/// which is the model reasoning — and a manager that tried to track that separately would be a second, quieter
/// record of the same conversation.
impl agent_loop::ContextStrategy for ContextManager {
    fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool) {
        self.sync_from(messages);
        let report = self.compact();
        (self.wire(), report.ran)
    }
}

/// What replaces an elided tool result. Names the elision so the model can act on it.
const ELIDED: &str = "[tool output removed to make room; re-run the call if you still need it]";

/// Marker appended to a compressed item, for the same reason.
const TRUNCATED: &str = "\n[… trimmed to make room …]";

/// One piece of context, with what it is worth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextItem {
    pub message: Message,
    pub tier: Tier,
    /// Estimated tokens. Recomputed whenever the item changes, so a compaction cannot leave a stale figure
    /// behind and then decide it is still over budget.
    pub tokens: u64,
}

impl ContextItem {
    pub fn new(message: Message, tier: Tier) -> Self {
        let tokens = estimate_message(&message);
        Self { message, tier, tokens }
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

    pub fn compact_threshold(&self) -> u64 {
        (self.max_tokens as f64 * self.compact_at) as u64
    }

    pub fn target_tokens(&self) -> u64 {
        (self.max_tokens as f64 * self.target) as u64
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
    /// True when everything removable was removed and it was still not enough.
    ///
    /// Not a failure — the run continues — but the caller should know, because the next thing to give is the
    /// conversation itself and that is a decision this crate will not make silently.
    pub still_over_budget: bool,
}

/// The conversation, plus the state that outlives it.
#[derive(Debug, Clone, Default)]
pub struct ContextManager {
    budget: Budget,
    items: Vec<ContextItem>,
    memory: TaskMemory,
}

impl ContextManager {
    pub fn new(budget: Budget) -> Self {
        Self { budget, items: Vec::new(), memory: TaskMemory::new() }
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
                Some(existing) if same_origin(&existing.message, message) => next.push(existing.clone()),
                _ => next.push(ContextItem::new(message.clone(), tier_for(message))),
            }
        }
        self.items = next;
    }

    /// Total tokens the wire would carry, task memory included.
    pub fn tokens(&self) -> u64 {
        let memory = if self.memory.is_empty() { 0 } else { estimate(&self.memory.render()) + 4 };
        memory + self.items.iter().map(|i| i.tokens).sum::<u64>()
    }

    pub fn needs_compaction(&self) -> bool {
        self.tokens() > self.budget.compact_threshold()
    }

    /// Bring the conversation under budget, if it is over.
    ///
    /// See the module header for why the traversal runs from the cheapest loss upward rather than in §8.3's
    /// listed order.
    pub fn compact(&mut self) -> CompactionReport {
        let before = self.tokens();
        let mut report = CompactionReport { tokens_before: before, tokens_after: before, ..Default::default() };
        if before <= self.budget.compact_threshold() {
            return report;
        }
        report.ran = true;
        let target = self.budget.target_tokens();
        // Tracked as a running total rather than recomputed per item: `tokens()` walks every item, so calling
        // it inside the loop would make one compaction quadratic in the length of the conversation — which is
        // exactly the conversation that triggers compaction in the first place.
        let mut running = before;

        // 1. Ephemeral first: the largest items with the least worth. Oldest first, because the most recent
        //    tool output is the one the current round is reasoning about.
        for item in self.items.iter_mut() {
            if running <= target {
                break;
            }
            if !item.tier.is_removable() || item.message.text() == ELIDED {
                continue;
            }
            // A stub, not a deletion — see the module header.
            let was = item.tokens;
            item.message.content = serde_json::Value::String(ELIDED.to_owned());
            item.recount();
            running = running.saturating_sub(was.saturating_sub(item.tokens));
            report.elided += 1;
        }

        // 2. Then compress the conversation, if that was not enough.
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
        let mut out = Vec::with_capacity(self.items.len() + 1);
        if !self.memory.is_empty() {
            out.push(Message::system(self.memory.render()));
        }
        out.extend(self.items.iter().map(|i| i.message.clone()));
        out
    }
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

/// Trim to roughly `tokens`, keeping the head and marking the cut.
///
/// The head rather than the tail: the opening of a message is where its subject is, and a fragment that starts
/// mid-sentence is harder to use than one that stops mid-sentence.
fn truncate_to(text: &str, tokens: u64) -> String {
    let chars = (tokens * CHARS_PER_TOKEN) as usize;
    if text.chars().count() <= chars {
        return text.to_owned();
    }
    let kept: String = text.chars().take(chars).collect();
    format!("{kept}{TRUNCATED}")
}

/// Characters per token, as an estimate.
///
/// The same 4 the TypeScript tokenizer falls back to when `js-tiktoken` is unavailable. A real tokenizer would
/// be more accurate and is worth adding, but this is used to decide *when* to compact rather than to bill
/// anyone — and the budget already leaves 15% of the window as headroom, which is far more than the error here.
const CHARS_PER_TOKEN: u64 = 4;

/// Estimated tokens for a string.
pub fn estimate(text: &str) -> u64 {
    text.chars().count() as u64 / CHARS_PER_TOKEN
}

/// Estimated tokens for a message, including the per-message overhead a provider charges for role and
/// separators.
pub fn estimate_message(m: &Message) -> u64 {
    let content = match &m.content {
        serde_json::Value::String(s) => estimate(s),
        // An image part's cost is not its JSON length, but a part array is dominated by whatever text sits
        // beside the image, and over-counting here only makes compaction slightly eager.
        other => estimate(&other.to_string()),
    };
    let calls: u64 = m.tool_calls.iter().map(|c| estimate(&c.name) + estimate(&c.arguments)).sum();
    let reasoning = m.reasoning_content.as_deref().map(estimate).unwrap_or(0);
    4 + content + calls + reasoning
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long(n: usize) -> String {
        "x".repeat(n)
    }

    fn manager(window: u64) -> ContextManager {
        ContextManager::new(Budget { max_tokens: window, compact_at: 0.85, target: 0.6 })
    }

    #[test]
    fn an_empty_context_needs_no_compaction() {
        let m = manager(1000);
        assert!(!m.needs_compaction());
        assert!(m.wire().is_empty());
    }

    #[test]
    fn compaction_does_not_run_below_the_threshold() {
        let mut m = manager(1000);
        m.push(Message::user(long(400)), Tier::Normal); // ~100 tokens
        let report = m.compact();
        assert!(!report.ran);
        assert_eq!(report.tokens_before, report.tokens_after);
    }

    #[test]
    fn tool_output_is_elided_before_the_conversation_is_touched() {
        let mut m = manager(1000);
        m.push(Message::user(long(400)), Tier::Normal);
        m.push(Message::tool_result("c1", long(4000)), Tier::Ephemeral);
        assert!(m.needs_compaction());

        let report = m.compact();
        assert!(report.ran);
        assert_eq!(report.elided, 1);
        assert_eq!(report.compressed, 0, "the conversation should not have been touched");
        assert!(report.tokens_after < report.tokens_before);
    }

    /// Deleting a tool message would make the request invalid; the stub is what keeps it well-formed.
    #[test]
    fn an_elided_tool_result_is_still_present_and_still_paired() {
        let mut m = manager(1000);
        m.push(Message::assistant_calls("", vec![agent_loop::model::call("c1", "read_file", serde_json::json!({}))]), Tier::Normal);
        m.push(Message::tool_result("c1", long(8000)), Tier::Ephemeral);
        m.compact();

        let wire = m.wire();
        let tool = wire.iter().find(|msg| msg.role == "tool").expect("the tool message must survive");
        assert_eq!(tool.tool_call_id.as_deref(), Some("c1"), "the pairing must survive");
        assert!(tool.text().contains("re-run the call"), "the model should be told it can redo the work");
    }

    #[test]
    fn the_conversation_is_compressed_only_when_eliding_was_not_enough() {
        let mut m = manager(1000);
        for _ in 0..8 {
            m.push(Message::assistant(long(2000)), Tier::Normal);
        }
        let report = m.compact();
        assert!(report.ran);
        assert_eq!(report.elided, 0, "there was nothing ephemeral to elide");
        assert!(report.compressed > 0);
        assert!(report.tokens_after < report.tokens_before);
    }

    /// §8.3's requirement, and the reason task memory lives outside the conversation.
    #[test]
    fn task_state_survives_a_compaction_that_removes_everything_removable() {
        let mut m = manager(600);
        {
            let memory = m.memory_mut();
            memory.user_goal = Some("migrate the runtime to Rust".into());
            memory.set_plan("finish the context crate, then wire it");
            memory.set_phase("executing");
            memory.add_pending("wire the compaction into the loop");
            memory.complete("build the tier model");
            memory.record_decision("task memory lives outside the conversation");
            memory.add_constraint("never lose the user's goal");
        }
        for _ in 0..10 {
            m.push(Message::tool_result("c", long(4000)), Tier::Ephemeral);
            m.push(Message::assistant(long(4000)), Tier::Normal);
        }

        let report = m.compact();
        assert!(report.ran);

        let wire = m.wire();
        let rendered = wire[0].text().to_owned();
        for expected in [
            "migrate the runtime to Rust",
            "finish the context crate",
            "executing",
            "wire the compaction into the loop",
            "build the tier model",
            "task memory lives outside the conversation",
            "never lose the user's goal",
        ] {
            assert!(rendered.contains(expected), "compaction lost {expected:?}:\n{rendered}");
        }
    }

    #[test]
    fn nothing_important_is_ever_touched() {
        let mut m = manager(500);
        m.push(Message::system(long(2000)), Tier::Critical);
        m.push(Message::assistant(long(2000)), Tier::High);
        m.push(Message::tool_result("c", long(4000)), Tier::Ephemeral);

        let critical_before = m.items()[0].message.clone();
        let high_before = m.items()[1].message.clone();
        m.compact();

        assert_eq!(m.items()[0].message, critical_before, "a critical item was modified");
        assert_eq!(m.items()[1].message, high_before, "a high item was modified");
    }

    /// Everything removable is gone and it is still not enough — reported, not hidden.
    #[test]
    fn a_context_that_cannot_be_brought_under_budget_says_so() {
        let mut m = manager(200);
        m.push(Message::system(long(40_000)), Tier::Critical);
        let report = m.compact();
        assert!(report.ran);
        assert!(report.still_over_budget, "an impossible budget must be reported, not silently accepted");
    }

    /// One compaction should buy several rounds, or a long task thrashes.
    #[test]
    fn compaction_comes_down_well_below_the_threshold_it_fired_at() {
        let mut m = manager(2000);
        for _ in 0..12 {
            m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
        }
        let report = m.compact();
        assert!(report.ran);
        assert!(
            report.tokens_after <= m.budget.target_tokens(),
            "came down to {} but the target is {}",
            report.tokens_after,
            m.budget.target_tokens()
        );
        assert!(!m.needs_compaction(), "compacting again immediately is thrashing");
    }

    /// The prefix a provider can cache has to be at the front, and stable.
    #[test]
    fn task_memory_is_rendered_at_the_front_of_the_wire() {
        let mut m = manager(1000);
        m.memory_mut().user_goal = Some("the goal".into());
        m.push(Message::user("hello"), Tier::Normal);
        let wire = m.wire();
        assert_eq!(wire[0].role, "system");
        assert!(wire[0].text().contains("the goal"));
        assert_eq!(wire[1].text(), "hello");
    }

    #[test]
    fn an_absent_task_memory_adds_no_message_at_all() {
        let mut m = manager(1000);
        m.push(Message::user("hello"), Tier::Normal);
        let wire = m.wire();
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0].role, "user");
    }

    #[test]
    fn a_second_compaction_does_not_re_elide_what_is_already_a_stub() {
        let mut m = manager(1000);
        for _ in 0..6 {
            m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
        }
        let first = m.compact();
        let second = m.compact();
        assert!(first.elided > 0);
        assert_eq!(second.elided, 0, "a stub must not be elided again");
    }

    #[test]
    fn the_estimate_counts_tool_calls_and_reasoning_not_only_content() {
        let plain = estimate_message(&Message::assistant(long(400)));
        let with_calls = estimate_message(&Message::assistant_calls(
            long(400),
            vec![agent_loop::model::call("c1", "read_file", serde_json::json!({ "path": long(400) }))],
        ));
        let with_reasoning = estimate_message(&Message::assistant(long(400)).with_reasoning(long(400)));
        assert!(with_calls > plain);
        assert!(with_reasoning > plain);
    }

    #[test]
    fn the_budget_leaves_headroom_for_the_reply() {
        let b = Budget::with_window(1000);
        assert!(b.compact_threshold() < b.max_tokens);
        assert!(b.target_tokens() < b.compact_threshold());
    }
}
