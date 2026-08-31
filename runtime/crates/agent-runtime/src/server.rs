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

use agent_core::{CallId, CancellationToken, ErrorClass, RuntimeError};
use agent_ipc::protocol::{
    is_compatible, CancelParams, ErrorBody, InitializeParams, InitializeResult, InvalidateParams,
    McpCallParams, McpCallResult, McpConnectParams, McpServerParams, McpServerStatus, McpStatusResult,
    McpToolDescriptor, Notification, PeekResult, PidParams, ProcessExitedEvent, ProcessRunParams,
    ProcessRunResult, Request, Response, ServiceDescriptor, ServiceListResult, StartBackgroundParams,
    StartBackgroundResult, StoppedResult, ToolCallParams, ToolCallResult, ToolDescriptor,
    EVENT_MCP_STATE, EVENT_PROCESS_EXITED, FEATURES, PROTOCOL_VERSION,
};
use agent_ipc::protocol::{
    decode_incoming, HostRequest, Incoming, SubagentJoinParams, SubagentJoinResult, SubagentOutcome,
    SubagentSpawnParams, SubagentSpawnResult, SubagentSpawned, SubagentStatus, SubagentTurnParams,
    HOST_RUN_SUBAGENT,
};
use agent_events::EventBus;
use agent_resource::{Limits, ResourceClass, ResourceManager};
use agent_scheduler::{Outcome, Priority, Scheduler, TaskSpec};
use agent_permission::Grant;
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
}

