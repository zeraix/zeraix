//! The three fallbacks, against a real HTTP server.
//!
//! The predicates are unit-tested next to themselves; what these prove is the behaviour built on them — that
//! the retry actually goes out, that it carries the *right* body, and above all that what the transport
//! *learns* from a failure is correct. That last one is the part worth testing hardest: a wrong verdict is
//! invisible at the time and silently degrades every later turn.
//!
//! The server is a few lines of raw HTTP/1.1 over `TcpListener` rather than a framework, because the workspace
//! has no HTTP server dependency and this needs one behaviour a framework would hide: replying from a script,
//! and recording exactly what body each request carried.

use std::sync::{Arc, Mutex};

use agent_core::CancellationToken;
use agent_loop::{Message, ModelClient, ModelRequest};
use agent_provider::{HttpModel, ProviderConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One scripted reply.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    /// `text/event-stream` rather than JSON.
    sse: bool,
}

impl Reply {
    fn ok(body: serde_json::Value) -> Self {
        Self { status: 200, body: body.to_string(), sse: false }
    }
    fn error(status: u16, message: &str) -> Self {
        Self { status, body: format!("{{\"error\":{{\"message\":{:?}}}}}", message), sse: false }
    }
    fn stream(events: &[&str]) -> Self {
        let mut body = String::new();
        for e in events {
            body.push_str(&format!("data: {e}\n\n"));
        }
        body.push_str("data: [DONE]\n\n");
        Self { status: 200, body, sse: true }
    }
}

/// A provider that answers from a script and remembers what it was asked.
struct FakeProvider {
    url: String,
    received: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl FakeProvider {
    async fn start(script: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let received = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&received);

        tokio::spawn(async move {
            let mut script = script.into_iter();
            // The last reply repeats, so a test does not have to script requests it is not asserting on.
            let mut last = Reply::ok(serde_json::json!({ "choices": [{ "message": { "content": "ok" } }] }));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                let seen = Arc::clone(&seen);
                let reply = script.next().unwrap_or_else(|| last.clone());
                if script.len() == 0 {
                    last = reply.clone();
                }

                // Read headers, then exactly `content-length` bytes of body.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let body = loop {
                    let n = match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break String::new(),
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(split) = text.find("\r\n\r\n") else { continue };
                    let len: usize = text
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_owned()))
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let body_start = split + 4;
                    if buf.len() >= body_start + len {
                        break String::from_utf8_lossy(&buf[body_start..body_start + len]).to_string();
                    }
                };
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                    seen.lock().unwrap().push(parsed);
                }

                let content_type = if reply.sse { "text/event-stream" } else { "application/json" };
                let response = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    content_type,
                    reply.body.len(),
                    reply.body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });

        Self { url: format!("http://{addr}/v1/chat/completions"), received }
    }

    fn bodies(&self) -> Vec<serde_json::Value> {
        self.received.lock().unwrap().clone()
    }
}

fn answer(text: &str) -> serde_json::Value {
    serde_json::json!({ "choices": [{ "message": { "content": text } }] })
}

fn model(provider: &FakeProvider, thinking: serde_json::Value) -> HttpModel {
    HttpModel::new(ProviderConfig {
        endpoint: provider.url.clone(),
        model: "test-model".into(),
        thinking_params: thinking,
        ..Default::default()
    })
    .expect("client")
}

fn with_image() -> Message {
    Message::parts(
        "user",
        vec![
            serde_json::json!({ "type": "text", "text": "what is this" }),
            serde_json::json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }),
        ],
    )
}

fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest { model: "test-model".into(), messages, ..Default::default() }
}

#[tokio::test]
async fn an_ordinary_completion_round_trips() {
    let provider = FakeProvider::start(vec![Reply::ok(answer("hello"))]).await;
    let m = model(&provider, serde_json::json!({}));
    let turn = m.complete(&request(vec![Message::user("hi")])).await.expect("a reply");
    assert_eq!(turn.content, "hello");
    assert_eq!(provider.bodies().len(), 1);
}

