//! Sub-agent Runtime (spec §9, TODO §3).
//!
//! ## This is a port, not a redesign
//!
//! `src/lib/ai/subagentScheduler.ts` is the best-factored piece of the runtime being replaced:
//! dependency-free, unit-tested, with a real state machine, spawn coalescing, and a `join` that
//! *suspends* instead of polling. Its semantics are reproduced here deliberately, including the parts
//! that look like details and are not:
//!
//! - **Results are reported in spawn order**, whoever finished first, so a fan-out reads the same way
//!   every time.
//! - **An outcome is delivered exactly once.** Both `join` and the automatic drain can reach a settled
//!   job, and reporting a conclusion twice makes the model believe it happened twice.
//! - **Spawn coalescing**: two identical delegations issued in one batch fold into one job. The existing
//!   repeat-guard compares against delegations that already *finished*, so before this it could not see
//!   a twin still in flight.
//! - **`join` suspends on real settlement, never polls.** A tool-calling loop has no callback, so
//!   "start now, collect later" has exactly two shapes: the model asks again and again (one full model
//!   round-trip per check), or a tool call blocks until the answer exists. Waiting for three sub-agents
//!   costs one round-trip here, not one per check.
//! - **`block: false`** harvests what is already settled without committing the turn to a wait. Not a
//!   poll: it returns immediately either way, and anything still running is delivered when it lands.
//!
//! ## What is new
//!
//! **Fault isolation** (spec §9), which the JS version cannot provide. A delegation there is a promise in
//! the same renderer as its parent, so a crash takes the parent with it. Here each delegation runs in its
//! own task and is awaited through its `JoinHandle`, so a panic becomes that job's `Failed` outcome and
//! its siblings are untouched.
//!
//! **Global quotas.** The JS limits (`MAX_PARALLEL_SUBAGENTS = 3`, `MAX_SUBAGENTS_PER_TURN = 12`) are
//! enforced by a scheduler instance created per turn, so two conversations get three each and nothing
//! bounds the total. The concurrency limit here comes from the process-wide `ResourceManager`.
//!
//! **Capability scoping.** A child's grant is derived through `agent-permission`, which strips elevated
//! capabilities rather than inheriting the parent's authority.

use agent_core::{AgentId, CancellationToken, TaskId};
use agent_events::{EventBus, EventKind};
use agent_permission::Grant;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};

/// Delegations allowed to run at once. Mirrors `MAX_PARALLEL_SUBAGENTS`.
///
/// Each one is an independent model loop, so this is a spend and rate-limit control at least as much as
/// a CPU one.
pub const DEFAULT_PARALLEL: usize = 3;
/// Hard cap per supervisor (i.e. per turn). Mirrors `MAX_SUBAGENTS_PER_TURN`. A backstop against a model
/// that fans out without end.
pub const DEFAULT_MAX_JOBS: usize = 12;
/// Default `join` timeout. Mirrors `JOIN_DEFAULT_TIMEOUT_MS`.
pub const JOIN_DEFAULT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Ceiling on a caller-supplied `join` timeout. Mirrors `JOIN_MAX_TIMEOUT_MS`.
pub const JOIN_MAX_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How long a cancelled delegation is given to return its own conclusion before being abandoned.
pub const CANCEL_GRACE: Duration = Duration::from_secs(2);

/// What stands in for a conclusion when the turn was interrupted.
pub const CANCELLED_RESULT: &str = "(cancelled: the turn was interrupted before this delegation finished)";

/// Where a job is in its life. `Queued` means spawned but waiting on a concurrency slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn is_settled(self) -> bool {
        matches!(self, JobState::Done | JobState::Failed | JobState::Cancelled)
    }
}

/// A job that will never change again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobOutcome {
    pub id: String,
    pub state: JobState,
    /// The sub-agent's conclusion, or the error / cancellation notice standing in for one.
    pub result: String,
    /// Wall clock from spawn to settle, queue wait included — what the delegation actually cost the turn.
    pub ms: u64,
}

/// The read-only view of a job handed to callers.
#[derive(Debug, Clone, Serialize)]
pub struct JobView<M> {
    pub id: String,
    pub meta: M,
    pub state: JobState,
    /// How many later spawns folded into this one.
    pub coalesced: u32,
}

#[derive(Debug)]
pub struct SpawnResult<M> {
    pub id: String,
    /// True when this spawn folded into an already-running identical job.
    pub coalesced: bool,
    /// The meta of the job the caller is now attached to — the *existing* job's meta when coalesced.
    pub meta: M,
    /// Set when the spawn was refused (cancelled, or the per-turn cap reached).
    pub refused: Option<String>,
}

/// What `join` waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinMode {
    /// Every requested job must settle.
    All,
    /// Return as soon as one has.
    Any,
}

