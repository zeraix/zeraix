//! The scheduler's actor: the one task that owns every entry, the ready queue and the resource permits.
//!
//! [`Scheduler`](crate::Scheduler) is only a handle that sends it [`Command`](crate::Command)s; everything that
//! decides runs here, on one task, so no decision ever races another.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use agent_core::{CancellationToken, Result, RuntimeError, TaskId, TaskState};
use agent_events::{EventBus, EventKind};
use agent_journal::{Journal, JournalEvent};
use agent_resource::ResourceManager;
use tokio::sync::{mpsc, oneshot};

use crate::queue::ReadyQueue;
use crate::task::{Outcome, TaskBody, TaskContext, TaskFuture, TaskRecord, TaskSpec};
use crate::{Command, shutdown_error};

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

struct Driver {
    rx: mpsc::UnboundedReceiver<Command>,
    tx: mpsc::UnboundedSender<Command>,
    resources: ResourceManager,
    events: EventBus,
    journal: Journal,
    root: CancellationToken,
    entries: HashMap<TaskId, Entry>,
    ready: ReadyQueue,
    /// dependency -> tasks blocked on it.
    dependents: HashMap<TaskId, Vec<TaskId>>,
    shutting_down: bool,
}

/// Start the actor, and hand back what a [`Scheduler`](crate::Scheduler) keeps of it: the way in, and the root of
/// every task's cancellation.
pub(crate) fn spawn(
    resources: ResourceManager,
    events: EventBus,
    journal: Journal,
) -> (mpsc::UnboundedSender<Command>, CancellationToken) {
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
        journal,
        root: root.clone(),
        entries: HashMap::new(),
        ready: ReadyQueue::new(),
        dependents: HashMap::new(),
        shutting_down: false,
    };
    tokio::spawn(driver.run());
    (tx, root)
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
                Command::Pause { id, reply } => {
                    let _ = reply.send(self.on_pause(&id));
                }
                Command::Resume { id, reply } => {
                    let paused = self.on_resume(&id);
                    let _ = reply.send(paused);
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
                    // Paused work is not on the ready queue, so draining it does not reach these. A caller
                    // awaiting a paused task's outcome would otherwise hang on a sender that is never used.
                    let paused: Vec<TaskId> = self
                        .entries
                        .iter()
                        .filter(|(_, e)| e.state == TaskState::Paused)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in paused {
                        self.finish(&id, Outcome::Cancelled);
                    }
                    // Durable, and last: this record is what tells a later replay that the runtime stopped on
                    // purpose. Its ABSENCE is the crash signal, so writing it without waiting would leave a
                    // clean shutdown occasionally indistinguishable from a kill -9.
                    let _ = self.journal.shut_down().await;
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
        // Recorded even for a task that is about to fail on an unsatisfiable dependency: the journal is a
        // history of what the scheduler was asked to do, and a submission that failed immediately is still
        // something it was asked to do. The `Settled` record below closes it out.
        self.journal.record(JournalEvent::Submitted {
            task: id.to_string(),
            label: spec.label.clone(),
            priority: spec.priority.as_str().to_string(),
            resource: spec.resource.as_str().to_string(),
            parent: spec.parent.as_ref().map(|p| p.to_string()),
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
        let journal = self.journal.clone();
        tokio::spawn(async move {
            // Durable, and awaited HERE rather than in the driver: the record has to be on the disk before
            // anything with side effects begins, but paying for that on the driver would put a disk
            // round-trip in the loop that serves cancellations. This way the cost lands on the task's own
            // startup. A journal write that fails is logged inside the journal and does not stop the work —
            // refusing to run because the crash log is unavailable would be a worse failure than the one it
            // insures against.
            let _ = journal
                .record_durable(JournalEvent::Started { task: task_id.to_string(), attempt })
                .await;
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
        // Not durable: losing this record makes a finished task read as interrupted, which costs a caller one
        // needless question. Losing a `Started` would cost a command run twice. See the journal's header.
        self.journal.record(JournalEvent::Settled {
            task: id.to_string(),
            state: entry.state,
            detail: match &outcome {
                Outcome::Failed(e) => Some(e.message.clone()),
                Outcome::DependencyFailed(dep) => Some(format!("dependency {dep} did not complete")),
                _ => None,
            },
        });
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

    /// Hold a task that has not started.
    ///
    /// Taking it off the ready queue is the whole mechanism: `pump` only starts what the queue holds, so a
    /// task that is not in it cannot be picked up however many slots free up. Nothing has to be told to skip it.
    fn on_pause(&mut self, id: &TaskId) -> bool {
        let Some(entry) = self.entries.get_mut(id) else { return false };
        if !entry.state.can_transition(TaskState::Paused) {
            return false;
        }
        entry.state = TaskState::Paused;
        self.ready.remove(id);
        self.events.publish(EventKind::TaskPaused { task: id.clone() });
        true
    }

    /// Put a paused task back on the queue, where the next pump will find it.
    fn on_resume(&mut self, id: &TaskId) -> bool {
        let Some(entry) = self.entries.get_mut(id) else { return false };
        if entry.state != TaskState::Paused {
            return false;
        }
        // A pause does not survive a cancellation: cancelling reaches every non-terminal state, including this
        // one, and resuming afterwards must not resurrect the work.
        if entry.token.is_cancelled() {
            self.finish(id, Outcome::Cancelled);
            return false;
        }
        entry.state = TaskState::Pending;
        let priority = entry.spec.priority;
        // Dependencies are re-checked by construction: a task with unmet ones was never on the ready queue,
        // and `finish` is what puts it there. Pausing does not change that, so a paused task whose dependency
        // is still outstanding resumes into Pending and waits, exactly as it would have.
        if entry.pending_deps.is_empty() {
            self.ready.push(id.clone(), priority);
        }
        self.events.publish(EventKind::TaskResumed { task: id.clone() });
        true
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
