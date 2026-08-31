//! Wire types.
//!
//! Every struct here is part of a published contract. Adding an optional field is safe; renaming,
//! removing or retyping one is a major-version change.

use agent_core::error::ErrorPayload;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version. Bump the minor for additive changes, the major for breaking ones.
///
/// 1.1 added the `process.*` namespace (Stage 2). Additive, so a 1.0 host still negotiates
/// successfully — and because it does, the version alone cannot tell a host whether the runtime it is
/// talking to has those methods. `InitializeResult::features` answers that; see its comment.
pub const PROTOCOL_VERSION: &str = "1.1";

/// Capabilities this build serves, beyond the 1.0 baseline every build has.
///
/// A host feature-detects against this rather than against the version number. The two can disagree in
/// exactly the case that matters: `ZERAIX_RUST_RUNTIME_BIN` pointing at an older binary, or a
/// development tree whose sidecar was built before the host code that calls it.
pub const FEATURES: &[&str] = &["process.run", "process.background", "mcp.stdio", "mcp.http", "subagent.scheduler"];

/// Parse a `major.minor` version string.
fn parse_version(v: &str) -> Option<(u32, u32)> {
    let (maj, min) = v.split_once('.')?;
    Some((maj.trim().parse().ok()?, min.trim().parse().ok()?))
}

/// Whether this runtime can serve a host asking for `requested`.
///
/// Same major, and the runtime's minor at least the host's — a host must not depend on methods added
/// after the runtime it is talking to was built.
pub fn is_compatible(requested: &str) -> bool {
    let (Some((r_maj, r_min)), Some((o_maj, o_min))) =
        (parse_version(requested), parse_version(PROTOCOL_VERSION))
    else {
        return false;
    };
    r_maj == o_maj && r_min <= o_min
}

/// A request or a notification. A notification is a request with no `id`, and gets no reply.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// The host's answer to a request the *runtime* made.
///
/// Distinguished from a request by the absence of `method`, which is what makes one stream carry both
/// directions: a message with a `method` is something to do, a message without one is an answer to
/// something already asked. Ids are per-direction — each side numbers its own outbound requests — so
/// the runtime's id 5 and the host's id 5 never meet.
#[derive(Debug, Clone, Deserialize)]
pub struct HostReply {
    pub id: u64,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// One decoded line from the host.
#[derive(Debug, Clone)]
pub enum Incoming {
    /// Something to do, possibly needing a reply.
    Request(Request),
    /// An answer to something this runtime asked.
    Reply(HostReply),
}

/// Decode a line from the host into whichever direction it belongs to.
///
/// Ordering matters: a `method` makes it a request even if it also carries an `id`, because that is a
/// request that wants a reply. Only a message with no `method` can be an answer.
pub fn decode_incoming(line: &str) -> Result<Incoming, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    if value.get("method").is_some() {
        return serde_json::from_value(value).map(Incoming::Request);
    }
    serde_json::from_value(value).map(Incoming::Reply)
}

/// A request the runtime makes of the host.
///
/// The direction that did not exist before Stage 4. Events (§`Notification`) tell the host something
/// happened; this *asks* it for something and waits — which is what lets the runtime own scheduling
/// while the host still owns the work, and what consent inversion will need when the runtime owns the
/// loop (see D5).
#[derive(Debug, Clone, Serialize)]
pub struct HostRequest {
    pub id: u64,
    pub method: &'static str,
    pub params: Value,
}

impl Request {
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// A reply. Exactly one of `result` / `error` is present.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }

    pub fn err(id: Value, error: ErrorBody) -> Self {
        Self { id, result: None, error: Some(error) }
    }
}

/// Convenience alias for handlers that return one or the other.
pub type ResponseBody = Result<Value, ErrorBody>;

/// The structured error carried on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    #[serde(flatten)]
    pub payload: ErrorPayload,
}

impl From<agent_core::RuntimeError> for ErrorBody {
    fn from(e: agent_core::RuntimeError) -> Self {
        Self { payload: (&e).into() }
    }
}

