//! MCP permission over the wire (TODO §4.1, §12): which servers a call may reach, decided by the runtime.
//!
//! Split out of `protocol.rs` when approving a server after the handshake (`mcp.set_approved`) was added.

mod common;

use common::{await_mcp_ready, mcp_fixture, Runtime};

/// MCP reached the outside world without the capability check every native tool passes. It does not now —
/// but only once the host has said what it approves.
///
/// Uses a genuinely CONNECTED server, because existence is checked before permission (a typo should be
/// reported as a typo, not as a refusal — the order `agent-dispatch` established). Denial is therefore only
/// observable on a server that is actually there.
#[test]
fn a_connected_but_unapproved_mcp_server_is_denied_and_nothing_is_sent() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // A policy IS declared, and it approves a DIFFERENT server than the one connected below.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["something-else"]
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

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": {}, "call_id": "m1" }),
    );
    let result = &r["result"];
    assert_eq!(result["delivered"], false, "a denied call must not reach the server: {result}");
    let error = result["error"].as_str().unwrap_or("");
    assert!(error.contains("Permission denied"), "{error}");
    assert!(error.contains("Nothing was sent"), "{error}");
}

/// The same server, approved, reaches the server it was denied to before.
#[test]
fn an_approved_mcp_server_is_reached() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
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

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": { "text": "hi" }, "call_id": "m2" }),
    );
    let error = r["result"]["error"].as_str().unwrap_or("");
    assert!(!error.contains("Permission denied"), "an approved server must pass the check: {r}");
}

/// A host that declares nothing has no MCP tools. The gate that used to exempt it is gone (§0.2 F7).
///
/// This is the deliberate cost of making §12's "MCP must not bypass Runtime Permission" unconditional: it is
/// not a property that can hold for some hosts and not others.
#[test]
fn a_host_that_declared_no_policy_has_no_mcp_access_at_all() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.init(); // no workspace_roots, no approved_mcp_servers // no workspace_roots, no approved_mcp_servers

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

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": {}, "call_id": "m2" }),
    );
    let result = &r["result"];
    assert_eq!(result["delivered"], false, "a connected but unapproved server must not be reached");
    assert!(
        result["error"].as_str().unwrap_or("").contains("Permission denied"),
        "{result}"
    );
}

/// Connect the fixture as `fix` and wait until it can serve a call.
fn connect_fixture(rt: &mut Runtime, node: &str, script: &str) {
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(rt, "fix");
}

/// Whether a call to the fixture was refused by the permission check.
fn call_is_denied(rt: &mut Runtime, call_id: &str) -> bool {
    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": { "text": "hi" }, "call_id": call_id }),
    );
    r["result"]["error"].as_str().unwrap_or("").contains("Permission denied")
}

#[test]
fn approval_after_the_handshake_is_announced_as_a_feature() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let features = r["result"]["features"].as_array().expect("features");
    assert!(features.iter().any(|f| f == "mcp.approval"), "{features:?}");
}

/// The case users actually hit: the app starts, THEN the user approves a server. A ceiling frozen at the
/// handshake denied every such server with "outside the configured ceiling".
#[test]
fn a_server_approved_after_the_handshake_is_reached() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.init();
    connect_fixture(&mut rt, &node, &script);
    assert!(call_is_denied(&mut rt, "a1"), "not approved yet");

    let r = rt.call("mcp.set_approved", serde_json::json!({ "servers": ["fix"] }));
    assert_eq!(r["result"]["applied"], true, "{r}");
    assert!(!call_is_denied(&mut rt, "a2"), "approved now, so the call must go through");
}

/// The list replaces the last one, so withdrawing an approval takes effect on the very next call.
#[test]
fn withdrawing_approval_denies_the_next_call() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.call(
        "runtime.initialize",
        serde_json::json!({ "protocol_version": "1.1", "client": "test", "approved_mcp_servers": ["fix"] }),
    );
    connect_fixture(&mut rt, &node, &script);
    assert!(!call_is_denied(&mut rt, "w1"));

    rt.call("mcp.set_approved", serde_json::json!({ "servers": [] }));
    assert!(call_is_denied(&mut rt, "w2"), "a withdrawn approval must be denied");
}
