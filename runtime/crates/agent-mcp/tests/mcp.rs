//! MCP Runtime tests (spec §11, TODO §4).
//!
//! Driven through a fake transport, because the interesting behaviour is the failure behaviour: a server
//! that stops answering pings, one that returns 400 MB, one that dies mid-call. Those are trivial to
//! inject here and awkward to arrange against a real server — and they are exactly the paths that decide
//! whether one bad MCP server can stall a turn.

use agent_mcp::transport::{McpTransport, TransportError, TransportFactory, TransportKind};
use agent_mcp::{ConnState, McpManager, ServerConfig};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A scriptable MCP server.
#[derive(Default)]
struct FakeServer {
    /// Fails `connect` while true.
    refuse_connect: AtomicBool,
    /// Fails `ping` while true — the "silently stopped answering" case.
    break_ping: AtomicBool,
    /// Fails `tools/call` while true.
    break_calls: AtomicBool,
    /// Delay applied to `tools/call`.
    call_delay_ms: AtomicU32,
    /// Response size for `tools/call`, in filler bytes.
    response_bytes: AtomicU32,
    connects: AtomicU32,
    calls: AtomicU32,
    closes: AtomicU32,
}

struct FakeTransport {
    server: Arc<FakeServer>,
}

#[async_trait::async_trait]
impl McpTransport for FakeTransport {
    async fn request(&self, method: &str, _params: Value) -> Result<Value, TransportError> {
        match method {
            "initialize" => Ok(json!({ "protocolVersion": "2024-11-05" })),
            "tools/list" => Ok(json!({
                "tools": [
                    { "name": "read", "description": "read a thing",
                      "inputSchema": { "type": "object", "properties": { "p": { "type": "string" } } } },
                    { "name": "write", "description": "write a thing" },
                    { "description": "malformed: no name" }
                ]
            })),
            "tools/call" => {
                self.server.calls.fetch_add(1, Ordering::SeqCst);
                let delay = self.server.call_delay_ms.load(Ordering::SeqCst);
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                }
                if self.server.break_calls.load(Ordering::SeqCst) {
                    return Err(TransportError::Closed("the child exited".into()));
                }
                let filler = self.server.response_bytes.load(Ordering::SeqCst) as usize;
                let text = if filler > 0 { "x".repeat(filler) } else { "result text".to_owned() };
                Ok(json!({ "content": [{ "type": "text", "text": text }] }))
            }
            other => Err(TransportError::Protocol(format!("unexpected method {other}"))),
        }
    }

    async fn ping(&self) -> Result<(), TransportError> {
        if self.server.break_ping.load(Ordering::SeqCst) {
            Err(TransportError::Closed("no response to ping".into()))
        } else {
            Ok(())
        }
    }

    async fn close(&self) {
        self.server.closes.fetch_add(1, Ordering::SeqCst);
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Stdio
    }
}

struct FakeFactory {
    server: Arc<FakeServer>,
    kind: TransportKind,
}

#[async_trait::async_trait]
impl TransportFactory for FakeFactory {
    async fn connect(&self) -> Result<Arc<dyn McpTransport>, TransportError> {
        self.server.connects.fetch_add(1, Ordering::SeqCst);
        if self.server.refuse_connect.load(Ordering::SeqCst) {
            return Err(TransportError::Io("connection refused".into()));
        }
        Ok(Arc::new(FakeTransport { server: Arc::clone(&self.server) }))
    }
    fn kind(&self) -> TransportKind {
        self.kind
    }
}

fn fast_config() -> ServerConfig {
    ServerConfig {
        heartbeat: Duration::from_millis(40),
        call_timeout: Duration::from_millis(300),
        connect_timeout: Duration::from_millis(300),
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(60),
        ..Default::default()
    }
}

/// Wait until `f` holds, or give up. Avoids fixed sleeps, which either flake or waste time.
async fn until(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    false
}

fn manager(server: Arc<FakeServer>, config: ServerConfig, kind: TransportKind) -> McpManager {
    let m = McpManager::new();
    m.add("files", Arc::new(FakeFactory { server, kind }), config);
    m
}

#[tokio::test]
async fn a_server_connects_and_its_tools_are_discovered() {
    let s = Arc::new(FakeServer::default());
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);

    assert!(until(|| m.get("files").unwrap().state().is_ready()).await, "never became ready");
    let tools = m.list_tools();
    // The malformed third entry is skipped; one bad tool must not cost the server its others.
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].name, "mcp__files__read");
    assert_eq!(tools[0].remote_name, "read");
    m.shutdown().await;
}

