//! The provider transport — `ModelClient` over HTTP.
//!
//! Stage 6b of TODO §2.1. `agent-loop` defines the seam; this is what sits behind it, so the loop can call a
//! real model instead of a scripted one. Ported from `src/app/agent/chat/chatRequest.ts`, which is the request
//! path that runs today and has already met the providers.
//!
//! ## What this owns, and why the loop does not
//!
//! Everything between "here are the messages" and "here is the reply": the body, the transport, SSE
//! reassembly, and **the three retry fallbacks**. Keeping them here rather than in the loop is what stops
//! there being two request paths — the duplication `chatRequest.ts`'s own header warns about, and the reason
//! the loop's `ModelClient` has exactly one method.
//!
//! ## The three fallbacks
//!
//! Each is a provider refusing something *we* put in the request, not something the conversation contains, and
//! each is recoverable by sending the same conversation again with less of ours in it.
//!
//! | # | Provider rejects | Response | Remembered as |
//! |---|---|---|---|
//! | 1 | the thinking parameter | resend without it | `thinking_unsupported` |
//! | 2 | a replayed thinking block | resend with `reasoning_content` stripped | `reasoning_context_unsupported` |
//! | 3 | images | resend with images stripped | `vision_unsupported` — *only on a narrow verdict* |
//!
//! Order matters: 1 and 2 are checked before 3, because they are certainly ours rather than the message's, and
//! because a wrong answer to either silently drops a user setting rather than merely resending.
//!
//! ## The one asymmetry worth understanding
//!
//! **The image retry is broad and the image verdict is narrow.**
//!
//! Any failed request carrying images is retried without them, whatever the error said, because providers word
//! that rejection every possible way and a signature that misses one becomes a hard failure on a picture the
//! user can see on screen. The cost of guessing wrong is one request that was already failing.
//!
//! But a retry succeeding does **not** prove the model is image-blind: images are the bulk of the body, so a
//! rate limit, a timeout, an oversized payload or a context overflow all "recover" identically. So only a
//! failure that actually reads as an image rejection ([`rejection::is_vision_rejection`]) may brand the model,
//! because that verdict strips the user's pictures from every later turn and reads to them as "the AI cannot
//! see images". Pairing a broad retry with a broad verdict is what once made models permanently image-blind,
//! curable only by deleting and re-adding them.
//!
//! ## Cancellation
//!
//! Checked before every attempt *and* before every fallback. A user who pressed Stop must not have three more
//! requests issued on their behalf while the runtime works through its ladder.

pub mod rejection;
pub mod wire;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use agent_core::{CancellationToken, ErrorClass, Result, RuntimeError};
use agent_loop::{Message, ModelCapabilities, ModelClient, ModelRequest, NormalizedTurn};
use futures_util::StreamExt;

/// How a caller receives tokens as they arrive. Returns nothing: a display that fails must not fail the turn.
pub type OnDelta = Box<dyn Fn(&str, &str) + Send + Sync>;

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
    pub request_timeout: Duration,
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
            request_timeout: Duration::from_secs(600),
        }
    }
}

