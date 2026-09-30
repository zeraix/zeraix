//! `tests` for `lib.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;

fn long(n: usize) -> String {
    "x".repeat(n)
}

fn manager(window: u64) -> ContextManager {
    ContextManager::new(Budget { max_tokens: window, compact_at: 0.85, target: 0.6 })
}

#[test]
fn an_empty_context_needs_no_compaction() {
    let m = manager(1000);
    assert!(!m.needs_compaction());
    assert!(m.wire().is_empty());
}

#[tokio::test]
async fn compaction_does_not_run_below_the_threshold() {
    let mut m = manager(1000);
    m.push(Message::user(long(400)), Tier::Normal); // ~100 tokens
    let report = m.compact().await;
    assert!(!report.ran);
    assert_eq!(report.tokens_before, report.tokens_after);
}

#[tokio::test]
async fn tool_output_is_elided_before_the_conversation_is_touched() {
    let mut m = manager(1000);
    m.push(Message::user(long(400)), Tier::Normal);
    m.push(Message::tool_result("c1", long(4000)), Tier::Ephemeral);
    assert!(m.needs_compaction());

    let report = m.compact().await;
    assert!(report.ran);
    assert_eq!(report.elided, 1);
    assert_eq!(report.compressed, 0, "the conversation should not have been touched");
    assert!(report.tokens_after < report.tokens_before);
}

/// Deleting a tool message would make the request invalid; the stub is what keeps it well-formed.
#[tokio::test]
async fn an_elided_tool_result_is_still_present_and_still_paired() {
    let mut m = manager(1000);
    m.push(Message::assistant_calls("", vec![agent_loop::model::call("c1", "read_file", serde_json::json!({}))]), Tier::Normal);
    m.push(Message::tool_result("c1", long(8000)), Tier::Ephemeral);
    m.compact().await;

    let wire = m.wire();
    let tool = wire.iter().find(|msg| msg.role == "tool").expect("the tool message must survive");
    assert_eq!(tool.tool_call_id.as_deref(), Some("c1"), "the pairing must survive");
    assert!(tool.text().contains("re-run the call"), "the model should be told it can redo the work");
}

#[tokio::test]
async fn the_conversation_is_compressed_only_when_eliding_was_not_enough() {
    let mut m = manager(1000);
    for _ in 0..8 {
        m.push(Message::assistant(long(2000)), Tier::Normal);
    }
    let report = m.compact().await;
    assert!(report.ran);
    assert_eq!(report.elided, 0, "there was nothing ephemeral to elide");
    assert!(report.compressed > 0);
    assert!(report.tokens_after < report.tokens_before);
}

/// §8.3's requirement, and the reason task memory lives outside the conversation.
#[tokio::test]
async fn task_state_survives_a_compaction_that_removes_everything_removable() {
    let mut m = manager(600);
    {
        let memory = m.memory_mut();
        memory.user_goal = Some("migrate the runtime to Rust".into());
        memory.set_plan("finish the context crate, then wire it");
        memory.set_phase("executing");
        memory.add_pending("wire the compaction into the loop");
        memory.complete("build the tier model");
        memory.record_decision("task memory lives outside the conversation");
        memory.add_constraint("never lose the user's goal");
    }
    for _ in 0..10 {
        m.push(Message::tool_result("c", long(4000)), Tier::Ephemeral);
        m.push(Message::assistant(long(4000)), Tier::Normal);
    }

    let report = m.compact().await;
    assert!(report.ran);

    let wire = m.wire();
    let rendered = wire[0].text().to_owned();
    for expected in [
        "migrate the runtime to Rust",
        "finish the context crate",
        "executing",
        "wire the compaction into the loop",
        "build the tier model",
        "task memory lives outside the conversation",
        "never lose the user's goal",
    ] {
        assert!(rendered.contains(expected), "compaction lost {expected:?}:\n{rendered}");
    }
}

#[tokio::test]
async fn nothing_important_is_ever_touched() {
    let mut m = manager(500);
    m.push(Message::system(long(2000)), Tier::Critical);
    m.push(Message::assistant(long(2000)), Tier::High);
    m.push(Message::tool_result("c", long(4000)), Tier::Ephemeral);

    let critical_before = m.items()[0].message.clone();
    let high_before = m.items()[1].message.clone();
    m.compact().await;

    assert_eq!(m.items()[0].message, critical_before, "a critical item was modified");
    assert_eq!(m.items()[1].message, high_before, "a high item was modified");
}

/// Everything removable is gone and it is still not enough — reported, not hidden.
#[tokio::test]
async fn a_context_that_cannot_be_brought_under_budget_says_so() {
    let mut m = manager(200);
    m.push(Message::system(long(40_000)), Tier::Critical);
    let report = m.compact().await;
    assert!(report.ran);
    assert!(report.still_over_budget, "an impossible budget must be reported, not silently accepted");
}

/// One compaction should buy several rounds, or a long task thrashes.
#[tokio::test]
async fn compaction_comes_down_well_below_the_threshold_it_fired_at() {
    let mut m = manager(2000);
    for _ in 0..12 {
        m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
    }
    let report = m.compact().await;
    assert!(report.ran);
    assert!(
        report.tokens_after <= m.budget.target_tokens(),
        "came down to {} but the target is {}",
        report.tokens_after,
        m.budget.target_tokens()
    );
    assert!(!m.needs_compaction(), "compacting again immediately is thrashing");
}

/// The prefix a provider can cache has to be at the front, and stable.
#[test]
fn task_memory_is_rendered_at_the_front_of_the_wire() {
    let mut m = manager(1000);
    m.memory_mut().user_goal = Some("the goal".into());
    m.push(Message::user("hello"), Tier::Normal);
    let wire = m.wire();
    assert_eq!(wire[0].role, "system");
    assert!(wire[0].text().contains("the goal"));
    assert_eq!(wire[1].text(), "hello");
}

#[test]
fn an_absent_task_memory_adds_no_message_at_all() {
    let mut m = manager(1000);
    m.push(Message::user("hello"), Tier::Normal);
    let wire = m.wire();
    assert_eq!(wire.len(), 1);
    assert_eq!(wire[0].role, "user");
}

#[tokio::test]
async fn a_second_compaction_does_not_re_elide_what_is_already_a_stub() {
    let mut m = manager(1000);
    for _ in 0..6 {
        m.push(Message::tool_result("c", long(2000)), Tier::Ephemeral);
    }
    let first = m.compact().await;
    let second = m.compact().await;
    assert!(first.elided > 0);
    assert_eq!(second.elided, 0, "a stub must not be elided again");
}

#[test]
fn the_estimate_counts_tool_calls_and_reasoning_not_only_content() {
    let plain = estimate_message(&Message::assistant(long(400)));
    let with_calls = estimate_message(&Message::assistant_calls(
        long(400),
        vec![agent_loop::model::call("c1", "read_file", serde_json::json!({ "path": long(400) }))],
    ));
    let with_reasoning = estimate_message(&Message::assistant(long(400)).with_reasoning(long(400)));
    assert!(with_calls > plain);
    assert!(with_reasoning > plain);
}

#[test]
fn the_budget_leaves_headroom_for_the_reply() {
    let b = Budget::with_window(1000);
    assert!(b.compact_threshold() < b.max_tokens);
    assert!(b.target_tokens() < b.compact_threshold());
}
