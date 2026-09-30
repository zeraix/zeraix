//! Tests for `wire.rs`, kept out of the source file (declared there as `mod tests`).

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
fn a_cache_hit_is_read_in_either_spelling() {
    let deepseek: WireUsage = serde_json::from_value(json!({
        "prompt_tokens": 100, "completion_tokens": 5, "prompt_cache_hit_tokens": 80
    }))
    .unwrap();
    assert_eq!(deepseek.to_usage().cached_tokens, 80);
    let openai: WireUsage = serde_json::from_value(json!({
        "prompt_tokens": 100, "completion_tokens": 5, "prompt_tokens_details": { "cached_tokens": 64 }
    }))
    .unwrap();
    assert_eq!(openai.to_usage().cached_tokens, 64);
    let neither: WireUsage = serde_json::from_value(json!({ "prompt_tokens": 1, "completion_tokens": 1 })).unwrap();
    assert_eq!(neither.to_usage().cached_tokens, 0);
    assert!(!neither.to_usage().estimated, "a provider that reported usage was not estimated");
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

/// A read can also end mid-CHARACTER. Every split point inside `你好` must decode to the same text.
#[test]
fn a_character_split_across_reads_is_held_back_not_replaced() {
    let bytes = "a你好".as_bytes();
    for at in 0..=bytes.len() {
        let (mut pending, mut out) = (Vec::new(), String::new());
        decode_utf8_into(&mut pending, &bytes[..at], &mut out);
        decode_utf8_into(&mut pending, &bytes[at..], &mut out);
        assert_eq!(out, "a你好", "split at byte {at}");
        assert!(pending.is_empty());
    }
    // One byte per read, the worst case a relay can produce.
    let (mut pending, mut out) = (Vec::new(), String::new());
    for b in bytes {
        decode_utf8_into(&mut pending, std::slice::from_ref(b), &mut out);
    }
    assert_eq!(out, "a你好");
}

#[test]
fn a_byte_that_is_invalid_in_itself_still_decodes_as_a_replacement() {
    let (mut pending, mut out) = (Vec::new(), String::new());
    decode_utf8_into(&mut pending, b"a\xFFb", &mut out);
    assert_eq!(out, "a\u{FFFD}b");
    assert!(pending.is_empty());
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
    let body = build_body(&req, true, &json!({}), None);
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"]["include_usage"], true);

    let body = build_body(&req, false, &json!({}), None);
    assert_eq!(body["stream"], false);
    assert!(body.get("stream_options").is_none());
}

#[test]
fn thinking_parameters_are_spread_last_so_a_provider_spelling_wins() {
    let req = ModelRequest { model: "m".into(), ..Default::default() };
    let body = build_body(&req, false, &json!({ "reasoning_effort": "high", "model": "override" }), None);
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["model"], "override");
}

#[test]
fn tools_are_omitted_entirely_when_there_are_none() {
    let req = ModelRequest { model: "m".into(), ..Default::default() };
    assert!(build_body(&req, false, &json!({}), None).get("tools").is_none());
}
