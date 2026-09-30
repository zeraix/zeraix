//! The OpenAI-compatible wire: building a request body, and reading what comes back.
//!
//! Every provider this app talks to speaks `chat/completions`, so there is one body builder and one parser.
//! The interesting part is not the happy path — it is that the same response arrives in several shapes
//! depending on who sent it, and the parser has to accept all of them without inventing anything.
//!
//! ## Reasoning arrives under two names
//!
//! `reasoning_content` and `reasoning`, depending on the provider. Both are read, in that order, on the
//! complete response and on every streamed delta. Reading only one would silently discard the thinking the
//! user paid for from half the providers.
//!
//! ## Streaming is reassembly, not a different result
//!
//! A streamed response is accumulated back into exactly the [`NormalizedTurn`] a non-streamed one produces.
//! Callers that want tokens as they arrive get them through a callback; callers that do not are not made to
//! care which transport ran. Tool calls in particular are *fragmented* across deltas — the name arrives in
//! pieces, the arguments arrive in pieces, and they are keyed by `index` rather than by id — so reassembling
//! them is the part that has to be right or a delegation batch turns into a parse error.

use agent_loop::{Message, ModelRequest, NormalizedTurn, ToolCall, Usage};
use serde::Deserialize;

/// Build the JSON body for one request.
///
/// `stream` is a parameter rather than a field of [`ModelRequest`] because it is a transport decision, not
/// something the loop asked for: the same request is sent streamed or not depending on what the caller wants
/// to display, and the answer it produces is identical either way.
pub fn build_body(
    req: &ModelRequest,
    stream: bool,
    thinking_params: &serde_json::Value,
    temperature: Option<f64>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": stream,
    });
    // Only when the caller asked for one. Sending a default would override whatever the provider's own is,
    // and "the app picked 1.0 for you" is not better than "the provider picked".
    if let Some(t) = temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(req.tools.clone());
    }
    if stream {
        // Without this most providers send no usage block at all on a streamed response, and the turn's cost
        // silently becomes an estimate.
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    // Spread last so a provider-specific spelling wins over anything above it.
    if let Some(params) = thinking_params.as_object() {
        for (k, v) in params {
            body[k] = v.clone();
        }
    }
    body
}

// ── The response shapes ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ChatResponse {
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub usage: Option<WireUsage>,
}

#[derive(Debug, Deserialize)]
pub struct Choice {
    #[serde(default)]
    pub message: Option<WireMessage>,
    #[serde(default)]
    pub delta: Option<WireDelta>,
}

#[derive(Debug, Default, Deserialize)]
pub struct WireMessage {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<WireToolCall>,
}

#[derive(Debug, Default, Deserialize)]
pub struct WireDelta {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<WireToolCallDelta>,
}

#[derive(Debug, Deserialize)]
pub struct WireToolCall {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub function: WireFunction,
}

#[derive(Debug, Default, Deserialize)]
pub struct WireFunction {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Deserialize)]
pub struct WireToolCallDelta {
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<WireFunctionDelta>,
}

#[derive(Debug, Deserialize)]
pub struct WireFunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
pub struct WireUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    /// DeepSeek's spelling of a prefix-cache hit.
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<u64>,
    /// The OpenAI-compatible spelling of the same thing.
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: Option<u64>,
}

impl WireUsage {
    /// The usage as the loop records it. Whichever cache spelling is present, in the order `chatRequest.ts`
    /// reads them, so a turn reports the same cache figure whichever side ran it.
    pub fn to_usage(self) -> Usage {
        Usage {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            cached_tokens: self
                .prompt_cache_hit_tokens
                .or(self.prompt_tokens_details.and_then(|d| d.cached_tokens))
                .unwrap_or(0),
            estimated: false,
        }
    }
}