#[tokio::test]
async fn a_streamed_response_is_reassembled_and_reports_progress() {
    let provider = FakeProvider::start(vec![Reply::stream(&[
        &serde_json::json!({"choices":[{"delta":{"content":"Hel"}}]}).to_string(),
        &serde_json::json!({"choices":[{"delta":{"content":"lo"}}]}).to_string(),
        &serde_json::json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}).to_string(),
    ])])
    .await;

    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&seen);
    let m = HttpModel::new(ProviderConfig {
        endpoint: provider.url.clone(),
        model: "test-model".into(),
        stream: true,
        ..Default::default()
    })
    .expect("client")
    .with_on_delta(Box::new(move |content, _| sink.lock().unwrap().push(content.to_owned())));

    let turn = m.complete(&request(vec![Message::user("hi")])).await.expect("a reply");
    assert_eq!(turn.content, "Hello");
    assert_eq!(turn.usage.expect("usage").prompt_tokens, 4);
    assert_eq!(*seen.lock().unwrap(), vec!["Hel".to_string(), "Hello".to_string()]);
    // A streamed request must ask for usage, or the turn's cost becomes an estimate.
    assert_eq!(provider.bodies()[0]["stream_options"]["include_usage"], true);
}

// ── Fallback 1: the thinking parameter ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_rejected_thinking_parameter_is_dropped_and_the_request_resent() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "unknown parameter: reasoning_effort"),
        Reply::ok(answer("second time lucky")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({ "reasoning_effort": "high" }));

    let turn = m.complete(&request(vec![Message::user("hi")])).await.expect("the retry to succeed");
    assert_eq!(turn.content, "second time lucky");

    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["reasoning_effort"], "high", "the first attempt carries the parameter");
    assert!(bodies[1].get("reasoning_effort").is_none(), "the retry must not carry it");
}

/// The verdict is remembered, so the fallback costs one request per model rather than one per turn.
#[tokio::test]
async fn a_model_that_rejected_thinking_is_not_asked_again() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "unknown parameter: reasoning_effort"),
        Reply::ok(answer("one")),
        Reply::ok(answer("two")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({ "reasoning_effort": "high" }));

    m.complete(&request(vec![Message::user("a")])).await.expect("first turn");
    m.complete(&request(vec![Message::user("b")])).await.expect("second turn");

    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 3, "the second turn must cost one request, not two");
    assert!(bodies[2].get("reasoning_effort").is_none(), "the parameter stays retired");
}

/// A 400 about something else must not silently retire the user's thinking setting.
#[tokio::test]
async fn an_unrelated_400_does_not_retire_the_thinking_setting() {
    let provider = FakeProvider::start(vec![Reply::error(400, "messages[3] has no content")]).await;
    let m = model(&provider, serde_json::json!({ "reasoning_effort": "high" }));

    let err = m.complete(&request(vec![Message::user("hi")])).await.expect_err("the failure to surface");
    assert!(err.message.contains("messages[3]"), "the real error must reach the caller: {}", err.message);
    assert_eq!(provider.bodies().len(), 1, "no retry should have been attempted");
}

// ── Fallback 2: a replayed thinking block ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_rejected_thinking_replay_is_stripped_and_the_request_resent() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "extra inputs are not permitted: reasoning_content"),
        Reply::ok(answer("fine without it")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({}));
    let messages = vec![
        Message::user("hi"),
        Message::assistant("earlier answer").with_reasoning("earlier thinking"),
    ];

    let turn = m.complete(&request(messages)).await.expect("the retry to succeed");
    assert_eq!(turn.content, "fine without it");

    let bodies = provider.bodies();
    assert_eq!(bodies[0]["messages"][1]["reasoning_content"], "earlier thinking");
    assert!(
        bodies[1]["messages"][1].get("reasoning_content").is_none(),
        "the retry must not replay the thinking block"
    );
    // The rest of the conversation is untouched — only our own field was dropped.
    assert_eq!(bodies[1]["messages"][1]["content"], "earlier answer");
}

/// Nothing to strip means nothing to blame: the failure is the caller's to see.
#[tokio::test]
async fn a_reasoning_rejection_without_any_replayed_block_is_surfaced_unchanged() {
    let provider = FakeProvider::start(vec![Reply::error(400, "unknown field `reasoning`")]).await;
    let m = model(&provider, serde_json::json!({}));

    let err = m.complete(&request(vec![Message::user("hi")])).await.expect_err("the failure to surface");
    assert!(err.message.contains("reasoning"));
    assert_eq!(provider.bodies().len(), 1);
}

// ── Fallback 3: images — broad retry, narrow verdict ──────────────────────────────────────────────

#[tokio::test]
async fn a_request_carrying_images_is_retried_without_them() {
    let provider =
        FakeProvider::start(vec![Reply::error(400, "unknown variant `image_url`"), Reply::ok(answer("text only"))])
            .await;
    let m = model(&provider, serde_json::json!({}));

    let turn = m.complete(&request(vec![with_image()])).await.expect("the retry to succeed");
    assert_eq!(turn.content, "text only");

    let bodies = provider.bodies();
    assert!(bodies[0]["messages"][0]["content"].is_array(), "the first attempt carries the image");
    assert_eq!(bodies[1]["messages"][0]["content"], "what is this", "the retry keeps the text and drops the image");
}

