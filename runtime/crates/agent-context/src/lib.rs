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
//! ## The turn in progress is not the budget's to cut
//!
//! Two limits, with different jobs. The **window** is what the model can take: past it the request fails, so
//! anything may go. The host's **working-set budget** is a preference about cost and attention, and it is held
//! only against *settled* history — the turns before the one being worked on. The turn in progress is the
//! model's working memory: the files it just read are what its next edit is built on. Eliding them to honour a
//! preference made a run forget what it read three calls ago, read it again, and compact again — slower,
//! costlier and less capable than no budget at all, which is what users saw. Between turns the host holds the
//! whole conversation to the budget; inside one, only the window cuts the live turn.
//!
//! Under the window's limit, two things still hold. The results the model has not yet seen are the last to go:
//! stubbing what it just asked for is how a run loops. And assistant prose is what gets shortened: a user
//! message carries a request, and the host's summary of earlier turns rides one, so a settled user message is
//! cut only when the request would not fit the window otherwise — and the turn's own request never.
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
        self.sent_estimate = Some(self.tokens());
        (self.wire(), report.changed())
    }

    fn observe_prompt_tokens(&mut self, prompt_tokens: u64) {
        let Some(estimate) = self.sent_estimate.take() else { return };
        // A count far BELOW the estimate is not a better measurement, it is a different quantity — a provider
        // that leaves cached tokens out of `prompt_tokens`, most likely. Trusting it would hold compaction back
        // until the request overflowed. Above the estimate is normal: tool declarations alone are thousands.
        if prompt_tokens.saturating_mul(4) < estimate {
            tracing::warn!(prompt_tokens, estimate, "the provider's prompt count is implausibly low; keeping the estimate");
            return;
        }
        self.anchor = Some(Anchor { provider: prompt_tokens, estimate });
    }
}

/// A provider's count of a request this manager prepared, beside what this manager estimated that request at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Anchor {
    provider: u64,
    estimate: u64,
}

/// What replaces an elided tool result when the host gave no way back to it. Names the elision so the model can
/// act on it.
const ELIDED: &str = "[tool output removed to make room; re-run the call if you still need it]";

/// How every elision stub begins, whatever follows: matched as well as written, so a stub carrying the host's
/// recall hint is still recognised as one and never elided twice.
const ELIDED_PREFIX: &str = "[tool output removed to make room";

/// Marker appended to a compressed item, for the same reason.
const TRUNCATED: &str = "\n[… trimmed to make room …]";

/// How the summary is introduced to the model. It has to read as *history*, not as instruction, or the model
/// answers the summary instead of the conversation.
const SUMMARY_PREFIX: &str = "Summary of the earlier part of this conversation:";

/// How a deduplicated read begins. Matched as well as written: eliding must recognise it as already-stubbed,
/// or it replaces a message that says WHICH file went stale and why with one that says only "removed".
const STALE_READ_PREFIX: &str = "[earlier read of ";

/// How the host's own notes for a result it already reduced begin: its `<context-compressed>` markers (a
/// completed round's released result, a stale read — `contextMarker.ts`) and its note for a result too large for
/// the context (`oversizedResultStub`). Recognised for the same reason as the two above: each says what the call
/// was and how to get at it, and replacing it with this crate's stub would say less and save nothing.
const HOST_STUB_PREFIXES: [&str; 2] = ["<context-compressed", "[tool result withheld:"];

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
    /// The content as it was before this manager first replaced it — stubbed, deduplicated or shortened.
    ///
    /// What the summariser reads. Eliding runs before summarising, so without this a summary of a span was
    /// built from `[tool output removed…]` markers: the findings the brief asks it to keep had already gone.
    /// Never sent; `None` for an item still as the loop handed it over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<serde_json::Value>,
}

impl ContextItem {
    pub fn new(message: Message, tier: Tier) -> Self {
        let tokens = estimate_message(&message);
        let source = fingerprint(&message);
        Self { message, tier, tokens, summarized: false, source, original: None }
    }

    fn recount(&mut self) {
        self.tokens = estimate_message(&self.message);
    }

