//! A removed result names the way back to it, when the host has one.
//!
//! "Re-run the call" is the wrong advice for a command with side effects, and costs a round trip and possibly a
//! different answer for everything else. The chat host keeps every result and returns one by id; these pin that the
//! runtime says so, and that it still says "re-run" for a host that cannot.

use agent_context::{Budget, ContextManager};
use agent_loop::model::call;
use agent_loop::{ContextStrategy, Message};
use serde_json::json;

const HINT: &str = r#"recall it with call_tool {"name": "recall_tool_result", "arguments": {"id": "{id}"}}"#;

/// `n` commands of ~20K tokens of output each, ids `call_{from}..`.
fn commands(from: usize, n: usize) -> Vec<Message> {
    (from..from + n)
        .flat_map(|i| {
            let id = format!("call_{i}");
            [
                Message::assistant_calls("", vec![call(&id, "run_command", json!({ "command": format!("step {i}") }))]),
                Message::tool_result(id, "x".repeat(80_000)),
            ]
        })
        .collect()
}

/// A turn the window forces to give up its oldest output: ~100K against a 100K window.
fn over_the_window() -> Vec<Message> {
    let mut messages = vec![Message::user("go")];
    messages.extend(commands(0, 5));
    messages
}

fn result<'a>(prepared: &'a [Message], id: &str) -> &'a str {
    prepared.iter().find(|m| m.tool_call_id.as_deref() == Some(id)).map(Message::text).expect("the result")
}

#[tokio::test]
async fn an_elided_result_names_its_id_and_the_call_that_recalls_it() {
    let mut m = ContextManager::new(Budget::with_window(100_000)).with_elision_hint(HINT);
    let (prepared, compacted) = m.prepare(&over_the_window()).await;

    assert!(compacted);
    let stub = result(&prepared, "call_0");
    assert!(stub.starts_with("[tool output removed to make room"), "still reads as a removal: {stub}");
    assert!(stub.contains(r#""arguments": {"id": "call_0"}"#), "the stub must name this result's id: {stub}");
    assert!(!stub.contains("{id}"), "the placeholder must be filled in: {stub}");
    assert!(!stub.contains("re-run the call"), "the host's way back replaces the default advice: {stub}");
}

#[tokio::test]
async fn without_a_hint_the_runtime_keeps_its_own_wording() {
    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, _) = m.prepare(&over_the_window()).await;
    assert!(result(&prepared, "call_0").contains("re-run the call"));
}

/// A stub carrying a hint is still a stub: a later compaction passes over it rather than "eliding" it again.
#[tokio::test]
async fn a_hinted_stub_is_never_elided_again() {
    let stubs = |m: &ContextManager| {
        m.items().iter().filter(|i| i.message.text().starts_with("[tool output removed to make room")).count()
    };
    let mut m = ContextManager::new(Budget::with_window(100_000)).with_elision_hint(HINT);
    let mut conversation = over_the_window();
    m.sync_from(&conversation);
    m.compact().await;
    let before = stubs(&m);
    assert!(before > 0, "the fixture must elide something the first time");

    conversation.extend(commands(5, 3));
    m.sync_from(&conversation);
    let second = m.compact().await;

    assert!(second.ran, "the fixture must be over the window again");
    assert_eq!(second.elided, stubs(&m) - before, "only new output may be elided; an existing stub was elided again");
}

/// The host's own notes for a result it already reduced say what the call was and how to get at it. Replacing one
/// with the runtime's stub would say less and save nothing.
#[tokio::test]
async fn the_hosts_own_notes_are_not_stubbed_again() {
    let released = format!(
        "<context-compressed kind=\"released-result\">\nThis call belongs to a task that has since completed. It was: \
         run_command npm test. {}\n</context-compressed>",
        "To see what it returned, recall it. ".repeat(20)
    );
    let withheld = format!("[tool result withheld: read_file big.log returned 90,000 lines. {}]", "Page it. ".repeat(60));
    let mut conversation = vec![Message::user("earlier")];
    conversation.push(Message::assistant_calls("", vec![call("r0", "run_command", json!({ "command": "npm test" }))]));
    conversation.push(Message::tool_result("r0", released.clone()));
    conversation.push(Message::assistant_calls("", vec![call("w0", "read_file", json!({ "path": "big.log" }))]));
    conversation.push(Message::tool_result("w0", withheld.clone()));
    conversation.push(Message::assistant("noted"));
    conversation.push(Message::user("now"));
    conversation.extend(commands(0, 5)); // ~100K of this turn's own output

    let mut m = ContextManager::new(Budget::with_window(100_000)).with_elision_hint(HINT);
    let (prepared, _) = m.prepare(&conversation).await;

    assert_eq!(result(&prepared, "r0"), released);
    assert_eq!(result(&prepared, "w0"), withheld);
}

/// A result shorter than the stub that would replace it is left as it is: stubbing it would grow the request.
#[tokio::test]
async fn a_result_smaller_than_its_stub_is_left_alone() {
    let mut conversation = vec![Message::user("go")];
    conversation.push(Message::assistant_calls("", vec![call("tiny", "run_command", json!({ "command": "true" }))]));
    conversation.push(Message::tool_result("tiny", "ok"));
    conversation.extend(commands(0, 5));

    let mut m = ContextManager::new(Budget::with_window(100_000)).with_elision_hint(HINT);
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted, "the fixture must compact");
    assert_eq!(result(&prepared, "tiny"), "ok");
}

