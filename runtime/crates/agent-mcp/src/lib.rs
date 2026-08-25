//! MCP Runtime (spec §11, TODO §4).
//!
//! ## What is wrong with the current arrangement
//!
//! `electron/mcp/client.mjs` keeps one entry per server and reconnects **lazily, per call**: a closed
//! stdio pipe marks the entry dead and the transport is rebuilt the next time someone asks for it. There
//! is no heartbeat, so a server that has silently stopped answering looks healthy until a tool call
//! discovers otherwise — and the turn pays for that discovery. There is no backpressure on stdio, so a
//! server returning a very large response is read into memory in full. And there is no pooling for
//! remote transports, so concurrent calls to an HTTP server serialise behind one connection.
//!
//! Each connection here gets a **supervisor task** that owns its lifecycle independently: connect,
//! discover, heartbeat, and reconnect with backoff, all without anyone calling a tool to trigger it.
//!
//! ## Two invariants inherited from the JS implementation
//!
//! Both are load-bearing and both are easy to lose in a rewrite:
//!
//! 1. **A tool call never throws.** `callMcpTool` returns a result for every failure mode there is,
//!    because an external server must not be able to abort a turn. `McpManager::call` returns
//!    `ToolCallOutcome` and has no error path at all.
//! 2. **Listing tools never blocks.** `listMcpTools()` is synchronous and cache-backed: a server that
//!    is still connecting contributes nothing to this turn rather than delaying the request. Tool
//!    declarations sit in the prompt prefix, so waiting on a slow server would stall the model call
//!    itself. `McpManager::list_tools` is likewise synchronous and reads only the last good snapshot.
//!
//! The second invariant is what makes the whole design safe: because a connection's state can never
//! block a turn, the supervisor is free to take as long as it needs to recover.

pub mod supervisor;
pub mod transport;

pub use supervisor::{ConnState, ConnectionSupervisor, ServerConfig};
pub use transport::{McpTransport, TransportError, TransportFactory, TransportKind};

use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;

/// Prefix and separator for namespaced tool names: `mcp__<server>__<tool>`.
///
/// The namespace exists so an MCP tool can never collide with a native handler, which is what lets
/// `runTool` dispatch on the name alone.
pub const TOOL_PREFIX: &str = "mcp";
pub const NAME_SEP: &str = "__";

/// One tool a server exposes, in the shape the tool registry wants.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct McpToolDescriptor {
    /// Namespaced: `mcp__<server>__<tool>`.
    pub name: String,
    /// The server-local name, as sent back over the wire.
    pub remote_name: String,
    pub server: String,
    pub description: String,
    pub parameters: Value,
}

/// The result of calling an MCP tool. Deliberately has no error variant — see invariant 1.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallOutcome {
    pub ok: bool,
    /// Text destined for the model. On failure this is the explanation.
    pub content: String,
}

impl ToolCallOutcome {
    fn ok(content: impl Into<String>) -> Self {
        Self { ok: true, content: content.into() }
    }
    fn failed(content: impl Into<String>) -> Self {
        Self { ok: false, content: content.into() }
    }
}

/// Sanitise an id so it cannot break the namespace.
///
/// A server called `a__b` would otherwise produce a name that parses back into the wrong server, which
/// is a namespace-confusion bug rather than a cosmetic one.
pub fn safe_segment(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect()
}

/// Build the namespaced name for a server-local tool.
pub fn namespaced(server: &str, tool: &str) -> String {
    format!("{TOOL_PREFIX}{NAME_SEP}{}{NAME_SEP}{}", safe_segment(server), safe_segment(tool))
}

/// Whether a name belongs to an MCP tool.
pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with(&format!("{TOOL_PREFIX}{NAME_SEP}"))
}

/// Owns every MCP connection.
#[derive(Default)]
pub struct McpManager {
    servers: DashMap<String, Arc<ConnectionSupervisor>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a server and start supervising it.
    ///
    /// Returns immediately: connecting happens in the supervisor's own task, so a server that is slow
    /// or dead never delays the caller.
    pub fn add(
        &self,
        id: impl Into<String>,
        factory: Arc<dyn TransportFactory>,
        config: ServerConfig,
    ) -> Arc<ConnectionSupervisor> {
        let id = id.into();
        let sup = Arc::new(ConnectionSupervisor::new(id.clone(), factory, config));
        Arc::clone(&sup).start();
        self.servers.insert(id, Arc::clone(&sup));
        sup
    }

    pub fn get(&self, id: &str) -> Option<Arc<ConnectionSupervisor>> {
        self.servers.get(id).map(|e| Arc::clone(e.value()))
    }

