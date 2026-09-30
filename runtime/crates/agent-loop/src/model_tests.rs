//! Tests for `model.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;
use serde_json::json;

#[test]
fn a_tool_call_is_written_in_the_shape_providers_accept() {
    let call = ToolCall { id: "c1".into(), name: "read_file".into(), arguments: r#"{"path":"a"}"#.into() };
    assert_eq!(
        serde_json::to_value(Message::assistant_calls("", vec![call.clone()])).unwrap()["tool_calls"],
        json!([{ "id": "c1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }])
    );
    // And read back as it was written, arguments byte for byte.
    let back: ToolCall = serde_json::from_value(serde_json::to_value(&call).unwrap()).unwrap();
    assert_eq!(back, call);
}

#[test]
fn a_tool_that_returned_nothing_still_carries_content() {
    assert_eq!(
        serde_json::to_value(Message::tool_result("c1", "")).unwrap(),
        json!({ "role": "tool", "content": "", "tool_call_id": "c1" })
    );
    // Read back from a stored transcript, where the field may be absent or null, it is written again.
    let stored: Message = serde_json::from_value(json!({ "role": "tool", "tool_call_id": "c1" })).unwrap();
    assert_eq!(serde_json::to_value(&stored).unwrap()["content"], "");
    assert_eq!(serde_json::to_value(Message::user("")).unwrap()["content"], "");
}

#[test]
fn an_assistant_turn_that_only_calls_tools_still_omits_content() {
    let v = serde_json::to_value(Message::assistant_calls("", vec![call("c1", "read_file", json!({}))])).unwrap();
    assert!(v.get("content").is_none(), "{v}");
}

/// Hand-written serialization must not move a byte of what was already being sent: the prompt prefix is
/// what a provider's cache keys on.
#[test]
fn serialization_is_byte_identical_to_the_derived_shape() {
    let m = Message::assistant_calls("text", vec![call("c1", "read_file", json!({ "path": "a" }))])
        .with_reasoning("why");
    assert_eq!(
        serde_json::to_string(&m).unwrap(),
        r#"{"role":"assistant","content":"text","tool_calls":[{"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}],"reasoning_content":"why"}"#
    );
    assert_eq!(
        serde_json::to_string(&Message::tool_result("c1", "out")).unwrap(),
        r#"{"role":"tool","content":"out","tool_call_id":"c1"}"#
    );
}

#[test]
fn a_tool_call_is_read_in_either_shape() {
    let open_ai: ToolCall = serde_json::from_value(json!({
        "id": "c1", "type": "function", "function": { "name": "grep", "arguments": "{ \"q\": 1 }" }
    }))
    .unwrap();
    // Unusual spacing survives: rewriting it would change the replayed prefix for nothing.
    assert_eq!(open_ai.arguments, "{ \"q\": 1 }");
    let flat: ToolCall = serde_json::from_value(json!({ "id": "c2", "name": "grep", "arguments": "{}" })).unwrap();
    assert_eq!((flat.id.as_str(), flat.name.as_str()), ("c2", "grep"));
    // An object where a string belongs, and no arguments at all: both readable.
    let object: ToolCall =
        serde_json::from_value(json!({ "id": "c3", "function": { "name": "grep", "arguments": { "q": 1 } } })).unwrap();
    assert_eq!(object.arguments, r#"{"q":1}"#);
    let bare: ToolCall = serde_json::from_value(json!({ "id": "c4", "function": { "name": "grep" } })).unwrap();
    assert_eq!(bare.arguments, "");
}

#[tokio::test]
async fn a_scripted_model_answers_in_order_and_records_what_it_was_asked() {
    let m = ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
        NormalizedTurn::text("done"),
    ]);
    let req = ModelRequest { model: "scripted".into(), ..Default::default() };

    let first = m.complete(&req).await.expect("first turn");
    assert_eq!(first.tool_calls.len(), 1);
    assert_eq!(first.tool_calls[0].name, "read_file");

    let second = m.complete(&req).await.expect("second turn");
    assert_eq!(second.content, "done");
    assert!(second.tool_calls.is_empty());

    assert_eq!(m.request_count(), 2);
}

/// A test that runs off the end of its own script has not described what it is testing.
#[tokio::test]
async fn an_exhausted_script_fails_rather_than_looking_like_a_model_that_stopped() {
    let m = ScriptedModel::new(vec![NormalizedTurn::text("only one")]);
    let req = ModelRequest::default();
    m.complete(&req).await.expect("scripted turn");
    let err = m.complete(&req).await.expect_err("must not answer past the script");
    assert_eq!(err.code, "model.script_exhausted");
}

#[tokio::test]
async fn a_scripted_provider_failure_surfaces_as_an_upstream_error() {
    let m = ScriptedModel::new(vec![]).then_fails("502 from the provider");
    let err = m.complete(&ModelRequest::default()).await.expect_err("scripted failure");
    assert_eq!(err.class, ErrorClass::Retryable);
    assert!(err.message.contains("502"));
}

#[test]
fn an_assistant_turn_carrying_tool_calls_keeps_its_text() {
    let m = Message::assistant_calls("I will read it", vec![call("c1", "read_file", json!({}))]);
    assert_eq!(m.role, "assistant");
    assert_eq!(m.text(), "I will read it");
    assert_eq!(m.tool_calls.len(), 1);
}

#[test]
fn a_tool_message_is_paired_with_the_call_it_answers() {
    let m = Message::tool_result("c1", "contents");
    assert_eq!(m.role, "tool");
    assert_eq!(m.tool_call_id.as_deref(), Some("c1"));
}
