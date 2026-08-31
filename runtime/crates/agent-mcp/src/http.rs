//! The Streamable HTTP MCP transport: remote and cloud-hosted servers.
//!
//! The other half of MCP. `stdio.rs` covers a server that is a local program; this covers one that is a
//! URL. Same `McpTransport` behind both, so the supervisor's reconnection, heartbeat, backpressure and
//! degradation are written once and neither transport has an opinion about them.
//!
//! ## What "Streamable HTTP" actually requires
//!
//! Not a plain JSON POST, and the difference is the whole reason this file is more than twenty lines. A
//! server may answer one request in either of two ways, and it chooses:
//!
//! - `application/json` — one JSON-RPC message in the body, the simple case;
//! - `text/event-stream` — an SSE stream carrying one or more messages, ending once the response to the
//!   request has been delivered. A server that wants to send progress notifications alongside a slow
//!   call uses this, so refusing to handle it would mean working against the simple servers and hanging
//!   against the capable ones.
//!
//! A `202 Accepted` with no body is the correct answer to a notification, which is why `notify` cannot
//! simply reuse `request`.
//!
//! ## Sessions
//!
//! A server may return `Mcp-Session-Id` on initialize and then require it on every later request. It may
//! also expire one, which it reports as `404` — and that is not a call failure but a dead connection:
//! reported as `Closed` so the supervisor rebuilds rather than failing one tool call and carrying on
//! against a session that no longer exists.
//!
//! ## Authentication
//!
//! Static headers only, supplied by the host at connect time. Servers backed by a plugin's OAuth grant
//! stay on the JS path deliberately: `pluginAuthedFetch` resolves a token *per request* because one
//! fixed at connect time works until the first refresh and then 401s for the rest of the session, and
//! token storage and refresh live in the host. `headers_hook` is the seam for moving that later without
//! reshaping this file.

use crate::transport::{McpTransport, TransportError, TransportFactory, TransportKind};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The MCP protocol version this client speaks, echoed on every request after initialize.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// Header a server uses to hand out, and then require, a session.
const SESSION_HEADER: &str = "mcp-session-id";

/// How long to wait for a connection to be established. The supervisor owns every other deadline; this
/// one exists because a TCP connect to an unreachable host can otherwise hang far past a call timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How to reach one remote MCP server.
#[derive(Debug, Clone)]
pub struct HttpServer {
    pub url: String,
    /// Sent on every request. Static: see the module header on authentication.
    pub headers: Vec<(String, String)>,
    /// Response size ceiling, in bytes.
    pub max_response_bytes: usize,
}

/// Builds HTTP connections to one server.
pub struct HttpFactory {
    server: HttpServer,
    /// Built once and shared: reqwest pools connections per client, so a client per request would throw
    /// away the pooling that makes `pool_size` meaningful.
    client: reqwest::Client,
    last_error: Arc<Mutex<String>>,
}

impl HttpFactory {
    pub fn new(server: HttpServer) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            // No overall request timeout: the supervisor sets one per call, and an SSE stream carrying
            // progress for a slow tool is *supposed* to stay open.
            .user_agent(concat!("zeraix-agent-runtime/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| TransportError::Io(format!("could not build an HTTP client: {e}")))?;
        Ok(Self { server, client, last_error: Arc::new(Mutex::new(String::new())) })
    }
}

#[async_trait::async_trait]
impl TransportFactory for HttpFactory {
    async fn connect(&self) -> Result<Arc<dyn McpTransport>, TransportError> {
        let headers = build_headers(&self.server.headers).inspect_err(|e| {
            *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = e.describe();
        })?;
        Ok(Arc::new(HttpConnection {
            client: self.client.clone(),
            url: self.server.url.clone(),
            base_headers: headers,
            session: Mutex::new(None),
            next_id: AtomicU64::new(0),
            max_response_bytes: self.server.max_response_bytes,
            last_error: Arc::clone(&self.last_error),
        }))
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Http
    }

