//! The `Tool` trait and its execution context (spec §7).
//!
//! ## What a tool is not allowed to do
//!
//! A tool receives a `ToolContext` and returns text. It does not decide whether it is permitted to run,
//! where it runs, or how long it may take: those are the runtime's calls, applied uniformly in
//! `ToolRegistry::execute`. Spec §7 puts it as "禁止 Agent 直接调用 OS API" — every external effect goes
//! through this trait, and every invocation of this trait goes through one wrapper.
//!
//! The practical reason is the failure this replaces. In the JS runtime the cancellation signal is an
//! optional second argument that a handler may accept, and **22 of 24 handlers simply do not**
//! (`agent-runtime-current-architecture.md` §13.1) — so pressing Stop leaves a large search running to
//! completion. Here the token is in the context every tool is handed, and the wrapper races the future
//! against it regardless, so a tool that ignores cancellation still stops being waited on and still
//! reports cancellation to the caller. Honouring the token promptly remains each tool's job; being
//! cancellable does not.

use agent_core::{CallId, CancellationToken, Result};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

use crate::walk::FileListCache;
use crate::workspace::Workspace;

/// How dangerous a tool is. Consumed by the permission runtime in a later stage; declared now so the
/// metadata does not have to change shape when it arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// Observes without changing anything.
    ReadOnly,
    /// Changes workspace state.
    Mutating,
    /// Spawns processes, reaches the network, or otherwise leaves the workspace.
    Elevated,
}

/// Where a tool's work happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// Runs inside the runtime process.
    InProcess,
    /// Spawns a child process on the host.
    HostProcess,
    /// Runs inside the sandbox VM.
    Sandbox,
}

/// Everything the registry knows about a tool without running it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolMetadata {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments, in the same shape `listTools("raw")` already returns.
    pub input_schema: Value,
    /// Capability names this tool requires, e.g. `filesystem.read` (spec §8).
    pub capabilities: &'static [&'static str],
    pub risk_level: RiskLevel,
    pub execution_mode: ExecutionMode,
    /// Wall-clock ceiling. `None` means the caller's deadline is the only bound.
    pub timeout_ms: Option<u64>,
}

/// What a tool is given when it runs.
#[derive(Clone)]
pub struct ToolContext {
    /// The workspace this call is scoped to. Per-call, never global — see `workspace.rs`.
    pub workspace: Workspace,
    /// Cancellation for this call, derived from the task tree.
    pub cancel: CancellationToken,
    /// The host's handle for this call, so logs and cancellations can be correlated.
    pub call_id: CallId,
    /// Shared file-list cache. Behind an `Arc` because it outlives any single call.
    pub file_cache: Arc<FileListCache>,
}

impl ToolContext {
    pub fn new(workspace: Workspace, cancel: CancellationToken, call_id: CallId, file_cache: Arc<FileListCache>) -> Self {
        Self { workspace, cancel, call_id, file_cache }
    }

    pub fn root(&self) -> &Path {
        self.workspace.root()
    }

    /// Bail out early if the caller has already stopped.
    ///
    /// Tools call this between units of work — per file, per directory — so that Stop takes effect in
    /// bounded time rather than at the end of the call.
    pub fn check_cancelled(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            Err(agent_core::RuntimeError::cancelled())
        } else {
            Ok(())
        }
    }
}

/// A tool's result: text destined for a model, plus whether the workspace file list changed.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: String,
    /// Set by tools that create, delete or rename files, so the registry can drop the walk cache.
    ///
    /// The JS runtime does this with a `FILE_LIST_MUTATORS` name set consulted by `runTool`, which
    /// means adding a mutating tool requires remembering to edit a list somewhere else. Returning it
    /// from the call keeps the fact next to the code that caused it.
    pub invalidates_file_list: bool,
}

impl ToolOutput {
    pub fn text(content: impl Into<String>) -> Self {
        Self { content: content.into(), invalidates_file_list: false }
    }

    pub fn mutating(content: impl Into<String>) -> Self {
        Self { content: content.into(), invalidates_file_list: true }
    }
}

/// One capability the runtime can invoke.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn metadata(&self) -> ToolMetadata;

    /// Run the tool. Arguments arrive as raw JSON and are the tool's own to validate.
    async fn execute(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput>;
}

/// Argument accessors.
///
/// These exist so the tools read like the JS handlers they replace — which destructure loosely and
/// coerce (`Number(offset) || DEFAULT`) rather than rejecting. Reproducing that leniency is deliberate:
/// a model that sends `"2"` instead of `2` gets the same result from both runtimes, and Stage 1 is
/// about proving the seam, not about tightening validation. Strictness belongs in a later stage where
/// it can be introduced as its own visible change.
pub mod args {
    use agent_core::{Result, RuntimeError};
    use serde_json::Value;

    /// Required string argument.
    pub fn req_str(args: &Value, key: &str) -> Result<String> {
        match args.get(key) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(other) => Err(RuntimeError::invalid(
                "tool.invalid_argument",
                format!("{key} must be a string, got {}", type_name(other)),
            )),
            None => Err(RuntimeError::invalid("tool.missing_argument", format!("{key} is required"))),
        }
    }

    /// Optional string argument; absent, null and non-strings all yield `None`.
    pub fn opt_str(args: &Value, key: &str) -> Option<String> {
        match args.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        }
    }

    /// Optional boolean. Mirrors JS truthiness for the shapes a model actually emits.
    pub fn opt_bool(args: &Value, key: &str) -> bool {
        match args.get(key) {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => !s.is_empty() && s != "false",
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            _ => false,
        }
    }

    /// Optional number, accepting a numeric string the way `Number(x)` does.
    pub fn opt_num(args: &Value, key: &str) -> Option<f64> {
        match args.get(key) {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    fn type_name(v: &Value) -> &'static str {
        match v {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
}
