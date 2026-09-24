//! The Agent Loop.
//!
//! Ported from `src/lib/agent/agentLoop.ts` (spec §2.1's Model → Agent → Tool → Result cycle), with the one
//! difference that is the entire point of moving it: on the TypeScript side a round is handed to the host to
//! execute (`runRound`), because the host owned the provider call and the tool registry. Here the loop owns
//! both. It calls the model through [`ModelClient`] and executes tools through [`ToolExecutor`], so the cycle
//! closes inside the runtime and Electron is not in it.
//!
//! ## The order of a round is the specification
//!
//! Every round follows the same steps, and each is placed where it is for a reason:
//!
//!  1. **check cancellation** — at the top rather than only after the request, so a run cancelled while a tool
//!     was executing does not issue one more request before noticing;
//!  2. **open the round** — the execution state re-derives its phase here, from facts recorded last round;
//!  3. **resolve reasoning FROM that phase** — before the request exists, which is what makes the policy real
//!     rather than advisory: nothing downstream can forget to apply it;
//!  4. **call the model**;
//!  5. **execute the tools**, folding each result into execution state first and the doom-loop detector
//!     second — the phase must reflect a failure immediately, and the detector's escalation is per round;
//!  6. **ask the stop policy**, which is the only thing that ends a run.
//!
//! Swapping (2) and (3) would issue a recovery round at reduced effort. Swapping the two folds in (5) would
//! let a round be judged against a phase that had not yet noticed the failure in it.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use agent_core::{CancellationToken, Result};

use crate::doom::{CallObservation, CallVerdict, DoomLoop, DoomSignal};
use crate::model::{Message, ModelClient, ModelRequest, NormalizedTurn, ToolCall, Usage};
use crate::reasoning::{Effort, ReasoningDecision, ThinkingConfig, resolve_reasoning};
use crate::state::ExecutionState;
use crate::stop::{StopDecision, StopInput, StopPolicyConfig, StopReason, decide_stop};

/// What executing one tool produced.
///
/// There is no error variant, and that is deliberate: a tool that fails produces a *result* saying so, which
/// the model reads and responds to. An `Err` here would abort the turn, and a failing tool is the most
/// ordinary thing that happens in an agent run — the model is usually the right thing to hand it to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    /// The text fed back to the model, after any capping.
    pub content: String,
    pub ok: bool,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self { content: content.into(), ok: true }
    }
    pub fn failed(content: impl Into<String>) -> Self {
        Self { content: content.into(), ok: false }
    }
}

/// One executed call, as the loop records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRecord {
    /// Pairs with [`ToolCall::id`], which is what keeps the assistant turn aligned with its results.
    pub tool_call_id: String,
    /// The RESOLVED tool name, never a dispatcher's — a routed call must not be recorded as `call_tool`.
    pub name: String,
    /// Arguments as executed, after routing resolved them.
    pub args: serde_json::Value,
    pub content: String,
    pub ok: bool,
    pub ms: u64,
}

/// The tool seam.
///
/// Resolving a call — reading its `arguments` string, routing a dispatcher, applying permission — belongs to
/// the implementation, not to the loop. The loop needs three things back: what actually ran, what to tell the
/// model, and whether it worked.
#[async_trait::async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Execute one call. Must not panic and must honour `token`.
    ///
    /// The returned `name` and `args` are what the loop records and what the doom-loop detector sees, so an
    /// implementation that routes a call is expected to report the resolved name rather than the wrapper's.
    async fn execute(
        &self,
        call: &ToolCall,
        token: &CancellationToken,
    ) -> (String, serde_json::Value, ToolOutcome);

    /// The arguments to REPLAY for `call` on later requests, when they must differ from what the model sent.
    ///
    /// A call whose `arguments` are not valid JSON is refused by the provider on every later request that
    /// replays it — the conversation dies, not the round. The executor owns the rules for reading arguments, so
    /// it also says what a readable copy is. The call itself still executes as sent, so the error it reports is
    /// about what the model actually wrote. `None`, the default, replays the call byte for byte.
    fn replay_arguments(&self, call: &ToolCall) -> Option<String> {
        let _ = call;
        None
    }
}

