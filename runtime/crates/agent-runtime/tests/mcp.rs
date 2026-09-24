//! `mcp.*` over the wire: connecting, declaring, calling and disconnecting a real MCP server. Split out of
//! protocol.rs.

mod common;

use common::*;

// ── mcp.* (Stage 3a) ──────────────────────────────────────────────────────────────────────────────

#[test]
fn an_mcp_server_connects_declares_and_serves_a_call() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // Approved, because MCP enforcement is unconditional (§0.2 F7): connecting a server is not the
    // same as being allowed to call it.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["fix"]
        }),
    );

    let accepted = rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    // Accepted immediately: a connecting server must never hold up the turn that configured it.
    assert_eq!(accepted["result"]["id"], "fix");
    assert_ne!(accepted["result"]["state"], "ready", "connecting is asynchronous by contract");

    // Readiness arrives as an event, carrying what the server declares — raw, exactly as the server
    // described it. Namespacing, the `[server]` description prefix and schema normalisation are the
    // host's, because those declarations sit in the cached prompt prefix.
    let ready = await_mcp_ready(&mut rt, "fix");
    let tools = ready["params"]["tools"].as_array().expect("tools");
    let echo = tools.iter().find(|t| t["name"] == "echo").unwrap_or_else(|| panic!("raw names: {tools:?}"));
    assert_eq!(echo["description"], "Echo the text back.");
    assert_eq!(echo["inputSchema"]["properties"]["text"]["type"], "string");
    assert!(
        !tools.iter().any(|t| t["name"].as_str().unwrap_or_default().starts_with("mcp__")),
        "the runtime must not be namespacing: {tools:?}"
    );

    let called = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": { "text": "over ipc" } }),
    );
    assert_eq!(called["result"]["delivered"], true);
    // The server's reply, untouched: the host flattens content blocks its own way.
    assert_eq!(called["result"]["raw"]["content"][0]["text"], "over ipc");
}

/// A tool that ran and failed is still `delivered`. The distinction matters: the host reads `isError`
/// to decide `ok`, and treating it as an undelivered call would make a failing tool look like a broken
/// connection.
#[test]
fn a_tool_that_reports_an_error_is_still_delivered() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // Approved, because MCP enforcement is unconditional (§0.2 F7): connecting a server is not the
    // same as being allowed to call it.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["fix"]
        }),
    );
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "fix");

    let called = rt.call("mcp.call", serde_json::json!({ "server": "fix", "tool": "boom", "args": {} }));
    assert_eq!(called["result"]["delivered"], true, "a server answered, so it was delivered");
    assert_eq!(called["result"]["raw"]["isError"], true, "and the host decides `ok` from this");
}

/// The invariant `callMcpTool` carries in JS, preserved across the wire: a broken MCP call is a
/// result, never a protocol error, because an external server must not be able to abort a turn.
#[test]
fn a_call_to_an_unconfigured_server_fails_as_a_result() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("mcp.call", serde_json::json!({ "server": "nope", "tool": "thing", "args": {} }));
    assert!(r["error"].is_null(), "no protocol error: {r}");
    assert_eq!(r["result"]["delivered"], false);
    assert!(r["result"]["error"].as_str().unwrap().contains("nope"));
}

#[test]
fn disconnecting_stops_declaring_the_server() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.init();
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "bye",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "bye");

    assert_eq!(rt.call("mcp.disconnect", serde_json::json!({ "id": "bye" }))["result"]["disconnected"], true);
    let status = rt.call("mcp.status", serde_json::json!({}));
    let servers = status["result"]["servers"].as_array().unwrap();
    let bye = servers.iter().find(|s| s["id"] == "bye").expect("still listed, as closed");
    assert_eq!(bye["state"], "closed");
    assert!(
        bye["tools"].as_array().unwrap().is_empty(),
        "a server that cannot serve a call must not be declaring tools"
    );
}
