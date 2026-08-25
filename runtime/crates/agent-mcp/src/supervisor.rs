//! One supervisor task per connection (spec §11, TODO §4).
//!
//! The supervisor owns a connection's whole life and nothing else owns any of it. Callers never see a
//! transport; they see `state()`, `tools_snapshot()` and `call()`. That is what makes the four TODO §4
//! items independent of each other and of the scheduler:
//!
//! - **Reconnection** is the supervisor's own loop, with exponential backoff, running whether or not
//!   anybody is calling tools. The JS implementation reconnects lazily on the next call, so the turn
//!   that happens to discover the outage is the turn that pays for recovery.
//! - **Heartbeats** detect a server that has stopped answering *before* a tool call does.
//! - **Backpressure** is a per-connection in-flight limit plus a response size cap. Without the cap a
//!   server returning 400 MB is read into memory in full; without the limit one server's slowness
//!   consumes unbounded concurrency.
//! - **Degradation** falls out of the first three: a connection that is not `Ready` contributes no
//!   tools and answers calls immediately with an explanation. Nothing waits on it, so nothing it does
//!   can stall overall scheduling.

use crate::transport::{McpTransport, TransportError, TransportFactory, TransportKind};
use crate::{flatten_content, namespaced, McpToolDescriptor, ToolCallOutcome};
use agent_core::CancellationToken;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

/// Where a connection is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnState {
    /// Not started.
    Idle,
    Connecting,
    Ready,
    /// Reachable before, not now. Reconnection is in progress and the last tool snapshot is retained.
    Degraded { reason: String },
    /// Retries are exhausted. Nothing further will be attempted until re-added.
    Failed { reason: String },
    Closed,
}

impl ConnState {
    pub fn is_ready(&self) -> bool {
        matches!(self, ConnState::Ready)
    }
    fn label(&self) -> &'static str {
        match self {
            ConnState::Idle => "idle",
            ConnState::Connecting => "connecting",
            ConnState::Ready => "ready",
            ConnState::Degraded { .. } => "degraded",
            ConnState::Failed { .. } => "failed",
            ConnState::Closed => "closed",
        }
    }
}

/// Per-server tuning.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// How often to probe a `Ready` connection.
    pub heartbeat: Duration,
    /// Per-call ceiling.
    pub call_timeout: Duration,
    /// Ceiling for connect + initialize + tool discovery.
    pub connect_timeout: Duration,
    /// Concurrent in-flight calls allowed on this connection. The backpressure valve.
    pub max_in_flight: usize,
    /// Response size cap, in bytes of serialised JSON.
    pub max_response_bytes: usize,
    /// Reconnect attempts before giving up. `None` means keep trying.
    pub max_reconnects: Option<u32>,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Connections to keep for an HTTP server. Ignored for stdio — see `TransportKind`.
    pub pool_size: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(30),
            call_timeout: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(20),
            max_in_flight: 8,
            max_response_bytes: 4 * 1024 * 1024,
            max_reconnects: None,
            backoff_base: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            pool_size: 1,
        }
    }
}

/// A pool of live connections to one server.
///
/// For stdio this is always one: a stdio server *is* a child process, so "pooling" would mean running
/// several copies of it, which is a deployment decision and not a transport optimisation. For HTTP it is
/// `pool_size`, dispatched round-robin — good enough because MCP calls are independent, and a
/// least-loaded policy would need per-connection accounting that buys nothing until connections differ.
struct Pool {
    conns: Vec<Arc<dyn McpTransport>>,
    next: AtomicUsize,
}

impl Pool {
    fn pick(&self) -> Option<Arc<dyn McpTransport>> {
        if self.conns.is_empty() {
            return None;
        }
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.conns.len();
        Some(Arc::clone(&self.conns[i]))
    }
}

struct Shared {
    state: Mutex<ConnState>,
    /// Last good tool list. Retained across a degradation on purpose: the tools a server exposed do not
    /// stop existing because it briefly went away, and clearing them would rewrite the prompt prefix
    /// (and invalidate the cache) on every blip.
    tools: Mutex<Arc<Vec<McpToolDescriptor>>>,
    pool: Mutex<Option<Arc<Pool>>>,
    /// Backpressure: bounds in-flight calls on this connection.
    slots: Arc<Semaphore>,
}

pub struct ConnectionSupervisor {
    id: String,
    factory: Arc<dyn TransportFactory>,
    config: ServerConfig,
    shared: Arc<Shared>,
    cancel: CancellationToken,
}

