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

mod context;
mod gate;
mod observer;
mod tools;

pub use context::{ContextStrategy, PassThroughContext};
pub use gate::{CallSummary, RoundContext, RoundDecision, RoundGate, RoundSummary, SignalRecord};
pub use observer::{LoopObserver, NoObserver};
pub use tools::{ToolExecutor, ToolOutcome, ToolRecord};

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use agent_core::{CancellationToken, Result};

use crate::doom::{CallObservation, CallVerdict, DoomLoop};
use crate::model::{Message, ModelClient, ModelRequest, NormalizedTurn, ToolCall, Usage};
use crate::reasoning::{Effort, ThinkingConfig, resolve_reasoning};
use crate::state::ExecutionState;
use crate::stop::{StopDecision, StopInput, StopPolicyConfig, StopReason, decide_stop};

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
            //
            // Raced against the token like the model request below, and for the same reason: preparing can
            // itself be a model request — a summary — with its own retries, and a Stop that waited for it to
            // finish could wait minutes. Dropping the future aborts that request too.
            let prepared = {
                let mut strategy = self.context.lock().await;
                tokio::select! {
                    biased;
                    _ = token.cancelled() => None,
                    p = strategy.prepare(&wire) => Some(p),
                }
            };
            let Some((prepared, compacted)) = prepared else {
                record.ms = started.elapsed().as_millis() as u64;
                turns.push(record);
                let stop = StopDecision { stop: true, reason: Some(StopReason::Cancelled), detail: None };
                self.observer.stopped(&stop);
                return Ok(LoopOutcome { stop, state, turns, messages: wire, injected });
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
            for group in group_calls(&tool_calls, |c| self.tools.resolved_name(c), &self.config.parallel_safe) {
                // Checked per batch, not only per round: a fan-out of twelve calls must stop at the one the
                // user interrupted, not run the remaining eleven first.
                if token.is_cancelled() {
                    break;
                }
                for call in &group {
                    self.observer.tool_started(call);
                }
                // Delivered before any of them runs. A host tool asks the host directly, not through the event
                // channel, so without this the host could be asked to run a call it has not yet been told began.
                self.flush().await;
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

/// Batch consecutive parallel-safe calls; everything else runs alone, in order. `groupParallelCalls`'s rule,
/// applied as it is there to the RESOLVED name (`name_of`), so a read reached through a dispatcher is a read.
fn group_calls<'a>(
    calls: &'a [ToolCall],
    name_of: impl Fn(&ToolCall) -> String,
    parallel_safe: &HashSet<String>,
) -> Vec<Vec<&'a ToolCall>> {
    let mut groups: Vec<Vec<&ToolCall>> = Vec::new();
    // Whether the group being built may take another member: it began with a parallel-safe call.
    let mut open = false;
    for call in calls {
        let safe = parallel_safe.contains(&name_of(call));
        match groups.last_mut() {
            Some(prev) if safe && open => prev.push(call),
            _ => {
                groups.push(vec![call]);
                open = safe;
            }
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