#[derive(Debug)]
pub struct JoinResult<M> {
    /// Settled and not previously reported, in spawn order. Each is marked delivered.
    pub ready: Vec<(JobView<M>, JobOutcome)>,
    /// Asked for but still queued or running.
    pub pending: Vec<String>,
    /// Asked for but never issued by this supervisor — almost always the model inventing a handle.
    pub unknown: Vec<String>,
    /// The wait ended on the timeout rather than on the work finishing.
    pub timed_out: bool,
}

/// What a delegation body is given.
pub struct DelegationContext {
    pub task: TaskId,
    pub agent: AgentId,
    /// Derived from the supervisor's root, so a parent cancellation reaches this delegation.
    pub cancel: CancellationToken,
    /// The capabilities this delegation holds — already stripped of elevated kinds.
    pub grant: Grant,
    pub depth: u32,
}

pub type DelegationFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type DelegationBody = Box<dyn FnOnce(DelegationContext) -> DelegationFuture + Send>;

struct Job<M> {
    id: String,
    meta: M,
    /// Coalescing key. `None` opts out.
    key: Option<String>,
    state: JobState,
    coalesced: u32,
    spawned_at: Instant,
    outcome: Option<JobOutcome>,
    /// Set once handed to the model, so `join` and the automatic drain cannot both report it.
    delivered: bool,
    cancel: CancellationToken,
}

struct Inner<M> {
    jobs: HashMap<String, Job<M>>,
    /// Spawn order, which is the order results are reported in.
    order: Vec<String>,
    seq: u64,
    closed: bool,
}

/// Supervises one turn's delegations.
pub struct SubAgentSupervisor<M: Clone + Send + 'static> {
    inner: Arc<Mutex<Inner<M>>>,
    /// Bumped on every settle. `join` waits on this rather than polling — a condition variable, not a
    /// timer.
    generation: watch::Sender<u64>,
    slots: Arc<Semaphore>,
    max_jobs: usize,
    root: CancellationToken,
    events: EventBus,
    task: TaskId,
    depth: u32,
}

