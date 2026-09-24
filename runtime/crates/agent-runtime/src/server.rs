//! The request loop: decode, dispatch, reply.
//!
//! Two properties this module exists to guarantee.
//!
//! **Every request is served concurrently.** A `tool.call` is spawned rather than awaited inline, so a
//! two-minute search does not block the `tool.cancel` that would stop it. Serving requests in order
//! would make cancellation unreachable — the exact failure the JS runtime has, where an `ipcMain.handle`
//! promise cannot be interrupted and a second channel had to be invented to work around it.
//!
//! **A panic in one call cannot take down the runtime.** Each call runs in its own task; `JoinError`
//! from a panicking task becomes an `Internal` error on that one call. Spec §17 bans `unwrap`/`panic!`
//! on the execution path, and this is the belt to that braces: if one slips through, one tool call
//! fails instead of every conversation dying at once.
//!
//! The method families with most code behind them live in child modules, each adding an `impl Server` block:
//! `agent_run` (a whole turn and its host bridges), `mcp`, `processes` and `subagents`. `handle` routes to them
//! by prefix; everything shared — the request loop, scheduling, cancellation, the host channel — stays here.

mod agent_run;
mod mcp;
mod processes;
mod subagents;

use agent_core::{CallId, CancellationToken, ErrorClass, RuntimeError};
use agent_ipc::protocol::{
    is_compatible, CancelParams, ErrorBody, InitializeParams, InitializeResult, InvalidateParams,
    McpCallParams, McpCallResult, McpConnectParams, McpServerParams, McpServerStatus, McpSetApprovedParams, McpStatusResult,
    McpToolDescriptor, Notification, PeekResult, PidParams, ProcessExitedEvent, ProcessRunParams,
    ProcessRunResult, Request, Response, ServiceDescriptor, ServiceListResult, StartBackgroundParams,
    StartBackgroundResult, StoppedResult, ToolCallParams, ToolCallResult, ToolDescriptor,
    AgentRunParams, AgentRunResult, EVENT_AGENT_DELTA, EVENT_MCP_STATE, EVENT_PROCESS_EXITED,
    EVENT_AGENT_RETRY, EVENT_AGENT_TOOL, EVENT_AGENT_TURN, EVENT_RUNTIME, FEATURES, HOST_REQUEST_ASK,
    HOST_REQUEST_CONSENT, HOST_REQUEST_ROUND, HOST_REQUEST_TOOL,
    PROTOCOL_VERSION,
};
use agent_ipc::protocol::{
    decode_incoming, HostRequest, Incoming, SubagentJoinParams, SubagentJoinResult, SubagentOutcome,
    SubagentSpawnParams, SubagentSpawnResult, SubagentSpawned, SubagentStatus, SubagentTurnParams,
    HOST_RUN_SUBAGENT,
};
use agent_events::EventBus;
use agent_resource::{Limits, ResourceClass, ResourceManager};
use agent_scheduler::{Outcome, Priority, Scheduler, TaskSpec};
use agent_journal::{Journal, RecoveryPlan};
use agent_permission::{Capability, CapabilityKind, Grant, PermissionRuntime, Policy, Principal};
use crate::session_policy::SessionPermissions;
use agent_subagents::{JoinMode, SubAgentSupervisor, JOIN_MAX_TIMEOUT};
use agent_ipc::transport::{StdioSender, StdioTransport, Transport};
use agent_tools::registry::to_legacy_content;
use agent_tools::tool::{ExecutionMode, RiskLevel};
use agent_tools::walk::FileListCache;
use agent_tools::workspace::Workspace;
use agent_mcp::{ConnState, HttpFactory, HttpServer, McpManager, ServerConfig, StdioFactory, StdioServer};
use agent_process::BackgroundRegistry;
use agent_tools::{ToolContext, ToolRegistry};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How many not-yet-registered cancels to remember. See `Server::early_cancels`.
const MAX_EARLY_CANCELS: usize = 256;

/// What `call.cancel` needs to stop one call, whatever stage it has reached.
#[derive(Clone)]
struct CallHandle {
    task: agent_core::TaskId,
    /// Cancelled directly by `call.cancel`; the task's body is linked to it.
    token: CancellationToken,
}