    /// Replace the content in place, keeping the first original for the summariser.
    fn replace_content(&mut self, content: String) {
        if self.original.is_none() {
            self.original = Some(self.message.content.clone());
        }
        self.message.content = serde_json::Value::String(content);
        self.recount();
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
    /// The host's working-set budget, when it has one. Held against settled history only — see the module
    /// header for why the turn in progress answers to the window alone.
    #[serde(default)]
    pub working_set: Option<WorkingSet>,
}

/// A working-set budget below the window, in tokens: shed settled history above `trigger`, down to `target`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkingSet {
    pub trigger: u64,
    pub target: u64,
}

impl Default for Budget {
    fn default() -> Self {
        Self { max_tokens: 128_000, compact_at: 0.85, target: 0.6, working_set: None }
    }
}

impl Budget {
    pub fn with_window(max_tokens: u64) -> Self {
        Self { max_tokens, ..Self::default() }
    }

    /// A window with a working-set budget below it: the numbers the host's context-budget setting resolves to.
    ///
    /// The window keeps its own thresholds, because they are about what the MODEL can take: "still over budget"
    /// and the only licence to cut the turn in progress. The budget becomes a
    /// [`WorkingSet`] held against settled history. Values the host should never send are made safe rather than
    /// trusted: a trigger above the window's threshold is that threshold, and a target at or above the trigger —
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
        Self { working_set: Some(WorkingSet { trigger, target }), ..window }
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
    /// The wire's size before and after, as the provider would count it — see
    /// [`ContextManager::measured_tokens`]. The plain estimate until a provider count has arrived.
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

impl CompactionReport {
    /// Did the wire actually change?
    ///
    /// Not the same as `ran`. A live turn larger than the working-set budget keeps the conversation over its
    /// trigger once settled history has nothing left to give, and every later round then runs and changes
    /// nothing. Reporting those as compactions would make every round a planning round (§6.1) and fill the
    /// host's log with compactions that never happened.
    pub fn changed(&self) -> bool {
        self.deduped + self.elided + self.compressed + self.summarized > 0
    }
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
    /// Where the turn in progress begins: the last user message of the first conversation `sync_from` saw.
    ///
    /// Pinned then rather than recomputed as "the latest user message", because a host can inject a user message
    /// mid-run, and recomputing would hand everything the run did before it to the working-set budget. A manager
    /// is built per run, so the first sync is the turn's start. `None` until then; see `live_start`.
    turn_start: Option<usize>,
    /// The host's way back to an elided result, `{id}` standing for its id. See [`with_elision_hint`](Self::with_elision_hint).
    elision_hint: Option<String>,
    /// The estimate of what the last `prepare` returned — what the provider's count for that request is set against.
    sent_estimate: Option<u64>,
    /// The latest provider count and the estimate it measured. See [`measured_tokens`](Self::measured_tokens).
    anchor: Option<Anchor>,
    /// The span end a summary was last declined for — the call failed, or came back no smaller than the span.
    /// See `summarize_head`.
    summary_declined: Option<usize>,
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
            .field("elision_hint", &self.elision_hint.is_some())
            .finish()
    }
}

impl ContextManager {
    pub fn new(budget: Budget) -> Self {
        Self {
            budget,
            items: Vec::new(),
            memory: TaskMemory::new(),
            summarizer: None,
            summary: None,
            turn_start: None,
            elision_hint: None,
            sent_estimate: None,
            anchor: None,
            summary_declined: None,
        }
    }

    /// Tell the model how to get an elided result back, instead of telling it to re-run the call.
    ///
    /// The host keeps every result in full and owns a tool that returns one by id; re-running is the wrong advice
    /// for anything with side effects, and costs a round trip and possibly a different answer for the rest. `{id}`
    /// in `hint` is replaced by the elided result's `tool_call_id`.
    pub fn with_elision_hint(mut self, hint: impl Into<String>) -> Self {
        self.elision_hint = Some(hint.into());
        self
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
        if self.turn_start.is_none() {
            self.turn_start = Some(last_user_index(&self.items));
        }
    }