/// One model request and everything it produced.
///
/// `tool_calls` and `tool_results` are separate rather than one paired list because they are populated at
/// different times — the calls arrive with the response, the results only after execution — and a round
/// cancelled mid-execution has fewer results than calls. That asymmetry is how a cancelled round is told apart
/// from a completed one.
#[derive(Debug, Clone, Default)]
pub struct AgentTurnRecord {
    /// 0-based index within the user turn.
    pub round: u32,
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub tool_results: Vec<ToolRecord>,
    pub usage: Usage,
    /// The effort this round was issued at, for the log.
    pub effort: Option<Effort>,
    /// The whole round: the request AND the tools it asked for.
    pub ms: u64,
    /// The model request alone. What a usage log means by a call's latency — `ms` would bill a slow tool
    /// to the provider.
    pub model_ms: u64,
}

/// Everything a run needs that is not the model or the tools.
#[derive(Default)]
pub struct LoopConfig {
    pub model: String,
    /// Tool declarations in the provider's shape. Empty means the run has no tools, not that they were
    /// withdrawn.
    pub tools: Vec<serde_json::Value>,
    pub stop_policy: StopPolicyConfig,
    /// The user's thinking setting: the ceiling, never modified.
    pub thinking: ThinkingConfig,
    pub context_window: Option<u64>,
    /// Tools that may run at the same time when the model asks for several in a row.
    ///
    /// Only CONSECUTIVE calls are batched, so a read can never overtake an edit issued in the same round —
    /// the rule `groupParallelCalls` in the chat page follows. Empty runs every call on its own, in order.
    pub parallel_safe: HashSet<String>,
    /// Send each round's thinking back to the model with its reply, for the rest of this turn.
    ///
    /// What a local model's chat template renders for the current turn, and what the user's "send thinking as
    /// context" setting asks for everywhere. Off, a round's reasoning is kept in the record and not replayed.
    pub replay_reasoning: bool,
}

/// What the caller learns when the run ends.
pub struct LoopOutcome {
    pub stop: StopDecision,
    pub state: ExecutionState,
    pub turns: Vec<AgentTurnRecord>,
    /// The conversation as it now stands, including every assistant turn and tool result the loop appended.
    ///
    /// **Verbatim.** A run that compacted sent the model something shorter; this is not that. The caller owns
    /// the record a person reads, and handing back the compacted copy would silently rewrite it — see the note
    /// at the `prepare` call site in [`AgentLoop::run`].
    pub messages: Vec<Message>,
    /// Indices into `messages` of the ones the HOST injected between rounds, through a [`RoundGate`].
    ///
    /// They belong in `messages` — the model answered them, and a transcript without the instruction reads as
    /// the model volunteering its answer — but they were said by nobody in the conversation. The "you have
    /// used your whole tool budget" note carries `role: "user"`, so a caller rendering the transcript as-is
    /// would show the user a message they never typed. This is how it can tell them apart and leave them out
    /// of what a person reads, while keeping them in what the model is sent next turn.
    pub injected: Vec<usize>,
}

impl LoopOutcome {
    /// The last assistant text — what a caller shows the user.
    pub fn final_text(&self) -> &str {
        self.turns.last().map(|t| t.content.as_str()).unwrap_or("")
    }
}

/// How the conversation is kept within the model's window.
///
/// A trait for the same reason [`ModelClient`] and [`ToolExecutor`] are: the loop owns *when* the context is
/// prepared — once per round, before the request is built — and nothing about *how*. Budgets, memory tiers and
/// compaction live in `agent-context`, which depends on this crate; putting them behind a trait is what keeps
/// that dependency pointing one way.
///
/// ## Why it is async
///
/// Dropping and truncating are decisions a strategy can make on its own. Summarising is not: it is a model
/// call, and it is the only technique that keeps what a conversation MEANT rather than merely what fitted. A
/// synchronous seam quietly rules it out, so the strategy that most needs to exist could not be written behind
/// it. The cost is one boxed future per round, against a request that takes seconds.
#[async_trait::async_trait]
pub trait ContextStrategy: Send + Sync {
    /// Produce the messages for this round.
    ///
    /// Returns the wire array and whether anything was compacted to produce it. The loop uses the flag to move
    /// the execution state — §6.1 makes the round after a compaction a planning round, because the model is
    /// about to be handed a conversation it has not seen before.
    async fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool);
}

