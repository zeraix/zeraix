//! Observers of a run: the hooks the UI and the audit log listen on.

use super::{AgentTurnRecord, ToolRecord};
use crate::doom::{CallVerdict, DoomSignal};
use crate::model::ToolCall;
use crate::reasoning::ReasoningDecision;
use crate::stop::StopDecision;

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
    /// [`ToolExecutor::replay_arguments`](super::ToolExecutor::replay_arguments)). A host that keeps its own copy of the conversation stores the
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
