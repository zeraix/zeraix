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
    Request, Response, ToolCallParams, ToolCallResult, ToolDescriptor, PROTOCOL_VERSION,
};
use agent_ipc::transport::{StdioSender, StdioTransport, Transport};
use agent_tools::registry::to_legacy_content;
use agent_tools::tool::{ExecutionMode, RiskLevel};
use agent_tools::walk::FileListCache;
use agent_tools::workspace::Workspace;
use agent_tools::{ToolContext, ToolRegistry};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::Arc;

pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Shared runtime state.
pub struct Server {
    registry: Arc<ToolRegistry>,
    file_cache: Arc<FileListCache>,
    /// Live calls, so `tool.cancel` can reach one by the id the host minted.
    inflight: Arc<DashMap<String, CancellationToken>>,
    /// Cancelled when the host asks the runtime to stop; parent of every call token.
    root_cancel: CancellationToken,
    initialized: Arc<std::sync::atomic::AtomicBool>,
}

impl Server {
    pub fn new() -> Self {
        let mut registry = ToolRegistry::new();
        agent_tools::tools::register_builtin(&mut registry);
        Self {
            registry: Arc::new(registry),
            file_cache: Arc::new(FileListCache::new()),
            inflight: Arc::new(DashMap::new()),
            root_cancel: CancellationToken::new(),
            initialized: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Serve until the host closes stdin or sends `runtime.shutdown`.
    pub async fn run(self: Arc<Self>, transport: StdioTransport) -> anyhow::Result<()> {
        let sender = transport.sender();
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

            let req: Request = match serde_json::from_str(trimmed) {
                Ok(r) => r,
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
        // processes or leave tasks running past the loop.
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

            "tool.cancel" => {
                let p: CancelParams = parse(req.params)?;
                // Cancelling an id that already finished is a no-op, which is what makes the race
                // harmless: a call can complete between the user's click and this arriving.
                if let Some(token) = self.inflight.get(&p.call_id) {
                    token.cancel();
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

            "runtime.status" => Ok(json!({
                "protocol_version": PROTOCOL_VERSION,
                "runtime_version": RUNTIME_VERSION,
                "inflight": self.inflight.len(),
                "cached_workspaces": self.file_cache.len(),
            })),

            "runtime.shutdown" => {
                self.root_cancel.cancel();
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
        // Child of the root token: shutting the runtime down cancels every call beneath it. This is
        // the parent/child derivation spec §14 asks for, at the only depth Stage 1 has.
        let token = self.root_cancel.child_token();
        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());
        self.inflight.insert(call_id.clone(), token.clone());

        let ctx = ToolContext::new(
            Workspace::new(&p.workdir),
            token,
            CallId::from_host(call_id.clone()),
            Arc::clone(&self.file_cache),
        );

        let registry = Arc::clone(&self.registry);
        let name = p.name.clone();
        let args = p.args.clone();
        // Spawned so a panic in a tool is contained: `JoinError` below turns it into a failed call
        // rather than an aborted process.
        let joined = tokio::spawn(async move { registry.execute(&name, &ctx, &args).await }).await;

        self.inflight.remove(&call_id);

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
