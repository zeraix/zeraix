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
    /// Held at the user's request (TODO §2.1).
    ///
    /// Distinct from `Waiting`, which the runtime enters on its own while a retry backs off or a dependency
    /// settles. `Paused` is a decision someone made, and only the matching decision undoes it — so the two
    /// must not share a state, or a resume would race a backoff and "continue" a task the runtime had already
    /// decided to continue by itself.
    ///
    /// Only work that has not started can be paused. A running body cannot be suspended mid-call: it may hold
    /// a child process or a half-written file, and the honest way to stop one is to cancel it.
    Paused,
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
            (Pending, Running)
                | (Running, Waiting)
                | (Waiting, Running)
                | (Running, Completed)
                // Pause and resume, both directions. `Waiting` may be paused too: a task backing off before a
                // retry is exactly the kind a user wants to hold.
                | (Pending, Paused)
                | (Waiting, Paused)
                | (Paused, Pending)
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
    fn a_paused_task_can_be_resumed_and_is_never_stuck() {
        assert!(TaskState::Pending.can_transition(TaskState::Paused));
        assert!(TaskState::Waiting.can_transition(TaskState::Paused));
        assert!(TaskState::Paused.can_transition(TaskState::Pending));
        // Paused is not terminal — a paused task is still work the runtime owes an answer for.
        assert!(!TaskState::Paused.is_terminal());
    }

    /// A running body may hold a child process or a half-written file; there is no honest way to freeze it.
    #[test]
    fn a_running_task_cannot_be_paused_only_cancelled() {
        assert!(!TaskState::Running.can_transition(TaskState::Paused));
        assert!(TaskState::Running.can_transition(TaskState::Cancelled));
    }

    /// Spec §14 again, for the state this change adds: nothing may become un-stoppable by being paused.
    #[test]
    fn a_paused_task_is_still_cancellable() {
        assert!(TaskState::Paused.can_transition(TaskState::Cancelled));
        assert!(TaskState::Paused.can_transition(TaskState::Failed));
    }

    #[test]
    fn task_waiting_round_trips() {
        assert!(TaskState::Running.can_transition(TaskState::Waiting));
        assert!(TaskState::Waiting.can_transition(TaskState::Running));
        assert!(!TaskState::Completed.can_transition(TaskState::Running));
    }
}
