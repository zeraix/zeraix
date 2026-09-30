//! What reaching one provider takes, and what the host already knows it refuses.

use std::time::Duration;

use agent_loop::ModelCapabilities;

/// Everything needed to reach one provider.
pub struct ProviderConfig {
    /// Full URL of the completions endpoint.
    pub endpoint: String,
    /// Bearer token. Empty for a local model, which is the normal case for llama.cpp.
    pub api_key: String,
    /// The model id sent on the wire.
    pub model: String,
    pub capabilities: ModelCapabilities,
    /// Provider fields for the thinking configuration, spread into the body.
    ///
    /// Supplied by the caller rather than computed here: which spelling a family wants is the app's existing
    /// `thinkingParams` decision, and reimplementing it would give the two request paths two answers.
    pub thinking_params: serde_json::Value,
    /// The thinking fields for each effort the loop may settle on for a round — `"low"`, `"medium"`, `"high"`.
    ///
    /// The loop lowers effort on routine rounds (see `resolve_reasoning`), and how a lower effort is SPELLED is
    /// the host's knowledge, family by family, as `thinking_params` is. A request whose effort has an entry here
    /// sends that entry; anything else sends `thinking_params`. Empty, every round sends `thinking_params` —
    /// which is what every request did before, when the per-round effort was resolved and then never sent.
    pub thinking_by_effort: std::collections::BTreeMap<String, serde_json::Value>,
    /// Stream the response. The answer is identical either way; this decides whether `on_delta` ever fires.
    pub stream: bool,
    /// Extra request headers, sent verbatim.
    ///
    /// For `X-Conversation-Id` above all: a local llama-server keys its KV cache by conversation and restores
    /// it by that id instead of re-reading the whole prompt. Without the header a long local conversation paid
    /// a full prefill on every round. The host decides which endpoints get it, as `chatRequest.ts` does.
    pub headers: Vec<(String, String)>,
    /// Sampling temperature, when the caller has an opinion. `None` leaves it to the provider.
    ///
    /// Not a style preference: an automation node has always sent 0.2, and a workflow step that silently
    /// moved to the provider's default would start producing different output for the same input — the
    /// hardest kind of change to notice, because nothing fails.
    pub temperature: Option<f64>,
    /// The route to the endpoint, as the host resolved it: `"direct"`, or a proxy URL. `None` leaves it to the
    /// `*_PROXY` environment variables.
    ///
    /// Resolved by the host because only the host can: a request from the chat window goes through Chromium,
    /// which follows the OS proxy settings and PAC scripts, and this client can read neither. Without it a user
    /// who reaches their provider through a system proxy would find chat stopped connecting the day it moved.
    pub proxy: Option<String>,
    /// How long the connection may go SILENT — no response headers, or no new bytes of the body — before the
    /// request is abandoned. It resets on every read.
    ///
    /// Not a total deadline, deliberately. reqwest's `.timeout()` bounds the whole request *including reading
    /// the body*, so it cut off a healthy stream that was still producing tokens — a slow local model, a long
    /// `write_file` — at the 600 s mark. The cut read as a network failure, the retry resent the request
    /// from scratch, and three attempts later the turn failed with "timed out" after about 30 minutes, billed
    /// three times. What this must catch is a stalled connection, and a stream that is still talking is not one.
    pub idle_timeout: Duration,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            api_key: String::new(),
            model: String::new(),
            capabilities: ModelCapabilities::default(),
            thinking_params: serde_json::json!({}),
            thinking_by_effort: std::collections::BTreeMap::new(),
            stream: false,
            headers: Vec::new(),
            temperature: None,
            proxy: None,
            idle_timeout: Duration::from_secs(600),
        }
    }
}

/// What one model is known to refuse, as the host remembers it and as a run discovers it.
///
/// The per-run `Learned` sets used to be the whole of it, and a run is short: every run paid the same failed
/// request again to rediscover a refusal the app had already seen. The TypeScript path keeps these across
/// turns (and `visionUnsupported` on the model itself), so the host passes in what it knows and reads back
/// what the run learned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Quirks {
    #[serde(default)]
    pub thinking_unsupported: bool,
    #[serde(default)]
    pub reasoning_context_unsupported: bool,
    #[serde(default)]
    pub vision_unsupported: bool,
}
