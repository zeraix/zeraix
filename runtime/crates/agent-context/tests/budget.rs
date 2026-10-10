//! A working-set budget below the window: settled history is shed at the budget, not near the window.
//!
//! On a 1M-window model, compacting at a fraction of the WINDOW means never: 85% of 1M is 850K, so history
//! grew for as long as the conversation ran and nothing was summarised, whatever the user's context budget said.
//! The turn in progress is the exception, and answers to the window alone — see `tests/live_turn.rs`.

use agent_context::{Budget, ContextManager, WorkingSet};
use agent_loop::model::call;
use agent_loop::{ContextStrategy, Message};
use serde_json::json;

#[test]
fn the_budget_becomes_a_working_set_and_the_window_keeps_its_own_thresholds() {
    let b = Budget::with_thresholds(1_000_000, 120_000, 80_000);
    let window = Budget::with_window(1_000_000);
    assert_eq!(b.max_tokens, 1_000_000, "the model's limit is still the window");
    assert_eq!(b.working_set, Some(WorkingSet { trigger: 120_000, target: 80_000 }));
    // Only the window may cut the turn in progress, so its thresholds are the window's, not the budget's.
    assert_eq!(b.compact_threshold(), window.compact_threshold());
    assert_eq!(b.target_tokens(), window.target_tokens());
}

#[test]
fn values_a_host_should_never_send_are_made_safe() {
    let ws = |b: Budget| b.working_set.expect("a working set");
    // A trigger above the window's own threshold is that threshold: a budget cannot make compaction LATER.
    assert_eq!(ws(Budget::with_thresholds(100_000, 200_000, 50_000)).trigger, 85_000);
    // A target at or above the trigger would compact again every round; it keeps Default's proportion instead.
    let b = ws(Budget::with_thresholds(1_000_000, 120_000, 150_000));
    assert_eq!(b.trigger, 120_000);
    assert_eq!(b.target, (120_000_f64 * 0.6 / 0.85).round() as u64);
    // No trigger is no budget.
    assert_eq!(Budget::with_thresholds(1_000_000, 0, 0), Budget::with_window(1_000_000));
}

/// About 200K tokens of conversation: old tool output, then the current question.
fn long_conversation() -> Vec<Message> {
    let mut messages = vec![Message::system("You are helpful.")];
    for i in 0..10 {
        messages.push(Message::user(format!("step {i}")));
        messages.push(Message::assistant_calls("", vec![call(&format!("c{i}"), "read_file", json!({ "path": format!("f{i}.rs") }))]));
        messages.push(Message::tool_result(format!("c{i}"), "x".repeat(80_000)));
        messages.push(Message::assistant(format!("read f{i}")));
    }
    messages.push(Message::user("now summarise what you found"));
    messages
}

#[tokio::test]
async fn a_long_conversation_on_a_large_window_is_compacted_at_the_budget() {
    let conversation = long_conversation();

    let mut without = ContextManager::new(Budget::with_window(1_000_000));
    let (_, compacted) = without.prepare(&conversation).await;
    assert!(!compacted, "200K on a 1M window is under the window's own threshold");

    let mut with = ContextManager::new(Budget::with_thresholds(1_000_000, 120_000, 80_000));
    let (prepared, compacted) = with.prepare(&conversation).await;
    assert!(compacted, "200K is over a 120K budget");
    let size: u64 = prepared.iter().map(agent_context::estimate_message).sum();
    assert!(size <= 80_000, "compacted down to the target, got {size}");
    assert_eq!(prepared.last().map(|m| m.text()), Some("now summarise what you found"), "the question survives");
}