/// The narrow verdict: a real image rejection brands the model, and later turns pre-strip.
#[tokio::test]
async fn a_genuine_image_rejection_marks_the_model_and_later_turns_send_no_images() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "unknown variant `image_url`"),
        Reply::ok(answer("one")),
        Reply::ok(answer("two")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({}));

    m.complete(&request(vec![with_image()])).await.expect("first turn");
    m.complete(&request(vec![with_image()])).await.expect("second turn");

    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 3, "the second turn must cost one request");
    assert_eq!(bodies[2]["messages"][0]["content"], "what is this", "images are stripped up front now");
}

/// The failure this asymmetry exists to prevent, and the most important test in the file.
///
/// A rate limit on a request that happened to carry images "recovers" when the images are removed, because
/// they were the bulk of the body. Treating that as proof of image-blindness is what once made models
/// permanently unable to see pictures, curable only by deleting and re-adding them.
#[tokio::test]
async fn a_rate_limit_recovers_by_stripping_images_but_never_brands_the_model() {
    let provider = FakeProvider::start(vec![
        Reply::error(429, "rate limit exceeded, please try again"),
        Reply::ok(answer("recovered")),
        Reply::ok(answer("later turn")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({}));

    let turn = m.complete(&request(vec![with_image()])).await.expect("the retry to succeed");
    assert_eq!(turn.content, "recovered");

    // The next turn must still send the user's image: nothing was learned from a rate limit.
    m.complete(&request(vec![with_image()])).await.expect("second turn");
    let bodies = provider.bodies();
    assert!(
        bodies[2]["messages"][0]["content"].is_array(),
        "a rate limit must not cost the user their images forever: {}",
        bodies[2]["messages"][0]["content"]
    );
}

/// Same shape, different cause: a context overflow is also "fixed" by dropping the biggest part of the body.
#[tokio::test]
async fn a_context_overflow_recovers_by_stripping_images_but_never_brands_the_model() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "maximum context length is 128000 tokens"),
        Reply::ok(answer("recovered")),
        Reply::ok(answer("later turn")),
    ])
    .await;
    let m = model(&provider, serde_json::json!({}));

    m.complete(&request(vec![with_image()])).await.expect("the retry to succeed");
    m.complete(&request(vec![with_image()])).await.expect("second turn");
    assert!(provider.bodies()[2]["messages"][0]["content"].is_array(), "image support must be kept");
}

/// No images to blame: the failure is genuine and must reach the caller unchanged.
#[tokio::test]
async fn a_failure_with_no_images_in_the_request_is_never_retried() {
    let provider = FakeProvider::start(vec![Reply::error(500, "internal server error")]).await;
    let m = model(&provider, serde_json::json!({}));

    let err = m.complete(&request(vec![Message::user("hi")])).await.expect_err("the failure to surface");
    assert!(err.message.contains("500"));
    assert_eq!(provider.bodies().len(), 1, "nothing to strip means nothing to retry");
}

/// If the retry fails too, the caller sees the retry's own error rather than a stale first one.
#[tokio::test]
async fn a_retry_that_also_fails_surfaces_its_own_error() {
    let provider = FakeProvider::start(vec![
        Reply::error(400, "unknown variant `image_url`"),
        Reply::error(503, "service unavailable"),
    ])
    .await;
    let m = model(&provider, serde_json::json!({}));

    let err = m.complete(&request(vec![with_image()])).await.expect_err("the retry's failure");
    assert!(err.message.contains("503"), "expected the retry's error, got: {}", err.message);
}

// ── Cancellation ──────────────────────────────────────────────────────────────────────────────────

/// A user who pressed Stop must not have the fallback ladder run on their behalf.
#[tokio::test]
async fn a_cancelled_request_issues_nothing_and_runs_no_fallbacks() {
    let provider = FakeProvider::start(vec![Reply::error(400, "unknown variant `image_url`")]).await;
    let token = CancellationToken::new();
    token.cancel();
    let m = model(&provider, serde_json::json!({})).with_cancellation(token);

    let err = m.complete(&request(vec![with_image()])).await.expect_err("a cancellation");
    assert!(err.is_cancelled(), "expected cancellation, got: {}", err.message);
    assert!(provider.bodies().is_empty(), "a cancelled request must reach no provider");
}