    /// Total tokens the wire would carry, task memory included.
    pub fn tokens(&self) -> u64 {
        let memory = if self.memory.is_empty() { 0 } else { estimate(&self.memory.render()) + 4 };
        // The summary is what a folded span actually costs; the originals are held for re-summarising and
        // cost nothing on the wire.
        let summary = self.summary.as_ref().map_or(0, |t| estimate(t) + estimate(SUMMARY_PREFIX) + 4);
        memory + summary + self.items.iter().filter(|i| !i.summarized).map(|i| i.tokens).sum::<u64>()
    }

    /// What the provider would count for the wire as it stands: the estimate, corrected by the latest provider count.
    ///
    /// The estimate is blind to what the provider counts beside the messages — tool declarations, thousands of tokens
    /// on every request — and to the provider's own tokenizer. So the latest count corrects it: by the overhead the
    /// provider counted on top of the estimate (which, for declarations and framing, is the same on every request,
    /// however the conversation changes), or — when the estimate ran HIGH — by the ratio, which shrinks with the
    /// conversation and so cannot fall below zero after a compaction the way a negative offset would. Without a
    /// count yet, the estimate.
    pub fn measured_tokens(&self) -> u64 {
        self.measured(self.tokens())
    }

    fn measured(&self, estimated: u64) -> u64 {
        match self.anchor {
            None => estimated,
            Some(a) if a.provider >= a.estimate => estimated.saturating_add(a.provider - a.estimate),
            Some(a) => (u128::from(estimated) * u128::from(a.provider) / u128::from(a.estimate.max(1))) as u64,
        }
    }

    /// The estimate at which [`measured`](Self::measured) reaches `limit` — its inverse, so compaction can compare in
    /// the provider's terms and still do its per-item arithmetic in the estimate's.
    fn to_estimate(&self, limit: u64) -> u64 {
        match self.anchor {
            None => limit,
            Some(a) if a.provider >= a.estimate => limit.saturating_sub(a.provider - a.estimate),
            Some(a) => (u128::from(limit) * u128::from(a.estimate) / u128::from(a.provider.max(1))) as u64,
        }
    }

    pub fn needs_compaction(&self) -> bool {
        let tokens = self.measured_tokens();
        tokens > self.budget.compact_threshold() || self.budget.working_set.is_some_and(|w| tokens > w.trigger)
    }

