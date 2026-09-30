//! `agent.run`: a whole agent loop in the runtime — the provider it reaches, and what the host gets back.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A working-set budget below the model's window: compact above `trigger_tokens`, down to `target_tokens`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ContextBudget {
    pub trigger_tokens: u64,
    pub target_tokens: u64,
}

/// Everything needed to reach the provider for one run.
///
/// Sent per run rather than configured once, because a session can switch models mid-conversation and the
/// credentials belong to the host: the runtime holds them for the length of a request and never persists them.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderParams {
    pub endpoint: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    /// Provider fields for the thinking configuration, spread into the request body.
    ///
    /// Supplied rather than computed: which spelling a model family wants is the host's existing
    /// `thinkingParams` decision, and a second implementation would give the two request paths two answers.
    #[serde(default)]
    pub thinking_params: Value,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub supports_per_turn_reasoning_effort: bool,
    /// Sampling temperature. Absent leaves it to the provider, which is what a host that does not set one means.
    #[serde(default)]
    pub temperature: Option<f64>,
    /// Extra request headers — `X-Conversation-Id` for a local llama-server, so it restores this conversation's
    /// KV cache instead of re-reading the prompt. The host decides which endpoints get which, as `chatRequest.ts`
    /// does. Never sent on the summariser's requests (see `run_agent`).
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// What the host already knows this model refuses, so a known refusal costs no failed request.
    #[serde(default)]
    pub known: ProviderQuirks,
    /// `thinking_params` for each effort a round may be issued at — see `ProviderConfig::thinking_by_effort`.
    #[serde(default)]
    pub thinking_by_effort: std::collections::BTreeMap<String, Value>,
    /// `"direct"` or a proxy URL, as the host's own network stack would route this endpoint. Absent: the
    /// runtime's environment decides. See `ProviderConfig::proxy`.
    #[serde(default)]
    pub proxy: Option<String>,
}

/// What one model is known to refuse. The host keeps these across turns; a run starts from them and reports
/// what it learned (`AgentRunResult::learned`), so each refusal is paid for once rather than once per run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderQuirks {
    #[serde(default)]
    pub thinking_unsupported: bool,
    #[serde(default)]
    pub reasoning_context_unsupported: bool,
    #[serde(default)]
    pub vision_unsupported: bool,
}

/// Run one agent turn inside the runtime.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentRunParams {
    /// The host's handle for this run, so it can be cancelled by the same id it was started with.
    pub run_id: String,
    /// The workspace tool calls are scoped to.
    pub workdir: String,
    /// The read-only asset root (the media library), if the host has one configured.
    ///
    /// Optional and defaulted so an older host that never sends it keeps working — it simply gets the
    /// single-root guard this had before. See `Workspace::with_assets`.
    #[serde(default)]
    pub asset_dir: Option<String>,
    pub provider: ProviderParams,
    /// The conversation so far, in the provider's message shape.
    pub messages: Vec<Value>,
    /// Tool declarations, already in the provider's shape. Empty means the run has no tools.
    #[serde(default)]
    pub tools: Vec<Value>,
    /// The model's context window, in tokens.
    ///
    /// Supplying it turns context management ON for the run: the conversation is kept inside the window by
    /// `agent-context` — eliding tool output, then summarising the older part of the conversation with a model
    /// call, then truncating as a last resort. Absent, the conversation is sent exactly as the loop holds it,
    /// which is what every run did before 2026-09-22 and is still right for a caller that manages its own.
    ///
    /// It also gives the stop policy its `context_limit_fraction` something to measure against.
    #[serde(default)]
    pub context_window: Option<u64>,
    /// When to compact, in tokens, when the host caps the working set below the window — the user's context
    /// budget, as the host already applies it between turns. Absent, compaction is relative to `context_window`.
    ///
    /// Separate from the window, not a smaller window: the window is also what the stop policy measures
    /// `context_limit_fraction` against, and a turn that could not be compacted under a 120K budget on a 1M
    /// model must not be stopped as though it were out of room.
    #[serde(default)]
    pub context_budget: Option<ContextBudget>,
    /// Which model writes the summaries. Defaults to the one running the turn.
    ///
    /// Worth setting to something cheap: summarising is the one call in a run whose output nobody reads, and
    /// it is issued against the same endpoint and key as the turn itself.
    #[serde(default)]
    pub summarizer_model: Option<String>,
    /// Ask the host, between rounds, whether the run may continue (see [`HOST_REQUEST_ROUND`](super::HOST_REQUEST_ROUND)).
    ///
    /// Off by default: it costs a round trip per round, and a host that does not answer it would have every
    /// run stopped at the first round. A caller with a budget or a round cap turns it on.
    #[serde(default)]
    pub round_gate: bool,
    /// Tools that may run at the same time when the model asks for several in a row. The host names them —
    /// it is the side that knows which of ITS tools touch nothing. See `LoopConfig::parallel_safe`.
    #[serde(default)]
    pub parallel_tools: Vec<String>,
    /// Send each round's thinking back with its reply for the rest of the turn. See
    /// `LoopConfig::replay_reasoning`; the host decides, by the same policy it applies to earlier turns.
    #[serde(default)]
    pub replay_reasoning: bool,
    /// Hand EVERY tool call to the host through `host.tool`, including the ones this runtime implements and
    /// `ask_user`. For a host whose own tool path carries consent, display and logging it must not lose — a
    /// chat window. The loop, and everything about when to stop, still runs here.
    #[serde(default)]
    pub host_tools_only: bool,
    /// The only tools this run may use, by name. A call to any other is refused without running — the runtime's
    /// own tools included, which never reach the host and so never met the host's tool policy. Absent, the run
    /// is unrestricted. Feature `agent.allowed_tools`: a host that needs it must decline a runtime without it.
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// The user's thinking setting: the switch and the ceiling the loop's per-round effort never exceeds.
    /// Absent, the loop assumes on at medium, as it always has.
    #[serde(default)]
    pub thinking: Option<ThinkingSetting>,
}

/// The user's thinking setting, in the host's terms.
#[derive(Debug, Clone, Deserialize)]
pub struct ThinkingSetting {
    pub enabled: bool,
    /// `"low"`, `"medium"` or `"high"`. Anything else reads as medium.
    #[serde(default)]
    pub effort: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentRunResult {
    /// Why the run ended: `completed`, `cancelled`, `error`, `doom-loop`, `context-limit`, …
    pub stop_reason: String,
    /// Human-readable detail, when there is any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The last assistant text — what a caller shows the user.
    pub content: String,
    /// Provider turns issued.
    pub rounds: u32,
    /// Tool calls executed across every round.
    pub tool_calls: u32,
    /// The conversation as it now stands, including everything the loop appended. Verbatim: compaction
    /// changes what the model is sent, never this.
    pub messages: Vec<Value>,
    /// Indices into `messages` of the ones the host injected through `host.round`, which nobody in the
    /// conversation said. Keep them on the wire; leave them out of a transcript a person reads. Always
    /// present, empty when nothing was injected, so a host never has to tell "none" from "not reported".
    pub injected: Vec<usize>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Of `prompt_tokens`, how many the provider served from its prefix cache.
    pub cached_tokens: u64,
    /// At least one round's usage was estimated because the provider reported none.
    pub estimated: bool,
    /// What is now known about this model: what the host passed in, plus anything this run discovered. The host
    /// keeps it for the next run.
    pub learned: ProviderQuirks,
}