impl Server {
    pub fn new() -> Self {
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
            scheduler: Arc::new(Scheduler::start(ResourceManager::new(Limits::default()), bus)),
        }
    }

    /// Serve until the host closes stdin or sends `runtime.shutdown`.
    pub async fn run(self: Arc<Self>, transport: StdioTransport) -> anyhow::Result<()> {
        let sender = transport.sender();
        // Events are pushed from reaper tasks that have no request to reply to, so the sender has to
        // outlive any one of them. Set here rather than in `new` because the transport is the caller's.
        let _ = self.events.set(sender.clone());
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
                tracing::info!(client = ?p.client, "initialized");
                Ok(json!(InitializeResult {
                    protocol_version: PROTOCOL_VERSION,
                    runtime_version: RUNTIME_VERSION,
                    tools: self.registry.list().iter().map(|m| m.name.to_string()).collect(),
                    features: FEATURES.iter().map(|f| f.to_string()).collect(),
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


            "mcp.connect" => {
                let p: McpConnectParams = parse(req.params)?;
                let max_response_bytes = ServerConfig::default().max_response_bytes;
                // A local program or a remote endpoint. The supervisor above is identical either way,
                // which is the point of the transport trait: reconnection, heartbeat, backpressure and
                // degradation are written once.
                let factory: Arc<dyn agent_mcp::TransportFactory> = match (&p.command, &p.url) {
                    (Some(command), None) => Arc::new(StdioFactory::new(StdioServer {
                        command: command.clone(),
                        args: p.args.clone(),
                        cwd: p.cwd.clone().map(Into::into),
                        env: p.env.clone(),
                        max_response_bytes,
                    })),
                    (None, Some(url)) => Arc::new(
                        HttpFactory::new(HttpServer {
                            url: url.clone(),
                            headers: p.headers.clone(),
                            max_response_bytes,
                        })
                        .map_err(|e| {
                            RuntimeError::invalid("mcp.bad_endpoint", e.describe())
                        })?,
                    ),
                    _ => {
                        return Err(RuntimeError::invalid(
                            "mcp.bad_config",
                            "an MCP server needs exactly one of `command` (local) or `url` (remote).",
                        )
                        .into())
                    }
                };
                let sup = self.mcp.add(p.id.clone(), factory, ServerConfig::default());

                // Watch this connection and push every transition. Started here rather than inside the
                // supervisor because who is told is the host's business, not the connection's.
                let mut rx = sup.watch_state();
                let events = Arc::clone(&self.events);
                let watched = Arc::clone(&sup);
                let id = p.id.clone();
                tokio::spawn(async move {
                    // `changed()` ends when the supervisor is dropped, which is the disconnect path.
                    while rx.changed().await.is_ok() {
                        let state = rx.borrow().clone();
                        let closed = matches!(state, ConnState::Closed);
                        if let Some(tx) = events.get().cloned() {
                            let status = describe_server(&id, &watched);
                            if let Ok(line) = serde_json::to_string(&Notification {
                                method: EVENT_MCP_STATE,
                                params: json!(status),
                            }) {
                                let _ = tx.send(line).await;
                            }
                        }
                        if closed {
                            break;
                        }
                    }
                });

                // Returns now, not when the server is ready: a connecting server must never delay a
                // turn. Readiness arrives as an mcp.state event.
                Ok(json!({ "id": p.id, "state": state_label(&sup.state()) }))
            }

            "mcp.call" => {
                let p: McpCallParams = parse(req.params)?;
                // `ToolCallOutcome` has no error variant by construction: an external server must not
                // be able to abort a turn, which is the same invariant `callMcpTool` carries in JS.
                let Some(sup) = self.mcp.get(&p.server) else {
                    return Ok(json!(McpCallResult {
                        delivered: false,
                        raw: None,
                        error: Some(format!("no MCP server named '{}' is connected", p.server)),
                    }));
                };
                // Scheduled like tools and commands, so `call.cancel` reaches an MCP call the same way
                // it reaches anything else -- without which a stopped turn would leave the call holding
                // its backpressure permit until the server answered. The per-server in-flight cap in
                // `agent-mcp` still applies underneath; this one bounds MCP work across all servers.
                let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());
                let tool = p.tool.clone();
                let args = p.args.clone();
                let out = self
                    .scheduled(
                        format!("mcp:{}/{}", p.server, p.tool),
                        ResourceClass::Mcp,
                        Some(&call_id),
                        // The supervisor owns the per-call timeout, and it words the failure for the
                        // model; a second ceiling here would just race it.
                        None,
                        move |cancel| {
                            let sup = Arc::clone(&sup);
                            let tool = tool.clone();
                            let args = args.clone();
                            Box::pin(async move { sup.call_cancellable(&tool, args, &cancel).await })
                        },
                    )
                    .await;
                let Some(out) = out else {
                    return Ok(json!(McpCallResult {
                        delivered: false,
                        raw: None,
                        error: Some("the call was cancelled".to_owned()),
                    }));
                };
                // `raw` present means a server answered, whatever it said. The host reads `isError`
                // off it and does its own flattening — see `McpToolDescriptor`.
                Ok(json!(match out.raw {
                    Some(raw) => McpCallResult { delivered: true, raw: Some(raw), error: None },
                    None => McpCallResult { delivered: false, raw: None, error: Some(out.content) },
                }))
            }

            "mcp.disconnect" => {
                let p: McpServerParams = parse(req.params)?;
                match self.mcp.get(&p.id) {
                    Some(sup) => {
                        sup.shutdown().await;
                        Ok(json!({ "disconnected": true }))
                    }
                    None => Ok(json!({ "disconnected": false })),
                }
            }

            "mcp.status" => Ok(json!(McpStatusResult {
                servers: self
                    .mcp
                    .ids()
                    .into_iter()
                    .filter_map(|id: String| self.mcp.get(&id).map(|sup| describe_server(&id, &sup)))
                    .collect(),
            })),


            "subagent.spawn" => {
                let p: SubagentSpawnParams = parse(req.params)?;
                let sup = self.supervisor_for(&p.turn);
                let mut spawned = Vec::with_capacity(p.jobs.len());
                for spec in p.jobs {
                    let meta = spec.meta.clone();
                    let turn = p.turn.clone();
                    let this = self.host_channel();
                    // The body is a call back into the host. Everything the runtime is good at --
                    // ordering, coalescing, quotas, the cancellation tree -- happens around it; what
                    // it wraps is a model conversation, which belongs where the models are.
                    let body: agent_subagents::DelegationBody = Box::new(move |ctx| {
                        Box::pin(async move {
                            let params = json!({
                                "turn": turn,
                                "job": ctx.agent.to_string(),
                                "meta": meta,
                                "depth": ctx.depth,
                            });
                            // Deliberately NOT racing `ctx.cancel` here. The supervisor already does:
                            // it gives a cancelled body a grace window to return its own partial
                            // conclusion and then aborts it, which is what produces a `cancelled`
                            // outcome. A body that noticed the token itself and returned `Err` would
                            // report the delegation as FAILED instead — the same conclusion the model
                            // draws when a sub-agent genuinely broke. Dropping this future is the
                            // cancellation, and `ask` cleans up after itself when that happens.
                            this.ask(HOST_RUN_SUBAGENT, params, SUBAGENT_BODY_TIMEOUT)
                                .await
                                .map(|v| {
                                    v.get("result")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned()
                                })
                        })
                    });
                    let r = sup.spawn(spec.meta, spec.key, Grant::empty(), body);
                    spawned.push(SubagentSpawned {
                        id: r.id,
                        coalesced: r.coalesced,
                        refused: r.refused,
                    });
                }
                Ok(json!(SubagentSpawnResult { jobs: spawned }))
            }

            "subagent.join" => {
                let p: SubagentJoinParams = parse(req.params)?;
                let Some(sup) = self.subagents.get(&p.turn).map(|e| Arc::clone(&e)) else {
                    // Nothing was ever spawned for this turn. Every id asked for is unknown, which is
                    // what the model gets told rather than an error it cannot act on.
                    return Ok(json!(SubagentJoinResult {
                        ready: vec![],
                        pending: vec![],
                        unknown: p.ids,
                        timed_out: false,
                    }));
                };
                let mode = if p.mode.as_deref() == Some("any") { JoinMode::Any } else { JoinMode::All };
                let timeout = p
                    .timeout_ms
                    .map(std::time::Duration::from_millis)
                    .map(|d| d.min(JOIN_MAX_TIMEOUT));
                let r = sup.join(&p.ids, mode, timeout, p.block).await;
                Ok(json!(SubagentJoinResult {
                    ready: r
                        .ready
                        .into_iter()
                        .map(|(view, outcome)| SubagentOutcome {
                            id: outcome.id,
                            meta: view.meta,
                            state: format!("{:?}", outcome.state).to_lowercase(),
                            result: outcome.result,
                            ms: outcome.ms,
                            coalesced: view.coalesced,
                        })
                        .collect(),
                    pending: r.pending,
                    unknown: r.unknown,
                    timed_out: r.timed_out,
                }))
            }

            "subagent.cancel" => {
                let p: SubagentTurnParams = parse(req.params)?;
                if let Some(sup) = self.subagents.get(&p.turn) {
                    sup.cancel_all(p.reason.as_deref().unwrap_or("the turn was interrupted"));
                }
                Ok(json!({ "ok": true }))
            }

            "subagent.status" => {
                let p: SubagentTurnParams = parse(req.params)?;
                let Some(sup) = self.subagents.get(&p.turn).map(|e| Arc::clone(&e)) else {
                    return Ok(json!(SubagentStatus {
                        turn: p.turn,
                        queued: 0,
                        running: 0,
                        settled: 0,
                        total: 0,
                        outstanding: vec![],
                    }));
                };
                let (queued, running, settled, total) = sup.counts();
                Ok(json!(SubagentStatus {
                    turn: p.turn,
                    queued,
                    running,
                    settled,
                    total,
                    outstanding: sup.outstanding(),
                }))
            }

            "process.run" => {
                let p: ProcessRunParams = parse(req.params)?;
                Ok(json!(self.run_process(p).await))
            }

            "process.start_background" => {
                let p: StartBackgroundParams = parse(req.params)?;
                // The sender outlives the call that started the service: the callback runs long
                // after this request has been answered.
                let events = Arc::clone(&self.events);
                let command = p.command.clone();
                let pid = self
                    .background
                    .start(&p.command, p.cwd.map(Into::into), move |exited| {
                        // Retirement happens inside the registry before this fires, so a `process.list`
                        // racing the event cannot report a service that has already ended.
                        if let Some(tx) = events.get().cloned() {
                            let event = ProcessExitedEvent {
                                pid: exited.pid,
                                code: exited.code,
                                signal: exited.signal,
                                output: exited.output,
                                command: exited.command,
                            };
                            // Spawned because the reaper's callback is synchronous and writing to the
                            // host is not. Losing the event would leave a dead service showing as
                            // running in the UI, so it is worth a task.
                            tokio::spawn(async move {
                                match serde_json::to_string(&Notification {
                                    method: EVENT_PROCESS_EXITED,
                                    params: json!(event),
                                }) {
                                    Ok(line) => {
                                        if let Err(e) = tx.send(line).await {
                                            tracing::warn!(error = %e, "failed to push process.exited");
                                        }
                                    }
                                    Err(e) => tracing::error!(error = %e, "failed to encode process.exited"),
                                }
                            });
                        }
                    })
                    .map_err(|e| {
                        // A service that could not start is a real error rather than a result: unlike a
                        // command that ran and failed, there is no output to report and no pid to track.
                        RuntimeError::new("process.spawn_failed", ErrorClass::Internal, e)
                    })?;
                tracing::info!(pid, command = %command, "background service started");
                Ok(json!(StartBackgroundResult { pid }))
            }

            "process.peek" => {
                let p: PidParams = parse(req.params)?;
                // A finished service still answers, with `alive: false` and the output it left
                // behind — see RECENTLY_EXITED_KEPT. An unknown pid answers empty.
                Ok(match self.background.peek(p.pid) {
                    Some((alive, output)) => json!(PeekResult { alive, output }),
                    None => json!(PeekResult { alive: false, output: String::new() }),
                })
            }

            "process.stop" => {
                let p: PidParams = parse(req.params)?;
                Ok(json!(StoppedResult { stopped: self.background.stop(p.pid) }))
            }

            "process.list" => Ok(json!(ServiceListResult {
                services: self
                    .background
                    .list()
                    .into_iter()
                    .map(|(pid, command)| ServiceDescriptor { pid, command })
                    .collect(),
            })),

            "process.stop_all" => Ok(json!({ "stopped": self.background.stop_all() })),

            // One cancel for every kind of call — see `CancelParams`. `tool.cancel` is the 1.0
            // spelling and stays accepted: a host and a runtime are versioned separately here.
            "call.cancel" | "tool.cancel" => {
                let p: CancelParams = parse(req.params)?;
                // Cancelling an id that already finished is a no-op, which is what makes the race
                // harmless: a call can complete between the user's click and this arriving.
                //
                // Handled on the request loop rather than scheduled, deliberately: a cancel that
                // queued behind the work it is meant to stop would never run.
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
                        let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
                        early.push_back(p.call_id.clone());
                        while early.len() > MAX_EARLY_CANCELS {
                            early.pop_front();
                        }
                    }
                }
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

    /// Run one foreground command, tracked so it can be cancelled by id.
    ///
    /// The host calls this from `native.mjs`'s `run()`, which means everything above that function
    /// keeps its behaviour: the `run_command` guardrails, the engine choice, the sandbox fallback and
    /// the result wording all stay in JS. What moves is the execution — and with it the two properties
    /// the JS path cannot have: a Stop that actually reaches the process tree, and output that stops
    /// being read at the cap instead of being buffered whole and trimmed afterwards.
    ///
    /// No workspace containment check, deliberately. `run()` accepts any `cwd` today and the caller
    /// chooses it; adding a restriction here would be a security control invented mid-migration, in the
    /// one place where a difference from the JS path shows up as a command that inexplicably refuses to
    /// run. Confinement belongs to `agent-sandbox` and the permission runtime, gated by their own stage.
    async fn run_process(&self, p: ProcessRunParams) -> ProcessRunResult {
        use agent_process::{ExitCode, ProcessRequest};

        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

        let mut req = ProcessRequest::new(p.command.clone());
        if let Some(dir) = &p.cwd {
            req = req.in_dir(dir);
        }
        if let Some(ms) = p.timeout_ms {
            req = req.with_timeout(std::time::Duration::from_millis(ms));
        }
        if let Some(cap) = p.max_buffer {
            // Saturating rather than `as`: a host sending a cap larger than this platform's usize
            // means "do not cap", and wrapping it into a small number would silently truncate output.
            req = req.with_max_buffer(usize::try_from(cap).unwrap_or(usize::MAX));
        }

        // Through the scheduler, which bounds how many host commands can run at once — the JS path
        // has no such cap, so a model that fans out into twenty builds gets twenty.
        let joined = self
            .scheduled(
                format!("process:{}", p.command.chars().take(40).collect::<String>()),
                ResourceClass::Process,
                Some(&call_id),
                // No task timeout: the command carries its own, and `agent-process` reports a killed
                // command as a RESULT with its partial output. A scheduler timeout would discard that.
                None,
                move |cancel| {
                    let req = req.clone();
                    // Spawned for the same reason `call_tool` spawns: a panic becomes this call's
                    // failure rather than a request the host waits out to its 180s timeout.
                    Box::pin(async move { tokio::spawn(async move { agent_process::run(req, &cancel).await }).await })
                },
            )
            .await;

        let Some(joined) = joined else {
            // Refused or cancelled before it produced anything. Reported as a user stop, which is the
            // only way a caller can reach this today.
            return ProcessRunResult {
                stdout: String::new(),
                stderr: String::new(),
                code: json!("?"),
                killed: false,
                canceled: true,
                truncated: false,
            };
        };

        match joined {
            Ok(r) => ProcessRunResult {
                stdout: r.stdout,
                stderr: r.stderr,
                code: match r.code {
                    ExitCode::Code(c) => json!(c),
                    ExitCode::Unknown => json!("?"),
                },
                killed: r.killed,
                canceled: r.canceled,
                truncated: r.truncated,
            },
            Err(join_err) => {
                tracing::error!(error = %join_err, "process task failed");
                // Shaped like a spawn failure, which is what the JS path reports when the child could
                // not start: the reason on stderr, an unknown code, and no exception for a caller that
                // has no way to handle one.
                ProcessRunResult {
                    stdout: String::new(),
                    stderr: format!("the runtime failed to run this command: {join_err}"),
                    code: json!("?"),
                    killed: false,
                    canceled: false,
                    truncated: false,
                }
            }
        }
    }

    /// Run one tool call, tracked so it can be cancelled by id.
    async fn call_tool(&self, p: ToolCallParams) -> ToolCallResult {
        let started = std::time::Instant::now();
        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

        let registry = Arc::clone(&self.registry);
        let file_cache = Arc::clone(&self.file_cache);
        let workdir = p.workdir.clone();
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
                        Workspace::new(&workdir),
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
            let err = RuntimeError::new("tool.cancelled", ErrorClass::Cancelled, "The user stopped this operation.");
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

/// How long a delegation may wait for the host to run it.
///
/// Generous because the work behind it is a whole sub-agent conversation — rounds of model calls and
/// tool execution. It is a backstop against a host that has stopped answering, not a task deadline:
/// the real bound is the caller's own cancellation, which reaches the delegation immediately.
const SUBAGENT_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

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
            self.inflight
                .insert(id.to_owned(), CallHandle { task: task_id.clone(), token: call_token.clone() });
            // Claimed AFTER registering, so a cancel arriving in between is seen by one side or the
            // other and never by neither.
            //
            // And answered by NOT STARTING, rather than by cancelling: the task has not been submitted
            // yet, so `scheduler.cancel` on this id would be a no-op against a task the scheduler has
            // never heard of. That was the first version of this fix, and it did nothing at all.
            let claimed = {
                let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
                early.iter().position(|c| c == id).map(|pos| early.remove(pos)).is_some()
            };
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

    /// A handle to the runtime→host direction, for tasks that outlive a request.
    fn host_channel(&self) -> HostChannel {
        HostChannel {
            sender: Arc::clone(&self.events),
            calls: Arc::clone(&self.host_calls),
            next_id: Arc::clone(&self.next_host_id),
        }
    }

    /// The supervisor for one turn, created on first use.
    ///
    /// Its cancellation token derives from the runtime root, so shutting the runtime down cancels every
    /// delegation beneath every turn without anyone keeping a list.
    fn supervisor_for(&self, turn: &str) -> Arc<SubAgentSupervisor<Value>> {
        if let Some(existing) = self.subagents.get(turn) {
            return Arc::clone(&existing);
        }
        let sup = Arc::new(SubAgentSupervisor::new(
            agent_core::TaskId::new(),
            &self.root_cancel,
            self.bus.clone(),
        ));
        // `entry` rather than `insert`: two spawns for one turn can race here, and the loser must get
        // the supervisor that won rather than a second one holding half the jobs.
        Arc::clone(self.subagents.entry(turn.to_owned()).or_insert(sup).value())
    }
}

impl Default for Server {
    fn default() -> Self {
        Self::new()
    }
}

/// The wire label for a connection state.
fn state_label(state: &ConnState) -> String {
    match state {
        ConnState::Idle => "idle",
        ConnState::Connecting => "connecting",
        ConnState::Ready => "ready",
        ConnState::Degraded { .. } => "degraded",
        ConnState::Failed { .. } => "failed",
        ConnState::Closed => "closed",
    }
    .to_owned()
}

/// One server's state and current declarations, in the shape the host consumes.
fn describe_server(id: &str, sup: &agent_mcp::ConnectionSupervisor) -> McpServerStatus {
    let state = sup.state();
    let reason = match &state {
        ConnState::Degraded { reason } | ConnState::Failed { reason } => Some(reason.clone()),
        _ => None,
    };
    McpServerStatus {
        id: id.to_owned(),
        state: state_label(&state),
        reason,
        stderr: sup.diagnostics(),
        // Empty unless ready — the supervisor's rule, not this function's: a server that cannot serve
        // a call must not be declaring tools to the model.
        tools: sup
            .tools_snapshot()
            .into_iter()
            .map(|t| McpToolDescriptor {
                // The server's own name, not the namespaced one: the host owns that scheme.
                name: t.remote_name,
                description: t.description,
                input_schema: t.parameters,
            })
            .collect(),
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    serde_json::from_value(params).map_err(|e| {
        RuntimeError::invalid("protocol.invalid_params", format!("invalid params: {e}")).into()
    })
}
