//! A run restricted to a set of tools refuses every other — the runtime's own tools included.
//!
//! The host's tool policy used to be applied only to calls that reached the host. The runtime's own tools never
//! do, so an automation node that denied `write_file` still had its files written. The restriction now sits in
//! the dispatcher, ahead of the host and the registry alike, and is checked on the RESOLVED name.

use std::sync::Arc;

use agent_core::{AgentId, CallId, CancellationToken, TaskId};
use agent_dispatch::{DispatchingExecutor, root_principal};
use agent_loop::{ToolCall, ToolExecutor};
use agent_permission::{Capability, CapabilityKind, Grant, PermissionRuntime, Policy};
use agent_tools::registry::ToolRegistry;
use agent_tools::tool::ToolContext;
use agent_tools::walk::FileListCache;
use agent_tools::workspace::Workspace;
use serde_json::json;

/// An executor that may read its workspace, restricted to `allowed` when given.
fn executor(workspace: &std::path::Path, allowed: Option<&[&str]>) -> DispatchingExecutor {
    let mut registry = ToolRegistry::new();
    agent_tools::tools::register_builtin(&mut registry);
    let roots = vec![workspace.to_path_buf()];
    let grant = Grant::of([Capability::paths(CapabilityKind::FilesystemRead, roots.clone())]);
    let exec = DispatchingExecutor::new(
        Arc::new(registry),
        Arc::new(PermissionRuntime::new(Policy::read_only(roots))),
        root_principal(TaskId::from_host("t1"), AgentId::from_host("main"), grant),
        ToolContext::new(
            Workspace::new(workspace),
            CancellationToken::new(),
            CallId::from_host("c0"),
            Arc::new(FileListCache::new()),
        ),
    );
    match allowed {
        Some(names) => exec.with_allowed_tools(names.iter().map(|n| n.to_string())),
        None => exec,
    }
}

fn call(name: &str, arguments: serde_json::Value) -> ToolCall {
    ToolCall { id: "c1".into(), name: name.into(), arguments: arguments.to_string() }
}

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("a.txt"), "contents").unwrap();
    dir
}

#[tokio::test]
async fn a_tool_outside_the_set_is_refused_even_when_the_runtime_serves_it() {
    let dir = workspace();
    let exec = executor(dir.path(), Some(&["web_search"]));
    let (name, _, outcome) = exec.execute(&call("read_file", json!({ "path": "a.txt" })), &CancellationToken::new()).await;
    assert_eq!(name, "read_file");
    assert!(!outcome.ok);
    assert!(outcome.content.contains("not one of the tools this run may use"), "{}", outcome.content);
    assert!(!outcome.content.contains("contents"), "the file must not have been read");
}

#[tokio::test]
async fn a_dispatcher_envelope_cannot_carry_a_refused_tool_past_the_check() {
    let dir = workspace();
    let exec = executor(dir.path(), Some(&["web_search", "call_tool"]));
    let wrapped = call("call_tool", json!({ "name": "read_file", "arguments": { "path": "a.txt" } }));
    let (name, _, outcome) = exec.execute(&wrapped, &CancellationToken::new()).await;
    assert_eq!(name, "read_file", "reported under the tool it reached for");
    assert!(!outcome.ok, "{}", outcome.content);
}

#[tokio::test]
async fn a_tool_in_the_set_runs_as_before_and_no_set_means_no_restriction() {
    let dir = workspace();
    for exec in [executor(dir.path(), Some(&["read_file"])), executor(dir.path(), None)] {
        let (_, _, outcome) = exec.execute(&call("read_file", json!({ "path": "a.txt" })), &CancellationToken::new()).await;
        assert!(outcome.ok, "{}", outcome.content);
        assert!(outcome.content.contains("contents"));
    }
}