/// Shared runtime state.
pub struct Server {
    registry: Arc<ToolRegistry>,
    file_cache: Arc<FileListCache>,
    /// Live calls, so `call.cancel` can reach one by the id the host minted.
    ///
    /// Holds BOTH the scheduler's task id and a token this server owns.
    ///
    /// Neither alone is enough. The task id reaches work the scheduler knows about, including work still
    /// queued — but there is a window between a call registering here and its task being submitted, and a
    /// cancel landing in that window finds no task to cancel. The token covers that window, because it
    /// exists before the task does and the body is linked to it.
    inflight: Arc<DashMap<String, CallHandle>>,
    /// Cancels that arrived before the call they name had registered itself.
    ///
    /// Requests are dispatched concurrently — that is what makes a cancel able to interrupt a running
    /// call at all — so nothing orders `tool.call` registering against `call.cancel` looking it up. Under
    /// load the cancel wins, finds no entry, and does nothing: the user presses Stop and the work runs
    /// to completion anyway.
    ///
    /// Held here until the call appears, which it does microseconds later. Bounded, because a cancel for
    /// an id that never arrives would otherwise accumulate for the life of the runtime.
    early_cancels: Arc<Mutex<VecDeque<String>>>,
    /// Cancelled when the host asks the runtime to stop; parent of every call token.
    root_cancel: CancellationToken,
    initialized: Arc<std::sync::atomic::AtomicBool>,
    /// Long-lived services started through `process.start_background`.
    background: Arc<BackgroundRegistry>,
    /// Supervised MCP connections.
    mcp: Arc<McpManager>,
    /// Set once the transport exists, so events can be pushed from tasks that outlive a request.
    events: Arc<OnceLock<StdioSender>>,
    /// Requests this runtime has made of the host, awaiting their replies.
    ///
    /// Separate from `inflight`, which tracks work the host asked FOR. These are the other direction:
    /// work the runtime asked the host to do. Ids are this runtime's own, so they cannot collide with
    /// the host's.
    host_calls: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    next_host_id: Arc<std::sync::atomic::AtomicU64>,
    /// One sub-agent supervisor per turn.
    ///
    /// Per turn because that is the scope the app already delegates in, and because a turn is what
    /// gets cancelled. What is NOT per turn is the concurrency limit inside them: they share one
    /// process-wide semaphore, which is the difference between "three per conversation" and "three",
    /// and the reason two conversations can no longer quietly run six.
    subagents: Arc<DashMap<String, Arc<SubAgentSupervisor<Value>>>>,
    /// Published for sub-agent lifecycle; the audit layer derives its metrics from this.
    bus: EventBus,
    /// Every unit of work the runtime executes goes through here.
    ///
    /// Not because ordering needed fixing — the runtime already served requests concurrently — but
    /// because nothing bounded them. A model can ask for a batch of parallel tool calls, several
    /// conversations can run at once, and the JS runtime has no global cap on any of it: the
    /// `PARALLEL_SAFE_TOOLS` batching is per round, in one renderer. This is the first thing in the
    /// system that can say "sixteen tool calls at a time, across everything".
    scheduler: Arc<Scheduler>,
    /// The capability ceiling for this session: set at `runtime.initialize`, MCP approvals amended by
    /// `mcp.set_approved`. See `session_policy`.
    permissions: Arc<SessionPermissions>,
    /// Derived metrics (TODO §11). Subscribed to the bus in `run`, so nothing has to be instrumented at its
    /// call site — see `agent-audit`'s header for why that is the right shape.
    metrics: Arc<agent_audit::MetricsCollector>,
    /// What a previous run left unfinished, read once at startup.
    ///
    /// Reported to the host at handshake rather than acted on here. Whether an interrupted task may be run
    /// again is a question about what it was — a search is safe to repeat, a deploy is not — and this process
    /// no longer has the body that would answer it. See `agent-journal`'s header.
    recovered: Arc<RecoveryPlan>,
}

impl Server {
    /// A runtime with no durable state. Used by the tests and the parity harness, which have nowhere to write
    /// and nothing to recover.
    pub fn new() -> Self {
        Self::build(Journal::disabled(), RecoveryPlan::default())
    }

