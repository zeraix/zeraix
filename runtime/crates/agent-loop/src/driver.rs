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
    pub ms: u64,
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
}

/// What the caller learns when the run ends.
pub struct LoopOutcome {
    pub stop: StopDecision,
    pub state: ExecutionState,
    pub turns: Vec<AgentTurnRecord>,
    /// The conversation as it now stands, including every assistant turn and tool result the loop appended.
    pub messages: Vec<Message>,
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
pub trait ContextStrategy: Send + Sync {
    /// Produce the messages for this round.
    ///
    /// Returns the wire array and whether anything was compacted to produce it. The loop uses the flag to move
    /// the execution state — §6.1 makes the round after a compaction a planning round, because the model is
    /// about to be handed a conversation it has not seen before.
    fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool);
}

/// The default: hand the conversation over untouched.
///
/// A loop with no strategy is not a loop with a broken one — it is a loop whose caller has not asked for
/// context management, and it must behave exactly as it did before the trait existed.
pub struct PassThroughContext;
impl ContextStrategy for PassThroughContext {
    fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool) {
        (messages.to_vec(), false)
    }
}

/// Observers of a run, for the UI and the audit log.
///
/// Every hook is optional and none may fail the run: an observer that returns an error would give reporting
/// the power to stop work, which is backwards.
#[allow(unused_variables)]
pub trait LoopObserver: Send + Sync {
    fn round_started(&self, round: u32, decision: &ReasoningDecision) {}
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
}

/// The no-op observer, so a caller that wants none does not have to write one.
pub struct NoObserver;
impl LoopObserver for NoObserver {}

pub struct AgentLoop {
    model: Arc<dyn ModelClient>,
    tools: Arc<dyn ToolExecutor>,
    observer: Arc<dyn LoopObserver>,
    /// Behind a `Mutex` because preparing the context mutates it — a manager that compacts has to remember
    /// that it did, or it would compact the same conversation again next round.
    context: std::sync::Mutex<Box<dyn ContextStrategy>>,
    config: LoopConfig,
}

impl AgentLoop {
    pub fn new(model: Arc<dyn ModelClient>, tools: Arc<dyn ToolExecutor>, config: LoopConfig) -> Self {
        Self {
            model,
            tools,
            observer: Arc::new(NoObserver),
            context: std::sync::Mutex::new(Box::new(PassThroughContext)),
            config,
        }
    }

    /// Keep the conversation within the model's window using `strategy`.
    pub fn with_context(mut self, strategy: Box<dyn ContextStrategy>) -> Self {
        self.context = std::sync::Mutex::new(strategy);
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
        // Carried across exactly one round: a model's effort override applies to the next turn and lapses.
        let mut pending_effort: Option<Effort> = None;
        // The run's own clock, for §9.1's deadlines. Started here rather than by the caller so that a slow
        // caller cannot make a run look as though it had already used its budget before it began.
        let run_started = Instant::now();

        loop {
            if token.is_cancelled() {
                let stop = StopDecision { stop: true, reason: Some(StopReason::Cancelled), detail: None };
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire });
            }

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
            let (prepared, compacted) = {
                let mut strategy = self.context.lock().expect("context strategy");
                strategy.prepare(&wire)
            };
            if compacted {
                state.mark_compacted();
                self.observer.compacted(state.round());
            }

            let request = ModelRequest {
                model: self.config.model.clone(),
                messages: prepared,
                tools: self.config.tools.clone(),
                reasoning_effort: reasoning.effort_param(),
            };

            // A provider failure ends the run through the stop policy rather than as an `Err`, so the caller
            // still receives every round that did complete. Losing a ten-round run because the eleventh
            // request was refused would throw away the work the user is waiting for.
            let turn = match self.model.complete(&request).await {
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
                    return Ok(LoopOutcome { stop, state, turns, messages: wire });
                }
            };

            let NormalizedTurn { content, reasoning: thought, tool_calls, usage } = turn;
            record.content = content.clone();
            record.reasoning = thought;
            record.usage = usage.unwrap_or_default();
            record.tool_calls = tool_calls.clone();

            // The assistant turn is appended with its calls attached, before any result: the transcript has to
            // read in the order it happened, or the next request contradicts the one it is continuing.
            wire.push(Message::assistant_calls(content, tool_calls.clone()));

            let mut verdicts: Vec<CallVerdict> = Vec::with_capacity(tool_calls.len());
            for call in &tool_calls {
                // Checked per call, not only per round: a fan-out of twelve calls must stop at the one the
                // user interrupted, not run the remaining eleven first.
                if token.is_cancelled() {
                    break;
                }
                self.observer.tool_started(call);
                let began = Instant::now();
                let (name, args, outcome) = self.tools.execute(call, &token).await;
                let executed = ToolRecord {
                    tool_call_id: call.id.clone(),
                    name,
                    args,
                    content: outcome.content,
                    ok: outcome.ok,
                    ms: began.elapsed().as_millis() as u64,
                };

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
                }
                verdicts.push(verdict);

                wire.push(Message::tool_result(&executed.tool_call_id, &executed.content));
                self.observer.tool_finished(&executed);
                record.tool_results.push(executed);
            }

            let round_verdict = doom.close_round(&verdicts);
            let final_response = tool_calls.is_empty();
            if final_response {
                state.end_round_without_tools();
            }

            record.ms = started.elapsed().as_millis() as u64;
            self.observer.round_finished(&record);
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
                    state.mark_completed();
                }
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire });
            }
        }
    }
}
