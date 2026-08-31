//! The stdio transport against a real MCP server process.
//!
//! `mcp.rs` covers the supervisor's logic through fakes, which is the right tool for "the server stops
//! answering pings" and "the response is 400 MB". What a fake cannot check is whether this client
//! speaks the protocol at all: the handshake, the framing, the shape of a `tools/list` reply, the
//! difference between a JSON-RPC error and a tool that ran and failed. That needs a server.
//!
//! The fixture is deliberately strict — it answers nothing until `notifications/initialized` arrives —
//! so a client that skips the handshake fails here rather than passing everywhere and hanging in the
//! field. See `tests/fixtures/mcp-server.mjs`.

use agent_mcp::{ConnState, McpManager, ServerConfig, StdioFactory, StdioServer};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The fixture, or `None` when there is no node to run it with.
///
/// Skipped rather than failed: this crate's own correctness does not depend on a JavaScript runtime
/// being installed, and CI runs these on a runner that has one (see .github/workflows/ci.yml).
fn fixture(mode: Option<&str>) -> Option<StdioServer> {
    let node = which_node()?;
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mcp-server.mjs");
    let mut args = vec![script.to_owned()];
    if let Some(m) = mode {
        args.push(m.to_owned());
    }
    Some(StdioServer {
        command: node,
        args,
        cwd: None,
        // The allowlist the host sends in production. PATH is what node itself needs to re-exec.
        env: std::env::vars().filter(|(k, _)| k == "PATH" || k == "HOME" || k == "SystemRoot").collect(),
        max_response_bytes: 64 * 1024,
    })
}

fn which_node() -> Option<String> {
    let out = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg("node")
        .output()
        .ok()?;
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

/// Wait for a server to reach `Ready`, or give up.
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
async fn connects_discovers_and_calls_a_real_server() {
    let Some(server) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add("fix", Arc::new(StdioFactory::new(server)), quick_config());

    assert!(await_ready(&mgr, "fix").await, "the server never became ready");

    // Discovery: the namespaced names are what the model will see.
    let tools = mgr.list_tools();
    assert!(tools.iter().any(|t| t.name == "mcp__fix__echo"), "got {:?}", tools.iter().map(|t| &t.name).collect::<Vec<_>>());
    assert!(tools.iter().any(|t| t.name == "mcp__fix__boom"));
    let echo = tools.iter().find(|t| t.name == "mcp__fix__echo").unwrap();
    assert_eq!(echo.description.as_deref(), Some("Echo the text back."));
    assert_eq!(echo.parameters["properties"]["text"]["type"], "string");

    // Invocation, through the same namespaced name.
    let out = mgr.call("mcp__fix__echo", json!({ "text": "hello mcp" })).await;
    assert!(out.ok, "call failed: {}", out.content);
    assert_eq!(out.content, "hello mcp", "content blocks are flattened to the text a model reads");

    mgr.shutdown().await;
}

/// The whole reason the fixture is strict. Reaching `Ready` at all means `notifications/initialized`
/// was sent — the fixture answers no `tools/list` before it.
#[tokio::test(flavor = "multi_thread")]
async fn the_handshake_notification_is_sent() {
    let Some(server) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add("strict", Arc::new(StdioFactory::new(server)), quick_config());
    assert!(
        await_ready(&mgr, "strict").await,
        "the server never answered tools/list, which is what a missing notifications/initialized looks like"
    );
    mgr.shutdown().await;
}

/// A tool that ran and failed is a RESULT, not an error. Collapsing the two would let a failing tool
/// look like a broken connection and trigger a reconnect.
#[tokio::test(flavor = "multi_thread")]
async fn a_failing_tool_is_a_result_not_a_transport_error() {
    let Some(server) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add("fix", Arc::new(StdioFactory::new(server)), quick_config());
    assert!(await_ready(&mgr, "fix").await);

    let out = mgr.call("mcp__fix__boom", json!({})).await;
    assert!(out.content.contains("the tool refused"), "got {:?}", out.content);
    // The connection is unharmed and still serving.
    let after = mgr.call("mcp__fix__echo", json!({ "text": "still here" })).await;
    assert!(after.ok && after.content == "still here");

    mgr.shutdown().await;
}

/// An unknown tool comes back as a JSON-RPC error. It must reach the caller as a failed call rather
/// than as an exception, because `runTool`'s contract is that nothing throws across this boundary.
#[tokio::test(flavor = "multi_thread")]
async fn a_protocol_error_becomes_a_failed_call() {
    let Some(server) = fixture(None) else { return };
    let mgr = McpManager::new();
    mgr.add("fix", Arc::new(StdioFactory::new(server)), quick_config());
    assert!(await_ready(&mgr, "fix").await);

    let out = mgr.call("mcp__fix__not_a_tool", json!({})).await;
    assert!(!out.ok);
    assert!(!out.content.is_empty(), "a failure the model can read");

    mgr.shutdown().await;
}

/// The cap is enforced against a real oversized reply, not just a fake one.
#[tokio::test(flavor = "multi_thread")]
async fn an_oversized_response_is_refused_rather_than_read_into_memory() {
    let Some(server) = fixture(Some("--huge")) else { return };
    let mgr = McpManager::new();
    mgr.add("big", Arc::new(StdioFactory::new(server)), quick_config());
    assert!(await_ready(&mgr, "big").await);

    let out = mgr.call("mcp__big__echo", json!({ "text": "anything" })).await;
    assert!(!out.ok, "a 200 KB response must not be delivered under a 64 KB cap");

    mgr.shutdown().await;
}

/// A server that dies is noticed and the supervisor rebuilds it, without a tool call to discover it.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_exits_is_reconnected_by_the_supervisor() {
    let Some(server) = fixture(Some("--die")) else { return };
    let mgr = McpManager::new();
    let sup = mgr.add(
        "flaky",
        Arc::new(StdioFactory::new(server)),
        ServerConfig { max_reconnects: Some(2), backoff_base: Duration::from_millis(50), ..quick_config() },
    );

    // It exits the moment it is initialized, so it should never reach Ready — and the supervisor
    // should keep trying rather than sitting on a dead connection.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw_retry = false;
    while Instant::now() < deadline {
        if matches!(sup.state(), ConnState::Connecting | ConnState::Failed { .. }) {
            saw_retry = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(saw_retry, "a dying server should leave the supervisor reconnecting or failed");

    mgr.shutdown().await;
}
