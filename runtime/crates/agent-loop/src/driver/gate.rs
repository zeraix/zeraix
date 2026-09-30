//! The round gate: the host's say, between rounds, in whether a run may continue — and what it is told to decide.

use super::AgentTurnRecord;
use crate::doom::DoomSignal;
use crate::model::{Message, Usage};

/// The host's right to stop the loop between rounds.
///
/// ## Why the loop does not decide this itself
///
/// Everything in [`StopPolicyConfig`](crate::stop::StopPolicyConfig) is something the loop can observe: a failure count, a clock, a context
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
    pub(super) fn of(record: &AgentTurnRecord, signals: Vec<SignalRecord>) -> Self {
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
    /// False ends the run with [`StopReason::HostStopped`](crate::stop::StopReason::HostStopped).
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
