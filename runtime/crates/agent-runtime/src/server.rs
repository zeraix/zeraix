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
    AgentRunParams, AgentRunResult, EVENT_AGENT_DELTA, EVENT_MCP_STATE, EVENT_PROCESS_EXITED,
    EVENT_AGENT_TOOL, EVENT_AGENT_TURN, EVENT_RUNTIME, FEATURES, HOST_REQUEST_ASK,
    HOST_REQUEST_CONSENT,
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
use agent_permission::{Grant, PermissionRuntime, Policy, Principal};
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
    /// The capability ceiling for this session, set at `runtime.initialize` from the roots the host says the
    /// user approved.
    ///
    /// Behind a `OnceLock` because it is not knowable until the handshake: only the host knows which
    /// directories the user has consented to. Until it is set — and for a host that never sends any — the
    /// ceiling grants nothing, which is the safe default rather than a permissive one.
    permissions: Arc<OnceLock<Arc<PermissionRuntime>>>,
    /// Derived metrics (TODO §11). Subscribed to the bus in `run`, so nothing has to be instrumented at its
    /// call site — see `agent-audit`'s header for why that is the right shape.
    metrics: Arc<agent_audit::MetricsCollector>,
    /// Whether the host declared a permission policy at the handshake.
    ///
    /// Read only by the SANDBOX now: MCP enforcement became unconditional (§0.2 F7), but confining a command
    /// to an empty allowlist would stop it exec'ing a shell at all, which is a different failure from denying
    /// it — so an undeclared policy means "unconfined", not "confined to nothing".
    policy_declared: Arc<std::sync::atomic::AtomicBool>,
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
            permissions: Arc::new(OnceLock::new()),
            policy_declared: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            recovered: Arc::new(recovered),
        }
    }

    /// Ask the host whether one action may proceed.
    ///
    /// This is what turns the capability check from a wall into a decision. `agent-dispatch` consults the
    /// permission runtime, the permission runtime consults its `Approver`, and this is the approver that can
    /// reach a person — through `HostChannel`, the same runtime→host request path the sub-agent body uses.
    ///
    /// Holds a `HostChannel` rather than the `Server`: asking a question needs the channel and nothing else,
    /// and a long-lived `Arc<Server>` inside a permission object is a cycle waiting to be written.
    ///
    /// Denies on any failure — a timeout, a host that does not implement the method, a malformed reply. The
    /// default approver denies for the same reason, and it is the only safe direction: a runtime that cannot
    /// ask must not proceed as though it had asked and been told yes.
    fn host_approver(&self) -> Arc<dyn agent_permission::Approver> {
        struct HostApprover {
            channel: HostChannel,
        }
        #[async_trait::async_trait]
        impl agent_permission::Approver for HostApprover {
            async fn approve(
                &self,
                principal: &agent_permission::Principal,
                request: &agent_permission::Request,
            ) -> bool {
                let params = json!({
                    "capability": request.kind.as_str(),
                    "resource": format!("{:?}", request.resource),
                    "call": request.call.to_string(),
                    "agent": principal.agent.to_string(),
                    "depth": principal.depth,
                });
                match self.channel.ask(HOST_REQUEST_CONSENT, params, CONSENT_TIMEOUT).await {
                    Ok(v) => v.get("approved").and_then(Value::as_bool).unwrap_or(false),
                    Err(e) => {
                        tracing::warn!(error = %e, "consent request failed; denying");
                        false
                    }
                }
            }
        }
        Arc::new(HostApprover { channel: self.host_channel() })
    }

    /// The tools whose implementation is a person.
    ///
    /// Only `ask_user` today. Forwarded rather than answered because the runtime cannot render a dialog and
    /// must not guess — a question the model asks and answers itself is not a question.
    ///
    /// A failure is reported to the MODEL rather than raised: a host that cannot ask, or a user who closed the
    /// dialog, leaves the model needing to proceed without an answer, and telling it so is more useful than
    /// ending the turn.
    fn host_tools(&self) -> Arc<dyn agent_dispatch::HostTools> {
        struct AskUser {
            channel: HostChannel,
        }
        #[async_trait::async_trait]
        impl agent_dispatch::HostTools for AskUser {
            fn serves(&self, name: &str) -> bool {
                name == "ask_user"
            }
            async fn call(&self, _name: &str, args: &Value) -> agent_loop::ToolOutcome {
                match self.channel.ask(HOST_REQUEST_ASK, args.clone(), ASK_TIMEOUT).await {
                    Ok(v) => {
                        // The host returns whatever shape its dialog produced; it goes to the model verbatim.
                        let text = v
                            .get("answers")
                            .map(|a| a.to_string())
                            .unwrap_or_else(|| v.to_string());
                        agent_loop::ToolOutcome::ok(text)
                    }
                    Err(e) => agent_loop::ToolOutcome::failed(format!(
                        "The question could not be put to the user: {e}. Proceed without an answer, or say \
                         what you need and stop."
                    )),
                }
            }
        }
        Arc::new(AskUser { channel: self.host_channel() })
    }

    /// Run one agent turn to completion.
    ///
    /// Additive: nothing in the app calls this yet — `chatRequest.ts` and the TypeScript loop remain the live
    /// path. What it demonstrates is that the runtime can hold a whole turn, which is the claim §2.1 makes and
    /// the thing that could not previously be shown at all.
    async fn run_agent(&self, p: AgentRunParams) -> Result<AgentRunResult, ErrorBody> {
        use agent_loop::{AgentLoop, LoopConfig, Message, StopPolicyConfig};
        use agent_provider::{HttpModel, ProviderConfig};

        let messages: Vec<Message> = p
            .messages
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| {
                RuntimeError::invalid("agent.bad_messages", format!("could not read the conversation: {e}"))
            })?;

        // Token streaming (TODO §10.1). The provider hands back the ACCUMULATED text on every chunk, so the
        // increment is computed here and only that is sent: forwarding the accumulation would be quadratic in
        // the answer's length, and a long reply would get slower to display the longer it grew.
        //
        // Through an unbounded channel rather than straight to the transport, for two reasons. The callback is
        // synchronous and the transport is not; and a bounded queue would push backpressure from the host's
        // stdout all the way into the model read, so a slow reader would stall the generation it is reading.
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
        let forwarder = {
            let events = Arc::clone(&self.events);
            let run_id = p.run_id.clone();
            tokio::spawn(async move {
                while let Some((content, reasoning)) = delta_rx.recv().await {
                    let Some(tx) = events.get().cloned() else { continue };
                    let params = json!({ "run_id": run_id, "content": content, "reasoning": reasoning });
                    if let Ok(line) =
                        serde_json::to_string(&Notification { method: EVENT_AGENT_DELTA, params })
                    {
                        if tx.send(line).await.is_err() {
                            break;
                        }
                    }
                }
            })
        };
        let sent = std::sync::Mutex::new((0usize, 0usize));
        let on_delta: agent_provider::OnDelta = Box::new(move |content, reasoning| {
            let mut sent = sent.lock().unwrap_or_else(|e| e.into_inner());
            // Byte offsets into text that only ever grows by appending, so slicing at the previous length is
            // always on a character boundary.
            let (c_at, r_at) = *sent;
            let c_new = content.get(c_at..).unwrap_or("");
            let r_new = reasoning.get(r_at..).unwrap_or("");
            if c_new.is_empty() && r_new.is_empty() {
                return;
            }
            *sent = (content.len(), reasoning.len());
            let _ = delta_tx.send((c_new.to_owned(), r_new.to_owned()));
        });

        let model = HttpModel::new(ProviderConfig {
            endpoint: p.provider.endpoint,
            api_key: p.provider.api_key,
            model: p.provider.model.clone(),
            capabilities: agent_loop::ModelCapabilities {
                supports_per_turn_reasoning_effort: p.provider.supports_per_turn_reasoning_effort,
                ..Default::default()
            },
            thinking_params: if p.provider.thinking_params.is_null() {
                json!({})
            } else {
                p.provider.thinking_params
            },
            stream: p.provider.stream,
            ..Default::default()
        })?
        .with_on_delta(on_delta);

        // One token for the whole run, registered under the host's id so `call.cancel` reaches it. Registered
        // BEFORE the first request goes out, so a cancel arriving during the opening round is not missed.
        let token = self.root_cancel.child_token();
        let task = agent_core::TaskId::from_host(p.run_id.clone());
        self.inflight.insert(
            p.run_id.clone(),
            CallHandle { task: task.clone(), token: token.clone() },
        );
        // A cancel that arrived before this id was registered. The same race the scheduled path handles:
        // the host can send `call.cancel` for a run whose request is still crossing the wire, and a cancel
        // that found nothing to cancel must not be silently dropped.
        let cancelled_early = {
            let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
            early.iter().position(|c| *c == p.run_id).map(|pos| early.remove(pos)).is_some()
        };
        if cancelled_early {
            token.cancel();
        }

        let workspace = agent_tools::workspace::Workspace::new(&p.workdir);
        let executor = agent_dispatch::DispatchingExecutor::new(
            Arc::clone(&self.registry),
            Arc::new(
                PermissionRuntime::new(self.permission_runtime().policy().clone())
                    .with_approver(self.host_approver()),
            ),
            agent_dispatch::root_principal(
                task,
                agent_core::AgentId::from_host("main"),
                self.permission_runtime().policy().ceiling.clone(),
            ),
            agent_tools::tool::ToolContext::new(
                workspace,
                token.clone(),
                agent_core::CallId::from_host(p.run_id.clone()),
                Arc::clone(&self.file_cache),
            ),
        )
        .with_host_tools(self.host_tools());

        // Tool activity, so a UI can show work in flight rather than only its result. Same channel shape as
        // the deltas, and for the same reasons.
        let (tool_tx, mut tool_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let tool_forwarder = {
            let events = Arc::clone(&self.events);
            tokio::spawn(async move {
                while let Some(params) = tool_rx.recv().await {
                    let Some(tx) = events.get().cloned() else { continue };
                    if let Ok(line) =
                        serde_json::to_string(&Notification { method: EVENT_AGENT_TOOL, params })
                    {
                        if tx.send(line).await.is_err() {
                            break;
                        }
                    }
                }
            })
        };

        struct RunObserver {
            run_id: String,
            tx: tokio::sync::mpsc::UnboundedSender<Value>,
            turns: tokio::sync::mpsc::UnboundedSender<Value>,
        }
        impl agent_loop::LoopObserver for RunObserver {
            fn round_started(&self, round: u32, decision: &agent_loop::ReasoningDecision) {
                let _ = self.turns.send(json!({
                    "run_id": self.run_id,
                    "phase": "start",
                    "round": round,
                    "effort": decision.effort_param(),
                }));
            }
            fn round_finished(&self, record: &agent_loop::AgentTurnRecord) {
                let _ = self.turns.send(json!({
                    "run_id": self.run_id,
                    "phase": "end",
                    "round": record.round,
                    "tool_calls": record.tool_calls.len(),
                    "prompt_tokens": record.usage.prompt_tokens,
                    "completion_tokens": record.usage.completion_tokens,
                    "ms": record.ms,
                }));
            }
            fn tool_started(&self, call: &agent_loop::ToolCall) {
                let _ = self.tx.send(json!({
                    "run_id": self.run_id, "phase": "start", "id": call.id, "name": call.name
                }));
            }
            fn tool_finished(&self, record: &agent_loop::ToolRecord) {
                let _ = self.tx.send(json!({
                    "run_id": self.run_id,
                    "phase": "end",
                    "id": record.tool_call_id,
                    "name": record.name,
                    "ok": record.ok,
                    "ms": record.ms
                }));
            }
        }
        let (turn_tx, mut turn_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let turn_forwarder = {
            let events = Arc::clone(&self.events);
            tokio::spawn(async move {
                while let Some(params) = turn_rx.recv().await {
                    let Some(tx) = events.get().cloned() else { continue };
                    if let Ok(line) =
                        serde_json::to_string(&Notification { method: EVENT_AGENT_TURN, params })
                    {
                        if tx.send(line).await.is_err() {
                            break;
                        }
                    }
                }
            })
        };
        let observer: Arc<dyn agent_loop::LoopObserver> =
            Arc::new(RunObserver { run_id: p.run_id.clone(), tx: tool_tx, turns: turn_tx });

        // Scoped so the loop — and with it the model, the delta callback, and the channel sender it owns — is
        // dropped before the forwarder is awaited below.
        let outcome = {
            let agent = AgentLoop::new(
                Arc::new(model),
                Arc::new(executor),
                LoopConfig {
                    model: p.provider.model,
                    tools: p.tools,
                    stop_policy: StopPolicyConfig { max_turns: p.max_turns, ..Default::default() },
                    ..Default::default()
                },
            )
            .with_observer(observer);
            agent.run(messages, token).await
        };

        // Every delta is written before this method returns, and therefore before the reply.
        //
        // Without this the deltas race the answer: they are forwarded by a spawned task while the reply is
        // written by this one, so a client could receive the finished text and then its tokens. A test caught
        // exactly that — the run assembled "Hello world" correctly and not one delta had arrived.
        let _ = forwarder.await;
        let _ = tool_forwarder.await;
        let _ = turn_forwarder.await;

        self.inflight.remove(&p.run_id);
        let outcome = outcome?;

        let (prompt_tokens, completion_tokens) = outcome
            .turns
            .iter()
            .fold((0, 0), |(p, c), t| (p + t.usage.prompt_tokens, c + t.usage.completion_tokens));

        Ok(AgentRunResult {
            stop_reason: outcome
                .stop
                .reason
                .as_ref()
                .and_then(|r| serde_json::to_value(r).ok().and_then(|v| v.as_str().map(str::to_owned)))
                .unwrap_or_else(|| "unknown".to_owned()),
            detail: outcome.stop.detail.clone(),
            content: outcome.final_text().to_owned(),
            rounds: outcome.state.round(),
            tool_calls: outcome.state.tool_calls(),
            messages: outcome
                .messages
                .iter()
                .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
                .collect(),
            prompt_tokens,
            completion_tokens,
        })
    }

    /// The session's permission runtime, or a deny-everything one if the handshake set none.
    ///
    /// Never `None` at a call site: a missing ceiling must fail closed, and returning an `Option` here would
    /// invite a caller to treat "not configured" as "unrestricted".
    fn permission_runtime(&self) -> Arc<PermissionRuntime> {
        self.permissions
            .get()
            .cloned()
            .unwrap_or_else(|| {
                Arc::new(PermissionRuntime::new(Policy {
                    ceiling: Grant::empty(),
                    approval_required: Vec::new(),
                    max_depth: agent_permission::DEFAULT_MAX_DEPTH,
                }))
            })
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
        if !self.policy_declared.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        let permissions = self.permissions.get()?;
        let mut roots: Vec<std::path::PathBuf> = permissions
            .policy()
            .ceiling
            .capabilities()
            .iter()
            .filter_map(|c| match &c.scope {
                agent_permission::Scope::Paths(paths) => Some(paths.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        if let Some(cwd) = cwd {
            roots.push(std::path::PathBuf::from(cwd));
        }
        let first = roots.first()?.clone();

        let mut filesystem = agent_sandbox::FilesystemPolicy::workspace(first);
        for root in roots {
            if !filesystem.read.contains(&root) {
                filesystem.read.push(root.clone());
            }
            if !filesystem.write.contains(&root) {
                filesystem.write.push(root);
            }
        }
        Some(agent_sandbox::SandboxPolicy { filesystem, ..Default::default() })
    }

    /// The grant a delegation of `turn` should start with.
    ///
    /// Derived through `issue_child` rather than written here, so the rule lives in one place: sub-agents do
    /// not inherit elevated capabilities, and beyond the depth limit they starve out to nothing rather than
    /// erroring. Before this, the spawn site passed `Grant::empty()` literally — correct at the time, and the
    /// kind of correct that stops being correct the moment a policy is configured and nobody remembers this
    /// line exists.
    ///
    /// With no ceiling configured the result is still empty, so behaviour is unchanged for a host that sends
    /// no `workspace_roots`.
    fn child_grant(&self, turn: &str) -> Grant {
        let Some(permissions) = self.permissions.get() else { return Grant::empty() };
        // The turn's own principal. Depth 0: this is the main agent, and the delegation about to be spawned is
        // its first level of children.
        //
        // The parent holds exactly what the user approved — the ceiling itself — rather than an unrestricted
        // grant. `Scope::Unrestricted` is deliberately something no code path constructs: it is the one scope
        // that has to be typed by a person into a config file, and manufacturing one here to then clamp it
        // would be the runtime widening its own ceiling in a way review could not see.
        let parent = Principal {
            task: agent_core::TaskId::from_host(turn),
            agent: agent_core::AgentId::from_host("main"),
            depth: 0,
            grant: permissions.policy().ceiling.clone(),
        };
        permissions.issue_child(&parent)
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
                let roots: Vec<std::path::PathBuf> =
                    p.workspace_roots.iter().map(std::path::PathBuf::from).collect();
                // Did the host declare a policy at all? The distinction matters more than the contents.
                let declared = !roots.is_empty() || !p.approved_mcp_servers.is_empty();
                self.policy_declared.store(declared, Ordering::SeqCst);

                let mut capabilities = Vec::new();
                if !roots.is_empty() {
                    // Read AND write. An approved root is a directory the user has told the agent to work in,
                    // and a grant that allowed reading but not writing would deny `write_file` inside the very
                    // workspace the sandbox already lets a command write to — two layers disagreeing about the
                    // same directory.
                    for kind in [
                        agent_permission::CapabilityKind::FilesystemRead,
                        agent_permission::CapabilityKind::FilesystemWrite,
                    ] {
                        capabilities.push(agent_permission::Capability::paths(kind, roots.clone()));
                    }
                }
                if !p.approved_mcp_servers.is_empty() {
                    capabilities.push(agent_permission::Capability::new(
                        agent_permission::CapabilityKind::McpInvoke,
                        agent_permission::Scope::Names(p.approved_mcp_servers.clone()),
                    ));
                }
                let policy = Policy {
                    ceiling: Grant::of(capabilities),
                    approval_required: if p.require_approval_for_mutations {
                        vec![
                            agent_permission::CapabilityKind::FilesystemWrite,
                            agent_permission::CapabilityKind::FilesystemDelete,
                            agent_permission::CapabilityKind::ProcessSpawn,
                        ]
                    } else {
                        Vec::new()
                    },
                    max_depth: agent_permission::DEFAULT_MAX_DEPTH,
                };
                let _ = self.permissions.set(Arc::new(PermissionRuntime::new(policy)));
                if !declared {
                    tracing::warn!(
                        "the host declared no permission policy; MCP calls run unchecked for compatibility \
                         with hosts that predate `workspace_roots` / `approved_mcp_servers`"
                    );
                }
                tracing::info!(
                    client = ?p.client,
                    roots = roots.len(),
                    mcp_servers = p.approved_mcp_servers.len(),
                    "initialized"
                );
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
                // Minted before the server lookup so that EVERY outcome below can be audited, including the
                // one where there is no server: "the agent tried to call something that is not connected" is
                // exactly the kind of thing an audit trail exists to show, and the first version of this
                // returned before any event was published.
                let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

                // `ToolCallOutcome` has no error variant by construction: an external server must not
                // be able to abort a turn, which is the same invariant `callMcpTool` carries in JS.
                let Some(sup) = self.mcp.get(&p.server) else {
                    let detail = format!("no MCP server named '{}' is connected", p.server);
                    self.bus.publish(agent_events::EventKind::McpCalled {
                        call: CallId::from_host(call_id),
                        server: p.server.clone(),
                        tool: p.tool.clone(),
                        delivered: false,
                        detail: Some(detail.clone()),
                    });
                    return Ok(json!(McpCallResult { delivered: false, raw: None, error: Some(detail) }));
                };
                // Permission, before the call goes out (TODO §4.1 MCP Capability, §12 MCP Permission Bypass).
                //
                // Unconditional as of 2026-09-01 (§0.2 F7 resolved). It was gated on the host having declared
                // a policy, because a host that declared nothing got a ceiling granting nothing and would have
                // lost MCP entirely. That gate is gone: §12's "MCP must not bypass Runtime Permission" is not
                // a property that can hold for some hosts and not others.
                //
                // The consequence is deliberate and worth stating plainly: a host that does not send
                // `approved_mcp_servers` at the handshake has no MCP tools. That is the same shape as the
                // filesystem ceiling, and the same shape as fail-open's removal — the runtime no longer has a
                // permissive mode to fall into.
                let permissions = self.permission_runtime();
                let decision = permissions
                    .decide(
                        &Principal {
                            task: agent_core::TaskId::from_host(call_id.clone()),
                            agent: agent_core::AgentId::from_host("main"),
                            depth: 0,
                            grant: permissions.policy().ceiling.clone(),
                        },
                        &agent_permission::Request {
                            kind: agent_permission::CapabilityKind::McpInvoke,
                            resource: agent_permission::Resource::Name(p.server.clone()),
                            call: CallId::from_host(call_id.clone()),
                            // No justification, for the reason `agent-dispatch` gives: text the model supplies
                            // must have nothing to influence.
                            justification: None,
                        },
                    )
                    .await;
                if !decision.is_allowed() {
                    // A refusal is a RESULT, not an error: `McpCallResult` has no error variant that aborts a
                    // turn, and a denied MCP call is something the model should read and work around.
                    let reason = match &decision {
                        agent_permission::Decision::Deny { reason } => reason.clone(),
                        agent_permission::Decision::NeedsApproval { reason } => {
                            format!("this needs the user's approval and none was given: {reason}")
                        }
                        agent_permission::Decision::Allow => unreachable!("checked above"),
                    };
                    self.bus.publish(agent_events::EventKind::McpCalled {
                        call: CallId::from_host(call_id.clone()),
                        server: p.server.clone(),
                        tool: p.tool.clone(),
                        delivered: false,
                        detail: Some(format!("denied: {reason}")),
                    });
                    return Ok(json!(McpCallResult {
                        delivered: false,
                        raw: None,
                        error: Some(format!(
                            "Permission denied for MCP server '{}' (mcp.invoke): {reason}. Nothing was sent.",
                            p.server
                        )),
                    }));
                }

                // Scheduled like tools and commands, so `call.cancel` reaches an MCP call the same way
                // it reaches anything else -- without which a stopped turn would leave the call holding
                // its backpressure permit until the server answered. The per-server in-flight cap in
                // `agent-mcp` still applies underneath; this one bounds MCP work across all servers.
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
                self.bus.publish(agent_events::EventKind::McpCalled {
                    call: CallId::from_host(call_id.clone()),
                    server: p.server.clone(),
                    tool: p.tool.clone(),
                    delivered: out.raw.is_some(),
                    detail: out.raw.is_none().then(|| out.content.clone()),
                });
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
                    let r = sup.spawn(spec.meta, spec.key, self.child_grant(&p.turn), body);
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
        // Confinement (TODO §4.2, §11 Sandbox Decision, §15 "Sandbox is enforced by Runtime").
        //
        // `agent-sandbox` has been complete and orphaned since it was built: nothing depended on it, so
        // "Sandbox is enforced by Runtime" was a diagram. It is applied here because this is the only place a
        // command is spawned, and Landlock has to be applied IN THE CHILD between fork and exec — applying it
        // in the parent would confine this runtime irrevocably for the rest of its life.
        //
        // Gated on the host having declared a policy, for the same reason the MCP check is: a host that
        // declared nothing gets an empty allowlist, and confining every command to nothing would break every
        // build, test and git command that works today. See §0.2 F7.
        let sandbox_policy = self.sandbox_policy(p.cwd.as_deref()).unwrap_or_default();
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
                    let policy = sandbox_policy.clone();
                    // Spawned for the same reason `call_tool` spawns: a panic becomes this call's
                    // failure rather than a request the host waits out to its 180s timeout.
                    //
                    // Always through the backend, even when the policy is empty. With nothing to enforce it
                    // runs `agent_process::run` exactly as before and reports `NotRequested` — so there is one
                    // spawn path rather than two, and the sandbox cannot be forgotten on one of them.
                    Box::pin(async move {
                        tokio::spawn(async move {
                            let sandbox_req = agent_sandbox::SandboxRequest {
                                command: req.command.clone(),
                                cwd: req.cwd.clone(),
                                env: req.env.clone(),
                                policy,
                                limits: req.limits,
                                timeout: req.timeout,
                                max_buffer: req.max_buffer,
                            };
                            // The trait has to be in scope for its method to be callable.
                            use agent_sandbox::ExecutionBackend as _;
                            let out = agent_sandbox::NativeBackend::new().execute(sandbox_req, &cancel).await;
                            (out.process, out.report)
                        })
                        .await
                    })
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
            Ok((r, report)) => {
                // What actually confined this command, published so the audit trail records a decision rather
                // than an intention (TODO §11 Sandbox Decision). Reported even when nothing was enforced: "not
                // requested" and "requested and unavailable" are different facts, and only one of them is a
                // problem.
                tracing::debug!(
                    filesystem = %report.filesystem.describe(),
                    network = %report.network.describe(),
                    "command finished"
                );
                self.bus.publish(agent_events::EventKind::SandboxDecided {
                    call: CallId::from_host(call_id.clone()),
                    filesystem: report.filesystem.describe(),
                    network: report.network.describe(),
                });
                ProcessRunResult {
                    stdout: r.stdout,
                    stderr: r.stderr,
                    code: match r.code {
                        ExitCode::Code(c) => json!(c),
                        ExitCode::Unknown => json!("?"),
                    },
                    killed: r.killed,
                    canceled: r.canceled,
                    truncated: r.truncated,
                }
            }
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

/// How long a delegation may wait for the host to run it.
///
/// Generous because the work behind it is a whole sub-agent conversation — rounds of model calls and
/// tool execution. It is a backstop against a host that has stopped answering, not a task deadline:
/// the real bound is the caller's own cancellation, which reaches the delegation immediately.
const SUBAGENT_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How long a consent request waits for a person.
///
/// Generous, because the thing at the other end is a human reading a dialog — a timeout that fires while they
/// are still deciding would deny an action they were about to allow, which reads as the app ignoring them.
const CONSENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// How long a question to the user waits. Same reasoning as the consent timeout: a person is reading it.
const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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