impl ConnectionSupervisor {
    pub fn new(id: String, factory: Arc<dyn TransportFactory>, config: ServerConfig) -> Self {
        let slots = Arc::new(Semaphore::new(config.max_in_flight.max(1)));
        Self {
            id,
            factory,
            config,
            shared: Arc::new(Shared {
                state: Mutex::new(ConnState::Idle),
                tools: Mutex::new(Arc::new(Vec::new())),
                pool: Mutex::new(None),
                slots,
            }),
            cancel: CancellationToken::new(),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn state(&self) -> ConnState {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The last good tool list. Never blocks, never waits on the connection — invariant 2.
    pub fn tools_snapshot(&self) -> Vec<McpToolDescriptor> {
        // A degraded or failed server declares nothing. It keeps its snapshot internally so a
        // reconnection does not have to rediscover before the next turn, but it must not offer the model
        // tools that currently cannot be called.
        if !self.state().is_ready() {
            return Vec::new();
        }
        self.shared.tools.lock().unwrap_or_else(|e| e.into_inner()).as_ref().clone()
    }

    fn set_state(&self, next: ConnState) {
        let mut guard = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if *guard != next {
            tracing::info!(server = %self.id, from = guard.label(), to = next.label(), "mcp connection state");
            *guard = next;
        }
    }

    /// Start the supervision loop.
    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move { self.supervise().await });
    }

    /// Connect, discover, then heartbeat until something breaks; reconnect with backoff.
    async fn supervise(self: Arc<Self>) {
        let mut attempt: u32 = 0;
        loop {
            if self.cancel.is_cancelled() {
                self.set_state(ConnState::Closed);
                return;
            }

            self.set_state(if attempt == 0 {
                ConnState::Connecting
            } else {
                ConnState::Degraded { reason: format!("reconnecting (attempt {})", attempt + 1) }
            });

            match self.bring_up().await {
                Ok(()) => {
                    attempt = 0;
                    self.set_state(ConnState::Ready);
                    // Holds until the connection stops answering.
                    let reason = self.heartbeat_loop().await;
                    if self.cancel.is_cancelled() {
                        self.set_state(ConnState::Closed);
                        return;
                    }
                    self.tear_down().await;
                    self.set_state(ConnState::Degraded { reason });
                }
                Err(e) => {
                    self.tear_down().await;
                    attempt += 1;
                    if let Some(max) = self.config.max_reconnects
                        && attempt > max
                    {
                        self.set_state(ConnState::Failed { reason: e.describe() });
                        return;
                    }
                    self.set_state(ConnState::Degraded { reason: e.describe() });
                }
            }

            // Exponential backoff, capped. No jitter: the number of MCP servers is small enough that a
            // thundering herd is not a real concern, and determinism makes the behaviour testable.
            let delay = self
                .config
                .backoff_base
                .saturating_mul(2u32.saturating_pow(attempt.min(10)))
                .min(self.config.backoff_max);
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    self.set_state(ConnState::Closed);
                    return;
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    /// Connect the pool, initialise, and discover tools.
    async fn bring_up(&self) -> Result<(), TransportError> {
        let want = match self.factory.kind() {
            TransportKind::Stdio => 1,
            TransportKind::Http => self.config.pool_size.max(1),
        };

        let mut conns = Vec::with_capacity(want);
        for _ in 0..want {
            let c = tokio::time::timeout(self.config.connect_timeout, self.factory.connect())
                .await
                .map_err(|_| TransportError::Timeout)??;
            conns.push(c);
        }
        let primary = Arc::clone(&conns[0]);
        *self.shared.pool.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Arc::new(Pool { conns, next: AtomicUsize::new(0) }));

        // MCP handshake, then capability/tool discovery. Both bounded, so a server that accepts the
        // connection and then goes quiet cannot hold the supervisor open.
        let init = json!({
            "protocolVersion": "2024-11-05",
            "clientInfo": { "name": "zeraix-agent-runtime", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": {}
        });
        tokio::time::timeout(self.config.connect_timeout, primary.request("initialize", init))
            .await
            .map_err(|_| TransportError::Timeout)??;

        let listed = tokio::time::timeout(
            self.config.connect_timeout,
            primary.request("tools/list", json!({})),
        )
        .await
        .map_err(|_| TransportError::Timeout)??;

        let tools = parse_tools(&self.id, &listed);
        tracing::info!(server = %self.id, tools = tools.len(), "mcp connection ready");
        *self.shared.tools.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(tools);
        Ok(())
    }

    /// Probe until the connection stops answering. Returns why it stopped.
    async fn heartbeat_loop(&self) -> String {
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => return "shutting down".to_owned(),
                _ = tokio::time::sleep(self.config.heartbeat) => {}
            }
            let Some(conn) = self.pick() else {
                return "the connection disappeared".to_owned();
            };
            match tokio::time::timeout(self.config.call_timeout, conn.ping()).await {
                Ok(Ok(())) => {}
                // The point of the heartbeat: this is discovered here rather than by the next tool call.
                Ok(Err(e)) => return e.describe(),
                Err(_) => return "the heartbeat timed out".to_owned(),
            }
        }
    }

    fn pick(&self) -> Option<Arc<dyn McpTransport>> {
        self.shared
            .pool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|p| p.pick())
    }

