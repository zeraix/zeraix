//! Wire types.
//!
//! Every struct here is part of a published contract. Adding an optional field is safe; renaming,
//! removing or retyping one is a major-version change.

use agent_core::error::ErrorPayload;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version. Bump the minor for additive changes, the major for breaking ones.
pub const PROTOCOL_VERSION: &str = "1.0";

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

// ── tool.cancel / workspace.invalidate ────────────────────────────────────────────────────────────

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
