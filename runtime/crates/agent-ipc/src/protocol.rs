//! Wire types.
//!
//! Every struct here is part of a published contract. Adding an optional field is safe; renaming,
//! removing or retyping one is a major-version change.

use agent_core::error::ErrorPayload;
use agent_journal::RecoveryPlan;
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod agent;
mod mcp;
mod process;
mod subagent;

pub use agent::{AgentRunParams, AgentRunResult, ContextBudget, ProviderParams, ProviderQuirks, ThinkingSetting};
pub use mcp::{
    EVENT_MCP_STATE, McpCallParams, McpCallResult, McpConnectParams, McpServerParams, McpServerStatus,
    McpSetApprovedParams, McpStatusResult, McpToolDescriptor,
};
pub use process::{
    PeekResult, PidParams, ProcessRunParams, ProcessRunResult, ServiceDescriptor, ServiceListResult,
    StartBackgroundParams, StartBackgroundResult, StoppedResult,
};
pub use subagent::{
    HOST_RUN_SUBAGENT, SubagentJoinParams, SubagentJoinResult, SubagentOutcome, SubagentSpawned, SubagentSpawnParams,
    SubagentSpawnResult, SubagentSpec, SubagentStatus, SubagentTurnParams,
};

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
pub const FEATURES: &[&str] =
    &["process.run", "process.background", "mcp.stdio", "mcp.http", "mcp.approval", "subagent.scheduler", "runtime.events", "task.pause", "agent.stream", "agent.host_tools", "agent.round_gate", "agent.context", "agent.transport", "agent.round_context", "agent.allowed_tools"];

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
    /// Filesystem roots the user has approved for this session.
    ///
    /// Becomes the permission ceiling: nothing in the runtime widens it, and a capability outside it is denied
    /// rather than escalated. **Absent means nothing is granted**, which is the safe default and is exactly
    /// what a host that predates this field gets — its behaviour is unchanged, because the runtime's own tool
    /// path does not consult the ceiling yet (see `agent-dispatch`, wired in a later stage).
    #[serde(default)]
    pub workspace_roots: Vec<String>,
    /// Roots the session may READ but never write.
    ///
    /// The media library is the case this exists for. Named in `workspace_roots` it became writable, because
    /// the sandbox built its policy from a single flat list — so declaring the library at all handed commands
    /// write access to it, which is the opposite of what the host's own file tools enforce (`resolvePath`
    /// refuses to write there). Kept apart, "the agent may look at your media" no longer means "the agent may
    /// overwrite your media".
    #[serde(default)]
    pub readonly_roots: Vec<String>,
    /// MCP servers the user has approved for this session, by id.
    ///
    /// Separate from `workspace_roots` because they answer different questions: what a given MCP server may be
    /// asked to do is about that server, not about a directory. A filesystem bridge and a Blender bridge are
    /// not interchangeable, so the grant names them individually.
    #[serde(default)]
    pub approved_mcp_servers: Vec<String>,
    /// Ask the host before anything that CHANGES something inside the approved roots.
    ///
    /// Off by default, which keeps an older host working: with it on, every write asks, and a host that does
    /// not answer `host.consent` would have every write denied. On, it is the runtime equivalent of the app's
    /// existing consent prompt.
    ///
    /// Note this is *within* the ceiling. A capability the ceiling forbids is denied outright and never
    /// escalated — approving it would not make it permitted, so asking would be a lie.
    #[serde(default)]
    pub require_approval_for_mutations: bool,
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
    /// Of `tools`, the ones that CHANGE something.
    ///
    /// The host needs this to decide what a lost reply means. For a read-only tool, re-running it on the JS
    /// handler after a transport failure costs a little time and nothing else. For a mutating one it is a
    /// second edit: `edit_file` replacing `a` with `ab` twice produces `abb`. Reported rather than inferred
    /// from the name, so adding a mutating tool cannot forget to update a list in another process.
    ///
    /// Additive: a host that does not know the field falls back as it always did, which is why this landed in
    /// the same change as the first mutating tool rather than after it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mutating_tools: Vec<String>,
    /// Work a previous run left unfinished, split by whether it had begun.
    ///
    /// Empty on an ordinary start. `interrupted` entries may already have had side effects and must never be
    /// re-run without a per-task decision — see `agent-journal`'s header for why that split is the whole
    /// point. Additive: a host that does not know the field ignores it.
    #[serde(skip_serializing_if = "RecoveryPlan::is_empty")]
    pub recovered: RecoveryPlan,
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
    /// The read-only asset root (the media library), if the host has one configured.
    ///
    /// Optional and defaulted so an older host that never sends it keeps working — it simply gets the
    /// single-root guard this had before. See `Workspace::with_assets`.
    #[serde(default)]
    pub asset_dir: Option<String>,
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