impl<M: Clone + Send + 'static> SubAgentSupervisor<M> {
    pub fn new(task: TaskId, parent_cancel: &CancellationToken, events: EventBus) -> Self {
        let (generation, _) = watch::channel(0);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                jobs: HashMap::new(),
                order: Vec::new(),
                seq: 0,
                closed: false,
            })),
            generation,
            slots: Arc::new(Semaphore::new(DEFAULT_PARALLEL)),
            max_jobs: DEFAULT_MAX_JOBS,
            // Derived, so cancelling the parent turn cancels every delegation beneath it without anyone
            // keeping a list.
            root: parent_cancel.child_token(),
            events,
            task,
            depth: 0,
        }
    }

    pub fn with_parallel(mut self, n: usize) -> Self {
        self.slots = Arc::new(Semaphore::new(n.max(1)));
        self
    }

    pub fn with_max_jobs(mut self, n: usize) -> Self {
        self.max_jobs = n;
        self
    }

    pub fn with_depth(mut self, depth: u32) -> Self {
        self.depth = depth;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner<M>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn bump(&self) {
        let next = *self.generation.borrow() + 1;
        let _ = self.generation.send(next);
    }

    /// Live counts, for status text ("2 running, 1 queued").
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let inner = self.lock();
        let mut queued = 0;
        let mut running = 0;
        let mut settled = 0;
        for j in inner.jobs.values() {
            match j.state {
                JobState::Queued => queued += 1,
                JobState::Running => running += 1,
                _ => settled += 1,
            }
        }
        (queued, running, settled, inner.jobs.len())
    }

    /// Jobs that have not settled. Used by the end-of-turn guard: a model about to finish while
    /// delegations are still running has something to wait for, not something to summarise.
    pub fn outstanding(&self) -> Vec<String> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .filter(|id| inner.jobs.get(*id).is_some_and(|j| !j.state.is_settled()))
            .cloned()
            .collect()
    }

    /// Start a delegation. Returns immediately; the work runs concurrently.
    ///
    /// `key` is the coalescing key: a spawn whose key matches an *unsettled* job folds into it rather
    /// than starting a second copy.
    pub fn spawn(
        &self,
        meta: M,
        key: Option<String>,
        grant: Grant,
        body: DelegationBody,
    ) -> SpawnResult<M> {
        let mut inner = self.lock();

        if inner.closed || self.root.is_cancelled() {
            return SpawnResult {
                id: String::new(),
                coalesced: false,
                meta,
                refused: Some(CANCELLED_RESULT.to_owned()),
            };
        }

        // Fold into an identical delegation that has not settled yet.
        if let Some(k) = &key
            && let Some(existing) = inner
                .order
                .iter()
                .filter_map(|id| inner.jobs.get(id))
                .find(|j| !j.state.is_settled() && j.key.as_deref() == Some(k.as_str()))
        {
            let id = existing.id.clone();
            let existing_meta = existing.meta.clone();
            if let Some(j) = inner.jobs.get_mut(&id) {
                j.coalesced += 1;
            }
            return SpawnResult { id, coalesced: true, meta: existing_meta, refused: None };
        }

        if inner.jobs.len() >= self.max_jobs {
            return SpawnResult {
                id: String::new(),
                coalesced: false,
                meta,
                refused: Some(format!(
                    "refused: this turn has already started {} delegations, which is the cap",
                    self.max_jobs
                )),
            };
        }

        inner.seq += 1;
        let id = format!("s{}", inner.seq);
        let cancel = self.root.child_token();
        let agent = AgentId::new();

        inner.jobs.insert(
            id.clone(),
            Job {
                id: id.clone(),
                meta: meta.clone(),
                key,
                state: JobState::Queued,
                coalesced: 0,
                spawned_at: Instant::now(),
                outcome: None,
                delivered: false,
                cancel: cancel.clone(),
            },
        );
        inner.order.push(id.clone());
        drop(inner);

        self.events.publish(EventKind::SubAgentCreated {
            task: self.task.clone(),
            agent: agent.clone(),
        });

        let ctx = DelegationContext {
            task: self.task.clone(),
            agent,
            cancel,
            grant,
            depth: self.depth + 1,
        };
        self.launch(id.clone(), ctx, body);

        SpawnResult { id, coalesced: false, meta, refused: None }
    }

    fn launch(&self, id: String, ctx: DelegationContext, body: DelegationBody) {
        let inner = Arc::clone(&self.inner);
        let generation = self.generation.clone();
        let slots = Arc::clone(&self.slots);
        let events = self.events.clone();
        let task = self.task.clone();

        tokio::spawn(async move {
            // FIFO-fair, so a queued delegation is not overtaken by a later one.
            let _permit = match slots.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };

            // Cancelled while queued: `cancel_all` already settled it, so the delegation must not start.
            {
                let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                match guard.jobs.get_mut(&id) {
                    Some(j) if j.state.is_settled() => return,
                    Some(j) if j.cancel.is_cancelled() => {
                        settle_locked(&mut guard, &id, JobState::Cancelled, CANCELLED_RESULT.to_owned());
                        drop(guard);
                        let next = *generation.borrow() + 1;
                        let _ = generation.send(next);
                        return;
                    }
                    Some(j) => j.state = JobState::Running,
                    None => return,
                }
            }

            let cancel = ctx.cancel.clone();
            let agent = ctx.agent.clone();

            // Fault isolation (spec §9): the body runs in its own task and is awaited through its
            // JoinHandle, so a panic inside a delegation becomes that job's Failed outcome instead of
            // unwinding the supervisor and taking every sibling with it.
            let mut handle = tokio::spawn(async move { body(ctx).await });
            let aborter = handle.abort_handle();

            let interpret = |joined: Result<Result<String, String>, tokio::task::JoinError>| match joined {
                Ok(Ok(text)) => (JobState::Done, text),
                Ok(Err(e)) => (JobState::Failed, e),
                Err(e) if e.is_cancelled() => (JobState::Cancelled, CANCELLED_RESULT.to_owned()),
                Err(e) => {
                    tracing::error!(error = %e, "a delegation panicked; its siblings are unaffected");
                    (JobState::Failed, "the sub-agent crashed".to_owned())
                }
            };

            let (state, result) = tokio::select! {
                biased;
                joined = &mut handle => interpret(joined),
                _ = cancel.cancelled() => {
                    // The body holds the same token and may be unwinding already, so give it a bounded
                    // window to return its own partial conclusion before it is abandoned. Same reasoning
                    // as the scheduler's CANCEL_GRACE: dropping a future is cancellation, but a body that
                    // wants to report what it got should be allowed to.
                    match tokio::time::timeout(CANCEL_GRACE, &mut handle).await {
                        Ok(joined) => interpret(joined),
                        Err(_) => {
                            aborter.abort();
                            (JobState::Cancelled, CANCELLED_RESULT.to_owned())
                        }
                    }
                }
            };

            {
                let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                settle_locked(&mut guard, &id, state, result);
            }
            events.publish(EventKind::SubAgentCompleted { task, agent });
            let next = *generation.borrow() + 1;
            let _ = generation.send(next);
        });
    }

    /// Collect outcomes.
    ///
    /// `ids` empty means "everything outstanding, plus anything that finished but was never reported" —
    /// a bare join must not silently skip a result the model never saw.
    pub async fn join(
        &self,
        ids: &[String],
        mode: JoinMode,
        timeout: Option<Duration>,
        block: bool,
    ) -> JoinResult<M> {
        let mut unknown = Vec::new();
        let targets: Vec<String> = {
            let inner = self.lock();
            if ids.is_empty() {
                inner
                    .order
                    .iter()
                    .filter(|id| {
                        inner.jobs.get(*id).is_some_and(|j| j.outcome.is_none() || !j.delivered)
                    })
                    .cloned()
                    .collect()
            } else {
                // Deduped and put back into spawn order, so joining ["s3","s1","s1"] reports s1 then s3
                // exactly once.
                let wanted: std::collections::HashSet<&String> = ids.iter().collect();
                for id in &wanted {
                    if !inner.jobs.contains_key(*id) {
                        unknown.push((*id).clone());
                    }
                }
                unknown.sort();
                inner.order.iter().filter(|id| wanted.contains(id)).cloned().collect()
            }
        };

        let mut timed_out = false;
        if block && !targets.is_empty() {
            let capped = timeout.map(|d| d.min(JOIN_MAX_TIMEOUT)).unwrap_or(JOIN_DEFAULT_TIMEOUT);
            let inner = Arc::clone(&self.inner);
            let targets_for_wait = targets.clone();
            let mut gen_rx = self.generation.subscribe();

            // A condition-variable wait, not a poll: the generation channel is signalled by each settle,
            // so this suspends until something actually changed.
            let wait = async move {
                loop {
                    {
                        let guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                        let settled = |id: &String| {
                            guard.jobs.get(id).is_some_and(|j| j.outcome.is_some())
                        };
                        let satisfied = match mode {
                            JoinMode::All => targets_for_wait.iter().all(settled),
                            JoinMode::Any => targets_for_wait.iter().any(settled),
                        };
                        if satisfied {
                            return;
                        }
                    }
                    if gen_rx.changed().await.is_err() {
                        return;
                    }
                }
            };
            timed_out = tokio::time::timeout(capped, wait).await.is_err();
        }

        let mut ready = Vec::new();
        let mut pending = Vec::new();
        {
            let mut inner = self.lock();
            for id in &targets {
                let Some(job) = inner.jobs.get_mut(id) else { continue };
                match (&job.outcome, job.delivered) {
                    (Some(o), false) => {
                        job.delivered = true;
                        let outcome = o.clone();
                        let view = JobView {
                            id: job.id.clone(),
                            meta: job.meta.clone(),
                            state: job.state,
                            coalesced: job.coalesced,
                        };
                        ready.push((view, outcome));
                    }
                    (None, _) => pending.push(id.clone()),
                    // Already reported: not repeated. Reporting a conclusion twice makes the model
                    // believe the work happened twice.
                    (Some(_), true) => {}
                }
            }
        }

        JoinResult { ready, pending, unknown, timed_out }
    }

    /// Outcomes that settled but were never reported, marking them delivered.
    ///
    /// This is what makes polling unnecessary: a delegation that finished while the model was doing
    /// something else rides back on the next tool result, so the model has no reason to ask.
    pub fn drain(&self) -> Vec<(JobView<M>, JobOutcome)> {
        let mut inner = self.lock();
        let order = inner.order.clone();
        let mut out = Vec::new();
        for id in order {
            let Some(job) = inner.jobs.get_mut(&id) else { continue };
            if let Some(o) = &job.outcome
                && !job.delivered
            {
                job.delivered = true;
                let outcome = o.clone();
                out.push((
                    JobView {
                        id: job.id.clone(),
                        meta: job.meta.clone(),
                        state: job.state,
                        coalesced: job.coalesced,
                    },
                    outcome,
                ));
            }
        }
        out
    }

    /// Cancel every delegation and refuse further spawns.
    ///
    /// Called when the turn ends. Queued jobs are settled here rather than left dangling: a caller
    /// awaiting an outcome must be answered, not stranded.
    pub fn cancel_all(&self, reason: &str) {
        {
            let mut inner = self.lock();
            inner.closed = true;
            let order = inner.order.clone();
            for id in order {
                let is_queued = inner.jobs.get(&id).is_some_and(|j| j.state == JobState::Queued);
                if is_queued {
                    settle_locked(&mut inner, &id, JobState::Cancelled, reason.to_owned());
                }
            }
        }
        // Cancels running bodies through token derivation.
        self.root.cancel();
        self.bump();
    }
}

/// Record a terminal outcome. Caller holds the lock.
fn settle_locked<M>(inner: &mut Inner<M>, id: &str, state: JobState, result: String) {
    let Some(job) = inner.jobs.get_mut(id) else { return };
    if job.outcome.is_some() {
        return; // already settled — cancel_all racing a natural finish
    }
    job.state = state;
    job.outcome = Some(JobOutcome {
        id: job.id.clone(),
        state,
        result,
        ms: job.spawned_at.elapsed().as_millis() as u64,
    });
}