/// The default: hand the conversation over untouched.
///
/// A loop with no strategy is not a loop with a broken one — it is a loop whose caller has not asked for
/// context management, and it must behave exactly as it did before the trait existed.
pub struct PassThroughContext;
#[async_trait::async_trait]
impl ContextStrategy for PassThroughContext {
    async fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool) {
        (messages.to_vec(), false)
    }
}

/// The host's right to stop the loop between rounds.
///
/// ## Why the loop does not decide this itself
///
/// Everything in [`StopPolicyConfig`] is something the loop can observe: a failure count, a clock, a context
/// window. A spending limit is not. Neither is a workflow node's round budget, nor an approval a user revoked
/// while the turn was running. Those live with the caller, and before this existed the caller could only
/// enforce them by *owning the loop* — which is precisely what moving the loop into the runtime takes away.
///
/// So the loop keeps the decision about whether a run is going well, and the host keeps the decision about
/// whether it may continue at all. Consulted between rounds, which is the only safe moment: no request is in
/// flight and no tool is half-done, so a refusal costs nothing that has to be unwound.
///
/// A gate must be quick. The loop is holding a turn open while it waits.
#[async_trait::async_trait]
pub trait RoundGate: Send + Sync {
    /// May the next round begin? See [`RoundContext`] for what the host is told.
    async fn before_round(&self, ctx: &RoundContext) -> RoundDecision;
}

/// What a [`RoundGate`] is told.
#[derive(Debug, Clone, Default)]
pub struct RoundContext {
    /// The round about to start, 0-based.
    pub round: u32,
    /// Everything the run has spent so far, which is what a budget is decided against.
    pub usage: Usage,
    /// The last round was a final answer, and the run completes unless the gate answers `resume`.
    ///
    /// Asked because a host can know a final answer is not one: the model spent the turn on tools and then
    /// said nothing, or it is ending the turn with delegations it started still running. Before this the only
    /// way to act on that was to own the loop.
    pub after_final: bool,
    /// The round that just closed. `None` before the first.
    pub last: Option<RoundSummary>,
}

/// One closed round, as much as a host needs to decide what to say next.
#[derive(Debug, Clone, Default)]
pub struct RoundSummary {
    /// The reply carried no text.
    pub content_empty: bool,
    /// The reply carried reasoning.
    pub has_reasoning: bool,
    /// Every call that ran, in order: the resolved name and the arguments as executed.
    pub calls: Vec<CallSummary>,
    /// The repetitions the detector noticed this round, one per call that drew one.
    pub signals: Vec<SignalRecord>,
}

#[derive(Debug, Clone)]
pub struct CallSummary {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
    pub ok: bool,
}

/// A repetition worth telling the model about. The host words it.
#[derive(Debug, Clone)]
pub struct SignalRecord {
    pub call_id: String,
    pub name: String,
    pub signal: DoomSignal,
    pub repeat: u32,
    pub fail_streak: u32,
    pub resource_hits: u32,
}

impl RoundSummary {
    fn of(record: &AgentTurnRecord, signals: Vec<SignalRecord>) -> Self {
        Self {
            content_empty: record.content.trim().is_empty(),
            has_reasoning: !record.reasoning.trim().is_empty(),
            calls: record
                .tool_results
                .iter()
                .map(|r| CallSummary { id: r.tool_call_id.clone(), name: r.name.clone(), args: r.args.clone(), ok: r.ok })
                .collect(),
            signals,
        }
    }
}

