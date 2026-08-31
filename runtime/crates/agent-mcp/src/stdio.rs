//! The stdio MCP transport: a real JSON-RPC client over a child process's pipes.
//!
//! Until this existed, `McpTransport` had only test fakes behind it — the supervisor's reconnection,
//! heartbeat and backpressure logic was complete and could not talk to an actual server.
//!
//! ## Hand-written rather than a crate
//!
//! MCP's stdio transport is newline-delimited JSON-RPC 2.0, which `serde_json` and `tokio` already
//! express completely. Taking an MCP client crate would add a dependency that brings its own async
//! runtime assumptions and its own opinion about connection lifecycle — the exact thing
//! `ConnectionSupervisor` is, and the reason it was written. What is actually protocol-specific here
//! is three method names and a handshake.
//!
//! ## The environment is the host's, verbatim
//!
//! `env` is applied to a **cleared** environment rather than layered onto the runtime's own. The JS
//! implementation is deliberate about this (`buildTransport` in `electron/mcp/client.mjs`): it uses the
//! SDK's `getDefaultEnvironment()` allowlist — HOME, PATH, SHELL and a handful more — precisely so that
//! `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` cannot reach the child, both of which break a node-based
//! MCP server in ways that look like the server's fault.
//!
//! The sidecar inherits its own environment from Electron, so it carries those same variables and the
//! hazard is identical. Rather than reimplement the allowlist — and drift from it — the host computes
//! the environment it already computes today and sends it; this applies exactly that and nothing else.
//!
//! ## What a timed-out call leaves behind
//!
//! `request` does not impose a deadline: the supervisor owns every timeout, so that a call, a
//! heartbeat and a connect can have different ones. When the supervisor's timeout fires it drops this
//! future, and the pending entry stays until a reply arrives that nobody is waiting for. That is
//! bounded by the number of timed-out calls on a connection, and a connection whose calls time out is
//! one the supervisor is about to tear down anyway.

use crate::transport::{McpTransport, TransportError, TransportFactory, TransportKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

/// Server stderr retained for diagnostics. Mirrors `STDERR_KEEP` in `mcp/client.mjs`, which exists so
/// a server that dies on startup has its only explanation visible in the settings panel rather than in
/// a console nobody sees.
pub const STDERR_KEEP: usize = 8_000;

/// How to start one stdio MCP server.
#[derive(Debug, Clone)]
pub struct StdioServer {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// The child's complete environment. See the module header — this replaces, never extends.
    pub env: Vec<(String, String)>,
    /// Response size ceiling, in bytes of one JSON line.
    pub max_response_bytes: usize,
}

/// Builds stdio connections, and keeps whatever the last one wrote to stderr.
pub struct StdioFactory {
    server: StdioServer,
    stderr: Arc<Mutex<String>>,
}

impl StdioFactory {
    pub fn new(server: StdioServer) -> Self {
        Self { server, stderr: Arc::new(Mutex::new(String::new())) }
    }

    /// The tail of the server's stderr, for reporting a failed connection to a human.
    pub fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[async_trait::async_trait]
impl TransportFactory for StdioFactory {
    async fn connect(&self) -> Result<Arc<dyn McpTransport>, TransportError> {
        let conn = StdioConnection::spawn(&self.server, Arc::clone(&self.stderr))?;
        Ok(Arc::new(conn))
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Stdio
    }

    fn diagnostics(&self) -> String {
        self.stderr_tail()
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, TransportError>>>>>;

/// One live connection to a stdio MCP server.
pub struct StdioConnection {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    child: Mutex<Option<Child>>,
}

impl StdioConnection {
    fn spawn(server: &StdioServer, stderr_sink: Arc<Mutex<String>>) -> Result<Self, TransportError> {
        let mut cmd = Command::new(&server.command);
        cmd.args(&server.args);
        if let Some(dir) = &server.cwd {
            cmd.current_dir(dir);
        }
        // Cleared first: what the host sent is the whole environment, not an overlay.
        cmd.env_clear();
        for (k, v) in &server.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            // The most common failure by far, and the one worth wording well: a server configured with
            // a command that is not installed.
            TransportError::Io(format!("could not start {}: {e}", server.command))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| TransportError::Io("no stdin".to_owned()))?;
        let stdout = child.stdout.take().ok_or_else(|| TransportError::Io("no stdout".to_owned()))?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        if let Some(err) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buf = stderr_sink.lock().unwrap_or_else(|e| e.into_inner());
                    buf.push_str(&line);
                    buf.push('\n');
                    if buf.len() > STDERR_KEEP {
                        // Keep the END: a server that fails on startup says why in its last lines.
                        let cut = buf.len() - STDERR_KEEP;
                        let cut = buf.char_indices().map(|(i, _)| i).find(|i| *i >= cut).unwrap_or(buf.len());
                        buf.replace_range(..cut, "");
                    }
                }
            });
        }

        tokio::spawn(read_loop(stdout, Arc::clone(&pending), Arc::clone(&closed), server.max_response_bytes));

        Ok(Self {
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(0),
            closed,
            child: Mutex::new(Some(child)),
        })
    }

    /// Write one framed message.
    async fn write(&self, value: &Value) -> Result<(), TransportError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(TransportError::Closed("the server is gone".to_owned()));
        }
        let line = serde_json::to_string(value)
            .map_err(|e| TransportError::Protocol(format!("could not encode a request: {e}")))?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| TransportError::Closed(e.to_string()))?;
        stdin.write_all(b"\n").await.map_err(|e| TransportError::Closed(e.to_string()))?;
        stdin.flush().await.map_err(|e| TransportError::Closed(e.to_string()))
    }
}