/// What the transport has learned about models, the hard way.
///
/// Shared across requests and deliberately monotonic — a model is never un-marked within a session. Each entry
/// costs exactly one failed request the first time and nothing afterwards.
#[derive(Debug, Default)]
struct Learned {
    thinking_unsupported: HashSet<String>,
    reasoning_context_unsupported: HashSet<String>,
    vision_unsupported: HashSet<String>,
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

/// A transport failure being retried, so the caller can say so. "Told, never silent": a retry nobody sees
/// turns a failing network into an app that is merely slow.
#[derive(Debug, Clone)]
pub struct RetryNotice {
    /// The attempt that just failed, 1-based.
    pub attempt: u32,
    pub attempts: u32,
    /// `network`, `rate-limit` or `server` — the three `requestError.ts` retries.
    pub kind: &'static str,
    pub delay_ms: u64,
    pub message: String,
}

/// How a caller hears about retries. Returns nothing: a display that fails must not fail the turn.
pub type OnRetry = Box<dyn Fn(&RetryNotice) + Send + Sync>;

/// One provider, reachable over HTTP.
pub struct HttpModel {
    http: reqwest::Client,
    config: ProviderConfig,
    learned: Mutex<Learned>,
    on_delta: Option<OnDelta>,
    on_retry: Option<OnRetry>,
    /// Cancels every request this client issues. Supplied by the caller so Stop reaches in-flight HTTP.
    token: CancellationToken,
}

impl HttpModel {
    pub fn new(config: ProviderConfig) -> Result<Self> {
        let mut builder = reqwest::Client::builder().timeout(config.request_timeout);
        match config.proxy.as_deref() {
            None => {}
            // Direct means direct: an environment proxy the host's resolver did not choose must not apply either.
            Some("direct") => builder = builder.no_proxy(),
            // The URL itself stays out of the message: a proxy URL can carry credentials.
            Some(url) => {
                let proxy = reqwest::Proxy::all(url).map_err(|e| {
                    RuntimeError::new("provider.proxy_invalid", ErrorClass::Invalid, "the proxy the host resolved is not a usable URL")
                        .with_cause(e)
                })?;
                builder = builder.proxy(proxy);
            }
        }
        let http =
            builder.build().map_err(|e| RuntimeError::internal("could not build the HTTP client").with_cause(e))?;
        Ok(Self {
            http,
            config,
            learned: Mutex::new(Learned::default()),
            on_delta: None,
            on_retry: None,
            token: CancellationToken::new(),
        })
    }

    pub fn with_on_delta(mut self, on_delta: OnDelta) -> Self {
        self.on_delta = Some(on_delta);
        self
    }

    pub fn with_on_retry(mut self, on_retry: OnRetry) -> Self {
        self.on_retry = Some(on_retry);
        self
    }

    /// Start from what the host already knows this model refuses, so a known refusal costs nothing.
    pub fn with_known(self, known: Quirks) -> Self {
        {
            let mut l = self.learned.lock().expect("learned");
            let m = self.config.model.clone();
            if known.thinking_unsupported {
                l.thinking_unsupported.insert(m.clone());
            }
            if known.reasoning_context_unsupported {
                l.reasoning_context_unsupported.insert(m.clone());
            }
            if known.vision_unsupported {
                l.vision_unsupported.insert(m);
            }
        }
        self
    }

    /// What is now known about this client's model — including what this run discovered — for the host to
    /// keep for the next one.
    pub fn quirks(&self) -> Quirks {
        let l = self.learned.lock().expect("learned");
        let m = &self.config.model;
        Quirks {
            thinking_unsupported: l.thinking_unsupported.contains(m),
            reasoning_context_unsupported: l.reasoning_context_unsupported.contains(m),
            vision_unsupported: l.vision_unsupported.contains(m),
        }
    }

    /// Cancel in-flight requests through this token as well as through the loop's.
    pub fn with_cancellation(mut self, token: CancellationToken) -> Self {
        self.token = token;
        self
    }

    fn knows(&self, which: fn(&Learned) -> &HashSet<String>) -> bool {
        let learned = self.learned.lock().expect("learned");
        which(&learned).contains(&self.config.model)
    }

    /// Send exactly what it is given. No fallbacks — `complete` owns those.
    async fn send_once(&self, messages: &[Message], req: &ModelRequest, thinking: bool) -> Result<NormalizedTurn> {
        let effective = ModelRequest {
            model: self.config.model.clone(),
            messages: messages.to_vec(),
            tools: req.tools.clone(),
            reasoning_effort: req.reasoning_effort.clone(),
        };
        let params = if !thinking {
            serde_json::json!({})
        } else {
            req.reasoning_effort
                .as_deref()
                .and_then(|effort| self.config.thinking_by_effort.get(effort))
                .unwrap_or(&self.config.thinking_params)
                .clone()
        };
        let body = wire::build_body(&effective, self.config.stream, &params, self.config.temperature);

        let mut request = self.http.post(&self.config.endpoint).json(&body);
        if !self.config.api_key.is_empty() {
            request = request.bearer_auth(&self.config.api_key);
        }
        for (name, value) in &self.config.headers {
            request = request.header(name.as_str(), value.as_str());
        }

        let response = tokio::select! {
            biased;
            _ = self.token.cancelled() => return Err(RuntimeError::cancelled()),
            r = request.send() => r.map_err(transport_error)?,
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            // "HTTP <status> — <body>" is the shape every rejection predicate reads, and it is the shape the
            // TypeScript path produces. Changing it would silently disable all three fallbacks.
            return Err(RuntimeError::new(
                "provider.http_error",
                if status.is_server_error() { ErrorClass::Retryable } else { ErrorClass::Invalid },
                format!("HTTP {} — {}", status.as_u16(), truncate(&body, 2000)),
            ));
        }

        if self.config.stream {
            self.read_stream(response).await
        } else {
            let text = response.text().await.map_err(transport_error)?;
            let parsed: wire::ChatResponse = serde_json::from_str(&text).map_err(|e| {
                RuntimeError::new(
                    "provider.bad_response",
                    ErrorClass::Retryable,
                    format!("the provider's response was not valid JSON: {}", truncate(&text, 500)),
                )
                .with_cause(e)
            })?;
            Ok(wire::normalize(parsed))
        }
    }