/// What a [`RoundGate`] decided.
// No `Eq`: `inject` carries `Message`, whose content is a JSON value and has no total equality.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RoundDecision {
    /// False ends the run with [`StopReason::HostStopped`].
    pub proceed: bool,
    /// Why, in words a user will read. Carried onto the stop decision.
    pub detail: Option<String>,
    /// Offer the model no tools this round.
    ///
    /// The "answer now" round: a caller that has spent its budget usually wants a final answer built from what
    /// the run already gathered, not a run terminated mid-investigation with its work discarded. Withdrawing
    /// the tools removes the option the model keeps taking, which turns the next round into the answer.
    pub withdraw_tools: bool,
    /// Messages to append to the conversation before this round's request.
    ///
    /// The other half of "answer now": withdrawing the tools removes the option, and a message says what to do
    /// instead — in the format the caller originally asked for, which the loop has no way to know. It is also
    /// how a host injects what it learned between rounds (a file that changed underneath the run, an approval
    /// that was revoked) without owning the loop to do it.
    ///
    /// Appended to the real conversation, not to a prepared copy: these are part of the transcript the run
    /// returns, because a model's answer is unreadable next to a transcript that does not contain the
    /// instruction it was answering.
    pub inject: Vec<Message>,
    /// Text to append to the turn's latest tool result, joined with a blank line, before the next request.
    ///
    /// The chat page's nudges ride the result the model is about to read rather than arriving as a message of
    /// their own: a user-role instruction would read as the user speaking, and a tool result the model has not
    /// yet been sent can be amended without breaking the provider's prefix cache. Ignored when this turn has
    /// no tool result yet, and when the result already carries the same text.
    pub nudge: Option<String>,
    /// Asked after a final answer ([`RoundContext::after_final`]): run another round instead of completing.
    /// Pair it with a `nudge` or `inject` saying why, or the model will answer the same way again.
    pub resume: bool,
}

impl RoundDecision {
    /// Carry on.
    pub fn proceed() -> Self {
        Self { proceed: true, ..Default::default() }
    }

    /// Carry on, but this round has no tools. See [`RoundDecision::withdraw_tools`].
    pub fn answer_now() -> Self {
        Self { proceed: true, withdraw_tools: true, ..Default::default() }
    }

    /// Stop here, for this reason.
    pub fn stop(detail: impl Into<String>) -> Self {
        Self { proceed: false, detail: Some(detail.into()), ..Default::default() }
    }
}

/// Observers of a run, for the UI and the audit log.
///
/// Every hook is optional and none may fail the run: an observer that returns an error would give reporting
/// the power to stop work, which is backwards.
#[allow(unused_variables)]
pub trait LoopObserver: Send + Sync {
    fn round_started(&self, round: u32, decision: &ReasoningDecision) {}
    /// The model answered, before any tool it asked for runs.
    ///
    /// `record` carries the reply, its reasoning, and the calls as they will be REPLAYED (see
    /// [`ToolExecutor::replay_arguments`]). A host that keeps its own copy of the conversation stores the
    /// assistant turn here, so it lands before the results that answer it.
    fn response_received(&self, record: &AgentTurnRecord) {}
    /// A round closed, with everything it produced.
    ///
    /// Paired with `round_started` rather than folded into it: they fire at different times and a UI needs
    /// both — one to show a turn opening, the other to show what it cost.
    fn round_finished(&self, record: &AgentTurnRecord) {}
    fn tool_started(&self, call: &ToolCall) {}
    fn tool_finished(&self, record: &ToolRecord) {}
    /// A repetition worth telling the model about. The host decides how to phrase it.
    fn doom_signal(&self, signal: DoomSignal, record: &ToolRecord, verdict: &CallVerdict) {}
    fn stopped(&self, decision: &StopDecision) {}
    /// The context was compacted before this round's request.
    fn compacted(&self, round: u32) {}
    /// Resolves once every event reported before this call has been delivered.
    ///
    /// The loop awaits it before it asks the host anything, so the host has seen everything it is being asked
    /// about. An observer that delivers synchronously has nothing to wait for and returns `None`.
    fn flush(&self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        None
    }
}

/// The no-op observer, so a caller that wants none does not have to write one.
pub struct NoObserver;
impl LoopObserver for NoObserver {}

pub struct AgentLoop {
    model: Arc<dyn ModelClient>,
    tools: Arc<dyn ToolExecutor>,
    observer: Arc<dyn LoopObserver>,
    /// Behind a `Mutex` because preparing the context mutates it — a manager that compacts has to remember
    /// that it did, or it would compact the same conversation again next round. Tokio's rather than std's:
    /// preparing can now await a model call, and a std guard may not be held across one.
    context: tokio::sync::Mutex<Box<dyn ContextStrategy>>,
    /// The host's between-rounds veto. `None` means nothing to ask, and the loop runs exactly as before.
    gate: Option<Arc<dyn RoundGate>>,
    config: LoopConfig,
}