#[tokio::test]
async fn listing_tools_never_blocks_on_a_connecting_server() {
    // Invariant 2. Tool declarations sit in the prompt prefix, so waiting on a slow server would stall
    // the model call itself.
    let s = Arc::new(FakeServer::default());
    s.refuse_connect.store(true, Ordering::SeqCst);
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);

    let started = std::time::Instant::now();
    let tools = m.list_tools();
    assert!(started.elapsed() < Duration::from_millis(50), "list_tools blocked");
    assert!(tools.is_empty(), "an unreachable server contributed declarations");
    m.shutdown().await;
}

#[tokio::test]
async fn calling_a_tool_on_an_unavailable_server_fails_fast_and_never_throws() {
    // Invariant 1 plus degradation: an unhealthy server answers immediately rather than being waited on.
    let s = Arc::new(FakeServer::default());
    s.refuse_connect.store(true, Ordering::SeqCst);
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    tokio::time::sleep(Duration::from_millis(60)).await;

    let started = std::time::Instant::now();
    let out = m.call("mcp__files__read", json!({})).await;
    assert!(!out.ok);
    assert!(out.content.contains("files"), "{}", out.content);
    assert!(started.elapsed() < Duration::from_millis(150), "a dead server was waited on");
    m.shutdown().await;
}

#[tokio::test]
async fn an_unknown_server_or_bad_name_is_a_result_not_a_panic() {
    let m = McpManager::new();
    let a = m.call("mcp__nope__read", json!({})).await;
    assert!(!a.ok && a.content.contains("no MCP server"));
    let b = m.call("read_file", json!({})).await;
    assert!(!b.ok && b.content.contains("not an MCP tool name"));
}

#[tokio::test]
async fn a_successful_call_returns_flattened_text() {
    let s = Arc::new(FakeServer::default());
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    let out = m.call("mcp__files__read", json!({ "p": "a.txt" })).await;
    assert!(out.ok);
    assert_eq!(out.content, "result text");
    m.shutdown().await;
}

#[tokio::test]
async fn the_heartbeat_detects_a_server_that_stopped_answering() {
    // The reason heartbeats exist: without one, this is discovered by whichever tool call happens next,
    // and that turn pays for the recovery.
    let s = Arc::new(FakeServer::default());
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    s.break_ping.store(true, Ordering::SeqCst);
    let sup = m.get("files").unwrap();
    assert!(
        until(|| !sup.state().is_ready()).await,
        "the heartbeat never noticed; state is {:?}",
        sup.state()
    );
    // And no tools are offered while it is unhealthy.
    assert!(m.list_tools().is_empty());
    m.shutdown().await;
}

#[tokio::test]
async fn a_broken_connection_is_reconnected_without_anyone_calling_a_tool() {
    // The JS implementation reconnects lazily on the next call. Here recovery happens on its own.
    let s = Arc::new(FakeServer::default());
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);
    let first_connects = s.connects.load(Ordering::SeqCst);

    s.break_ping.store(true, Ordering::SeqCst);
    let sup = m.get("files").unwrap();
    assert!(until(|| !sup.state().is_ready()).await, "never degraded");

    // Let it heal, with no tool call to trigger anything.
    s.break_ping.store(false, Ordering::SeqCst);
    assert!(until(|| sup.state().is_ready()).await, "never recovered on its own");
    assert!(
        s.connects.load(Ordering::SeqCst) > first_connects,
        "recovery did not involve a fresh connection"
    );
    assert_eq!(m.list_tools().len(), 2, "tools were not rediscovered");
    m.shutdown().await;
}

#[tokio::test]
async fn reconnect_attempts_are_bounded_when_configured() {
    let s = Arc::new(FakeServer::default());
    s.refuse_connect.store(true, Ordering::SeqCst);
    let config = ServerConfig { max_reconnects: Some(2), ..fast_config() };
    let m = manager(Arc::clone(&s), config, TransportKind::Stdio);

    let sup = m.get("files").unwrap();
    assert!(
        until(|| matches!(sup.state(), ConnState::Failed { .. })).await,
        "never reached Failed; state is {:?}",
        sup.state()
    );
    let after = s.connects.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(s.connects.load(Ordering::SeqCst), after, "kept retrying after giving up");
    m.shutdown().await;
}