#[async_trait::async_trait]
impl McpTransport for StdioConnection {
    async fn request(&self, method: &str, params: Value) -> Result<Value, TransportError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);

        let sent = self
            .write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        if let Err(e) = sent {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(e);
        }

        match rx.await {
            Ok(result) => result,
            // The reader is gone, which only happens once the pipe has closed.
            Err(_) => Err(TransportError::Closed("the server stopped answering".to_owned())),
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    async fn ping(&self) -> Result<(), TransportError> {
        self.request("ping", json!({})).await.map(|_| ())
    }

    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Killed rather than asked to leave: MCP has no shutdown request, and a server blocked on a
        // read of a pipe nobody will write to again would otherwise linger.
        if let Some(mut child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.start_kill();
            // Awaited so it is reaped rather than left as a zombie for the runtime to accumulate.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
        fail_all(&self.pending, "the connection was closed");
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Stdio
    }
}

/// Read replies until the pipe closes, settling whichever call each one answers.
async fn read_loop(
    stdout: tokio::process::ChildStdout,
    pending: Pending,
    closed: Arc<AtomicBool>,
    max_response_bytes: usize,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // EOF or a read error: the server is gone either way.
            _ => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > max_response_bytes {
            // Refused rather than parsed: the cap exists to stop one server's runaway response from
            // being read into memory in full, which is what the JS implementation does today.
            if let Some(id) = quick_id(&line) {
                settle(&pending, id, Err(TransportError::TooLarge { bytes: line.len(), cap: max_response_bytes }));
            }
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                // One bad line must not take down a working connection; the call it belonged to (if
                // any) will time out on the supervisor's clock.
                tracing::warn!(error = %e, "discarding unparseable line from an MCP server");
                continue;
            }
        };

        let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else {
            // A notification. `tools/list_changed` is the one worth acting on and the supervisor
            // rediscovers on reconnect anyway, so nothing here depends on it yet.
            continue;
        };
        if let Some(err) = msg.get("error") {
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("the server reported an error")
                .to_owned();
            settle(&pending, id, Err(TransportError::Protocol(message)));
        } else {
            settle(&pending, id, Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
        }
    }

    closed.store(true, Ordering::SeqCst);
    // Everything still waiting is waiting forever otherwise. `Closed` is what tells the supervisor to
    // rebuild the connection rather than to fail just this call.
    fail_all(&pending, "the server closed the connection");
}

/// Pull an id out of a line too large to parse, so the call it answers can still be failed.
fn quick_id(line: &str) -> Option<u64> {
    let at = line.find("\"id\"")?;
    let rest = &line[at + 4..];
    let colon = rest.find(':')?;
    rest[colon + 1..]
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn settle(pending: &Pending, id: u64, result: Result<Value, TransportError>) {
    let entry = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(tx) = entry {
        // A dropped receiver means the caller's timeout already fired. Nothing to do.
        let _ = tx.send(result);
    }
}

fn fail_all(pending: &Pending, why: &str) {
    let drained: Vec<_> = pending.lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
    for (_, tx) in drained {
        let _ = tx.send(Err(TransportError::Closed(why.to_owned())));
    }
}