    async fn tear_down(&self) {
        let pool = self.shared.pool.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(p) = pool {
            for c in &p.conns {
                c.close().await;
            }
        }
    }

    /// Call a tool on this server.
    ///
    /// Never fails — invariant 1. Every path returns a `ToolCallOutcome` the model can read.
    pub async fn call(&self, tool: &str, args: Value) -> ToolCallOutcome {
        let state = self.state();
        if !state.is_ready() {
            // Degradation (TODO §4): answer immediately rather than waiting for a recovery that may
            // never come. Nothing blocks on an unhealthy server, so nothing it does stalls scheduling.
            return ToolCallOutcome::failed(match &state {
                ConnState::Connecting | ConnState::Idle => format!(
                    "the MCP server '{}' is still connecting; try again shortly",
                    self.id
                ),
                ConnState::Degraded { reason } => {
                    format!("the MCP server '{}' is unavailable ({reason})", self.id)
                }
                ConnState::Failed { reason } => {
                    format!("the MCP server '{}' has failed ({reason})", self.id)
                }
                ConnState::Closed => format!("the MCP server '{}' is closed", self.id),
                ConnState::Ready => unreachable!(),
            });
        }

        // Backpressure. `try_acquire` rather than waiting: a queue on top of a per-call timeout means a
        // caller can wait twice over, and the honest answer when a server is saturated is to say so.
        let _permit = match Arc::clone(&self.shared.slots).try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                return ToolCallOutcome::failed(format!(
                    "the MCP server '{}' already has {} calls in flight; try again shortly",
                    self.id, self.config.max_in_flight
                ));
            }
        };

        let Some(conn) = self.pick() else {
            return ToolCallOutcome::failed(format!(
                "the MCP server '{}' has no live connection",
                self.id
            ));
        };

        let params = json!({ "name": tool, "arguments": args });
        let result =
            tokio::time::timeout(self.config.call_timeout, conn.request("tools/call", params)).await;

        match result {
            Ok(Ok(value)) => {
                // Size cap, checked on the decoded value. A transport that streams should refuse
                // earlier still (`TransportError::TooLarge`); this is the backstop for one that does not.
                let encoded = value.to_string();
                if encoded.len() > self.config.max_response_bytes {
                    return ToolCallOutcome::failed(format!(
                        "the MCP tool '{tool}' returned {} bytes, over the {}-byte cap; the response was discarded",
                        encoded.len(),
                        self.config.max_response_bytes
                    ));
                }
                if value.get("isError").and_then(Value::as_bool) == Some(true) {
                    return ToolCallOutcome::failed(flatten_content(&value));
                }
                ToolCallOutcome::ok(flatten_content(&value))
            }
            Ok(Err(e)) => ToolCallOutcome::failed(format!("the MCP tool '{tool}' failed: {}", e.describe())),
            Err(_) => ToolCallOutcome::failed(format!(
                "the MCP tool '{tool}' did not respond within {:?}",
                self.config.call_timeout
            )),
        }
    }

    /// Stop supervising and close the connection.
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        self.tear_down().await;
        self.set_state(ConnState::Closed);
    }
}

/// Turn a `tools/list` response into descriptors.
///
/// A malformed entry is skipped rather than failing the whole discovery: one bad tool must not cost a
/// server every other tool it exposes.
fn parse_tools(server: &str, listed: &Value) -> Vec<McpToolDescriptor> {
    let Some(items) = listed.get("tools").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|t| {
            let remote = t.get("name").and_then(Value::as_str)?;
            Some(McpToolDescriptor {
                name: namespaced(server, remote),
                remote_name: remote.to_owned(),
                server: server.to_owned(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                parameters: t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            })
        })
        .collect()
}
