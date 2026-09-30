//! `mcp.*`: supervising stdio MCP servers, calling their tools, and the approvals that gate them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Start supervising one stdio MCP server.
///
/// Returns as soon as the supervisor is running, NOT when the server is ready. That is the same
/// contract `listMcpTools()` already relies on in the JS implementation: a server still connecting
/// contributes no declarations this turn rather than delaying the model request. Readiness arrives as
/// an `mcp.state` event.
///
/// `env` is the child's COMPLETE environment, sent by the host rather than assembled here. The host
/// already computes it from the MCP SDK's allowlist, which exists to keep `ELECTRON_RUN_AS_NODE` and
/// `NODE_OPTIONS` away from a node-based server; reimplementing that here would be a second copy free
/// to drift from the one users actually run.
#[derive(Debug, Clone, Deserialize)]
pub struct McpConnectParams {
    pub id: String,
    /// A local program to run. Present for a stdio server, absent for a remote one.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// A remote endpoint. Present for an HTTP server, absent for a local one.
    ///
    /// Exactly one of `command` and `url` is expected; a request carrying neither is refused rather
    /// than guessed at.
    #[serde(default)]
    pub url: Option<String>,
    /// Sent on every request to a remote server. Static — a server whose credentials are refreshed per
    /// request stays on the host's own client, see the header of `agent-mcp/src/http.rs`.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// One tool call, addressed by server and by the tool's own name.
///
/// Not by the namespaced `mcp__server__tool` name the model used: the host resolves that through the
/// index it already maintains, and it is the host's naming scheme — sanitisation included — so having
/// the runtime parse it back apart would be a second implementation of it.
#[derive(Debug, Clone, Deserialize)]
pub struct McpCallParams {
    pub server: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    /// The host's handle, so `call.cancel` can stop this call. Absent means the caller never cancels.
    #[serde(default)]
    pub call_id: Option<String>,
}

/// The outcome of one MCP tool call.
///
/// `delivered` says whether a server answered at all. It is deliberately not "did the tool succeed":
/// a tool that ran and returned `isError` **was** delivered, and the host reads that off `raw` exactly
/// as it does today. Collapsing the two would lose the distinction between a failing tool and a
/// broken connection.
#[derive(Debug, Clone, Serialize)]
pub struct McpCallResult {
    pub delivered: bool,
    /// The server's reply, untouched, when one arrived.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    /// Why nothing arrived. Present exactly when `delivered` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpServerParams {
    pub id: String,
}

/// `mcp.set_approved`: the MCP servers the user has approved, by id — the complete list, replacing the last one.
///
/// The handshake's `approved_mcp_servers` cannot cover a server approved while the app runs, which is how a user
/// usually approves one. Feature-detected as `mcp.approval`.
#[derive(Debug, Clone, Deserialize)]
pub struct McpSetApprovedParams {
    pub servers: Vec<String>,
}

/// One tool a server exposes, exactly as the server described it.
///
/// Raw on purpose. The host turns these into declarations with conversions that are already in front
/// of users and must not shift underneath them: the name becomes
/// `mcp__<safe server>__<safe tool>`, the description gains a `[server]` prefix — which is what the
/// model actually reads when two servers expose a `search` — and the schema goes through
/// `toParameters`, which strips `$schema`/`$id`/`title` and drops `required` entries naming properties
/// the server never defined, because strict function-calling modes reject both.
///
/// Those declarations sit ahead of `messages` in the cached prompt prefix, so a byte of drift here
/// re-prefills every conversation from token 0. Sending raw values and converting in one place is what
/// makes that impossible rather than unlikely.
#[derive(Debug, Clone, Serialize)]
pub struct McpToolDescriptor {
    /// The server's own tool name, unprefixed and unsanitised.
    pub name: String,
    /// The server's own description, if it gave one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The server's `inputSchema`, untouched — under MCP's own spelling.
    ///
    /// Renamed rather than snake_cased because this struct is a passthrough of a *server's* tool
    /// description, not a type this protocol designed. The host feeds it to the same `toParameters`
    /// that handles the SDK's output, and that function reads `inputSchema`.
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// A server's current state, and what it currently declares.
///
/// `tools` is empty for anything but a ready server — deliberately, and inherited from the supervisor:
/// a degraded server keeps its discovered list internally so a reconnect need not rediscover, but must
/// not offer the model tools that cannot currently be called.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub id: String,
    /// `idle` | `connecting` | `ready` | `degraded` | `failed` | `closed`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub tools: Vec<McpToolDescriptor>,
    /// The server's stderr tail. Often the only explanation a failed server offers, and what the
    /// settings panel shows.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatusResult {
    pub servers: Vec<McpServerStatus>,
}

/// Method name of the event pushed when a connection changes state.
///
/// This is the half of the MCP runtime that the JS implementation cannot have: there, a dead server is
/// discovered by the next tool call that fails, and the turn pays for the discovery. A supervisor that
/// reconnects on its own is only useful if the host hears about it, and this is how.
pub const EVENT_MCP_STATE: &str = "mcp.state";
