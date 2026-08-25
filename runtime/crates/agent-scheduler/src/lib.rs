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

mod queue;
pub mod task;

pub use task::{Outcome, Priority, RetryPolicy, TaskBody, TaskContext, TaskFuture, TaskRecord, TaskSpec};

use agent_core::{CancellationToken, Result, RuntimeError, TaskId, TaskState};
use agent_events::{EventBus, EventKind};
use agent_resource::ResourceManager;
use queue::ReadyQueue;
use std::collections::HashMap;
use std::time::{Duration, Instant};
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
    Snapshot {
        reply: oneshot::Sender<Vec<TaskRecord>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// Everything the driver knows about one task.
struct Entry {
    spec: Box<TaskSpec>,
    body: Option<TaskBody>,
    state: TaskState,
    token: CancellationToken,
    attempt: u32,
    started: Option<Instant>,
    /// Dependencies not yet satisfied.
    pending_deps: Vec<TaskId>,
    /// Who is waiting on this task's outcome.
    waiters: Vec<oneshot::Sender<Outcome>>,
    /// The settled outcome, kept verbatim.
    ///
    /// Reconstructing it from `TaskState` instead loses everything that matters: `Failed` cannot say
    /// *why*, and `DependencyFailed` collapses into a generic failure. It also has to be recorded
    /// because a watcher can arrive after the task has already settled — `run_to_completion` submits
    /// and then watches, and a task that fails during submission (an unknown dependency) is terminal
    /// before the watch is registered.
    outcome: Option<Outcome>,
}

/// Handle to a running scheduler. Cheap to clone.
#[derive(Clone)]
pub struct Scheduler {
    tx: mpsc::UnboundedSender<Command>,
    root: CancellationToken,
}

impl Scheduler {
    /// Start a scheduler on the current Tokio runtime.
    pub fn start(resources: ResourceManager, events: EventBus) -> Self {
        // Unbounded because the *producer* here is the runtime itself reporting settled tasks; a
        // bounded channel would let a full queue deadlock the driver against its own workers. Growth
        // is bounded instead by the resource quotas, which is where a limit belongs.
        let (tx, rx) = mpsc::unbounded_channel();
        let root = CancellationToken::new();
        let driver = Driver {
            rx,
            tx: tx.clone(),
            resources,
            events,
            root: root.clone(),
            entries: HashMap::new(),
            ready: ReadyQueue::new(),
            dependents: HashMap::new(),
            shutting_down: false,
        };
        tokio::spawn(driver.run());
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

struct Driver {
    rx: mpsc::UnboundedReceiver<Command>,
    tx: mpsc::UnboundedSender<Command>,
    resources: ResourceManager,
    events: EventBus,
    root: CancellationToken,
    entries: HashMap<TaskId, Entry>,
    ready: ReadyQueue,
    /// dependency -> tasks blocked on it.
    dependents: HashMap<TaskId, Vec<TaskId>>,
    shutting_down: bool,
}

impl Driver {
    async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                Command::Submit { spec, body, reply } => {
                    let r = self.on_submit(spec, body);
                    let _ = reply.send(r);
                    self.pump();
                }
                Command::Watch { id, reply } => self.on_watch(id, reply),
                Command::Settled { id, outcome, attempt, body } => {
                    self.on_settled(id, outcome, attempt, body);
                    self.pump();
                }
                Command::Requeue { id } => {
                    self.on_requeue(id);
                    self.pump();
                }
                Command::Cancel { id } => {
                    self.on_cancel(&id);
                    self.pump();
                }
                Command::Snapshot { reply } => {
                    let _ = reply.send(self.snapshot());
                }
                Command::Shutdown { reply } => {
                    self.shutting_down = true;
                    self.root.cancel();
                    self.events.publish(EventKind::RuntimeShutdown);
                    // Queued-but-unstarted work is resolved as cancelled rather than dropped, so a
                    // caller awaiting an outcome is answered instead of hanging on a lost sender.
                    let queued: Vec<TaskId> = self.ready.drain().collect();
                    for id in queued {
                        self.finish(&id, Outcome::Cancelled);
                    }
                    let _ = reply.send(());
                    return;
                }
            }
        }
    }

    fn on_submit(&mut self, spec: Box<TaskSpec>, body: TaskBody) -> Result<()> {
        if self.shutting_down {
            return Err(shutdown_error());
        }
        let id = spec.id.clone();
        if self.entries.contains_key(&id) {
            return Err(RuntimeError::invalid(
                "scheduler.duplicate_task",
                format!("task {id} is already known to the scheduler"),
            ));
        }

        // Derive from the parent when there is one, so cancelling a parent reaches this task without
        // anyone tracking the relationship explicitly.
        let token = match spec.parent.as_ref().and_then(|p| self.entries.get(p)) {
            Some(parent) => parent.token.child_token(),
            None => self.root.child_token(),
        };

        // A dependency that is already finished must not be waited on. Anything unknown is treated as
        // unsatisfiable rather than silently ignored — a typo in a dependency id should fail the task,
        // not quietly turn it into an independent one.
        let mut pending = Vec::new();
        let mut failed_dep = None;
        for dep in &spec.depends_on {
            match self.entries.get(dep) {
                Some(e) if e.state == TaskState::Completed => {}
                Some(e) if e.state.is_terminal() => {
                    failed_dep = Some(dep.clone());
                    break;
                }
                Some(_) => pending.push(dep.clone()),
                None => {
                    failed_dep = Some(dep.clone());
                    break;
                }
            }
        }

        self.events.publish(EventKind::TaskSubmitted {
            task: id.clone(),
            parent: spec.parent.clone(),
            priority: spec.priority.as_str().to_string(),
        });

        let priority = spec.priority;
        let entry = Entry {
            spec,
            body: Some(body),
            state: TaskState::Pending,
            token,
            attempt: 0,
            started: None,
            pending_deps: pending.clone(),
            waiters: Vec::new(),
            outcome: None,
        };
        self.entries.insert(id.clone(), entry);

        if let Some(dep) = failed_dep {
            self.finish(&id, Outcome::DependencyFailed(dep));
            return Ok(());
        }

        if pending.is_empty() {
            self.ready.push(id, priority);
        } else {
            for dep in pending {
                self.dependents.entry(dep).or_default().push(id.clone());
            }
        }
        Ok(())
    }

    fn on_watch(&mut self, id: TaskId, reply: oneshot::Sender<Outcome>) {
        match self.entries.get_mut(&id) {
            // Already finished: answer immediately from the recorded outcome.
            Some(e) if e.state.is_terminal() => {
                let outcome = e
                    .outcome
                    .clone()
                    .unwrap_or_else(|| Outcome::Failed(RuntimeError::internal("task failed")));
                let _ = reply.send(outcome);
            }
            Some(e) => e.waiters.push(reply),
            None => {
                let _ = reply.send(Outcome::Failed(RuntimeError::invalid(
                    "scheduler.unknown_task",
                    format!("no such task: {id}"),
                )));
            }
        }
    }

    /// Start as many ready tasks as quotas allow.
    ///
    /// `try_acquire` rather than `acquire`: the driver must not await here. Blocking for a permit
    /// would stop it serving cancellations — precisely when the queue is full and cancelling matters
    /// most. A task that cannot get a slot stays queued and is retried on the next pump, and every
    /// settle triggers a pump, so a freed slot is always picked up.
    fn pump(&mut self) {
        if self.shutting_down {
            return;
        }
        let mut deferred = Vec::new();
        while let Some(id) = self.ready.pop() {
            let Some(entry) = self.entries.get(&id) else { continue };
            if entry.token.is_cancelled() {
                self.finish(&id, Outcome::Cancelled);
                continue;
            }
            match self.resources.try_acquire(entry.spec.resource) {
                Ok(permit) => self.spawn(&id, permit),
                Err(_) => deferred.push((id, entry.spec.priority)),
            }
        }
        for (id, priority) in deferred {
            self.ready.push(id, priority);
        }
    }

    fn spawn(&mut self, id: &TaskId, permit: agent_resource::Permit) {
        let Some(entry) = self.entries.get_mut(id) else { return };
        let Some(mut body) = entry.body.take() else { return };

        entry.attempt += 1;
        entry.state = TaskState::Running;
        entry.started = Some(Instant::now());
        let attempt = entry.attempt;
        let ctx = TaskContext { id: id.clone(), cancel: entry.token.clone(), attempt };
        let timeout = entry.spec.timeout;
        let token = entry.token.clone();

        self.events.publish(EventKind::TaskStarted { task: id.clone() });

        let tx = self.tx.clone();
        let task_id = id.clone();
        tokio::spawn(async move {
            let fut = body(ctx);
            let outcome = run_attempt(fut, timeout, &token).await;
            // Released at the end of the attempt, before the driver is told — so the pump triggered by
            // this message already sees the freed capacity.
            drop(permit);
            let _ = tx.send(Command::Settled { id: task_id, outcome, attempt, body: Some(body) });
        });
    }

    fn on_settled(&mut self, id: TaskId, outcome: Outcome, attempt: u32, body: Option<TaskBody>) {
        let Some(entry) = self.entries.get_mut(&id) else { return };
        // Take the body back before anything else: a retry needs it, and a terminal outcome drops it
        // in `finish`.
        if entry.body.is_none() {
            entry.body = body;
        }
        // A stale report from a superseded attempt: ignore it rather than double-settling.
        if entry.attempt != attempt || entry.state.is_terminal() {
            return;
        }

        let elapsed = entry.started.map(|s| s.elapsed().as_millis() as u64).unwrap_or(0);

        // Retry only genuine, retryable failures — never a cancellation, and never a timeout, which
        // spec §15 classes as a cancellation because the work was actually stopped.
        if let Outcome::Failed(err) = &outcome {
            let policy = entry.spec.retry;
            if err.class.is_retryable() && attempt < policy.max_attempts && !entry.token.is_cancelled() {
                let delay = policy.delay_for(attempt);
                entry.state = TaskState::Waiting;
                self.events.publish(EventKind::TaskRetrying {
                    task: id.clone(),
                    attempt: attempt + 1,
                    delay_ms: delay.as_millis() as u64,
                });
                let tx = self.tx.clone();
                let token = entry.token.clone();
                let retry_id = id.clone();
                tokio::spawn(async move {
                    // Interruptible: cancelling during backoff must not wait out the delay.
                    tokio::select! {
                        _ = token.cancelled() => {
                            let _ = tx.send(Command::Settled {
                                id: retry_id, outcome: Outcome::Cancelled, attempt, body: None,
                            });
                        }
                        _ = tokio::time::sleep(delay) => {
                            let _ = tx.send(Command::Requeue { id: retry_id });
                        }
                    }
                });
                return;
            }
        }

        match &outcome {
            Outcome::Completed => {
                self.events.publish(EventKind::TaskCompleted { task: id.clone(), duration_ms: elapsed })
            }
            Outcome::Failed(e) => self.events.publish(EventKind::TaskFailed {
                task: id.clone(),
                code: e.code.to_string(),
                message: e.message.clone(),
            }),
            Outcome::Cancelled => self.events.publish(EventKind::TaskCancelled { task: id.clone() }),
            Outcome::DependencyFailed(_) => self.events.publish(EventKind::TaskFailed {
                task: id.clone(),
                code: "scheduler.dependency_failed".to_string(),
                message: "a dependency did not complete".to_string(),
            }),
        };

        self.finish(&id, outcome);
    }

    /// Record a terminal outcome, answer waiters, and release dependents.
    fn finish(&mut self, id: &TaskId, outcome: Outcome) {
        let Some(entry) = self.entries.get_mut(id) else { return };
        entry.state = outcome.state();
        entry.body = None;
        entry.outcome = Some(outcome.clone());
        for w in entry.waiters.drain(..) {
            let _ = w.send(outcome.clone());
        }

        let Some(blocked) = self.dependents.remove(id) else { return };
        for dep_id in blocked {
            let Some(e) = self.entries.get_mut(&dep_id) else { continue };
            if e.state.is_terminal() {
                continue;
            }
            e.pending_deps.retain(|d| d != id);
            if !outcome.is_success() {
                // A dependency that did not succeed fails everything waiting on it, transitively —
                // `finish` recurses through this same path.
                self.finish(&dep_id, Outcome::DependencyFailed(id.clone()));
                continue;
            }
            if e.pending_deps.is_empty() {
                let priority = e.spec.priority;
                self.ready.push(dep_id, priority);
            }
        }
    }

    /// A backoff elapsed: put the task back on the ready queue for another attempt.
    fn on_requeue(&mut self, id: TaskId) {
        let Some(entry) = self.entries.get(&id) else { return };
        if entry.state.is_terminal() {
            return;
        }
        if entry.token.is_cancelled() {
            self.finish(&id, Outcome::Cancelled);
            return;
        }
        let priority = entry.spec.priority;
        self.ready.push(id, priority);
    }

    fn on_cancel(&mut self, id: &TaskId) {
        let Some(entry) = self.entries.get(id) else { return };
        if entry.state.is_terminal() {
            return;
        }
        // Published before the token fires, so the measured propagation latency includes everything
        // between the request and the task actually settling.
        self.events.publish(EventKind::TaskCancelRequested { task: id.clone() });
        // Cancelling the token reaches the running future and, through child derivation, the whole
        // subtree. A task that has not started yet is settled directly, since nothing will report it.
        entry.token.cancel();
        if entry.state == TaskState::Pending {
            self.finish(id, Outcome::Cancelled);
        }
    }

    fn snapshot(&self) -> Vec<TaskRecord> {
        let mut out: Vec<TaskRecord> = self
            .entries
            .values()
            .map(|e| TaskRecord {
                id: e.spec.id.to_string(),
                label: e.spec.label.clone(),
                state: e.state,
                priority: e.spec.priority.as_str().to_string(),
                resource: e.spec.resource.as_str().to_string(),
                parent: e.spec.parent.as_ref().map(|p| p.to_string()),
                attempt: e.attempt,
                waiting_on: e.pending_deps.iter().map(|d| d.to_string()).collect(),
            })
            .collect();
        // Stable order so a snapshot can be diffed against a previous one.
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

/// How long a cancelled task is given to unwind before its future is abandoned.
///
/// Dropping a future the instant the token fires *is* cancellation, and for a pure computation it is
/// the right thing. It is the wrong thing the moment a task owns something outside itself: spec §10
/// requires a cancelled process to get SIGTERM, then a wait, then SIGKILL — and none of that can
/// happen if the code holding the child handle is dropped mid-await. The grace window is the "then a
/// wait" part, generalised: the body is told, and gets a bounded chance to stop cleanly.
///
/// A body that ignores it is still abandoned, so this cannot be used to defeat Stop.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// Run one attempt, bounded by its timeout and its cancellation token.
///
/// The two stop conditions share one path on purpose. An earlier version wrapped the whole thing in
/// `tokio::time::timeout` and fired the token afterwards — which cannot work, because the timeout
/// drops the body's future *before* the token is ever cancelled, so a task with cleanup to do is
/// killed without being told. Deadline and cancellation now both mean the same thing to the body:
/// the token fires, and it gets `CANCEL_GRACE` to unwind. Only the reported outcome differs.
async fn run_attempt(fut: TaskFuture, timeout: Option<Duration>, token: &CancellationToken) -> Outcome {
    /// Why the attempt is being stopped. The body cannot tell the difference; the caller can.
    enum Stop {
        Cancelled,
        TimedOut(Duration),
    }

    let mut fut = fut;
    let stop = tokio::select! {
        biased;
        // Finished on its own: nothing to stop.
        r = &mut fut => {
            return match r {
                Ok(()) => Outcome::Completed,
                Err(e) if e.is_cancelled() => Outcome::Cancelled,
                Err(e) => Outcome::Failed(e),
            };
        }
        _ = token.cancelled() => Stop::Cancelled,
        _ = deadline(timeout) => Stop::TimedOut(timeout.unwrap_or_default()),
    };

    // Spec §15: a timeout must *cause* cancellation, not merely report one. Firing the token before
    // the grace window is what makes that true rather than aspirational.
    token.cancel();
    if tokio::time::timeout(CANCEL_GRACE, &mut fut).await.is_err() {
        tracing::warn!("task did not unwind within {CANCEL_GRACE:?}; abandoning it");
    }

    match stop {
        // A body that manages to finish during its own cancellation still does not get to report
        // success — the caller asked for it to stop, and it stopped.
        Stop::Cancelled => Outcome::Cancelled,
        Stop::TimedOut(d) => Outcome::Failed(RuntimeError::timeout("task", d.as_millis() as u64)),
    }
}

/// Completes when the deadline elapses, or never when there is no deadline.
async fn deadline(timeout: Option<Duration>) {
    match timeout {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending::<()>().await,
    }
}