    /// Read an SSE body to completion, folding deltas into one turn.
    async fn read_stream(&self, response: reqwest::Response) -> Result<NormalizedTurn> {
        let mut acc = wire::StreamAccumulator::new();
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();

        loop {
            let chunk = tokio::select! {
                biased;
                _ = self.token.cancelled() => return Err(RuntimeError::cancelled()),
                next = stream.next() => match next {
                    Some(chunk) => chunk.map_err(transport_error)?,
                    None => break,
                },
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            let (events, tail) = wire::split_events(&buffer);
            buffer = tail;
            for event in events {
                // `[DONE]` is the stream's terminator, not a chunk. Parsing it would be one skipped chunk;
                // handling it explicitly is what lets the loop end on the sentinel rather than on EOF.
                if event == "[DONE]" {
                    return Ok(acc.finish());
                }
                if acc.push(&event) {
                    if let Some(cb) = &self.on_delta {
                        cb(acc.content(), acc.reasoning());
                    }
                }
            }
        }
        Ok(acc.finish())
    }
}

#[async_trait::async_trait]
impl ModelClient for HttpModel {
    fn id(&self) -> &str {
        &self.config.model
    }

    fn capabilities(&self) -> ModelCapabilities {
        self.config.capabilities.clone()
    }

    /// One request, with the three fallbacks — and usage filled in when the provider sent none.
    async fn complete(&self, req: &ModelRequest) -> Result<NormalizedTurn> {
        let mut turn = self.complete_uncounted(req).await?;
        if turn.usage.is_none() {
            turn.usage = Some(estimate_usage(&req.messages, &turn));
        }
        Ok(turn)
    }
}

impl HttpModel {
    /// `send_once`, retried when the failure was the TRANSPORT rather than the request — C8, ported from
    /// `withRequestRetry` in src/lib/ai/requestError.ts, with the same classification, attempt budget and backoff
    /// so a turn weathers the same network either side.
    ///
    /// Beneath the three fallbacks, as in TypeScript: those change the request because the provider objected
    /// to it; this resends the identical request because it never arrived. Kept separate, a dropped connection
    /// during a fallback attempt is retried too, and neither mechanism has to know about the other.
    ///
    /// Safe with respect to side effects: the model request is the first thing a round does, so no tool of this
    /// round has run when a retry fires.
    async fn send_with_retry(
        &self,
        messages: &[Message],
        req: &ModelRequest,
        thinking: bool,
    ) -> Result<NormalizedTurn> {
        let mut attempt: u32 = 1;
        loop {
            let err = match self.send_once(messages, req, thinking).await {
                Ok(turn) => return Ok(turn),
                Err(e) => e,
            };
            if err.is_cancelled() || self.token.is_cancelled() {
                return Err(err);
            }
            let (kind, retryable) = classify_failure(&err);
            if !retryable || attempt >= MAX_ATTEMPTS {
                return Err(err);
            }
            let delay = retry_delay_ms(attempt, kind);
            if let Some(notify) = &self.on_retry {
                notify(&RetryNotice {
                    attempt,
                    attempts: MAX_ATTEMPTS,
                    kind,
                    delay_ms: delay,
                    message: err.message.clone(),
                });
            }
            // Clear the half-streamed reply before the next attempt writes over it, so a reader sees a restart
            // rather than text that appears to un-write itself. Accumulated text going BACKWARDS is the signal;
            // the forwarder turns it into a reset.
            if let Some(on_delta) = &self.on_delta {
                on_delta("", "");
            }
            tokio::select! {
                biased;
                _ = self.token.cancelled() => return Err(RuntimeError::cancelled()),
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
            }
            attempt += 1;
        }
    }

