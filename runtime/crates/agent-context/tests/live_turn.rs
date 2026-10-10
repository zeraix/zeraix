//! The turn in progress answers to the window, not to the working-set budget.
//!
//! What users saw with the budget on: a long turn on a 1M model crossed 120K, its own reads were stubbed oldest
//! first, and the model read them again — slower, costlier and less capable than with no budget at all. These
//! pin the split: the budget sheds settled history; only the window cuts the live turn; the results the model
//! has not yet seen go last; and a user's message is never shortened.

use agent_context::{Budget, ContextManager};
use agent_loop::model::call;
use agent_loop::{ContextStrategy, Message};
use serde_json::json;

/// What an elided result says. Matched loosely so the wording can change without this suite noticing.
const REMOVED: &str = "tool output removed";

fn read(id: &str) -> Message {
    Message::assistant_calls("", vec![call(id, "read_file", json!({ "path": format!("{id}.rs") }))])
}

/// A read's result of about `tokens` tokens (ASCII is four bytes a token), tagged with its id.
fn result(id: &str, tokens: usize) -> Message {
    Message::tool_result(id, format!("{id} {}", "x".repeat(tokens * 4)))
}

/// `n` rounds of one read each, ids `{prefix}0..`.
fn rounds(prefix: &str, n: usize, tokens: usize) -> Vec<Message> {
    (0..n)
        .flat_map(|i| {
            let id = format!("{prefix}{i}");
            [read(&id), result(&id, tokens)]
        })
        .collect()
}

fn sent<'a>(prepared: &'a [Message], id: &str) -> &'a str {
    prepared.iter().find(|m| m.tool_call_id.as_deref() == Some(id)).map(Message::text).expect("the result")
}

fn budget_120k() -> ContextManager {
    ContextManager::new(Budget::with_thresholds(1_000_000, 120_000, 80_000))
}

#[tokio::test]
async fn a_live_turn_larger_than_the_budget_is_left_whole() {
    let mut conversation = vec![Message::system("You are helpful."), Message::user("fix the bug")];
    conversation.extend(rounds("live", 10, 20_000)); // ~200K, all of it this turn's

    let mut m = budget_120k();
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(!compacted, "nothing was changed, so nothing may be reported as a compaction");
    for i in 0..10 {
        assert!(sent(&prepared, &format!("live{i}")).starts_with(&format!("live{i} ")), "live{i} was cut");
    }
}

#[tokio::test]
async fn the_budget_sheds_settled_history_and_never_the_turn_in_progress() {
    let mut conversation = vec![Message::system("You are helpful."), Message::user("look around")];
    conversation.extend(rounds("old", 5, 20_000)); // ~100K settled
    conversation.push(Message::assistant("looked"));
    conversation.push(Message::user("now fix it"));
    conversation.extend(rounds("live", 7, 20_000)); // ~140K live: over the budget on its own

    let mut m = budget_120k();
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    for i in 0..5 {
        assert!(sent(&prepared, &format!("old{i}")).contains(REMOVED), "old{i} is settled and should be shed");
    }
    for i in 0..7 {
        assert!(sent(&prepared, &format!("live{i}")).starts_with(&format!("live{i} ")), "live{i} was cut");
    }

    // Still over the budget — the live turn is — but there is nothing settled left to give.
    let (_, again) = m.prepare(&conversation).await;
    assert!(!again, "a round that changed nothing is not a compaction");
}

/// A user message the host injects mid-run must not move the boundary and expose the turn's earlier work.
#[tokio::test]
async fn the_turn_start_is_pinned_when_a_user_message_arrives_mid_run() {
    let mut conversation = vec![Message::user("earlier")];
    conversation.extend(rounds("old", 2, 20_000));
    conversation.push(Message::user("the task"));
    conversation.extend(rounds("live", 2, 20_000));

    let mut m = budget_120k();
    let (_, compacted) = m.prepare(&conversation).await;
    assert!(!compacted, "~80K is under the budget");

    conversation.push(Message::user("also check the tests"));
    conversation.extend(rounds("more", 3, 20_000)); // ~140K now
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    assert!(sent(&prepared, "old0").contains(REMOVED));
    for id in ["live0", "live1", "more0", "more1", "more2"] {
        assert!(sent(&prepared, id).starts_with(&format!("{id} ")), "{id} belongs to the turn in progress");
    }
}

#[tokio::test]
async fn the_window_still_cuts_the_live_turn_oldest_first() {
    let mut conversation = vec![Message::user("go")];
    conversation.extend(rounds("live", 5, 20_000)); // ~100K against a 100K window: over its 85K threshold

    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    assert!(sent(&prepared, "live0").contains(REMOVED), "the oldest of the turn's results goes first");
    assert!(sent(&prepared, "live4").starts_with("live4 "), "the result the model has not seen yet stays");
    let size: u64 = prepared.iter().map(agent_context::estimate_message).sum();
    assert!(size <= 60_000, "down to the window's target, got {size}");
}