/// Every structured state change the runtime publishes, forwarded verbatim from the event bus.
///
/// One method rather than one per kind: the payload is already tagged (`{"type": "task_started", …}`), and a
/// host that wants to filter can do so on that tag. Splitting it into a dozen methods would make adding an
/// event kind a protocol change, which is exactly what an additive bus exists to avoid.
pub const EVENT_RUNTIME: &str = "runtime.event";

/// Tokens from a running `agent.run`, as they arrive (TODO §10.1 Streaming).
///
/// Carries the INCREMENT, not the accumulated text: a run that emits four thousand tokens would otherwise send
/// four thousand messages of growing length, which is quadratic in the answer's size and would make a long
/// reply slower to display the longer it got.
pub const EVENT_AGENT_DELTA: &str = "agent.delta";

/// A run's tool calls, as they happen, so a UI can show work in flight rather than only its result.
pub const EVENT_AGENT_TOOL: &str = "agent.tool";

/// Runtime → host: may this action proceed?
///
/// The counterpart of the TypeScript loop's `onConsent`. A capability check that can only ever deny is not a
/// permission system, it is a wall — the runtime has to be able to ask, and only the host can put the question
/// to a person.
pub const HOST_REQUEST_CONSENT: &str = "host.consent";

/// Runtime → host: put these questions to the user and return their answers.
///
/// The counterpart of the TypeScript loop's `onAsk`. The runtime cannot render a dialog and must not guess an
/// answer, so `ask_user` is a tool whose implementation is the host's.
pub const HOST_REQUEST_ASK: &str = "host.ask";

/// Runtime → host: run one tool the runtime does not implement, and return what it produced.
///
/// ## Why the loop reaches back out at all
///
/// `agent.run` holds the whole Model → Tool → Result cycle, and it can only do that if it can execute every
/// tool the model is offered. The runtime implements the filesystem and process tools; it does not implement —
/// and should not — the ones whose substance lives in the app: an MCP server's tools, a plugin's, a browser
/// panel, image generation, the app's own state. Those are host capabilities, not un-migrated code.
///
/// So the division is the same one `subagent.run` already draws. The runtime decides *when* a tool runs, in
/// what order, under which permission and against which cancellation; the host decides *what the tool does*
/// when the answer lives in the app. Without this the loop can only ever be offered a fraction of the catalog,
/// which is why it stayed unreachable: a run that cannot call `web_search` is not a run anyone would route to.
///
/// Params are `{ name, args }`. The reply is `{ ok, content }` — the same pair `tool.call` answers with, so a
/// host has one shape to produce whichever direction a call arrives from.
pub const HOST_REQUEST_TOOL: &str = "host.tool";

/// Runtime → host: may another round start?
///
/// The host's veto over a run it no longer drives. Everything the stop policy knows is something the loop can
/// observe — a failure count, a clock, a context window; a spending limit is not, and neither is a workflow
/// node's round budget or an approval withdrawn mid-turn. Those live with the caller, and before this the only
/// way to enforce one was to own the loop, which is exactly what `agent.run` takes away.
///
/// Params are `{ run_id, round, prompt_tokens, completion_tokens }` — the round about to start, 0-based, and
/// what the run has spent so far. The reply is `{ proceed, detail?, withdraw_tools? }`.
///
/// `withdraw_tools` is the "answer now" round: a caller whose budget is spent usually wants a final answer
/// built from what the run already gathered, not a run terminated mid-investigation with its work thrown away.
///
/// Opt-in per run (`round_gate`), because it costs a round trip between every round and most runs have no
/// policy to apply.
pub const HOST_REQUEST_ROUND: &str = "host.round";

/// A run's turn boundaries, so a UI can show a turn opening and what it cost.
pub const EVENT_AGENT_TURN: &str = "agent.turn";

/// A request being retried after a transport failure: `{ run_id, attempt, attempts, kind, delay_ms, message }`.
///
/// "Told, never silent" — the rule `withRequestRetry` follows in TypeScript. A retry nobody sees turns a failing
/// network into an app that is merely slow. When it fires, the partial reply streamed so far is also being
/// discarded: an `agent.delta` with `reset: true` precedes the next attempt's text.
pub const EVENT_AGENT_RETRY: &str = "agent.retry";

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
#[path = "protocol_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "protocol_removed_field_compat.rs"]
mod removed_field_compat;