#[tokio::test]
async fn an_oversized_response_is_refused_rather_than_returned() {
    // Without the cap, a server returning hundreds of megabytes is read into memory in full and then
    // pushed into the conversation.
    let s = Arc::new(FakeServer::default());
    s.response_bytes.store(200_000, Ordering::SeqCst);
    let config = ServerConfig { max_response_bytes: 4096, ..fast_config() };
    let m = manager(Arc::clone(&s), config, TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    let out = m.call("mcp__files__read", json!({})).await;
    assert!(!out.ok);
    assert!(out.content.contains("cap"), "{}", out.content);
    // The cap is reported, not silently truncated into something that reads as a complete answer.
    assert!(out.content.len() < 500);
    m.shutdown().await;
}

#[tokio::test]
async fn in_flight_calls_are_bounded_so_one_server_cannot_consume_the_runtime() {
    let s = Arc::new(FakeServer::default());
    s.call_delay_ms.store(200, Ordering::SeqCst);
    let config = ServerConfig { max_in_flight: 2, call_timeout: Duration::from_secs(5), ..fast_config() };
    let m = manager(Arc::clone(&s), config, TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    let m = Arc::new(m);
    let mut handles = Vec::new();
    for _ in 0..5 {
        let m = Arc::clone(&m);
        handles.push(tokio::spawn(async move { m.call("mcp__files__read", json!({})).await }));
    }
    let results: Vec<_> = futures_join(handles).await;
    let refused = results.iter().filter(|r| !r.ok && r.content.contains("in flight")).count();
    assert!(refused >= 1, "backpressure never engaged: {results:?}");
    // And it says so rather than queueing behind a per-call timeout, which would make a caller wait twice.
    m.shutdown().await;
}

#[tokio::test]
async fn a_slow_call_times_out_without_taking_the_connection_down() {
    let s = Arc::new(FakeServer::default());
    s.call_delay_ms.store(1000, Ordering::SeqCst);
    let config = ServerConfig { call_timeout: Duration::from_millis(80), ..fast_config() };
    let m = manager(Arc::clone(&s), config, TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    let out = m.call("mcp__files__read", json!({})).await;
    assert!(!out.ok);
    assert!(out.content.contains("did not respond"), "{}", out.content);
    // A timeout is not a dead connection: the server is still Ready and still declares its tools.
    assert!(m.get("files").unwrap().state().is_ready(), "one slow call tore down the connection");
    m.shutdown().await;
}

#[tokio::test]
async fn an_http_server_opens_a_pool_and_a_stdio_server_does_not() {
    // Pooling is a transport property, not a tuning knob: a stdio server IS a child process, so opening
    // three connections would mean running three copies of it.
    let http = Arc::new(FakeServer::default());
    let m1 = McpManager::new();
    m1.add(
        "remote",
        Arc::new(FakeFactory { server: Arc::clone(&http), kind: TransportKind::Http }),
        ServerConfig { pool_size: 3, ..fast_config() },
    );
    assert!(until(|| m1.get("remote").unwrap().state().is_ready()).await);
    assert_eq!(http.connects.load(Ordering::SeqCst), 3, "the pool was not opened");

    let stdio = Arc::new(FakeServer::default());
    let m2 = manager(Arc::clone(&stdio), ServerConfig { pool_size: 3, ..fast_config() }, TransportKind::Stdio);
    assert!(until(|| m2.get("files").unwrap().state().is_ready()).await);
    assert_eq!(stdio.connects.load(Ordering::SeqCst), 1, "stdio was pooled");

    m1.shutdown().await;
    m2.shutdown().await;
}

#[tokio::test]
async fn a_failing_call_reports_the_transport_error() {
    let s = Arc::new(FakeServer::default());
    s.break_calls.store(true, Ordering::SeqCst);
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    let out = m.call("mcp__files__read", json!({})).await;
    assert!(!out.ok);
    assert!(out.content.contains("failed"), "{}", out.content);
    m.shutdown().await;
}

#[tokio::test]
async fn shutdown_closes_the_transport_and_stops_supervising() {
    let s = Arc::new(FakeServer::default());
    let m = manager(Arc::clone(&s), fast_config(), TransportKind::Stdio);
    assert!(until(|| m.get("files").unwrap().state().is_ready()).await);

    m.shutdown().await;
    assert!(s.closes.load(Ordering::SeqCst) >= 1, "the transport was never closed");
    let before = s.connects.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(s.connects.load(Ordering::SeqCst), before, "kept reconnecting after shutdown");
}

#[tokio::test]
async fn status_reports_every_server() {
    let a = Arc::new(FakeServer::default());
    let b = Arc::new(FakeServer::default());
    b.refuse_connect.store(true, Ordering::SeqCst);

    let m = McpManager::new();
    m.add("good", Arc::new(FakeFactory { server: a, kind: TransportKind::Stdio }), fast_config());
    m.add("bad", Arc::new(FakeFactory { server: b, kind: TransportKind::Stdio }), fast_config());

    assert!(until(|| m.get("good").unwrap().state().is_ready()).await);
    let status = m.status();
    assert_eq!(status.len(), 2);
    let good = status.iter().find(|(id, _, _)| id == "good").unwrap();
    assert!(good.1.is_ready());
    assert_eq!(good.2, 2);
    let bad = status.iter().find(|(id, _, _)| id == "bad").unwrap();
    assert!(!bad.1.is_ready());
    m.shutdown().await;
}

/// Minimal join_all, so the crate needs no `futures` dependency.
async fn futures_join<T>(handles: Vec<tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}
