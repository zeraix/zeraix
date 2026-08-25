//! Task descriptions and outcomes.

use agent_core::{CancellationToken, RuntimeError, TaskId, TaskState};
use agent_resource::ResourceClass;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Scheduling priority. Ordered so `Critical` sorts highest.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Background,
    #[default]
    Normal,
    High,
    /// Reserved for work the user is actively waiting on.
    Critical,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Background => "background",
            Priority::Normal => "normal",
            Priority::High => "high",
            Priority::Critical => "critical",
        }
    }
}

/// How a failed task should be retried.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    /// Delay multiplier per attempt.
    pub factor: u32,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1, // no retry
            base_delay: Duration::from_millis(200),
            factor: 2,
            max_delay: Duration::from_secs(30),
        }
    }
}

impl RetryPolicy {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn attempts(n: u32) -> Self {
        Self { max_attempts: n.max(1), ..Self::default() }
    }

    /// Backoff before `attempt` (1-based). Saturating, so a large factor cannot overflow into a
    /// nonsensically short delay.
    pub fn delay_for(&self, attempt: u32) -> Duration {
        let mult = self.factor.saturating_pow(attempt.saturating_sub(1));
        self.base_delay.saturating_mul(mult).min(self.max_delay)
    }
}

/// What the scheduler needs to know before it can run something.
pub struct TaskSpec {
    pub id: TaskId,
    pub priority: Priority,
    /// Parent task, if this is a child. Its cancellation token becomes this task's parent, so
    /// cancelling the parent cancels the whole subtree (spec §9, §14).
    pub parent: Option<TaskId>,
    /// Tasks that must complete successfully first.
    pub depends_on: Vec<TaskId>,
    /// Which quota bucket this task draws from.
    pub resource: ResourceClass,
    /// Wall-clock ceiling for a single attempt.
    pub timeout: Option<Duration>,
    pub retry: RetryPolicy,
    /// Human-readable label for logs and events.
    pub label: String,
}

impl TaskSpec {
    pub fn new(label: impl Into<String>, resource: ResourceClass) -> Self {
        Self {
            id: TaskId::new(),
            priority: Priority::Normal,
            parent: None,
            depends_on: Vec::new(),
            resource,
            timeout: None,
            retry: RetryPolicy::none(),
            label: label.into(),
        }
    }

    pub fn with_id(mut self, id: TaskId) -> Self {
        self.id = id;
        self
    }
    pub fn with_priority(mut self, p: Priority) -> Self {
        self.priority = p;
        self
    }
    pub fn with_parent(mut self, parent: TaskId) -> Self {
        self.parent = Some(parent);
        self
    }
    pub fn depends_on(mut self, deps: impl IntoIterator<Item = TaskId>) -> Self {
        self.depends_on.extend(deps);
        self
    }
    pub fn with_timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }
    pub fn with_retry(mut self, r: RetryPolicy) -> Self {
        self.retry = r;
        self
    }
}

/// What a task body is given when it runs.
#[derive(Clone)]
pub struct TaskContext {
    pub id: TaskId,
    /// Cancelled when this task, its parent, or the whole scheduler is cancelled.
    pub cancel: CancellationToken,
    /// 1-based; increments on retry so a body can log or vary behaviour.
    pub attempt: u32,
}

impl TaskContext {
    pub fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

pub type TaskFuture = Pin<Box<dyn Future<Output = agent_core::Result<()>> + Send>>;
/// Boxed because the queue holds heterogeneous work; `FnMut` rather than `FnOnce` so a retry can
/// build a fresh future for the next attempt.
pub type TaskBody = Box<dyn FnMut(TaskContext) -> TaskFuture + Send>;

/// How a task ended.
#[derive(Debug, Clone)]
pub enum Outcome {
    Completed,
    Failed(RuntimeError),
    Cancelled,
    /// A dependency did not complete, so this task never ran.
    DependencyFailed(TaskId),
}

impl Outcome {
    pub fn state(&self) -> TaskState {
        match self {
            Outcome::Completed => TaskState::Completed,
            Outcome::Failed(_) | Outcome::DependencyFailed(_) => TaskState::Failed,
            Outcome::Cancelled => TaskState::Cancelled,
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self, Outcome::Completed)
    }
}

/// Compared by shape and error *code*, not by message.
///
/// `RuntimeError` carries a formatted message and an optional cause, neither of which is a stable
/// identity — two ENOENTs on different paths are the same kind of failure. Tests and retry policy both
/// want "did this fail the same way?", so that is what equality means here.
impl PartialEq for Outcome {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Outcome::Completed, Outcome::Completed) => true,
            (Outcome::Cancelled, Outcome::Cancelled) => true,
            (Outcome::Failed(a), Outcome::Failed(b)) => a.code == b.code,
            (Outcome::DependencyFailed(a), Outcome::DependencyFailed(b)) => a == b,
            _ => false,
        }
    }
}

/// A point-in-time record of one task, for `snapshot()` and crash recovery (spec §1).
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskRecord {
    pub id: String,
    pub label: String,
    pub state: TaskState,
    pub priority: String,
    pub resource: String,
    pub parent: Option<String>,
    pub attempt: u32,
    pub waiting_on: Vec<String>,
}
