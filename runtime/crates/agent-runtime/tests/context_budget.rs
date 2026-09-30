//! `agent.run` holds a turn to the host's working-set budget, not only to the model's window.
//!
//! The host compacts between turns at the user's budget; the runtime runs every round after a turn's first, and
//! compacted only near the WINDOW. On a 1M model that is 850K, so a long turn grew for as long as it ran.

mod common;

use common::*;

/// A conversation of about 50K tokens: two old tool results, then the current question.
fn history() -> serde_json::Value {
    let big = "x".repeat(100_000);
    serde_json::json!([
        { "role": "user", "content": "look at both files" },
        { "role": "assistant", "content": "", "tool_calls": [
            { "id": "c1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" } },
            { "id": "c2", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"b.rs\"}" } }
        ] },
        { "role": "tool", "tool_call_id": "c1", "content": big },
        { "role": "tool", "tool_call_id": "c2", "content": big },
        { "role": "assistant", "content": "read both" },
        { "role": "user", "content": "what did they have in common?" }
    ])
}

/// Run one turn over `history()` on a 1M window, with or without a budget, and return the first request body.
fn first_request(budget: Option<serde_json::Value>) -> String {
    let (endpoint, seen) = recording_provider(vec![assistant_text("they both hold x")]);
    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "budget-run", history());
    params["context_window"] = serde_json::json!(1_000_000);
    if let Some(b) = budget {
        params["context_budget"] = b;
    }
    let (reply, _) = run_collecting(&mut rt, params);
    assert_eq!(reply["result"]["stop_reason"], "completed", "{reply}");
    let bodies = seen.lock().expect("seen");
    bodies.first().cloned().expect("one request")
}

#[test]
fn a_turn_over_the_budget_is_compacted_before_it_is_sent() {
    let body = first_request(Some(serde_json::json!({ "trigger_tokens": 20_000, "target_tokens": 10_000 })));
    assert!(body.contains("tool output removed"), "the old tool output should have been elided");
    assert!(body.len() < 100_000, "the request should be far smaller than the 200K characters supplied: {}", body.len());
    assert!(body.contains("what did they have in common?"), "the current question survives");
}

#[test]
fn without_a_budget_the_same_turn_is_sent_whole_on_a_large_window() {
    let body = first_request(None);
    assert!(!body.contains("tool output removed"));
    assert!(body.len() > 200_000, "{}", body.len());
}