impl AgentLoop {
    pub fn new(model: Arc<dyn ModelClient>, tools: Arc<dyn ToolExecutor>, config: LoopConfig) -> Self {
        Self {
            model,
            tools,
            observer: Arc::new(NoObserver),
            context: tokio::sync::Mutex::new(Box::new(PassThroughContext)),
            gate: None,
            config,
        }
    }

    /// Let `gate` decide, between rounds, whether the run may continue. See [`RoundGate`].
    pub fn with_gate(mut self, gate: Arc<dyn RoundGate>) -> Self {
        self.gate = Some(gate);
        self
    }

    /// Keep the conversation within the model's window using `strategy`.
    pub fn with_context(mut self, strategy: Box<dyn ContextStrategy>) -> Self {
        self.context = tokio::sync::Mutex::new(strategy);
        self
    }

    pub fn with_observer(mut self, observer: Arc<dyn LoopObserver>) -> Self {
        self.observer = observer;
        self
    }

    /// Run until the stop policy ends it.
    ///
    /// `messages` is the conversation so far; the loop appends to it and returns it in [`LoopOutcome`]. The
    /// only `Err` this can produce is one the run could not continue past *and* could not describe — a
    /// provider failure is a stop reason, not an error, because the user is owed the partial run either way.
    pub async fn run(&self, messages: Vec<Message>, token: CancellationToken) -> Result<LoopOutcome> {
        let mut state = ExecutionState::new();
        let mut doom = DoomLoop::new();
        let mut turns: Vec<AgentTurnRecord> = Vec::new();
        let mut wire = messages;
        // Positions in `wire` of messages the host injected. See [`LoopOutcome::injected`].
        let mut injected: Vec<usize> = Vec::new();
        // Carried across exactly one round: a model's effort override applies to the next turn and lapses.
        let mut pending_effort: Option<Effort> = None;
        // The run's own clock, for §9.1's deadlines. Started here rather than by the caller so that a slow
        // caller cannot make a run look as though it had already used its budget before it began.
        let run_started = Instant::now();
        // Where this turn's latest tool result sits in `wire` — what a gate's `nudge` is appended to. This turn's
        // only: a result from an earlier turn has already been answered, and amending it would rewrite history.
        let mut last_tool_idx: Option<usize> = None;
        // The round that just closed, for the next gate question.
        let mut last_round: Option<RoundSummary> = None;
        // A gate answer already given for the round about to start: a `resume` after a final answer. Asking
        // again at the top of the loop would put a second round trip between the same two rounds.
        let mut decided: Option<RoundDecision> = None;

        loop {
            if token.is_cancelled() {
                let stop = StopDecision { stop: true, reason: Some(StopReason::Cancelled), detail: None };
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
            }

            // Asked before the round opens, so a refusal is not recorded as a round that happened. The
            // cancellation check above comes first deliberately: a user's Stop outranks a policy question,
            // and asking the host about a run the user already ended would be a round trip for nothing.
            let gated = match (decided.take(), &self.gate) {
                (Some(decision), _) => decision,
                (None, Some(gate)) => {
                    self.flush().await;
                    let ctx = RoundContext {
                        round: state.round(),
                        usage: spent(&turns),
                        after_final: false,
                        last: last_round.take(),
                    };
                    // A user who presses Stop while the host is being asked about the next round must not
                    // wait for that answer first — it is a question about a run they have just ended.
                    tokio::select! {
                        biased;
                        _ = token.cancelled() => RoundDecision::stop("cancelled"),
                        d = gate.before_round(&ctx) => d,
                    }
                }
                (None, None) => RoundDecision::proceed(),
            };
            if !gated.proceed {
                // A Stop that landed while the gate was being asked is the user's cancellation, and says so;
                // anything else the gate refused is the host's rule.
                let reason =
                    if token.is_cancelled() { StopReason::Cancelled } else { StopReason::HostStopped };
                let stop = StopDecision {
                    stop: true,
                    reason: Some(reason),
                    detail: if token.is_cancelled() { None } else { gated.detail },
                };
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
            }

            // Before the round opens and before the context is prepared, so an injected instruction is part of
            // what a compaction sees rather than something appended behind its back.
            if let (Some(text), Some(i)) = (gated.nudge.as_deref(), last_tool_idx) {
                append_block(&mut wire[i], text);
            }
            let from = wire.len();
            wire.extend(gated.inject.iter().cloned());
            injected.extend(from..wire.len());

            state.begin_round();
            let reasoning = resolve_reasoning(
                self.config.thinking,
                state.phase(),
                &self.model.capabilities(),
                pending_effort.take(),
            );
            self.observer.round_started(state.round(), &reasoning);

            let started = Instant::now();
            let mut record = AgentTurnRecord {
                round: state.round() - 1,
                effort: reasoning.config.enabled.then_some(reasoning.config.effort),
                ..Default::default()
            };

            // Prepared here, after the phase was derived and before the request exists. A compaction has to
            // be recorded on the state as it happens: §6.1 makes the next round a planning round, and a flag
            // set after the request was built would apply it one round late.
            // One conversation, two views. `prepared` is the WIRE view — compacted, elided, summarised — and
            // it exists only for the request built below. `wire` is the conversation as it actually happened,
            // it is never written back to, and it is what [`LoopOutcome::messages`] returns.
            //
            // Assigning `wire = prepared` here would compile, pass every test about compaction, and quietly
            // replace the user's transcript with the lossy copy the model was sent. Compaction is for fitting
            // a window; it is not an edit to what the user said.
            let (prepared, compacted) = {
                let mut strategy = self.context.lock().await;
                strategy.prepare(&wire).await
            };
            if compacted {
                state.mark_compacted();
                self.observer.compacted(state.round());
            }

            let request = ModelRequest {
                model: self.config.model.clone(),
                messages: without_empty_assistant_turns(prepared),
                // Empty when the gate asked for an answer rather than more work. Not a withdrawal of the
                // tools from the run — the next round, if there is one, is offered them again.
                tools: if gated.withdraw_tools { Vec::new() } else { self.config.tools.clone() },
                reasoning_effort: reasoning.effort_param(),
            };

            // A provider failure ends the run through the stop policy rather than as an `Err`, so the caller
            // still receives every round that did complete. Losing a ten-round run because the eleventh
            // request was refused would throw away the work the user is waiting for.
            // Raced against the token, not merely checked before and after it.
            //
            // The token used to be consulted only between steps, so a Stop pressed while a request was in
            // flight waited for the provider to answer — seconds for a short reply, a minute or more for a long
            // one — and then discarded the answer anyway. The TypeScript loop aborts its fetch the moment Stop
            // is pressed, and a user comparing the two sees Stop that works and Stop that does not. Dropping
            // the future is what aborts the HTTP request; the round is recorded as far as it got.
            let completed = tokio::select! {
                biased;
                _ = token.cancelled() => None,
                r = self.model.complete(&request) => Some(r),
            };
            let Some(completed) = completed else {
                record.ms = started.elapsed().as_millis() as u64;
                turns.push(record);
                let stop = StopDecision { stop: true, reason: Some(StopReason::Cancelled), detail: None };
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
            };
            record.model_ms = started.elapsed().as_millis() as u64;
            let turn = match completed {
                Ok(turn) => turn,
                Err(e) => {
                    record.ms = started.elapsed().as_millis() as u64;
                    turns.push(record);
                    let stop = decide_stop(
                        &StopInput {
                            provider_error: Some(e.to_string()),
                            cancelled: token.is_cancelled(),
                            elapsed: Some(run_started.elapsed()),
                            round_elapsed: Some(started.elapsed()),
                            ..StopInput::new(&state)
                        },
                        &self.config.stop_policy,
                    );
                    self.observer.stopped(&stop);
                    return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
                }
            };

            let NormalizedTurn { content, reasoning: thought, tool_calls, usage } = turn;
            // The copy that is replayed: repaired where the model's arguments would make every later request
            // fail. The ORIGINALS are what execute, so the error a broken call reports is about what was sent.
            let replayed: Vec<ToolCall> = tool_calls
                .iter()
                .map(|c| match self.tools.replay_arguments(c) {
                    Some(arguments) => ToolCall { arguments, ..c.clone() },
                    None => c.clone(),
                })
                .collect();
            record.content = content.clone();
            record.reasoning = thought.clone();
            record.usage = usage.unwrap_or_default();
            record.tool_calls = replayed.clone();

            // The assistant turn is appended with its calls attached, before any result: the transcript has to
            // read in the order it happened, or the next request contradicts the one it is continuing.
            let mut assistant = Message::assistant_calls(content, replayed);
            if self.config.replay_reasoning && !thought.trim().is_empty() {
                assistant = assistant.with_reasoning(thought);
            }
            wire.push(assistant);
            self.observer.response_received(&record);
            // Before any tool runs, and so before any tool asks the host for anything: a host answering a tool
            // has already seen the reply that asked for it.
            self.flush().await;

            let mut verdicts: Vec<CallVerdict> = Vec::with_capacity(tool_calls.len());
            let mut signals: Vec<SignalRecord> = Vec::new();
            for group in group_calls(&tool_calls, &self.config.parallel_safe) {
                // Checked per batch, not only per round: a fan-out of twelve calls must stop at the one the
                // user interrupted, not run the remaining eleven first.
                if token.is_cancelled() {
                    break;
                }
                for call in &group {
                    self.observer.tool_started(call);
                }
                let executed: Vec<ToolRecord> = if group.len() == 1 {
                    vec![self.execute_one(group[0], &token).await]
                } else {
                    futures_util::future::join_all(group.iter().map(|call| self.execute_one(call, &token))).await
                };

                // Folded in the order the model asked, whichever finished first, so the results line up with
                // `tool_calls` and the detector reads the same sequence either way.
                for executed in executed {
                    // Execution state first, so the phase reflects a failure immediately; then the detector,
                    // whose verdicts are per call and whose escalation is per round.
                    state.record_tool_result(&executed.name, executed.ok);
                    let verdict = doom.observe(&CallObservation {
                        name: &executed.name,
                        args: &executed.args,
                        result: &executed.content,
                        ok: executed.ok,
                    });
                    if let Some(signal) = verdict.signal {
                        self.observer.doom_signal(signal, &executed, &verdict);
                        signals.push(SignalRecord {
                            call_id: executed.tool_call_id.clone(),
                            name: executed.name.clone(),
                            signal,
                            repeat: verdict.repeat,
                            fail_streak: verdict.fail_streak,
                            resource_hits: verdict.resource_hits,
                        });
                    }
                    verdicts.push(verdict);

                    wire.push(Message::tool_result(&executed.tool_call_id, &executed.content));
                    last_tool_idx = Some(wire.len() - 1);
                    self.observer.tool_finished(&executed);
                    record.tool_results.push(executed);
                }
                // Delivered before the next batch starts, so a host that stores results as they arrive stores them
                // in the order the model asked — and has this batch's results before it is asked to run the next.
                self.flush().await;
            }

            let round_verdict = doom.close_round(&verdicts);
            let final_response = tool_calls.is_empty();
            if final_response {
                state.end_round_without_tools();
            }

            record.ms = started.elapsed().as_millis() as u64;
            self.observer.round_finished(&record);
            let summary = RoundSummary::of(&record, signals);
            turns.push(record);

            let stop = decide_stop(
                &StopInput {
                    cancelled: token.is_cancelled(),
                    doom_loop_escalated: round_verdict.escalate,
                    final_response,
                    // Measured, not estimated. `round_elapsed` covers the model call AND the tools it asked
                    // for, because a round stuck in either is stuck for the user either way.
                    elapsed: Some(run_started.elapsed()),
                    round_elapsed: Some(started.elapsed()),
                    ..StopInput::new(&state)
                },
                &self.config.stop_policy,
            );

            if stop.stop {
                if stop.reason == Some(StopReason::Completed) {
                    // A final answer the host may send back for another round. Only a COMPLETED run: one the stop
                    // policy ended for any other reason ended for a reason the host cannot talk it out of.
                    if let Some(gate) = self.gate.as_ref().filter(|_| !token.is_cancelled()) {
                        self.flush().await;
                        let ctx = RoundContext {
                            round: state.round(),
                            usage: spent(&turns),
                            after_final: true,
                            last: Some(summary),
                        };
                        let decision = tokio::select! {
                            biased;
                            _ = token.cancelled() => RoundDecision::default(),
                            d = gate.before_round(&ctx) => d,
                        };
                        if decision.resume && decision.proceed && !token.is_cancelled() {
                            decided = Some(decision);
                            continue;
                        }
                    }
                    state.mark_completed();
                }
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
            }
            last_round = Some(summary);
        }
    }

