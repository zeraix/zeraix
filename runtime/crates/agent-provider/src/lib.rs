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

mod config;
pub mod rejection;
mod retry;
pub mod wire;

pub use config::{ProviderConfig, Quirks};
pub use retry::{OnRetry, RetryNotice};

use std::collections::HashSet;
use std::sync::Mutex;

use agent_core::{CancellationToken, ErrorClass, Result, RuntimeError};
use agent_loop::{Message, ModelCapabilities, ModelClient, ModelRequest, NormalizedTurn};
use futures_util::StreamExt;

/// How a caller receives tokens as they arrive. Returns nothing: a display that fails must not fail the turn.
pub type OnDelta = Box<dyn Fn(&str, &str) + Send + Sync>;

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
    on_retry: Option<OnRetry>,
    /// Cancels every request this client issues. Supplied by the caller so Stop reaches in-flight HTTP.
    token: CancellationToken,
}

impl HttpModel {
    pub fn new(config: ProviderConfig) -> Result<Self> {
        let mut builder = reqwest::Client::builder().read_timeout(config.idle_timeout);
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
        let mut partial_char = Vec::new();
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
            wire::decode_utf8_into(&mut partial_char, &chunk, &mut buffer);
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
#[path = "lib_tests.rs"]
mod tests;