impl From<&agent_core::RuntimeError> for ErrorBody {
    fn from(e: &agent_core::RuntimeError) -> Self {
        Self { payload: e.into() }
    }
}

// ── runtime.initialize ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct InitializeParams {
    /// The protocol version the host expects to speak.
    pub protocol_version: String,
    /// Host name and version, for the runtime's logs. Diagnostic only.
    #[serde(default)]
    pub client: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InitializeResult {
    pub protocol_version: &'static str,
    pub runtime_version: &'static str,
    /// Names of the tools this runtime can serve. The host uses this to decide, per tool, whether to
    /// route to the runtime or keep using its own handler — which is what makes a partial migration
    /// possible at all.
    pub tools: Vec<String>,
    /// Non-tool capabilities, for the same reason: the host routes per feature, not per version.
    /// A host that does not know this field ignores it and behaves exactly as it did at 1.0.
    pub features: Vec<String>,
}

// ── tool.list ─────────────────────────────────────────────────────────────────────────────────────

/// One tool as the host sees it. Mirrors the `"raw"` format of `listTools` so the host can hand it
/// straight to the model without reshaping.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    // Beyond the legacy shape — ignored by a host that does not know about them yet.
    pub capabilities: Vec<String>,
    pub risk_level: String,
    pub execution_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

// ── tool.call ─────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub args: Value,
    /// Absolute path this call is scoped to.
    ///
    /// Per call, not per connection: the JS runtime's process-global `WORKDIR` is the reason two
    /// conversations cannot currently work on two projects at once.
    pub workdir: String,
    /// The host's handle for this call, used by `tool.cancel`. Absent means the caller never cancels.
    #[serde(default)]
    pub call_id: Option<String>,
}

/// A finished call.
///
/// `ok` and `content` reproduce the legacy `runTool` contract exactly, so the host bridge can hand the
/// result to existing code unchanged. `error` carries the structured detail alongside for callers ready
/// to use it — the migration path off stringly-typed failures, without a flag day.
#[derive(Debug, Clone, Serialize)]
pub struct ToolCallResult {
    pub ok: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    pub duration_ms: u64,
}

// ── process.run ───────────────────────────────────────────────────────────────────────────────────

/// One foreground command.
///
/// Mirrors the options `run()` in `electron/tools/sandbox/native.mjs` accepts, because that is the
/// function this replaces and the engine contract in `sandbox/engine.mjs` is what both must satisfy.
/// Notably absent: resource limits. `agent-process` can apply them, the JS implementation cannot, and
/// Stage 2's contract is parity — so they stay off until a stage turns them on deliberately, rather
/// than arriving as a silent behaviour change under a migration.
#[derive(Debug, Clone, Deserialize)]
pub struct ProcessRunParams {
    pub command: String,
    /// Working directory. Absent means the runtime's own, matching `spawn` with no `cwd`.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Wall-clock ceiling. Absent means no timeout, as in the JS implementation.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Per-stream byte cap. Absent means unbounded.
    #[serde(default)]
    pub max_buffer: Option<u64>,
    /// The host's handle, so `call.cancel` can reach this run. Absent means the caller never cancels.
    #[serde(default)]
    pub call_id: Option<String>,
}

/// A finished command.
///
/// The first five fields ARE the JS engine contract — `{ stdout, stderr, code, killed, canceled }` —
/// so the host can hand this straight back to callers that predate the runtime. `code` is a number or
/// the string `"?"`, matching the JS `code ?? (sig ? "?" : 0)` exactly; `"?"` is what a signal death or
/// a failed spawn reports, and callers already render it verbatim.
///
/// `truncated` is beyond that contract and additive: the JS path cannot report whether the cap was hit,
/// because it truncates after the fact rather than stopping at the cap.
#[derive(Debug, Clone, Serialize)]
pub struct ProcessRunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: Value,
    pub killed: bool,
    pub canceled: bool,
    pub truncated: bool,
}

// ── process.start_background / peek / stop / list / stop_all ──────────────────────────────────────