    /// A runtime that journals its task lifecycle under `state_dir`, recovering from whatever is there.
    ///
    /// Replay happens before the scheduler starts, so the plan describes the *previous* run only and cannot
    /// be polluted by this one's first submissions. The journal is then rotated: the old file is kept for
    /// diagnosis under a timestamped name, and this run starts a clean one. Without the rotation every
    /// restart would re-report the same interrupted tasks forever, since nothing in this process can settle
    /// a task whose body died with the last one.
    pub async fn with_state_dir(state_dir: impl AsRef<std::path::Path>) -> Self {
        let path = state_dir.as_ref().join("tasks.jsonl");
        let recovered = match agent_journal::replay(&path).await {
            Ok(plan) => plan,
            Err(e) => {
                // A journal that cannot be read must not stop the runtime from starting: that would turn one
                // bad file into a runtime that never boots again.
                tracing::error!(error = %e, "could not read the task journal; starting without recovery");
                RecoveryPlan::default()
            }
        };
        if !recovered.is_empty() || recovered.torn_tail || recovered.corrupt_lines > 0 {
            tracing::warn!(
                resumable = recovered.resumable.len(),
                interrupted = recovered.interrupted.len(),
                torn_tail = recovered.torn_tail,
                corrupt_lines = recovered.corrupt_lines,
                "recovered unfinished work from a previous run"
            );
        }
        if let Err(e) = Journal::rotate(&path).await {
            tracing::error!(error = %e, "could not rotate the task journal");
        }
        let journal = match Journal::open(&path).await {
            Ok(journal) => journal,
            Err(e) => {
                tracing::error!(error = %e, "could not open the task journal; continuing without durability");
                Journal::disabled()
            }
        };
        Self::build(journal, recovered)
    }

    fn build(journal: Journal, recovered: RecoveryPlan) -> Self {
        let mut registry = ToolRegistry::new();
        agent_tools::tools::register_builtin(&mut registry);
        let bus = EventBus::new(agent_events::DEFAULT_CAPACITY);
        Self {
            registry: Arc::new(registry),
            file_cache: Arc::new(FileListCache::new()),
            inflight: Arc::new(DashMap::new()),
            early_cancels: Arc::new(Mutex::new(VecDeque::new())),
            root_cancel: CancellationToken::new(),
            initialized: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            background: Arc::new(BackgroundRegistry::new()),
            mcp: Arc::new(McpManager::new()),
            events: Arc::new(OnceLock::new()),
            host_calls: Arc::new(DashMap::new()),
            next_host_id: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            subagents: Arc::new(DashMap::new()),
            bus: bus.clone(),
            scheduler: Arc::new(Scheduler::start_journalled(
                ResourceManager::new(Limits::default()),
                bus,
                journal,
            )),
            metrics: Arc::new(agent_audit::MetricsCollector::new()),
            permissions: Arc::new(SessionPermissions::default()),
            recovered: Arc::new(recovered),
        }
    }

    /// The filesystem policy a command should run under, or `None` when the host declared none.
    ///
    /// Built on [`FilesystemPolicy::workspace`], which already knows the part that is easy to get wrong: a
    /// toolchain lives outside the project, so `/usr`, `/lib` and `/bin` have to stay readable and executable
    /// or the confined command cannot even exec `/bin/sh`. The first version of this listed only the approved
    /// roots and every command failed with EACCES — caught by the test that exists to insist confinement must
    /// not break work inside the workspace.
    ///
    /// The approved roots and the command's own working directory are added to that base: a build writes into
    /// its own tree, and a policy allowing the roots but not the cwd would break every command run from a
    /// subdirectory.
    fn sandbox_policy(&self, cwd: Option<&str>) -> Option<agent_sandbox::SandboxPolicy> {
        let declared = self.permissions.declared_roots()?;
        if declared.is_empty() {
            // Declared, but naming no directory — an MCP-only policy. There is nothing to confine a command
            // to, and confining it to nothing would stop it exec'ing a shell at all.
            return None;
        }
        let mut writable = declared.writable;
        if let Some(cwd) = cwd {
            writable.push(std::path::PathBuf::from(cwd));
        }

        // The system half, then each root under the access it was declared with. Built from `system()` rather
        // than `workspace(first)` because the two kinds differ: a read-only root put through `workspace` would
        // land in the write list as well, which is exactly the bug this separation exists to prevent.
        let mut filesystem = agent_sandbox::FilesystemPolicy::system();
        for root in writable {
            if !filesystem.read.contains(&root) {
                filesystem.read.push(root.clone());
            }
            if !filesystem.write.contains(&root) {
                filesystem.write.push(root);
            }
        }
        for root in declared.readonly {
            if !filesystem.read.contains(&root) {
                filesystem.read.push(root);
            }
        }
        Some(agent_sandbox::SandboxPolicy { filesystem, ..Default::default() })
    }