    fn diagnostics(&self) -> String {
        self.last_error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

fn build_headers(pairs: &[(String, String)]) -> Result<HeaderMap, TransportError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    // Both, because the server picks which one it answers with. Declaring only JSON would make a
    // streaming server either refuse or degrade.
    headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
    for (k, v) in pairs {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| TransportError::Protocol(format!("invalid header name: {k}")))?;
        let value = HeaderValue::from_str(v)
            .map_err(|_| TransportError::Protocol(format!("invalid value for header {k}")))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

pub struct HttpConnection {
    client: reqwest::Client,
    url: String,
    base_headers: HeaderMap,
    /// Handed out by the server on initialize, required on everything after.
    session: Mutex<Option<String>>,
    next_id: AtomicU64,
    max_response_bytes: usize,
    last_error: Arc<Mutex<String>>,
}

impl HttpConnection {
    fn headers_now(&self) -> HeaderMap {
        let mut headers = self.base_headers.clone();
        if let Some(id) = self.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            && let Ok(value) = HeaderValue::from_str(id)
        {
            headers.insert(HeaderName::from_static(SESSION_HEADER), value);
            // Only meaningful once a session exists, which is to say after initialize.
            if let Ok(v) = HeaderValue::from_str(PROTOCOL_VERSION) {
                headers.insert(HeaderName::from_static("mcp-protocol-version"), v);
            }
        }
        headers
    }

    fn note(&self, message: &str) {
        *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = message.to_owned();
    }

    /// POST one message and return the raw response, or a transport error.
    async fn post(&self, body: &Value) -> Result<reqwest::Response, TransportError> {
        let response = self
            .client
            .post(&self.url)
            .headers(self.headers_now())
            .json(body)
            .send()
            .await
            .map_err(|e| {
                // A connect or send failure is the connection, not this call: reported as `Closed` so
                // the supervisor rebuilds rather than failing one tool call against a dead endpoint.
                let msg = format!("could not reach {}: {e}", self.url);
                self.note(&msg);
                TransportError::Closed(msg)
            })?;

        // A session the server has forgotten. Not a call failure — everything after it would fail the
        // same way — so the connection is declared dead and rebuilt without a session.
        if response.status() == reqwest::StatusCode::NOT_FOUND
            && self.session.lock().unwrap_or_else(|e| e.into_inner()).is_some()
        {
            let msg = "the server expired this session".to_owned();
            self.note(&msg);
            return Err(TransportError::Closed(msg));
        }
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let msg = format!("HTTP {status}: {}", body.chars().take(200).collect::<String>());
            self.note(&msg);
            // 4xx/5xx are the server answering badly, not the pipe breaking, so the connection survives
            // and only this call fails.
            return Err(TransportError::Protocol(msg));
        }

        // Captured whenever offered, which in practice is the initialize exchange.
        if let Some(id) = response.headers().get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
            *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.to_owned());
        }
        Ok(response)
    }

    /// Read one JSON-RPC response out of whichever body shape the server chose.
    async fn read_reply(&self, response: reqwest::Response, id: u64) -> Result<Value, TransportError> {
        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));

        if !is_sse {
            let bytes = response.bytes().await.map_err(|e| TransportError::Io(e.to_string()))?;
            if bytes.len() > self.max_response_bytes {
                return Err(TransportError::TooLarge {
                    bytes: bytes.len(),
                    cap: self.max_response_bytes,
                });
            }
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|e| TransportError::Protocol(format!("unparseable response: {e}")))?;
            return extract(value, id);
        }

        // SSE: events separated by a blank line, payload on `data:` lines. Read until the message that
        // answers this request arrives; anything else on the stream is a notification we do not need.
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| TransportError::Io(e.to_string()))?;
            buffer.extend_from_slice(&chunk);
            if buffer.len() > self.max_response_bytes {
                return Err(TransportError::TooLarge {
                    bytes: buffer.len(),
                    cap: self.max_response_bytes,
                });
            }
            while let Some(split) = find_event_end(&buffer) {
                let event: Vec<u8> = buffer.drain(..split.0).collect();
                buffer.drain(..split.1);
                let Some(payload) = sse_data(&event) else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&payload) else { continue };
                // Skip anything that is not the answer to this request: a server is entitled to send
                // progress notifications on the same stream.
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    return extract(value, id);
                }
            }
        }
        Err(TransportError::Closed("the stream ended before answering".to_owned()))
    }
}

