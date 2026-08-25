//! Agent and task state machines (spec §4, §6).
//!
//! Stage 1 does not drive these — it executes single tool calls and returns. They are defined now
//! because the wire protocol names them, and a state added after the protocol ships is a breaking
//! change to every host that switches on it.
//!
//! The transition tables are the point. Writing them as data, checked by `can_transition`, is what
//! makes "the scheduler moved a task from Completed back to Running" a test failure instead of a
//! debugging session six weeks later.

use serde::{Deserialize, Serialize};

/// Where an agent is in its life (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Created,
    Queued,
    Running,
    Thinking,
    ToolCalling,
    WaitingTool,
    WaitingApproval,
    Blocked,
    Completed,
    Failed,
    Cancelled,
    Timeout,
}

impl AgentState {
    /// Terminal states never transition again.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            AgentState::Completed | AgentState::Failed | AgentState::Cancelled | AgentState::Timeout
        )
    }

    /// Whether `self -> next` is legal.
    ///
    /// Cancellation and timeout are reachable from any non-terminal state — that is exactly what
    /// spec §14 requires of a runtime-level cancellation: no state may be a place an agent can hide
    /// from Stop.
    pub fn can_transition(self, next: AgentState) -> bool {
        use AgentState::*;
        if self.is_terminal() {
            return false;
        }
        if matches!(next, Cancelled | Timeout | Failed) {
            return true;
        }
        matches!(
            (self, next),
            (Created, Queued)
                | (Queued, Running)
                | (Running, Thinking)
                | (Thinking, ToolCalling)
                | (Thinking, Completed)
                | (ToolCalling, WaitingApproval)
                | (ToolCalling, WaitingTool)
                | (WaitingApproval, WaitingTool)
                | (WaitingApproval, Blocked)
                | (WaitingTool, Thinking)
                | (Blocked, Thinking)
                | (Running, Completed)
        )
    }
}

/// Where a unit of scheduled work is (spec §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskState::Completed | TaskState::Failed | TaskState::Cancelled)
    }

    pub fn can_transition(self, next: TaskState) -> bool {
        use TaskState::*;
        if self.is_terminal() {
            return false;
        }
        if matches!(next, Cancelled | Failed) {
            return true;
        }
        matches!(
            (self, next),
            (Pending, Running) | (Running, Waiting) | (Waiting, Running) | (Running, Completed)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states_are_final() {
        for s in [AgentState::Completed, AgentState::Failed, AgentState::Cancelled, AgentState::Timeout] {
            assert!(s.is_terminal());
            assert!(!s.can_transition(AgentState::Running), "{s:?} must not resurrect");
        }
    }

    #[test]
    fn cancellation_reaches_every_live_state() {
        // Spec §14: no non-terminal state may be unreachable by Stop.
        for s in [
            AgentState::Created,
            AgentState::Queued,
            AgentState::Running,
            AgentState::Thinking,
            AgentState::ToolCalling,
            AgentState::WaitingTool,
            AgentState::WaitingApproval,
            AgentState::Blocked,
        ] {
            assert!(s.can_transition(AgentState::Cancelled), "{s:?} must be cancellable");
        }
    }

    #[test]
    fn task_waiting_round_trips() {
        assert!(TaskState::Running.can_transition(TaskState::Waiting));
        assert!(TaskState::Waiting.can_transition(TaskState::Running));
        assert!(!TaskState::Completed.can_transition(TaskState::Running));
    }
}