    /// Bring the conversation under budget, if it is over.
    ///
    /// See the module header for why the traversal runs from the cheapest loss upward rather than in §8.3's
    /// listed order, and why it runs over settled history before the turn in progress — and over the turn in
    /// progress only when the window itself is at stake.
    pub async fn compact(&mut self) -> CompactionReport {
        // Decided in the provider's terms, worked in the estimate's: the limits are what a provider counts, so each is
        // compared as measured and converted once into estimate units, where the per-item arithmetic below lives.
        let before = self.tokens();
        let measured = self.measured(before);
        let mut report = CompactionReport { tokens_before: measured, tokens_after: measured, ..Default::default() };
        let over_window = measured > self.budget.compact_threshold();
        let over_working_set = self.budget.working_set.is_some_and(|w| measured > w.trigger);
        if !over_window && !over_working_set {
            return report;
        }
        report.ran = true;
        let live = self.live_start();

        // Settled history first, under whichever limit is tighter. Every step here is one the turn in progress
        // never notices: the reads it is building on are not in this span.
        let settled_target = self.to_estimate(self.settled_target());

        // 0. Stale reads, before anything else. It is the only step here that costs nothing and loses
        //    nothing: the file's current contents are already in the conversation, in a later read or a
        //    later write, so the earlier snapshot is redundant rather than merely cheap. Running it first
        //    means the steps that DO lose something have less to do, and may stop before reaching a tool
        //    result the model still needs.
        report.deduped = self.dedup_stale_reads(0..live);
        // Tracked as a running total rather than recomputed per item: `tokens()` walks every item, so calling
        // it inside the loop would make one compaction quadratic in the length of the conversation — which is
        // exactly the conversation that triggers compaction in the first place.
        let mut running = if report.deduped > 0 { self.tokens() } else { before };

        // 1. Ephemeral next: the largest items with the least worth.
        report.elided += self.elide(0..live, settled_target, &mut running);

        // 2. Summarise the head, if eliding was not enough and a summariser was configured.
        //
        //    Placed between the two blunt techniques on purpose. Eliding tool output is cheaper — it costs no
        //    model call and loses something the model can re-fetch. Truncation is worse: it keeps the first N
        //    characters of a message and throws away whatever the point was. Summarising sits where it does
        //    because it is the only step that preserves MEANING, so it should run before the step that does
        //    not, and after the step that costs nothing.
        if running > settled_target && self.summarizer.is_some() {
            report.summarized = self.summarize_head(live).await;
            if report.summarized > 0 {
                running = self.tokens();
            }
        }

        // The turn in progress, only when the window is STILL at stake once settled history has given what it can:
        // decided on what is left, not on the size this started at, because shedding the settled span is often
        // enough on its own. Over the working-set budget alone the turn stays exactly as the model left it.
        let threshold = self.to_estimate(self.budget.compact_threshold());
        let target = self.to_estimate(self.budget.target_tokens());
        let window = self.to_estimate(self.budget.max_tokens);
        if running > threshold {
            // 3. Stale reads inside the turn — the same lossless step, now that the window needs it.
            let deduped = self.dedup_stale_reads(live..self.items.len());
            if deduped > 0 {
                report.deduped += deduped;
                running = self.tokens();
            }

            // 4. The turn's own tool output, oldest first — except the batch the model has not seen yet.
            let fresh = self.fresh_start();
            report.elided += self.elide(live..fresh, target, &mut running);

            // 5. Then assistant prose, if that was still not enough. Prose and not requests: cutting a user
            //    message keeps the first few dozen tokens of what was asked and drops the point of it.
            if running > target {
                report.compressed += self.compress(0..self.items.len(), "assistant", target, &mut running);
            }

            // The last two only when the request would not fit the window at all — the alternative is a request
            // the provider refuses, which ends the run — and only down to the threshold, not the target: enough to
            // fit with room for the reply, and not a token more of what they cut.

            // 6. Settled user messages: earlier requests, and the host's summary that rides one. Never the
            //    turn's own request, which is what the run is for.
            if running > window {
                report.compressed += self.compress(0..live, "user", threshold, &mut running);
            }

            // 7. The unseen batch. Stubbing a result the model just asked for is how a run loops — it asks
            //    again, and gets the same stub — so this is the last thing given up.
            if running > window {
                report.elided += self.elide(fresh..self.items.len(), threshold, &mut running);
            }
        }

        report.tokens_after = self.measured(self.tokens());
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

    /// What settled history is brought down to: the working-set target when the host set a budget, else the
    /// window's own target — whichever applies is the tighter, since a working set never exceeds the window's.
    fn settled_target(&self) -> u64 {
        self.budget.working_set.map_or(self.budget.target_tokens(), |w| w.target)
    }

    /// Where the turn in progress begins. Everything before it is settled history.
    ///
    /// The pinned start when `sync_from` has run. A manager filled only by `push` has no run to pin to, and
    /// takes the latest user message instead — or 0 when there is none, which treats everything as live: the
    /// conservative answer, since it leaves only the window licensed to cut.
    fn live_start(&self) -> usize {
        self.turn_start.unwrap_or_else(|| last_user_index(&self.items)).min(self.items.len())
    }

    /// Where what the model has not yet seen begins: everything after its latest turn — the results it just asked
    /// for. Not "the trailing run of tool messages": a host may append a message of its own behind them (an
    /// automation's final-round instruction), and that is exactly the round where they would have gone unprotected.
    fn fresh_start(&self) -> usize {
        self.items.iter().rposition(|i| i.message.role == "assistant").map_or(0, |i| i + 1)
    }

    /// Stub removable items in `range`, oldest first, until `running` is at or under `target`. Returns how many.
    ///
    /// Oldest first, because the most recent tool output is the one the current round is reasoning about.
    fn elide(&mut self, range: std::ops::Range<usize>, target: u64, running: &mut u64) -> usize {
        let mut elided = 0;
        let hint = self.elision_hint.as_deref();
        for item in self.items.iter_mut().take(range.end).skip(range.start) {
            if *running <= target {
                break;
            }
            // Already a stub, by either technique. Re-stubbing saves nothing and would overwrite dedup's
            // wording — which names the file and says a newer copy is further down — with this one's, which
            // does not. And never a folded item: it is not on the wire, so stubbing it saves nothing either, and
            // counting its "saving" against `running` would stop the loop while the wire was still over target.
            if item.summarized || !item.tier.is_removable() || is_stub(item.message.text()) {
                continue;
            }
            // A stub, not a deletion — see the module header. And only where it is smaller: a result shorter than
            // the stub that would replace it saves nothing and still rewrites a message the provider had cached.
            let was = item.tokens;
            let stub = elided_text(hint, item.message.tool_call_id.as_deref());
            if estimate(&stub) + 4 >= was {
                continue;
            }
            item.replace_content(stub);
            *running = running.saturating_sub(was.saturating_sub(item.tokens));
            elided += 1;
        }
        elided
    }

    /// Shorten the Normal-tier `role` messages in `range` evenly until `running` comes down to `target`.
    /// Returns how many were shortened.
    fn compress(&mut self, range: std::ops::Range<usize>, role: &str, target: u64, running: &mut u64) -> usize {
        // Folded items are not on the wire — see `elide` for why their "saving" must not be counted.
        let shortenable = |i: &ContextItem| !i.summarized && i.tier.is_compressible() && i.message.role == role;
        let sizes: Vec<u64> =
            self.items.iter().take(range.end).skip(range.start).filter(|i| shortenable(i)).map(|i| i.tokens).collect();
        let allowance = compression_allowance(&sizes, target, *running);
        let mut compressed = 0;
        for item in self.items.iter_mut().take(range.end).skip(range.start) {
            if !shortenable(item) {
                continue;
            }
            let Some(text) = item.message.content.as_str() else { continue };
            if estimate(text) <= allowance {
                continue;
            }
            let was = item.tokens;
            let shortened = truncate_to(text, allowance);
            item.replace_content(shortened);
            *running = running.saturating_sub(was.saturating_sub(item.tokens));
            compressed += 1;
        }
        compressed
    }
}

/// The index of the latest user message, or 0 when there is none.
fn last_user_index(items: &[ContextItem]) -> usize {
    items.iter().rposition(|i| i.message.role == "user").unwrap_or(0)
}

/// Has this message already been replaced by a marker, by any technique?
fn is_stub(text: &str) -> bool {
    text.starts_with(ELIDED_PREFIX)
        || text.starts_with(STALE_READ_PREFIX)
        || HOST_STUB_PREFIXES.iter().any(|p| text.starts_with(p))
}

/// The stub for one elided result: the host's way back to it when there is one and the result has an id to name,
/// the plain "re-run" wording otherwise.
fn elided_text(hint: Option<&str>, id: Option<&str>) -> String {
    match (hint, id) {
        (Some(hint), Some(id)) if !id.is_empty() => format!("{ELIDED_PREFIX} — {}]", hint.replace("{id}", id)),
        _ => ELIDED.to_owned(),
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

/// How many tokens each compressible item may keep, given their sizes.
///
/// Spread evenly rather than trimming the longest: an even allowance keeps the *shape* of the conversation,
/// and it is the shape that lets a reply stay coherent once the detail has gone. Never returns zero — an item
/// compressed to nothing is a deletion wearing a different name, and would break the same tool pairing the
/// ephemeral stub exists to protect.
fn compression_allowance(sizes: &[u64], target: u64, current: u64) -> u64 {
    if sizes.is_empty() {
        return u64::MAX;
    }
    let total: u64 = sizes.iter().sum();
    let overshoot = current.saturating_sub(target);
    let keep = total.saturating_sub(overshoot);
    (keep / sizes.len() as u64).max(32)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