/// Reduce a complete (non-streamed) response to what the loop acts on.
pub fn normalize(resp: ChatResponse) -> NormalizedTurn {
    let msg = resp.choices.into_iter().next().and_then(|c| c.message).unwrap_or_default();
    NormalizedTurn {
        content: msg.content.unwrap_or_default(),
        // Two spellings, in preference order. A provider sending neither simply reasoned in the open.
        reasoning: msg.reasoning_content.or(msg.reasoning).unwrap_or_default(),
        tool_calls: msg
            .tool_calls
            .into_iter()
            .map(|tc| ToolCall { id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
            .collect(),
        usage: resp.usage.map(WireUsage::to_usage),
    }
}

/// Accumulates SSE deltas back into one turn.
///
/// Tool calls are keyed by the delta's `index`, not by id: an id arrives once, on the first fragment, while
/// the name and the arguments arrive in pieces across many. Keying by id would drop every fragment after the
/// first, which shows up as a truncated `arguments` string — the exact failure `toolArgs.ts` exists to report.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    reasoning: String,
    /// index -> (id, name, arguments), kept sparse because providers do not promise contiguous indices.
    tool_calls: std::collections::BTreeMap<usize, (String, String, String)>,
    usage: Option<Usage>,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one `data:` payload in. Returns true if this chunk changed the visible text.
    pub fn push(&mut self, chunk: &str) -> bool {
        let Ok(parsed) = serde_json::from_str::<ChatResponse>(chunk) else {
            // A chunk that will not parse is skipped rather than fatal: providers interleave keep-alives and
            // occasional non-conforming frames, and one of them must not lose the turn that surrounds it.
            return false;
        };
        if let Some(u) = parsed.usage {
            self.usage = Some(u.to_usage());
        }
        let Some(delta) = parsed.choices.into_iter().next().and_then(|c| c.delta) else {
            return false;
        };
        let mut visible = false;
        if let Some(c) = delta.content.filter(|c| !c.is_empty()) {
            self.content.push_str(&c);
            visible = true;
        }
        if let Some(r) = delta.reasoning_content.or(delta.reasoning).filter(|r| !r.is_empty()) {
            self.reasoning.push_str(&r);
            visible = true;
        }
        for tc in delta.tool_calls {
            let entry = self.tool_calls.entry(tc.index).or_default();
            if let Some(id) = tc.id.filter(|id| !id.is_empty()) {
                entry.0 = id;
            }
            if let Some(f) = tc.function {
                if let Some(name) = f.name {
                    entry.1.push_str(&name);
                }
                if let Some(args) = f.arguments {
                    entry.2.push_str(&args);
                }
            }
        }
        visible
    }

    pub fn content(&self) -> &str {
        &self.content
    }
    pub fn reasoning(&self) -> &str {
        &self.reasoning
    }

    pub fn finish(self) -> NormalizedTurn {
        NormalizedTurn {
            content: self.content,
            reasoning: self.reasoning,
            tool_calls: self
                .tool_calls
                .into_values()
                .map(|(id, name, arguments)| ToolCall { id, name, arguments })
                .collect(),
            usage: self.usage,
        }
    }
}

/// Split an SSE buffer into complete `data:` payloads, returning the unconsumed tail.
///
/// Events are separated by a blank line, and a read can end anywhere — including mid-event — so the tail has
/// to be carried to the next read rather than parsed. Getting this wrong truncates whatever frame happened to
/// straddle a chunk boundary, which is invisible until a long tool-call payload lands on one.
pub fn split_events(buffer: &str) -> (Vec<String>, String) {
    let mut payloads = Vec::new();
    let mut consumed = 0;
    // Events end at a blank line, in either newline convention.
    let mut search = 0;
    while let Some(rel) = find_separator(&buffer[search..]) {
        let (at, len) = rel;
        let end = search + at;
        let event = &buffer[consumed..end];
        for line in event.lines() {
            let line = line.trim_start();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    payloads.push(data.to_owned());
                }
            }
        }
        consumed = end + len;
        search = consumed;
    }
    (payloads, buffer[consumed..].to_owned())
}

/// Append a network read to `out` as UTF-8, holding back a character the read cut in half.
///
/// The same trap as `split_events`, one level down: a read ends on a byte, not a character, and a CJK
/// character is three bytes. Decoding each read on its own turned the two halves of `你` into two U+FFFD —
/// in the reply, and in tool-call arguments, where `write_file` would put them into the user's file. The
/// incomplete tail stays in `pending` for the next read, as `TextDecoder`'s `stream: true` does on the
/// TypeScript path. Bytes that are invalid in themselves, not merely unfinished, still decode as U+FFFD.
pub fn decode_utf8_into(pending: &mut Vec<u8>, read: &[u8], out: &mut String) {
    pending.extend_from_slice(read);
    let mut start = 0;
    loop {
        match std::str::from_utf8(&pending[start..]) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                return;
            }
            Err(e) => {
                let valid = start + e.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&pending[start..valid]));
                match e.error_len() {
                    // The read ended inside a character: keep its first bytes for the next read.
                    None => {
                        pending.drain(..valid);
                        return;
                    }
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        start = valid + bad;
                    }
                }
            }
        }
    }
}

fn find_separator(s: &str) -> Option<(usize, usize)> {
    let a = s.find("\n\n").map(|i| (i, 2));
    let b = s.find("\r\n\r\n").map(|i| (i, 4));
    match (a, b) {
        (Some(x), Some(y)) => Some(if x.0 <= y.0 { x } else { y }),
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
}

/// Remove every image part, leaving the text. Used by the image fallback.
pub fn strip_images(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .map(|m| {
            let Some(parts) = m.content.as_array() else { return m.clone() };
            let kept: Vec<serde_json::Value> =
                parts.iter().filter(|p| p["type"] != "image_url").cloned().collect();
            let mut out = m.clone();
            // Collapse a single text part back to a plain string: it is what the message would have been
            // without the image, and some providers are stricter about a one-element array than about a
            // string.
            out.content = match kept.as_slice() {
                [only] if only["type"] == "text" => only["text"].clone(),
                _ => serde_json::Value::Array(kept),
            };
            out
        })
        .collect()
}

/// Remove replayed thinking blocks. Used by the reasoning fallback.
pub fn strip_reasoning(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .map(|m| {
            let mut out = m.clone();
            out.reasoning_content = None;
            out
        })
        .collect()
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