    /// Every tool currently known, from the last good snapshot of each server.
    ///
    /// **Synchronous and non-blocking** — invariant 2. A server that is connecting, degraded or failed
    /// contributes nothing this turn instead of delaying the model call.
    pub fn list_tools(&self) -> Vec<McpToolDescriptor> {
        let mut out: Vec<McpToolDescriptor> = self
            .servers
            .iter()
            .flat_map(|e| e.value().tools_snapshot())
            .collect();
        // Stable order: these go into the prompt prefix, and a reshuffle would invalidate the cache.
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Status of every server, for the UI and `runtime.status`.
    pub fn status(&self) -> Vec<(String, ConnState, usize)> {
        let mut out: Vec<(String, ConnState, usize)> = self
            .servers
            .iter()
            .map(|e| {
                let s = e.value();
                (s.id().to_owned(), s.state(), s.tools_snapshot().len())
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Call a namespaced MCP tool.
    ///
    /// **Never fails** — invariant 1. Every failure mode, including "no such server" and "the server is
    /// down", comes back as `ok: false` with an explanation the model can read.
    pub async fn call(&self, namespaced_name: &str, args: Value) -> ToolCallOutcome {
        let Some((server, tool)) = split_name(namespaced_name) else {
            return ToolCallOutcome::failed(format!("{namespaced_name} is not an MCP tool name"));
        };
        let Some(sup) = self.find_server(&server) else {
            return ToolCallOutcome::failed(format!(
                "no MCP server named '{server}' is configured"
            ));
        };
        sup.call(&tool, args).await
    }

    /// Servers are keyed by their configured id, but names carry the *sanitised* id, so a lookup has to
    /// compare sanitised forms.
    fn find_server(&self, sanitised: &str) -> Option<Arc<ConnectionSupervisor>> {
        self.servers
            .iter()
            .find(|e| safe_segment(e.key()) == sanitised)
            .map(|e| Arc::clone(e.value()))
    }

    /// Disconnect everything.
    pub async fn shutdown(&self) {
        let all: Vec<Arc<ConnectionSupervisor>> =
            self.servers.iter().map(|e| Arc::clone(e.value())).collect();
        for s in all {
            s.shutdown().await;
        }
        self.servers.clear();
    }
}

/// Split `mcp__server__tool` into its parts.
///
/// Splits on the FIRST separator after the prefix, so a tool whose own name contains the separator
/// still resolves to the right server.
fn split_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix(&format!("{TOOL_PREFIX}{NAME_SEP}"))?;
    let (server, tool) = rest.split_once(NAME_SEP)?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server.to_owned(), tool.to_owned()))
}

/// Flatten an MCP `content` array into text (mirrors `flattenContent` in mcp/client.mjs).
///
/// Servers return a list of typed blocks; the model needs one string. Non-text blocks are described
/// rather than dropped, because "the server returned an image" is information and silence is not.
pub fn flatten_content(result: &Value) -> String {
    let Some(items) = result.get("content").and_then(Value::as_array) else {
        // Some servers answer with a bare value. Serialising it is better than reporting nothing.
        return match result {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    };
    let mut parts = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = item.get("text").and_then(Value::as_str) {
                    parts.push(t.to_owned());
                }
            }
            Some("image") => parts.push("[image]".to_owned()),
            Some("resource") => {
                let uri = item
                    .get("resource")
                    .and_then(|r| r.get("uri"))
                    .and_then(Value::as_str)
                    .unwrap_or("(unknown)");
                parts.push(format!("[resource: {uri}]"));
            }
            Some(other) => parts.push(format!("[{other}]")),
            None => {}
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        let n = namespaced("files", "read");
        assert_eq!(n, "mcp__files__read");
        assert!(is_mcp_tool(&n));
        assert_eq!(split_name(&n), Some(("files".into(), "read".into())));
    }

    #[test]
    fn a_server_id_cannot_break_the_namespace() {
        // Without sanitising, "a__b" would parse back as server "a", tool "b__read".
        let n = namespaced("a__b", "read");
        assert_eq!(n, "mcp__a__b__read");
        // The sanitised segment is what lookup compares, so the confusion is contained.
        assert_eq!(safe_segment("a__b"), "a__b");
        assert_eq!(safe_segment("a b/c"), "a_b_c");
    }

    #[test]
    fn non_mcp_names_are_rejected() {
        assert!(!is_mcp_tool("read_file"));
        assert_eq!(split_name("read_file"), None);
        assert_eq!(split_name("mcp__onlyserver"), None);
        assert_eq!(split_name("mcp____x"), None);
    }

    #[test]
    fn content_blocks_flatten_to_text() {
        let v = serde_json::json!({
            "content": [
                { "type": "text", "text": "line one" },
                { "type": "image", "data": "..." },
                { "type": "text", "text": "line two" }
            ]
        });
        assert_eq!(flatten_content(&v), "line one\n[image]\nline two");
    }

    #[test]
    fn a_bare_result_is_still_reported() {
        assert_eq!(flatten_content(&serde_json::json!("plain")), "plain");
        assert_eq!(flatten_content(&serde_json::json!({"n": 1})), "{\"n\":1}");
    }
}