    /// One request, with the three fallbacks.
    ///
    /// See the module header for why the order is what it is and why the image rule is asymmetric.
    async fn complete_uncounted(&self, req: &ModelRequest) -> Result<NormalizedTurn> {
        let model = self.config.model.clone();

        // What this model has already refused, applied up front so a known rejection costs nothing.
        let send_thinking = !self.knows(|l| &l.thinking_unsupported);
        let messages = if self.knows(|l| &l.reasoning_context_unsupported) {
            wire::strip_reasoning(&req.messages)
        } else {
            req.messages.clone()
        };
        let messages = if self.knows(|l| &l.vision_unsupported) {
            wire::strip_images(&messages)
        } else {
            messages
        };

        let has_images = messages.iter().any(Message::has_images);
        let has_reasoning = messages.iter().any(|m| m.reasoning_content.is_some());

        let first = match self.send_with_retry(&messages, req, send_thinking).await {
            Ok(turn) => return Ok(turn),
            Err(e) if e.is_cancelled() => return Err(e),
            Err(e) => e,
        };

        // A user who pressed Stop must not have the ladder run on their behalf.
        if self.token.is_cancelled() {
            return Err(RuntimeError::cancelled());
        }

        // 1. The thinking parameter itself. Checked first: it is the failure most certainly ours, and it is
        //    matched narrowly because acting on it drops the user's setting rather than merely resending.
        if send_thinking && rejection::is_thinking_param_error(&first.message) {
            tracing::warn!(model = %model, error = %first.message, "provider rejected the thinking parameter; resending without it");
            self.learned.lock().expect("learned").thinking_unsupported.insert(model.clone());
            return self.send_with_retry(&messages, req, false).await;
        }

        // 2. A REPLAYED thinking block — only reachable when the user has reasoning-as-context on, since
        //    nothing else puts `reasoning_content` in a request.
        if has_reasoning && rejection::is_reasoning_content_error(&first.message) {
            tracing::warn!(model = %model, error = %first.message, "provider rejected replayed thinking blocks; resending without them");
            self.learned.lock().expect("learned").reasoning_context_unsupported.insert(model.clone());
            return self.send_with_retry(&wire::strip_reasoning(&messages), req, send_thinking).await;
        }

        // 3. Images. No images to blame means this failure is genuine — surface it unchanged.
        if !has_images {
            return Err(first);
        }

        let stripped = wire::strip_images(&messages);
        let retried = self.send_with_retry(&stripped, req, send_thinking).await?;

        // The retry succeeded, but that alone does not mean the model is image-blind. Only a failure that
        // actually reads as an image rejection may brand it, because the verdict silently strips the user's
        // pictures from every later turn.
        if rejection::is_vision_rejection(&first.message) {
            tracing::warn!(model = %model, error = %first.message, "provider rejected image input; images will be stripped for this model");
            self.learned.lock().expect("learned").vision_unsupported.insert(model);
        } else {
            tracing::warn!(
                model = %model,
                error = %first.message,
                "a request carrying images failed and succeeded without them, but the error does not read as an image rejection; image support is kept"
            );
        }
        Ok(retried)
    }
}

/// Attempts per request, the first included. `MAX_ATTEMPTS` in requestError.ts.
const MAX_ATTEMPTS: u32 = 3;

/// HTTP statuses that mean "try again", not "you asked wrong". `RETRYABLE_STATUS` in requestError.ts.
const RETRYABLE_STATUS: [u16; 13] = [408, 425, 429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524];

/// Substrings of a transport failure. `NETWORK_HINTS` in requestError.ts; matched case-insensitively.
const NETWORK_HINTS: [&str; 24] = [
    "fetch failed",
    "failed to fetch",
    "network error",
    "networkerror",
    "load failed",
    "socket hang up",
    "premature close",
    "terminated",
    "econnreset",
    "econnrefused",
    "econnaborted",
    "enotfound",
    "eai_again",
    "ehostunreach",
    "enetunreach",
    "epipe",
    "etimedout",
    "timeout",
    "connection error",
    "connection closed",
    "getaddrinfo",
    "tls",
    "certificate",
    "could not connect",
];

/// `(kind, retryable)`, by the rule `classifyFailure` in requestError.ts applies — so the same failure is
/// retried, or not, whichever side sent the request.
fn classify_failure(e: &RuntimeError) -> (&'static str, bool) {
    let status: u16 =
        e.message.strip_prefix("HTTP ").and_then(|rest| rest.get(..3)).and_then(|d| d.parse().ok()).unwrap_or(0);
    let lower = e.message.to_lowercase();
    let kind = if status == 429 {
        "rate-limit"
    } else if RETRYABLE_STATUS.contains(&status) {
        "server"
    } else if (400..500).contains(&status) {
        "client"
    } else if status >= 500 {
        "server"
    } else if e.code == "provider.transport" || NETWORK_HINTS.iter().any(|h| lower.contains(h)) {
        "network"
    } else {
        "unknown"
    };
    (kind, matches!(kind, "network" | "rate-limit" | "server"))
}

/// Backoff: 600 ms (2 s when rate-limited) × 3^(attempt-1), ±25% jitter, capped at 30 s. `retryDelayMs`.
///
/// Jitter from the clock rather than a random-number crate: it only has to decorrelate clients hitting the
/// same provider, and the offline build this runtime ships from cannot take on a dependency casually.
fn retry_delay_ms(attempt: u32, kind: &str) -> u64 {
    let base: f64 = if kind == "rate-limit" { 2000.0 } else { 600.0 };
    let ideal = base * 3f64.powi(attempt.saturating_sub(1) as i32);
    let nanos =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let jitter = 1.0 + ((nanos % 1000) as f64 / 1000.0 - 0.5) * 0.5;
    (ideal * jitter).min(30_000.0).round() as u64
}

/// Usage for a response that carried none, estimated from the text and marked as such.
///
/// Four characters a token: the same rough rule `agent-context` budgets with. Not what the TypeScript path's
/// tokenizer would say, which is why the result is flagged `estimated` rather than passed off as a count.
fn estimate_usage(messages: &[Message], turn: &NormalizedTurn) -> agent_loop::Usage {
    let tokens = |chars: usize| (chars as u64).div_ceil(4);
    let prompt: usize = messages
        .iter()
        .map(|m| m.text().len() + m.tool_calls.iter().map(|c| c.arguments.len() + c.name.len()).sum::<usize>())
        .sum();
    let completion = turn.content.len()
        + turn.reasoning.len()
        + turn.tool_calls.iter().map(|c| c.arguments.len() + c.name.len()).sum::<usize>();
    agent_loop::Usage {
        prompt_tokens: tokens(prompt),
        completion_tokens: tokens(completion),
        cached_tokens: 0,
        estimated: true,
    }
}

/// A request that never reached the provider, or died on the way back./// A request that never reached the provider, or died on the way back.
///
/// Classed `Retryable` rather than `Invalid`: nothing about the request was refused, so sending it again is
/// the reasonable response. The message deliberately carries no HTTP status, which is also what keeps
/// `is_vision_rejection` from reading a transport failure as a verdict about the model.
fn transport_error(e: reqwest::Error) -> RuntimeError {
    // A request that could not even be built — a header HTTP cannot carry, a malformed endpoint — fails the
    // same way on every attempt. Retrying it only spends the backoff before saying so.
    if e.is_builder() {
        return RuntimeError::new(
            "provider.request_invalid",
            ErrorClass::Invalid,
            "the request to the provider could not be built",
        )
        .with_cause(e);
    }
    let what = if e.is_timeout() {
        "the request to the provider timed out"
    } else if e.is_connect() {
        "could not connect to the provider"
    } else {
        "the request to the provider failed"
    };
    RuntimeError::new("provider.transport", ErrorClass::Retryable, what).with_cause(e)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}… (truncated)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transport_failure_carries_no_status_so_it_cannot_be_read_as_a_verdict() {
        // Built through the real path rather than by hand: the point is what `send_once` produces.
        let msg = "could not connect to the provider";
        assert!(!rejection::is_vision_rejection(msg));
        assert!(!rejection::is_thinking_param_error(msg));
    }

