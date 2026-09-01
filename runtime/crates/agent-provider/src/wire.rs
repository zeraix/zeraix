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
pub fn build_body(req: &ModelRequest, stream: bool, thinking_params: &serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": stream,
    });
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
        usage: resp.usage.map(|u| Usage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
        }),
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
            self.usage =
                Some(Usage { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens });
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_complete_response_is_reduced_to_content_reasoning_and_calls() {
        let resp: ChatResponse = serde_json::from_value(json!({
            "choices": [{ "message": {
                "content": "here you go",
                "reasoning_content": "thought hard",
                "tool_calls": [{ "id": "c1", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }]
            }}],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        }))
        .unwrap();
        let turn = normalize(resp);
        assert_eq!(turn.content, "here you go");
        assert_eq!(turn.reasoning, "thought hard");
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "read_file");
        assert_eq!(turn.usage.unwrap().prompt_tokens, 10);
    }

    /// Reading only one spelling would discard the thinking from half the providers.
    #[test]
    fn reasoning_is_read_under_either_field_name() {
        for field in ["reasoning_content", "reasoning"] {
            let resp: ChatResponse =
                serde_json::from_value(json!({ "choices": [{ "message": { field: "thought" } }] })).unwrap();
            assert_eq!(normalize(resp).reasoning, "thought", "{field}");
        }
    }

    #[test]
    fn an_empty_response_normalises_rather_than_failing() {
        let resp: ChatResponse = serde_json::from_value(json!({ "choices": [] })).unwrap();
        let turn = normalize(resp);
        assert_eq!(turn.content, "");
        assert!(turn.tool_calls.is_empty());
    }

    /// The reassembly that has to be right or a delegation batch becomes a parse error.
    #[test]
    fn a_tool_call_fragmented_across_deltas_is_reassembled_by_index() {
        let mut acc = StreamAccumulator::new();
        acc.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"spawn_"}}]}}]}).to_string());
        acc.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"subagents","arguments":"{\"tasks\":"}}]}}]}).to_string());
        acc.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[]}"}}]}}]}).to_string());
        let turn = acc.finish();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].id, "c1");
        assert_eq!(turn.tool_calls[0].name, "spawn_subagents");
        assert_eq!(turn.tool_calls[0].arguments, "{\"tasks\":[]}");
    }

    #[test]
    fn parallel_tool_calls_are_kept_apart_by_index_and_ordered_by_it() {
        let mut acc = StreamAccumulator::new();
        acc.push(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":1,"id":"b","function":{"name":"second","arguments":"{}"}},
            {"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}
        ]}}]}).to_string());
        let turn = acc.finish();
        assert_eq!(turn.tool_calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
    }

    #[test]
    fn streamed_text_and_reasoning_accumulate_in_order() {
        let mut acc = StreamAccumulator::new();
        assert!(acc.push(&json!({"choices":[{"delta":{"reasoning_content":"think"}}]}).to_string()));
        assert!(acc.push(&json!({"choices":[{"delta":{"content":"Hel"}}]}).to_string()));
        assert!(acc.push(&json!({"choices":[{"delta":{"content":"lo"}}]}).to_string()));
        assert_eq!(acc.content(), "Hello");
        let turn = acc.finish();
        assert_eq!(turn.content, "Hello");
        assert_eq!(turn.reasoning, "think");
    }

    /// A keep-alive or a non-conforming frame must not lose the turn around it.
    #[test]
    fn an_unparseable_chunk_is_skipped_rather_than_fatal() {
        let mut acc = StreamAccumulator::new();
        acc.push(&json!({"choices":[{"delta":{"content":"a"}}]}).to_string());
        assert!(!acc.push("not json at all"));
        acc.push(&json!({"choices":[{"delta":{"content":"b"}}]}).to_string());
        assert_eq!(acc.finish().content, "ab");
    }

    #[test]
    fn usage_from_a_late_chunk_is_kept() {
        let mut acc = StreamAccumulator::new();
        acc.push(&json!({"choices":[{"delta":{"content":"x"}}]}).to_string());
        acc.push(&json!({"choices":[], "usage":{"prompt_tokens":7,"completion_tokens":3}}).to_string());
        let usage = acc.finish().usage.expect("usage");
        assert_eq!((usage.prompt_tokens, usage.completion_tokens), (7, 3));
    }

    /// A read can end mid-event, and the fragment has to survive to the next one.
    #[test]
    fn an_event_split_across_reads_is_carried_in_the_tail() {
        let (events, tail) = split_events("data: {\"a\":1}\n\ndata: {\"b\":");
        assert_eq!(events, vec!["{\"a\":1}"]);
        assert_eq!(tail, "data: {\"b\":");

        let (events, tail) = split_events(&format!("{tail}2}}\n\n"));
        assert_eq!(events, vec!["{\"b\":2}"]);
        assert_eq!(tail, "");
    }

    #[test]
    fn both_newline_conventions_separate_events() {
        let (events, _) = split_events("data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\n\n");
        assert_eq!(events, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn stripping_images_keeps_the_text_and_collapses_a_lone_part_to_a_string() {
        let m = Message::parts(
            "user",
            vec![
                json!({"type": "text", "text": "what is this"}),
                json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}),
            ],
        );
        assert!(m.has_images());
        let stripped = strip_images(&[m]);
        assert!(!stripped[0].has_images());
        assert_eq!(stripped[0].text(), "what is this");
    }

    #[test]
    fn stripping_images_leaves_a_plain_text_message_untouched() {
        let m = Message::user("no pictures here");
        let stripped = strip_images(std::slice::from_ref(&m));
        assert_eq!(stripped[0], m);
    }

    #[test]
    fn stripping_reasoning_removes_only_the_replayed_block() {
        let m = Message::assistant("the answer").with_reasoning("the thinking");
        let stripped = strip_reasoning(&[m]);
        assert_eq!(stripped[0].reasoning_content, None);
        assert_eq!(stripped[0].text(), "the answer");
    }

    #[test]
    fn a_streamed_body_asks_for_usage_which_providers_otherwise_omit() {
        let req = ModelRequest { model: "m".into(), ..Default::default() };
        let body = build_body(&req, true, &json!({}));
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);

        let body = build_body(&req, false, &json!({}));
        assert_eq!(body["stream"], false);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn thinking_parameters_are_spread_last_so_a_provider_spelling_wins() {
        let req = ModelRequest { model: "m".into(), ..Default::default() };
        let body = build_body(&req, false, &json!({ "reasoning_effort": "high", "model": "override" }));
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["model"], "override");
    }

    #[test]
    fn tools_are_omitted_entirely_when_there_are_none() {
        let req = ModelRequest { model: "m".into(), ..Default::default() };
        assert!(build_body(&req, false, &json!({})).get("tools").is_none());
    }
}
