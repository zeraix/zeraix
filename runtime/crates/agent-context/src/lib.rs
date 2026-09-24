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

/// User turns kept verbatim at the end. The tail is where the current task lives, and summarising it is how a
/// run forgets what it was just asked. Matches `KEEP_TAIL_TURNS` in the TypeScript path.
const KEEP_TAIL_TURNS: usize = 4;

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

/// How a deduplicated read begins. Matched as well as written: eliding must recognise it as already-stubbed,
/// or it replaces a message that says WHICH file went stale and why with one that says only "removed".
const STALE_READ_PREFIX: &str = "[earlier read of ";

/// Per-item ceiling when rendering a span for the summariser. A span can be enormous — that is why it is being
/// summarised — and handing the whole of it over would spend more tokens than the compaction saves.
const SUMMARY_SOURCE_TOKENS: u64 = 400;

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
    fn dedup_stale_reads(&mut self) -> usize {
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
    async fn summarize_head(&mut self) -> usize {
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

/// Has this message already been replaced by a marker, by any technique?
fn is_stub(text: &str) -> bool {
    text == ELIDED || text.starts_with(STALE_READ_PREFIX)
}

/// Compare paths the way a model writes them: `./src/a.rs`, `src/a.rs` and `src/a.rs/` are one file.
///
/// Deliberately lexical. Resolving against the workspace would be more accurate and would need the filesystem,
/// which this crate does not touch — and the cost of being wrong is asymmetric: a missed match wastes an
/// opportunity, a false match tells the model a still-current read has been superseded.
fn normalize_path(raw: &str) -> String {
    raw.trim().trim_start_matches("./").trim_end_matches('/').to_owned()
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

    #[tokio::test]
    async fn compaction_does_not_run_below_the_threshold() {
        let mut m = manager(1000);
        m.push(Message::user(long(400)), Tier::Normal); // ~100 tokens
        let report = m.compact().await;
        assert!(!report.ran);
        assert_eq!(report.tokens_before, report.tokens_after);
    }

    #[tokio::test]
    async fn tool_output_is_elided_before_the_conversation_is_touched() {
        let mut m = manager(1000);
        m.push(Message::user(long(400)), Tier::Normal);
        m.push(Message::tool_result("c1", long(4000)), Tier::Ephemeral);
        assert!(m.needs_compaction());

        let report = m.compact().await;
        assert!(report.ran);
        assert_eq!(report.elided, 1);
        assert_eq!(report.compressed, 0, "the conversation should not have been touched");
        assert!(report.tokens_after < report.tokens_before);
    }

    /// Deleting a tool message would make the request invalid; the stub is what keeps it well-formed.
    #[tokio::test]
    async fn an_elided_tool_result_is_still_present_and_still_paired() {
        let mut m = manager(1000);
        m.push(Message::assistant_calls("", vec![agent_loop::model::call("c1", "read_file", serde_json::json!({}))]), Tier::Normal);
        m.push(Message::tool_result("c1", long(8000)), Tier::Ephemeral);
        m.compact().await;

        let wire = m.wire();
        let tool = wire.iter().find(|msg| msg.role == "tool").expect("the tool message must survive");
        assert_eq!(tool.tool_call_id.as_deref(), Some("c1"), "the pairing must survive");
        assert!(tool.text().contains("re-run the call"), "the model should be told it can redo the work");
    }

    #[tokio::test]
    async fn the_conversation_is_compressed_only_when_eliding_was_not_enough() {
        let mut m = manager(1000);
        for _ in 0..8 {
            m.push(Message::assistant(long(2000)), Tier::Normal);
        }
        let report = m.compact().await;
        assert!(report.ran);
        assert_eq!(report.elided, 0, "there was nothing ephemeral to elide");
        assert!(report.compressed > 0);
        assert!(report.tokens_after < report.tokens_before);
    }

    /// §8.3's requirement, and the reason task memory lives outside the conversation.
    #[tokio::test]
    async fn task_state_survives_a_compaction_that_removes_everything_removable() {
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

        let report = m.compact().await;
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

    #[tokio::test]
    async fn nothing_important_is_ever_touched() {
        let mut m = manager(500);
        m.push(Message::system(long(2000)), Tier::Critical);
        m.push(Message::assistant(long(2000)), Tier::High);
        m.push(Message::tool_result("c", long(4000)), Tier::Ephemeral);

        let critical_before = m.items()[0].message.clone();
        let high_before = m.items()[1].message.clone();
        m.compact().await;

        assert_eq!(m.items()[0].message, critical_before, "a critical item was modified");
        assert_eq!(m.items()[1].message, high_before, "a high item was modified");
    }

    /// Everything removable is gone and it is still not enough — reported, not hidden.
    #[tokio::test]
    async fn a_context_that_cannot_be_brought_under_budget_says_so() {
        let mut m = manager(200);
        m.push(Message::system(long(40_000)), Tier::Critical);
        let report = m.compact().await;
        assert!(report.ran);
        assert!(report.still_over_budget, "an impossible budget must be reported, not silently accepted");
    }

    /// One compaction should buy several rounds, or a long task thrashes.
    #[tokio::test]
    async fn compaction_comes_down_well_below_the_threshold_it_fired_at() {
        let mut m = manager(2000);
        for _ in 0..12 {
            m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
        }
        let report = m.compact().await;
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

    #[tokio::test]
    async fn a_second_compaction_does_not_re_elide_what_is_already_a_stub() {
        let mut m = manager(1000);
        for _ in 0..6 {
            m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
        }
        let first = m.compact().await;
        let second = m.compact().await;
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
