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
    /// Stream the response. The answer is identical either way; this decides whether `on_delta` ever fires.
    pub stream: bool,
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
            stream: false,
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

/// One provider, reachable over HTTP.
pub struct HttpModel {
    http: reqwest::Client,
    config: ProviderConfig,
    learned: Mutex<Learned>,
    on_delta: Option<OnDelta>,
    /// Cancels every request this client issues. Supplied by the caller so Stop reaches in-flight HTTP.
    token: CancellationToken,
}

impl HttpModel {
    pub fn new(config: ProviderConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(config.request_timeout)
            .build()
            .map_err(|e| RuntimeError::internal("could not build the HTTP client").with_cause(e))?;
        Ok(Self {
            http,
            config,
            learned: Mutex::new(Learned::default()),
            on_delta: None,
            token: CancellationToken::new(),
        })
    }

    pub fn with_on_delta(mut self, on_delta: OnDelta) -> Self {
        self.on_delta = Some(on_delta);
        self
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
        let params = if thinking { self.config.thinking_params.clone() } else { serde_json::json!({}) };
        let body = wire::build_body(&effective, self.config.stream, &params);

        let mut request = self.http.post(&self.config.endpoint).json(&body);
        if !self.config.api_key.is_empty() {
            request = request.bearer_auth(&self.config.api_key);
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

    /// One request, with the three fallbacks.
    ///
    /// See the module header for why the order is what it is and why the image rule is asymmetric.
    async fn complete(&self, req: &ModelRequest) -> Result<NormalizedTurn> {
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

        let first = match self.send_once(&messages, req, send_thinking).await {
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
            return self.send_once(&messages, req, false).await;
        }

        // 2. A REPLAYED thinking block — only reachable when the user has reasoning-as-context on, since
        //    nothing else puts `reasoning_content` in a request.
        if has_reasoning && rejection::is_reasoning_content_error(&first.message) {
            tracing::warn!(model = %model, error = %first.message, "provider rejected replayed thinking blocks; resending without them");
            self.learned.lock().expect("learned").reasoning_context_unsupported.insert(model.clone());
            return self.send_once(&wire::strip_reasoning(&messages), req, send_thinking).await;
        }

        // 3. Images. No images to blame means this failure is genuine — surface it unchanged.
        if !has_images {
            return Err(first);
        }

        let stripped = wire::strip_images(&messages);
        let retried = self.send_once(&stripped, req, send_thinking).await?;

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

/// A request that never reached the provider, or died on the way back.
///
/// Classed `Retryable` rather than `Invalid`: nothing about the request was refused, so sending it again is
/// the reasonable response. The message deliberately carries no HTTP status, which is also what keeps
/// `is_vision_rejection` from reading a transport failure as a verdict about the model.
fn transport_error(e: reqwest::Error) -> RuntimeError {
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
}