    /// Forward every event the runtime publishes to the host, as `runtime.event` notifications.
    ///
    /// The bus has existed since the scheduler landed and, until now, had no subscriber outside the runtime:
    /// Electron learned about a task only by asking. That is what made §10.2's event list unimplementable and
    /// left the UI polling for state it could have been told about.
    ///
    /// ## Lag is dropped, not buffered
    ///
    /// The bus is a broadcast channel with a bounded backlog. A consumer that falls behind is told it lagged
    /// and skips to the newest events, and this bridge does the same rather than trying to catch up: these
    /// events drive presentation, and a UI showing a queue of stale transitions is worse than one that missed
    /// some. The `seq` on every event is monotonic, so a host that cares can SEE the gap rather than being
    /// silently misled — which is the property that makes dropping acceptable at all.
    ///
    /// ## It never blocks the runtime
    ///
    /// The send is `try_send`-shaped by construction: this runs in its own task, so a host that stops reading
    /// its own stdin cannot apply backpressure to the scheduler through the event bus.
    fn bridge_events(self: Arc<Self>) {
        let mut rx = self.bus.subscribe();
        let events = Arc::clone(&self.events);
        let metrics = Arc::clone(&self.metrics);
        let root = self.root_cancel.clone();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    biased;
                    _ = root.cancelled() => break,
                    next = rx.recv() => match next {
                        Ok(event) => event,
                        // Lagged: skip to the newest rather than replaying stale transitions. The gap is
                        // visible to the host through `seq`.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(skipped = n, "event consumer lagged; dropping to the newest");
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                };
                // Derived first, then forwarded. The collector is the reason `agent-audit` exists and, until
                // now, the reason it had no dependents: the metrics are relationships BETWEEN events, so they
                // are computed here rather than threaded through the scheduler and the registry.
                metrics.observe(&event);
                let Some(tx) = events.get().cloned() else { continue };
                if let Ok(line) = serde_json::to_string(&Notification { method: EVENT_RUNTIME, params: json!(event) })
                {
                    // A closed channel means the host is gone; the loop above ends on the same signal.
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            }
        });
    }

    /// Serve until the host closes stdin or sends `runtime.shutdown`.
    pub async fn run(self: Arc<Self>, transport: StdioTransport) -> anyhow::Result<()> {
        let sender = transport.sender();
        // Events are pushed from reaper tasks that have no request to reply to, so the sender has to
        // outlive any one of them. Set here rather than in `new` because the transport is the caller's.
        let _ = self.events.set(sender.clone());
        self.clone().bridge_events();
        loop {
            let line = tokio::select! {
                biased;
                _ = self.root_cancel.cancelled() => break,
                r = transport.recv() => r?,
            };
            let Some(line) = line else { break }; // EOF: the host exited.
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let req = match decode_incoming(trimmed) {
                // An answer to something this runtime asked the host to do. Settled here rather than
                // dispatched: there is no handler for it, only a caller waiting.
                Ok(Incoming::Reply(reply)) => {
                    if let Some((_, tx)) = self.host_calls.remove(&reply.id) {
                        let _ = tx.send(match reply.error {
                            Some(e) => Err(e),
                            None => Ok(reply.result.unwrap_or(Value::Null)),
                        });
                    }
                    // A reply nobody is waiting for means the caller timed out. Harmless.
                    continue;
                }
                Ok(Incoming::Request(r)) => r,
                Err(e) => {
                    // Unparseable input has no id to reply to, so it can only be logged. Dropping the
                    // connection instead would turn one malformed line into a lost conversation.
                    tracing::warn!(error = %e, "discarding malformed request");
                    continue;
                }
            };

            let this = Arc::clone(&self);
            let tx = sender.clone();
            tokio::spawn(async move {
                this.dispatch(req, tx).await;
            });
        }
        // Stopping the root token cancels every in-flight call, so shutdown does not strand child
        // processes or leave tasks running past the loop. Background services are not in-flight calls
        // and so are not covered by it: they are killed explicitly, because a service outliving the
        // runtime that started it is a dev server nobody can find and nobody can stop.
        self.background.stop_all();
        self.mcp.shutdown().await;
        // Before the root token, not after: `shutdown` gives running tasks their cancellation and waits
        // for the driver to settle them, so in-flight work is stopped in an order it can observe rather
        // than having the process pulled out from under it.
        self.scheduler.shutdown().await;
        self.root_cancel.cancel();
        Ok(())
    }

    async fn dispatch(&self, req: Request, tx: StdioSender) {
        let id = req.id.clone();
        let method = req.method.clone();
        let result = self.handle(req).await;

        // Notifications get no reply, whether they succeeded or not.
        let Some(id) = id else {
            if let Err(e) = result {
                tracing::warn!(method = %method, error = %e.payload.message, "notification failed");
            }
            return;
        };

        let response = match result {
            Ok(value) => Response::ok(id, value),
            Err(err) => Response::err(id, err),
        };
        match serde_json::to_string(&response) {
            Ok(line) => {
                if let Err(e) = tx.send(line).await {
                    tracing::error!(error = %e, "failed to write response");
                }
            }
            Err(e) => tracing::error!(error = %e, "failed to encode response"),
        }
    }

    async fn handle(&self, req: Request) -> Result<Value, ErrorBody> {
        use std::sync::atomic::Ordering;

        // `runtime.initialize` must come first: serving anything else before versions are agreed is
        // how a host and runtime end up disagreeing about a payload shape mid-turn.
        if req.method != "runtime.initialize" && !self.initialized.load(Ordering::SeqCst) {
            return Err(RuntimeError::invalid(
                "protocol.not_initialized",
                "runtime.initialize must be called before any other method.",
            )
            .into());
        }

        match req.method.as_str() {
            "runtime.initialize" => {
                let p: InitializeParams = parse(req.params)?;
                if !is_compatible(&p.protocol_version) {
                    return Err(RuntimeError::invalid(
                        "protocol.version_mismatch",
                        format!(
                            "host requested protocol {} but this runtime speaks {PROTOCOL_VERSION}",
                            p.protocol_version
                        ),
                    )
                    .into());
                }
                self.initialized.store(true, Ordering::SeqCst);
                self.permissions.initialize(&p);
                tracing::info!(client = ?p.client, "initialized");
                Ok(json!(InitializeResult {
                    protocol_version: PROTOCOL_VERSION,
                    runtime_version: RUNTIME_VERSION,
                    tools: self.registry.list().iter().map(|m| m.name.to_string()).collect(),
                    mutating_tools: self
                        .registry
                        .list()
                        .iter()
                        .filter(|m| !matches!(m.risk_level, agent_tools::tool::RiskLevel::ReadOnly))
                        .map(|m| m.name.to_string())
                        .collect(),
                    features: FEATURES.iter().map(|f| f.to_string()).collect(),
                    // Reported at handshake because that is the only moment the host can still act on it:
                    // once it starts sending work, an interrupted task from the last run is indistinguishable
                    // from this run's. A host that does not know the field ignores it, exactly as with
                    // `features`.
                    recovered: (*self.recovered).clone(),
                }))
            }

            "tool.list" => {
                let tools: Vec<ToolDescriptor> = self
                    .registry
                    .list()
                    .into_iter()
                    .map(|m| ToolDescriptor {
                        name: m.name.to_string(),
                        description: m.description.to_string(),
                        parameters: m.input_schema,
                        capabilities: m.capabilities.iter().map(|s| s.to_string()).collect(),
                        risk_level: match m.risk_level {
                            RiskLevel::ReadOnly => "read_only",
                            RiskLevel::Mutating => "mutating",
                            RiskLevel::Elevated => "elevated",
                        }
                        .to_string(),
                        execution_mode: match m.execution_mode {
                            ExecutionMode::InProcess => "in_process",
                            ExecutionMode::HostProcess => "host_process",
                            ExecutionMode::Sandbox => "sandbox",
                        }
                        .to_string(),
                        timeout_ms: m.timeout_ms,
                    })
                    .collect();
                Ok(json!({ "tools": tools }))
            }

            "tool.call" => {
                let p: ToolCallParams = parse(req.params)?;
                Ok(json!(self.call_tool(p).await))
            }

            m if m.starts_with("mcp.") => self.handle_mcp(m, req.params).await,
            m if m.starts_with("subagent.") => self.handle_subagent(m, req.params).await,
            m if m.starts_with("process.") => self.handle_process(m, req.params).await,

            // One cancel for every kind of call — see `CancelParams`. `tool.cancel` is the 1.0
            // spelling and stays accepted: a host and a runtime are versioned separately here.
            "call.cancel" | "tool.cancel" => {
                let p: CancelParams = parse(req.params)?;
                // Cancelling an id that already finished is a no-op, which is what makes the race
                // harmless: a call can complete between the user's click and this arriving.
                //
                // Handled on the request loop rather than scheduled, deliberately: a cancel that
                // queued behind the work it is meant to stop would never run.
                //
                // Under `early_cancels`' lock for the WHOLE look-up-then-record, not just the record. The
                // registering side (`register_call`) inserts into `inflight` and checks `early_cancels`
                // under the same lock. Without that, the two sides interleave: this misses the call in
                // `inflight`, the call registers and finds nothing in `early_cancels`, and only then does
                // this record the id — which nobody reads again. The user's Stop is lost and the command
                // runs to completion. That is what `a_call_can_be_cancelled_before_it_starts` was catching
                // about one run in sixty, and one in five on a slow filesystem.
                let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
                match self.inflight.get(&p.call_id) {
                    Some(handle) => {
                        // Both, because they cover different stages: the token reaches a body that is
                        // running or about to be, the scheduler reaches a task still in its queue.
                        handle.token.cancel();
                        self.scheduler.cancel(&handle.task);
                    }
                    // Not registered YET, rather than already finished — the two are indistinguishable
                    // from here, so the id is remembered and checked when a call claims it. Cancelling
                    // an id that already finished stays a no-op; the entry simply ages out.
                    None => {
                        early.push_back(p.call_id.clone());
                        while early.len() > MAX_EARLY_CANCELS {
                            early.pop_front();
                        }
                    }
                }
                drop(early);
                Ok(json!({ "ok": true }))
            }

            "workspace.invalidate" => {
                let p: InvalidateParams = parse(req.params)?;
                match p.workdir {
                    Some(dir) => self.file_cache.invalidate(Workspace::new(&dir).root()),
                    None => self.file_cache.invalidate_all(),
                }
                Ok(json!({ "ok": true }))
            }

            // ── The Agent Loop, inside the runtime (TODO §2.1) ────────────────────────────────────
            //
            // The whole Model → Agent → Tool → Result cycle, run here rather than in a renderer. The pieces
            // are `agent-provider` (the model), `agent-dispatch` (the tools, behind the permission check) and
            // `agent-loop` (the decisions). This method is what finally puts them together.
            //
            // Cancellable by `run_id` through the same `call.cancel` every other kind of work uses: "stop what
            // you are doing" is one question, and having two answers to it is how a cancellation reaches one
            // subsystem and not the other.
            "agent.run" => {
                let p: AgentRunParams = parse(req.params)?;
                Ok(json!(self.run_agent(p).await?))
            }

            // Hold and release queued work (TODO §2.1). Deliberately by the same id every other kind of work
            // is addressed by, so a caller does not have to know whether the thing it wants to hold is a tool
            // call, a command or an agent run.
            "task.pause" | "task.resume" => {
                let p: CancelParams = parse(req.params)?;
                let id = p.call_id;
                // The scheduler's task id, not the host's call id: `inflight` is what maps between them.
                let Some(task) = self.inflight.get(&id).map(|h| h.task.clone()) else {
                    return Ok(json!({ "ok": false, "reason": "no such call" }));
                };
                let ok = if req.method == "task.pause" {
                    self.scheduler.pause(&task).await
                } else {
                    self.scheduler.resume(&task).await
                };
                // `false` is an answer, not an error: pausing work that has already started is a question with
                // a legitimate negative answer, and the caller needs to hear it rather than see a failure.
                Ok(json!({ "ok": ok }))
            }

            "runtime.status" => {
                // The scheduler's own view, which is the only place that can answer "what is this
                // runtime doing" now that every unit of work goes through it.
                let tasks = self.scheduler.snapshot().await;
                let running = tasks.iter().filter(|t| t.state == agent_core::TaskState::Running).count();
                let queued = tasks.len() - running;
                Ok(json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "runtime_version": RUNTIME_VERSION,
                    "inflight": self.inflight.len(),
                    "cached_workspaces": self.file_cache.len(),
                    "scheduler": { "running": running, "queued": queued, "tasks": tasks },
                    // Derived from the event stream rather than instrumented at call sites, and reported as
                    // percentiles: a mean hides the tail, which is the only interesting part of "how long does
                    // Stop take".
                    "metrics": self.metrics.snapshot(),
                    "recovered": *self.recovered,
                }))
            }

            "runtime.shutdown" => {
                // Cancelled AFTER this reply is written, not during it. Cancelling here ends the
                // request loop immediately, and the reply is written by a task the loop was about to
                // let finish — so the host never sees an answer and waits out its own shutdown
                // timeout instead. Two seconds on every quit, for a message that had already been
                // handled. Yielding once lets `dispatch` write before the loop stops.
                let token = self.root_cancel.clone();
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    token.cancel();
                });
                Ok(json!({ "ok": true }))
            }

            other => Err(RuntimeError::invalid(
                "protocol.unknown_method",
                format!("unknown method: {other}"),
            )
            .into()),
        }
    }

    /// Run one tool call, tracked so it can be cancelled by id.
    async fn call_tool(&self, p: ToolCallParams) -> ToolCallResult {
        let started = std::time::Instant::now();
        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

        let registry = Arc::clone(&self.registry);
        let file_cache = Arc::clone(&self.file_cache);
        let workdir = p.workdir.clone();
        let asset_dir = p.asset_dir.clone().unwrap_or_default();
        let name = p.name.clone();
        let args = p.args.clone();
        let handle = CallId::from_host(call_id.clone());
        // Through the scheduler, which is what bounds concurrent tool calls across every conversation.
        // The token comes from the task rather than from the runtime root, so the cancellation tree is
        // the scheduler's — one place that knows how to stop work, whether it has started or not.
        let joined = self
            .scheduled(
                format!("tool:{}", p.name),
                ResourceClass::Tool,
                Some(&call_id),
                self.registry.get(&p.name).and_then(|t| t.metadata().timeout_ms).map(std::time::Duration::from_millis),
                move |cancel| {
                    let registry = Arc::clone(&registry);
                    let ctx = ToolContext::new(
                        Workspace::new(&workdir).with_assets(&asset_dir),
                        cancel,
                        handle.clone(),
                        Arc::clone(&file_cache),
                    );
                    let name = name.clone();
                    let args = args.clone();
                    // Spawned so a panic in a tool is contained: `JoinError` below turns it into a
                    // failed call rather than an aborted process.
                    Box::pin(async move { tokio::spawn(async move { registry.execute(&name, &ctx, &args).await }).await })
                },
            )
            .await;

        let Some(joined) = joined else {
            // `runtime.cancelled`, not a code of its own: `to_legacy_content` matches on exactly that
            // code to produce the cancellation sentence the UI already renders, so a second spelling
            // would give the model "Error in <tool>: The user stopped this operation." for a call
            // cancelled while queued and the bare sentence for one cancelled while running. One user
            // action, one string.
            let err = RuntimeError::new("runtime.cancelled", ErrorClass::Cancelled, "The user stopped this operation.");
            return ToolCallResult {
                ok: false,
                content: to_legacy_content(&p.name, &err),
                error: Some((&err).into()),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        };

        match joined {
            Ok(Ok(inv)) => ToolCallResult {
                ok: true,
                content: inv.content,
                error: None,
                duration_ms: inv.duration_ms,
            },
            Ok(Err(err)) => ToolCallResult {
                ok: false,
                content: to_legacy_content(&p.name, &err),
                error: Some((&err).into()),
                duration_ms: started.elapsed().as_millis() as u64,
            },
            Err(join_err) => {
                tracing::error!(tool = %p.name, error = %join_err, "tool task failed");
                let err = RuntimeError::new(
                    "tool.panicked",
                    ErrorClass::Internal,
                    format!("The {} tool crashed.", p.name),
                )
                .with_cause(join_err);
                ToolCallResult {
                    ok: false,
                    content: to_legacy_content(&p.name, &err),
                    error: Some((&err).into()),
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
        }
    }
}

/// Removes a pending host call when its future ends, however it ends.
struct PendingGuard {
    calls: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.calls.remove(&self.id);
    }
}

/// The runtime's end of the runtime→host direction.
///
/// Split out of `Server` so a task that outlives a request — a delegation body, and later a consent
/// prompt — can hold one without holding the whole server.
#[derive(Clone)]
pub struct HostChannel {
    sender: Arc<OnceLock<StdioSender>>,
    calls: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

impl HostChannel {
    /// Ask the host to do something, and wait for its answer.
    ///
    /// Errors rather than panics on every path a caller cannot control: no transport yet, a host that
    /// never answers, a host that answers with an error. A sub-agent whose body cannot be dispatched is
    /// a failed delegation, not a dead runtime.
    pub async fn ask(
        &self,
        method: &'static str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let Some(tx) = self.sender.get().cloned() else {
            return Err("the runtime has no connection to its host".to_owned());
        };
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        // Registered BEFORE the send, not after. The host can answer in the same breath as it reads,
        // and a reply arriving before this entry existed would be discarded as one nobody is waiting
        // for — leaving the caller to time out on work that had already been done. The same ordering
        // rule that the process-exit and MCP-state races both came down to.
        self.calls.insert(id, reply_tx);
        // Removes the entry however this future ends, including being DROPPED — which is exactly what
        // happens to a cancelled delegation, since the supervisor aborts its task. Without this, every
        // cancelled sub-agent would leave a sender behind waiting for a reply that never comes.
        let _cleanup = PendingGuard { calls: Arc::clone(&self.calls), id };

        let line = match serde_json::to_string(&HostRequest { id, method, params }) {
            Ok(line) => line,
            Err(e) => return Err(format!("could not encode a request to the host: {e}")),
        };
        if let Err(e) = tx.send(line).await {
            return Err(format!("could not reach the host: {e}"));
        }

        match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            // The sender was dropped, which only happens if the entry was removed by a shutdown.
            Ok(Err(_)) => Err("the host connection closed before answering".to_owned()),
            // The guard removes the entry, so a late reply is discarded rather than settling a
            // caller that gave up.
            Err(_) => Err(format!("the host did not answer {method} within {timeout:?}")),
        }
    }
}