    /// Wait for the observer to deliver everything reported so far. See [`LoopObserver::flush`].
    async fn flush(&self) {
        if let Some(delivered) = self.observer.flush() {
            // An observer whose delivery has stopped drops the sender, which ends this wait too.
            let _ = delivered.await;
        }
    }

    /// Run one call, timed.
    async fn execute_one(&self, call: &ToolCall, token: &CancellationToken) -> ToolRecord {
        let began = Instant::now();
        let (name, args, outcome) = self.tools.execute(call, token).await;
        ToolRecord {
            tool_call_id: call.id.clone(),
            name,
            args,
            content: outcome.content,
            ok: outcome.ok,
            ms: began.elapsed().as_millis() as u64,
        }
    }
}

/// Everything the run has spent, for a gate deciding against a budget.
fn spent(turns: &[AgentTurnRecord]) -> Usage {
    turns.iter().fold(Usage::default(), |mut acc, t| {
        acc.prompt_tokens += t.usage.prompt_tokens;
        acc.completion_tokens += t.usage.completion_tokens;
        acc.cached_tokens += t.usage.cached_tokens;
        acc.estimated |= t.usage.estimated;
        acc
    })
}

/// Batch consecutive parallel-safe calls; everything else runs alone, in order. `groupParallelCalls`'s rule.
fn group_calls<'a>(calls: &'a [ToolCall], parallel_safe: &HashSet<String>) -> Vec<Vec<&'a ToolCall>> {
    let mut groups: Vec<Vec<&ToolCall>> = Vec::new();
    for call in calls {
        let safe = parallel_safe.contains(&call.name);
        match groups.last_mut() {
            Some(prev) if safe && parallel_safe.contains(&prev[0].name) => prev.push(call),
            _ => groups.push(vec![call]),
        }
    }
    groups
}