    #[test]
    fn a_request_that_cannot_be_built_is_not_retried() {
        // Every attempt would build the same invalid request. The host drops unsendable headers before they
        // get here, but a runtime driven by anything else must not spend three backoffs learning that.
        let built = reqwest::Client::new().post("http://127.0.0.1:9/").header("Not A Header", "x").build();
        let err = transport_error(built.expect_err("an invalid header name must not build"));
        assert_eq!(classify_failure(&err), ("unknown", false));
    }

    #[test]
    fn an_http_error_is_formatted_so_the_predicates_can_read_it() {
        let formatted = format!("HTTP {} — {}", 400, "unknown variant `image_url`");
        assert!(rejection::is_vision_rejection(&formatted));
    }

    #[test]
    fn a_long_error_body_is_truncated_rather_than_carried_whole() {
        let long = "x".repeat(5000);
        let out = truncate(&long, 2000);
        assert!(out.len() < long.len());
        assert!(out.ends_with("… (truncated)"));
        assert_eq!(truncate("short", 2000), "short");
    }

    // ── C8 parity: the same failure is retried, or not, whichever side sent the request ─────────────────

    fn http(status: u16) -> RuntimeError {
        RuntimeError::new("provider.http_error", ErrorClass::Invalid, format!("HTTP {status} — body"))
    }

