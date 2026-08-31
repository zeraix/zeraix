//! The HTTP transport against a real Streamable HTTP MCP server.
//!
//! Same argument as `stdio.rs`: fakes cover the supervisor's behaviour, but only a server can show
//! whether this client speaks the protocol. HTTP adds three things a fake would never catch — the
//! session handshake, a body that is sometimes JSON and sometimes SSE, and a stream that carries a
//! notification before the answer.
//!
//! The fixture is strict about all three. See `tests/fixtures/mcp-http-server.mjs`.

use agent_mcp::{ConnState, HttpFactory, HttpServer, McpManager, ServerConfig};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A running fixture server. Killed on drop, so a failing test cannot leak one.
struct Fixture {
    child: Child,
    url: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Start the fixture, or `None` when there is no node to run it with.
///
/// Skipped rather than failed, for the same reason as the stdio suite: this crate's correctness does
/// not depend on a JavaScript runtime being installed, and CI has one.
fn fixture(mode: Option<&str>) -> Option<Fixture> {
    let node = which_node()?;
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mcp-http-server.mjs");
    let mut cmd = Command::new(node);
    cmd.arg(script);
    if let Some(m) = mode {
        cmd.arg(m);
    }
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;

    // The port is chosen by the OS, so the URL has to be read back rather than assumed.
    let stdout = child.stdout.take()?;
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).ok()?;
    let url = line.strip_prefix("LISTENING ")?.trim().to_owned();
    Some(Fixture { child, url })
}

fn which_node() -> Option<String> {
    let out = Command::new(if cfg!(windows) { "where" } else { "which" }).arg("node").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_owned();
    (!path.is_empty()).then_some(path)
}

fn quick_config() -> ServerConfig {
    ServerConfig {
        heartbeat: Duration::from_millis(200),
        call_timeout: Duration::from_secs(10),
        connect_timeout: Duration::from_secs(10),
        max_response_bytes: 64 * 1024,
        ..Default::default()
    }
}

fn server_for(url: &str) -> HttpServer {
    HttpServer { url: url.to_owned(), headers: Vec::new(), max_response_bytes: 64 * 1024 }
}

async fn await_ready(mgr: &McpManager, id: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if mgr.status().iter().any(|(s, state, _)| s == id && *state == ConnState::Ready) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn connects_discovers_and_calls_a_remote_server() {
    let Some(fx) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add(
        "remote",
        Arc::new(HttpFactory::new(server_for(&fx.url)).expect("client")),
        quick_config(),
    );

    // Reaching Ready at all means the session was captured and replayed: the fixture answers 404 to
    // any post-initialize request without it, so `tools/list` would have failed otherwise.
    assert!(await_ready(&mgr, "remote").await, "the remote server never became ready");

    let tools = mgr.list_tools();
    assert!(tools.iter().any(|t| t.name == "mcp__remote__echo"), "got {:?}", tools);

    // Answered over SSE, with a progress notification ahead of the result.
    let out = mgr.call("mcp__remote__echo", json!({ "text": "over http" })).await;
    assert!(out.ok, "call failed: {}", out.content);
    assert_eq!(out.content, "over http", "the answer, not the notification that preceded it");

    mgr.shutdown().await;
}

/// A server that issues no session is legitimate and simpler. The client must not require one.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_without_sessions_works_too() {
    let Some(fx) = fixture(Some("--nosession")) else { return };
    let mgr = McpManager::new();
    mgr.add(
        "plain",
        Arc::new(HttpFactory::new(server_for(&fx.url)).expect("client")),
        quick_config(),
    );
    assert!(await_ready(&mgr, "plain").await);
    let out = mgr.call("mcp__plain__echo", json!({ "text": "no session" })).await;
    assert!(out.ok && out.content == "no session");
    mgr.shutdown().await;
}

/// The cap applies to a streamed body too, where it is enforced while reading rather than after.
#[tokio::test(flavor = "multi_thread")]
async fn an_oversized_streamed_response_is_refused() {
    let Some(fx) = fixture(Some("--huge")) else { return };
    let mgr = McpManager::new();
    mgr.add(
        "big",
        Arc::new(HttpFactory::new(server_for(&fx.url)).expect("client")),
        quick_config(),
    );
    assert!(await_ready(&mgr, "big").await);
    let out = mgr.call("mcp__big__echo", json!({ "text": "anything" })).await;
    assert!(!out.ok, "a 200 KB stream must not be delivered under a 64 KB cap");
    mgr.shutdown().await;
}

/// A server that goes away is noticed by the supervisor, not by the next tool call.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_stops_answering_is_noticed() {
    let Some(mut fx) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add(
        "flaky",
        Arc::new(HttpFactory::new(server_for(&fx.url)).expect("client")),
        quick_config(),
    );
    assert!(await_ready(&mgr, "flaky").await);

    // Kill it and let the heartbeat find out.
    let _ = fx.child.kill();
    let _ = fx.child.wait();

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut left_ready = false;
    while Instant::now() < deadline && !left_ready {
        left_ready = !mgr.status().iter().any(|(s, state, _)| s == "flaky" && *state == ConnState::Ready);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(left_ready, "a dead remote server must not keep declaring tools");

    // And a call against it is a result, not a panic or a hang.
    let out = mgr.call("mcp__flaky__echo", json!({ "text": "gone" })).await;
    assert!(!out.ok);
    assert!(!out.content.is_empty());

    mgr.shutdown().await;
}