impl Server {

    /// Run one unit of work through the scheduler and hand back what it produced.
    ///
    /// The scheduler reports how a task ENDED, not what it returned, so the value comes back through a
    /// slot the body fills. `TaskBody` is `FnMut` because a retry policy may call it again; nothing here
    /// retries yet, and a body that did would simply overwrite the slot.
    ///
    /// `None` means the work never produced a value — cancelled, or refused before it started. Callers
    /// turn that into whatever their own contract says a stopped call looks like, because "cancelled"
    /// reads very differently to a model depending on what was cancelled.
    async fn scheduled<T, F>(
        &self,
        label: impl Into<String>,
        resource: ResourceClass,
        call_id: Option<&str>,
        timeout: Option<std::time::Duration>,
        make: F,
    ) -> Option<T>
    where
        T: Send + 'static,
        F: Fn(CancellationToken) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>
            + Send
            + Sync
            + 'static,
    {
        let task_id = agent_core::TaskId::new();
        let call_token = CancellationToken::new();
        // Registered before submission, so a cancel arriving while the task is still queued finds it.
        // The same ordering rule as everywhere else in this migration (D12).
        if let Some(id) = call_id {
            // A cancel that arrived first is answered by NOT STARTING, rather than by cancelling: the task
            // has not been submitted yet, so `scheduler.cancel` on this id would be a no-op against a task
            // the scheduler has never heard of. That was the first version of this fix, and it did nothing
            // at all.
            let claimed =
                self.register_call(id, CallHandle { task: task_id.clone(), token: call_token.clone() });
            if claimed {
                self.inflight.remove(id);
                return None;
            }
        }

        let slot: Arc<std::sync::Mutex<Option<T>>> = Arc::new(std::sync::Mutex::new(None));
        let writer = Arc::clone(&slot);
        let spec = TaskSpec {
            id: task_id.clone(),
            priority: Priority::Normal,
            parent: None,
            depends_on: Vec::new(),
            resource,
            timeout,
            retry: Default::default(),
            label: label.into(),
        };
        let body = Box::new(move |ctx: agent_scheduler::TaskContext| {
            // Link this server's call token to the task's own, so a cancel that arrived before the
            // scheduler had ever heard of this task still reaches the work. Fires immediately if the
            // token is already cancelled, which is exactly the window this exists for.
            let linked = ctx.cancel.clone();
            let call_token = call_token.clone();
            tokio::spawn(async move {
                call_token.cancelled().await;
                linked.cancel();
            });
            let fut = make(ctx.cancel.clone());
            let writer = Arc::clone(&writer);
            Box::pin(async move {
                let value = fut.await;
                *writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
                Ok(())
            }) as agent_scheduler::TaskFuture
        });

        let outcome = self.scheduler.run_to_completion(spec, body).await;
        if let Some(id) = call_id {
            self.inflight.remove(id);
        }
        match outcome {
            Ok(Outcome::Completed) => slot.lock().unwrap_or_else(|e| e.into_inner()).take(),
            // Cancelled, failed or refused: the body may still have written a value before it was
            // stopped, and if it did that is the more useful answer than a synthesised one.
            _ => slot.lock().unwrap_or_else(|e| e.into_inner()).take(),
        }
    }