/// Byte offset where an event's payload ends, and the length of the separator that follows.
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    // Both spellings, because a server may use either and the difference is invisible until one does.
    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        return Some((i, 4));
    }
    buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2))
}

/// Concatenate an event's `data:` lines, as the SSE format defines.
fn sse_data(event: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(event);
    let mut data = String::new();
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("data:") else { continue };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
    }
    (!data.is_empty()).then_some(data)
}

/// Turn a JSON-RPC message into a result, or the error it reports.
fn extract(value: Value, id: u64) -> Result<Value, TransportError> {
    if value.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(TransportError::Protocol("the server answered a different request".to_owned()));
    }
    if let Some(err) = value.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("the server reported an error")
            .to_owned();
        return Err(TransportError::Protocol(message));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

#[async_trait::async_trait]
impl McpTransport for HttpConnection {
    async fn request(&self, method: &str, params: Value) -> Result<Value, TransportError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let response = self.post(&body).await?;
        self.read_reply(response, id).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        // A notification has no id, so there is no reply to read — `202 Accepted` with an empty body is
        // the correct answer and would look like a truncated response to `read_reply`.
        self.post(&body).await.map(|_| ())
    }

    async fn ping(&self) -> Result<(), TransportError> {
        self.request("ping", json!({})).await.map(|_| ())
    }

    async fn close(&self) {
        // Best effort: the spec defines DELETE as ending a session, and a server that does not
        // implement it simply answers something we ignore. Nothing depends on this succeeding — the
        // connection is being dropped either way.
        let session = self.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(id) = session
            && let Ok(value) = HeaderValue::from_str(&id)
        {
            let mut headers = self.base_headers.clone();
            headers.insert(HeaderName::from_static(SESSION_HEADER), value);
            let _ = self.client.delete(&self.url).headers(headers).send().await;
        }
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Http
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_events_are_split_on_either_line_ending() {
        assert_eq!(find_event_end(b"data: 1\n\nrest"), Some((7, 2)));
        assert_eq!(find_event_end(b"data: 1\r\n\r\nrest"), Some((7, 4)));
        assert_eq!(find_event_end(b"data: incomplete"), None);
    }

    #[test]
    fn data_lines_are_concatenated_and_the_optional_space_stripped() {
        assert_eq!(sse_data(b"data: hello").as_deref(), Some("hello"));
        assert_eq!(sse_data(b"data:hello").as_deref(), Some("hello"));
        assert_eq!(sse_data(b"event: message\ndata: a\ndata: b").as_deref(), Some("a\nb"));
        // A comment or a bare event line carries nothing to parse.
        assert_eq!(sse_data(b": keep-alive"), None);
    }

    #[test]
    fn a_reply_to_a_different_request_is_refused_rather_than_returned() {
        let other = json!({ "jsonrpc": "2.0", "id": 99, "result": { "ok": true } });
        assert!(matches!(extract(other, 1), Err(TransportError::Protocol(_))));
    }

    #[test]
    fn a_json_rpc_error_becomes_a_protocol_error() {
        let err = json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "nope" } });
        match extract(err, 1) {
            Err(TransportError::Protocol(m)) => assert!(m.contains("nope")),
            other => panic!("expected a protocol error, got {other:?}"),
        }
    }
}