/// Over the threshold but inside the window: the model gets what it just asked for, whatever else goes.
#[tokio::test]
async fn the_unseen_batch_survives_while_it_fits_the_window() {
    let mut conversation = vec![Message::user("go")];
    conversation.extend(rounds("live", 1, 10_000));
    conversation.extend(rounds("big", 1, 80_000)); // ~90K: over 85K, under 100K

    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, _) = m.prepare(&conversation).await;

    assert!(sent(&prepared, "live0").contains(REMOVED));
    assert!(sent(&prepared, "big0").starts_with("big0 "), "stubbing what was just asked for is how a run loops");
}

#[tokio::test]
async fn the_unseen_batch_goes_only_when_the_request_would_not_fit() {
    let mut conversation = vec![Message::user("go")];
    conversation.extend(rounds("live", 1, 20_000));
    conversation.push(Message::assistant_calls(
        "",
        vec![
            call("a", "read_file", json!({ "path": "a.rs" })),
            call("b", "read_file", json!({ "path": "b.rs" })),
        ],
    ));
    conversation.push(result("a", 55_000));
    conversation.push(result("b", 55_000)); // the unseen batch alone is ~110K against a 100K window

    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, _) = m.prepare(&conversation).await;

    assert!(sent(&prepared, "live0").contains(REMOVED), "everything else goes before the unseen batch");
    assert!(sent(&prepared, "a").contains(REMOVED), "the oldest of the batch, once nothing else is left");
    assert!(sent(&prepared, "b").starts_with("b "), "and no more of it than the window needs");
}

#[tokio::test]
async fn user_messages_stay_whole_while_assistant_prose_gives() {
    let request = format!("Please do exactly this: {}", "constraint ".repeat(1_100)); // ~3K tokens
    let conversation = vec![
        Message::user(request.clone()),
        Message::assistant("y".repeat(16_000)),
        Message::assistant("z".repeat(16_000)),
        Message::user("continue"),
    ];

    let mut m = ContextManager::new(Budget::with_window(10_000));
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    assert_eq!(prepared[0].text(), request, "the request was cut");
    assert_eq!(prepared[3].text(), "continue");
    assert!(prepared[1].text().len() < 16_000, "assistant prose is what gives");
}

/// When nothing else is left, an earlier request may be cut so the run can go on — the turn's own never.
#[tokio::test]
async fn the_turns_own_request_survives_even_when_the_request_would_not_fit() {
    let task = format!("Now refactor it: {}", "requirement ".repeat(150)); // ~460 tokens
    let conversation = vec![
        Message::user(format!("Earlier, a pasted log: {}", "line ".repeat(3_200))), // ~4K tokens
        Message::assistant("noted"),
        Message::user(task.clone()),
    ];

    let mut m = ContextManager::new(Budget::with_window(2_000));
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    assert!(prepared[0].text().len() < 16_000, "the settled request gives, so the run can continue");
    assert_eq!(prepared[2].text(), task, "the turn's own request was cut");
}

/// Over the window at the start, but shedding settled history is enough: the turn in progress is not touched.
#[tokio::test]
async fn shedding_settled_history_that_suffices_leaves_the_live_turn_alone() {
    let mut conversation = vec![Message::user("earlier")];
    conversation.extend(rounds("old", 1, 18_000));
    conversation.push(Message::assistant("ok"));
    conversation.push(Message::user("now this"));
    conversation.extend(rounds("live", 2, 35_000)); // ~88K in all: over 85K, under it once `old0` goes

    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted);
    assert!(sent(&prepared, "old0").contains(REMOVED));
    assert!(sent(&prepared, "live0").starts_with("live0 "), "~70K after the settled phase is under the threshold");
}

/// The emergency steps cut to the threshold — room to fit and to answer — not to the target.
#[tokio::test]
async fn the_unseen_batch_gives_up_only_what_the_window_needs() {
    let calls: Vec<_> = (0..4).map(|i| call(&format!("b{i}"), "read_file", json!({ "path": format!("b{i}.rs") }))).collect();
    let mut conversation = vec![Message::user("read all four"), Message::assistant_calls("", calls)];
    conversation.extend((0..4).map(|i| result(&format!("b{i}"), 28_000))); // ~112K, all of it unseen

    let mut m = ContextManager::new(Budget::with_window(100_000));
    let (prepared, _) = m.prepare(&conversation).await;

    let stubbed = (0..4).filter(|i| sent(&prepared, &format!("b{i}")).contains(REMOVED)).count();
    assert_eq!(stubbed, 1, "one result brings ~112K under 85K; a second would only serve the 60K target");
}

/// A message the host appends behind the results (an automation's final-round instruction) does not hide them.
#[tokio::test]
async fn the_unseen_batch_is_found_behind_a_message_the_host_appended() {
    let mut conversation = vec![Message::user("go")];
    conversation.extend(rounds("l", 1, 10_000));
    let mut m = ContextManager::new(Budget::with_window(100_000));
    m.prepare(&conversation).await;

    conversation.extend(rounds("big", 1, 80_000));
    conversation.push(Message::user("This is the final round: answer now."));
    let (prepared, _) = m.prepare(&conversation).await;

    assert!(sent(&prepared, "l0").contains(REMOVED), "the seen result goes first");
    assert!(sent(&prepared, "big0").starts_with("big0 "), "the result the model has not seen yet stays");
}