    /// Register `id` as cancellable and claim any cancel that arrived before it. Returns whether one had.
    ///
    /// Both steps under `early_cancels`' lock, which the `call.cancel` handler also holds across its own
    /// look-up-then-record. That shared lock is the whole fix: each side's check-then-act is two operations,
    /// and unless the pairs exclude each other they interleave — the cancel misses the registration, the
    /// registration misses the cancel, and Stop is silently dropped. Registering first and claiming second
    /// (the previous arrangement) orders the steps within one side; it cannot order them against the other.
    ///
    /// Lock order is `early_cancels` then an `inflight` shard, on both sides, so the two cannot deadlock.
    fn register_call(&self, id: &str, handle: CallHandle) -> bool {
        let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
        self.inflight.insert(id.to_owned(), handle);
        early.iter().position(|c| c == id).map(|pos| early.remove(pos)).is_some()
    }

    /// A handle to the runtime→host direction, for tasks that outlive a request.    /// A handle to the runtime→host direction, for tasks that outlive a request.
    fn host_channel(&self) -> HostChannel {
        HostChannel {
            sender: Arc::clone(&self.events),
            calls: Arc::clone(&self.host_calls),
            next_id: Arc::clone(&self.next_host_id),
        }
    }

}

impl Default for Server {
    fn default() -> Self {
        Self::new()
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    serde_json::from_value(params).map_err(|e| {
        RuntimeError::invalid("protocol.invalid_params", format!("invalid params: {e}")).into()
    })
}