/// Start a service that outlives this call.
///
/// No timeout and no output cap, because neither applies to a process that is supposed to keep
/// running; the trailing-buffer bound lives in the registry. Note what is absent: any notion of
/// readiness. The host decides when a service has started, by scraping the output it reads back
/// through `process.peek` with its own patterns — see `BackgroundRegistry`.
#[derive(Debug, Clone, Deserialize)]
pub struct StartBackgroundParams {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartBackgroundResult {
    pub pid: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PidParams {
    pub pid: u32,
}

/// What a service has printed so far.
///
/// `alive` is false for a pid this runtime is not tracking — which covers both "never started here"
/// and "already exited", exactly as `bgProcs.has(pid)` does in the JS implementation. The host needs no
/// finer answer: it has the exit event for the difference.
#[derive(Debug, Clone, Serialize)]
pub struct PeekResult {
    pub alive: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoppedResult {
    /// False when the pid was not one this runtime started.
    pub stopped: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceDescriptor {
    pub pid: u32,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceListResult {
    pub services: Vec<ServiceDescriptor>,
}

// ── mcp.connect / call / disconnect / status ──────────────────────────────────────────────────────

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


// ── subagent.* ────────────────────────────────────────────────────────────────────────────────────

/// One delegation to schedule.
///
/// `key` is the coalescing key: two unsettled spawns sharing one fold into a single job. The existing
/// repeat-guard in the app compares against delegations that already *finished*, so before this it
/// could not see a twin still in flight.
#[derive(Debug, Clone, Deserialize)]
pub struct SubagentSpec {
    /// Opaque to the runtime and handed back verbatim when the host is asked to run it. The role, the
    /// prompt and every other model-facing detail live in here precisely so the scheduler never has an
    /// opinion about them.
    pub meta: Value,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubagentSpawnParams {
    /// The turn these delegations belong to. Scoping is per turn, matching the JS scheduler, but the
    /// concurrency limit behind it is process-global — which is the thing a per-turn scheduler cannot do.
    pub turn: String,
    pub jobs: Vec<SubagentSpec>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentSpawned {
    pub id: String,
    /// True when this spawn folded into an already-running identical job.
    pub coalesced: bool,
    /// Set when the spawn was refused — cancelled, or the per-turn cap reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentSpawnResult {
    pub jobs: Vec<SubagentSpawned>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubagentJoinParams {
    pub turn: String,
    /// Empty means "everything outstanding".
    #[serde(default)]
    pub ids: Vec<String>,
    /// `all` waits for every one; `any` returns as soon as one settles.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// False harvests what is already settled without committing the turn to a wait. Not a poll: it
    /// returns immediately either way, and anything still running is delivered when it lands.
    #[serde(default = "default_true")]
    pub block: bool,
}

fn default_true() -> bool {
    true
}

/// One settled delegation, delivered exactly once.
#[derive(Debug, Clone, Serialize)]
pub struct SubagentOutcome {
    pub id: String,
    pub meta: Value,
    /// `queued` | `running` | `done` | `failed` | `cancelled`.
    pub state: String,
    pub result: String,
    /// Wall clock from spawn to settle, queue wait included — what the delegation cost the turn.
    pub ms: u64,
    /// How many later spawns folded into this one.
    pub coalesced: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentJoinResult {
    pub ready: Vec<SubagentOutcome>,
    pub pending: Vec<String>,
    /// Asked for but never issued — almost always the model inventing a handle.
    pub unknown: Vec<String>,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubagentTurnParams {
    pub turn: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubagentStatus {
    pub turn: String,
    pub queued: usize,
    pub running: usize,
    pub settled: usize,
    pub total: usize,
    pub outstanding: Vec<String>,
}

/// Method name of the request the runtime makes of the host to actually run a delegation.
///
/// The division this stage exists to draw: the runtime decides *whether, when and how many*; the host
/// decides *what a sub-agent says*, because that means talking to a model and holding a conversation,
/// neither of which belongs in a scheduler.
pub const HOST_RUN_SUBAGENT: &str = "subagent.run";

// ── Events: runtime → host ────────────────────────────────────────────────────────────────────────

/// Method name of the one event this protocol version pushes.
///
/// Events travel as notifications in the same frame shape the host uses — a `method` with no `id` —
/// so nothing about the transport changes and a host that does not recognise the method can ignore it.
///
/// This direction exists because of a gap nothing else can fill: the host polls a starting service only
/// until it settles, and then stops. An exit after that point — a dev server that dies an hour later, an
/// install the user asked to be notified about — has no other way to be noticed. `stop_service` and the
/// running-services indicator both depend on learning it.
pub const EVENT_PROCESS_EXITED: &str = "process.exited";

/// A background process ended, for any reason including a kill this runtime performed.
///
/// `code` and `signal` carry Node's shape (`null` for whichever does not apply). `output` is the whole
/// decoded trailing buffer rather than a clipped tail: the host applies its own `tailOf`, so the notice
/// a model reads is worded in exactly one place.
#[derive(Debug, Clone, Serialize)]
pub struct ProcessExitedEvent {
    pub pid: u32,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub output: String,
    pub command: String,
}

/// One event on the wire.
#[derive(Debug, Clone, Serialize)]
pub struct Notification {
    pub method: &'static str,
    pub params: Value,
}

// ── call.cancel / workspace.invalidate ────────────────────────────────────────────────────────────

/// Cancel one in-flight call by the id the host minted for it.
///
/// One method for every kind of call: a tool invocation and a `process.run` share the same in-flight
/// table, because "stop what you are doing" is one question and having two answers to it is how a
/// cancellation ends up reaching one subsystem and not the other. `tool.cancel` remains accepted as
/// the 1.0 spelling.
#[derive(Debug, Clone, Deserialize)]
pub struct CancelParams {
    pub call_id: String,
}

/// Drop the cached file list for a workspace.
///
/// Sent by the host when one of *its* tools creates, deletes or renames a file. Needed only while the
/// two runtimes share a tree: once the mutating tools migrate, the tool that caused the change reports
/// it directly (see `ToolOutput::invalidates_file_list`) and this becomes vestigial.
#[derive(Debug, Clone, Deserialize)]
pub struct InvalidateParams {
    /// Absent means every workspace.
    #[serde(default)]
    pub workdir: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_version_is_compatible() {
        assert!(is_compatible(PROTOCOL_VERSION));
    }

    #[test]
    fn older_minor_is_accepted_newer_is_not() {
        assert!(is_compatible("1.0"));
        assert!(!is_compatible("1.9"), "host must not demand methods this build lacks");
    }

    /// The 1.0 host in the field must keep negotiating against a 1.1 runtime, or a packaged app whose
    /// binary is newer than its bridge would lose the Stage 1 tools it already had.
    #[test]
    fn the_baseline_host_still_negotiates() {
        assert!(is_compatible("1.0"), "1.1 is additive; a 1.0 host loses nothing");
    }

    /// Why `features` exists: the version cannot distinguish "1.0 host, 1.1 runtime" (process.run is
    /// there) from "1.1 host, 1.0 runtime" (it is not, and the handshake refuses). A host that routes
    /// on the version alone gets the second case wrong.
    #[test]
    fn features_are_advertised_for_routing() {
        assert!(FEATURES.contains(&"process.run"));
    }

    #[test]
    fn major_mismatch_is_refused() {
        assert!(!is_compatible("2.0"));
        assert!(!is_compatible("0.9"));
    }

    #[test]
    fn garbage_is_refused_rather_than_assumed() {
        assert!(!is_compatible(""));
        assert!(!is_compatible("v1"));
        assert!(!is_compatible("1"));
    }

    #[test]
    fn notification_has_no_id() {
        let r: Request = serde_json::from_str(r#"{"method":"tool.cancel","params":{}}"#).unwrap();
        assert!(r.is_notification());
        let r: Request = serde_json::from_str(r#"{"id":1,"method":"tool.list"}"#).unwrap();
        assert!(!r.is_notification());
    }
}