/// Append `text` to a message's content, joined with a blank line — how the chat page folds a reminder into a
/// tool result, so a turn replayed from its storage later reads byte for byte as it was sent now.
fn append_block(message: &mut Message, text: &str) {
    if text.is_empty() {
        return;
    }
    match &mut message.content {
        serde_json::Value::String(s) if s.contains(text) => {}
        serde_json::Value::String(s) if s.is_empty() => *s = text.to_owned(),
        serde_json::Value::String(s) => {
            s.push_str("\n\n");
            s.push_str(text);
        }
        serde_json::Value::Array(parts) => parts.push(serde_json::json!({ "type": "text", "text": text })),
        other => *other = serde_json::Value::String(text.to_owned()),
    }
}

/// The request without assistant turns that say nothing: no text and no calls.
///
/// Invalid to send — several providers refuse an empty assistant message — and they happen: a model that ends
/// a round in silence, which a gate then resumes. The conversation keeps them; only the request drops them, as
/// `sanitizeToolCallPairs` does in the chat page.
fn without_empty_assistant_turns(messages: Vec<Message>) -> Vec<Message> {
    if !messages.iter().any(is_empty_assistant_turn) {
        return messages;
    }
    messages.into_iter().filter(|m| !is_empty_assistant_turn(m)).collect()
}

fn is_empty_assistant_turn(m: &Message) -> bool {
    m.role == "assistant"
        && m.tool_calls.is_empty()
        && match &m.content {
            serde_json::Value::Null => true,
            serde_json::Value::String(s) => s.trim().is_empty(),
            serde_json::Value::Array(a) => a.is_empty(),
            _ => false,
        }
}
