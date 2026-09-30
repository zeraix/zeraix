//! The task scheduler (spec §6).
//!
//! ## What it replaces
//!
//! Nothing, which is the point. The runtime being migrated has no scheduler at all: round order is a
//! `while (true)` inside a React component, and parallelism is `Promise.all` over a batch of calls
//! whose names appear in a `PARALLEL_SAFE_TOOLS` set. There is no priority, no quota, no dependency
//! graph, no queue, and no persisted state — so a renderer crash loses the turn outright.
//!
//! ## Shape: one owner, messages in
//!
//! All mutable scheduling state lives in a single driver task and is reached only by sending it
//! messages. No mutex, no shared map, no lock ordering to get wrong — and the concurrency argument for
//! the whole module reduces to "the driver processes one command at a time", which is small enough to
//! actually verify.
//!
//! The driver never blocks on work. It starts tasks, and each task reports back through the same
//! command channel when it settles. A long-running task therefore cannot delay a cancellation, a new
//! submission, or a snapshot — the property that makes Stop responsive, and the one the JS runtime
//! cannot have because an `ipcMain.handle` promise is uninterruptible.
//!
//! ## Cancellation
//!
//! Every task's token is derived from its parent's, and every parent's from the scheduler root. So
//! cancelling a parent cancels its entire subtree, and shutting the scheduler down cancels everything,
//! without anyone maintaining a list of who to notify (spec §14).
//!
//! ## What is deliberately absent
//!
//! Work stealing, fairness beyond priority, and any attempt to schedule across processes. Tokio's
//! multi-threaded runtime already does the first, and the other two are not problems this system has.

mod driver;
mod queue;
pub mod task;

pub use driver::CANCEL_GRACE;
pub use task::{Outcome, Priority, RetryPolicy, TaskBody, TaskContext, TaskFuture, TaskRecord, TaskSpec};

use agent_core::{CancellationToken, Result, RuntimeError, TaskId};
use agent_events::EventBus;
use agent_journal::Journal;
use agent_resource::ResourceManager;
use tokio::sync::{mpsc, oneshot};

/// Messages the driver accepts. Everything that mutates scheduling state is one of these.
enum Command {
    Submit {
        spec: Box<TaskSpec>,
        body: TaskBody,
        reply: oneshot::Sender<Result<()>>,
    },
    /// A task finished an attempt.
    ///
    /// The body rides back with the report. It has to: `TaskBody` is a boxed `FnMut` and cannot be
    /// cloned, so the only way a retry can build a second future is for the worker to hand ownership
    /// back to the driver when the attempt ends.
    Settled {
        id: TaskId,
        outcome: Outcome,
        attempt: u32,
        body: Option<TaskBody>,
    },
    /// A retry's backoff elapsed; the task is ready to run again.
    Requeue {
        id: TaskId,
    },
    /// Ask to be told this task's outcome.
    Watch {
        id: TaskId,
        reply: oneshot::Sender<Outcome>,
    },
    Cancel {
        id: TaskId,
    },
    /// Hold a task that has not started. See `Driver::on_pause`.
    Pause {
        id: TaskId,
        reply: oneshot::Sender<bool>,
    },
    Resume {
        id: TaskId,
        reply: oneshot::Sender<bool>,
    },
    Snapshot {
        reply: oneshot::Sender<Vec<TaskRecord>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// Handle to a running scheduler. Cheap to clone.
#[derive(Clone)]
pub struct Scheduler {
    tx: mpsc::UnboundedSender<Command>,
    root: CancellationToken,
}

impl Scheduler {
    /// Start a scheduler on the current Tokio runtime, with no durable state.
    ///
    /// Equivalent to `start_journalled` with `Journal::disabled()`. Kept as the default because durability is
    /// a deployment choice: the tests, the parity harness and any embedder that has nowhere to write should
    /// not have to name a path they will never read.
    pub fn start(resources: ResourceManager, events: EventBus) -> Self {
        Self::start_journalled(resources, events, Journal::disabled())
    }

    /// Start a scheduler that records the task lifecycle to `journal`.
    ///
    /// What that buys is in `agent-journal`'s header: after a crash, [`agent_journal::replay`] can say which
    /// tasks were merely queued (safe to submit again) and which had begun (may have had side effects, and so
    /// are reported rather than repeated).
    pub fn start_journalled(resources: ResourceManager, events: EventBus, journal: Journal) -> Self {
        let (tx, root) = driver::spawn(resources, events, journal);
        Self { tx, root }
    }

    /// Queue a task. Returns once it is *accepted*, not once it has run.
    pub async fn submit(&self, spec: TaskSpec, body: TaskBody) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Submit { spec: Box::new(spec), body, reply })
            .map_err(|_| shutdown_error())?;
        rx.await.map_err(|_| shutdown_error())?
    }

    /// Queue a task and wait for its outcome.
    pub async fn run_to_completion(&self, spec: TaskSpec, body: TaskBody) -> Result<Outcome> {
        let id = spec.id.clone();
        let (done_tx, done_rx) = oneshot::channel();
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Submit { spec: Box::new(spec), body, reply })
            .map_err(|_| shutdown_error())?;
        rx.await.map_err(|_| shutdown_error())??;
        self.tx.send(Command::Watch { id, reply: done_tx }).map_err(|_| shutdown_error())?;
        done_rx.await.map_err(|_| shutdown_error())
    }

    /// Cancel a task and everything beneath it.
    pub fn cancel(&self, id: &TaskId) {
        let _ = self.tx.send(Command::Cancel { id: id.clone() });
    }

    /// Hold a task that has not started yet.
    ///
    /// Returns whether it was paused. `false` means it could not be — it is already running, already finished,
    /// or unknown — and that is an answer rather than an error, because "pause this" against work that has
    /// already begun is a question with a legitimate negative answer that the caller needs to hear.
    ///
    /// A RUNNING task is deliberately not pausable: its body may hold a child process or a half-written file,
    /// and there is no way to freeze that honestly. Cancelling is the operation for work in flight.
    pub async fn pause(&self, id: &TaskId) -> bool {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Command::Pause { id: id.clone(), reply }).is_err() {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Return a paused task to the queue. Returns whether it was resumed.
    pub async fn resume(&self, id: &TaskId) -> bool {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Command::Resume { id: id.clone(), reply }).is_err() {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Current state of every known task.
    pub async fn snapshot(&self) -> Vec<TaskRecord> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Command::Snapshot { reply }).is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Cancel everything and wait for the driver to finish (spec §6: graceful shutdown).
    pub async fn shutdown(&self) {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Command::Shutdown { reply }).is_ok() {
            let _ = rx.await;
        }
        self.root.cancel();
    }

    /// The root token. Every task's cancellation derives from this.
    pub fn root_token(&self) -> &CancellationToken {
        &self.root
    }
}

fn shutdown_error() -> RuntimeError {
    RuntimeError::new(
        "scheduler.stopped",
        agent_core::ErrorClass::Internal,
        "the scheduler is no longer running",
    )
}
