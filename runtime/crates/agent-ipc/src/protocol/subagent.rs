//! `subagent.*`: scheduling delegations. The runtime decides whether and when; the host runs them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
