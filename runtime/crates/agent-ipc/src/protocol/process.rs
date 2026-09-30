//! `process.*`: one foreground command, and the background services that outlive a call.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