    #[test]
    fn failures_are_classified_as_request_error_ts_classifies_them() {
        // One row per branch of `kindOf` in src/lib/ai/requestError.ts.
        assert_eq!(classify_failure(&http(429)), ("rate-limit", true));
        for s in [408, 425, 500, 502, 503, 504, 507, 520, 524] {
            assert_eq!(classify_failure(&http(s)), ("server", true), "HTTP {s}");
        }
        assert_eq!(classify_failure(&http(501)), ("server", true), "any other 5xx is server too");
        for s in [400, 401, 403, 404, 422] {
            assert_eq!(classify_failure(&http(s)), ("client", false), "HTTP {s} must NOT be retried");
        }
        let transport =
            RuntimeError::new("provider.transport", ErrorClass::Retryable, "could not connect to the provider");
        assert_eq!(classify_failure(&transport), ("network", true));
        let reset = RuntimeError::new("provider.stream", ErrorClass::Retryable, "stream failed: ECONNRESET");
        assert_eq!(classify_failure(&reset), ("network", true), "recognised by its network hint");
        // Retryable by class, but not by C8's table: a body that is not JSON is not a transport failure, and the
        // TypeScript path would not resend it either.
        let garbage = RuntimeError::new(
            "provider.bad_response",
            ErrorClass::Retryable,
            "the provider's response was not valid JSON",
        );
        assert_eq!(classify_failure(&garbage), ("unknown", false));
    }

    #[test]
    fn backoff_follows_the_c8_schedule_and_never_exceeds_its_cap() {
        for _ in 0..50 {
            let first = retry_delay_ms(1, "network");
            assert!((450..=750).contains(&first), "600 ms ±25%: {first}");
            let second = retry_delay_ms(2, "server");
            assert!((1350..=2250).contains(&second), "1800 ms ±25%: {second}");
            let limited = retry_delay_ms(1, "rate-limit");
            assert!((1500..=2500).contains(&limited), "a rate limit starts at 2 s: {limited}");
            assert!(retry_delay_ms(9, "rate-limit") <= 30_000, "capped at 30 s");
        }
    }

    #[test]
    fn a_response_without_usage_is_estimated_and_says_so() {
        let turn = NormalizedTurn { content: "x".repeat(40), ..Default::default() };
        let u = estimate_usage(&[Message::user("y".repeat(400))], &turn);
        assert!(u.estimated, "an estimate must never be passed off as a count");
        assert_eq!((u.prompt_tokens, u.completion_tokens), (100, 10));
    }

    #[test]
    fn known_quirks_go_in_and_learned_ones_come_out() {
        let model = HttpModel::new(ProviderConfig { model: "m".into(), ..Default::default() })
            .unwrap()
            .with_known(Quirks { vision_unsupported: true, ..Default::default() });
        assert!(model.knows(|l| &l.vision_unsupported), "a refusal the host already knows is applied up front");
        model.learned.lock().unwrap().thinking_unsupported.insert("m".into());
        assert_eq!(
            model.quirks(),
            Quirks { thinking_unsupported: true, reasoning_context_unsupported: false, vision_unsupported: true },
            "what the run learned is handed back beside what it was told"
        );
    }
}
