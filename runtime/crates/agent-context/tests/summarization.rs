//! Summarising a conversation that no longer fits.
//!
//! The techniques either side of it — eliding tool output, truncating prose — are deterministic and are
//! covered by the unit tests in the crate. This file covers the one that needs a model, and it covers the
//! properties that are easy to lose and hard to notice afterwards: that the tail a run is actually working on
//! stays verbatim, that folding a span cannot orphan a tool result, and that a summary is never built from an
//! earlier summary.

use std::sync::Arc;

use agent_context::{Budget, ContextManager, Summarizer};
use agent_loop::{ContextStrategy, Message, ModelClient, NormalizedTurn, ScriptedModel, ToolCall};

/// A conversation over budget: a long head, then four short user turns to keep.
fn long_conversation() -> Vec<Message> {
    let mut messages = vec![Message::system("be helpful")];
    for i in 0..6 {
        messages.push(Message::user(format!("old question {i}: {}", "detail ".repeat(200))));
        messages.push(Message::assistant(format!("old answer {i}: {}", "because ".repeat(200))));
    }
    for i in 0..4 {
        messages.push(Message::user(format!("recent question {i}")));
        messages.push(Message::assistant(format!("recent answer {i}")));
    }
    messages
}

fn summarizer(text: &str) -> (Arc<ScriptedModel>, Summarizer) {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text(text)]));
    let s = Summarizer::new(Arc::clone(&model) as Arc<dyn ModelClient>, "summary-model");
    (model, s)
}

/// The tight budget that forces compaction. Deliberately small: the point is to reach the threshold
/// deterministically, not to model a real window.
fn tight() -> Budget {
    Budget { max_tokens: 800, compact_at: 0.75, target: 0.5 }
}

#[tokio::test]
async fn the_head_is_summarised_and_the_recent_turns_are_kept_verbatim() {
    let (model, s) = summarizer("The user asked six earlier questions; all were answered.");
    let mut m = ContextManager::new(tight()).with_summarizer(s);

    let before = long_conversation();
    let (wire, compacted) = m.prepare(&before).await;

    assert!(compacted, "a conversation this far over budget must compact");
    assert_eq!(model.request_count(), 1, "exactly one summariser call");

    let texts: Vec<&str> = wire.iter().map(Message::text).collect();
    assert!(
        texts.iter().any(|t| t.contains("The user asked six earlier questions")),
        "the summary must reach the wire: {texts:?}"
    );
    // The tail a run is working on is the thing it must not forget.
    for i in 0..4 {
        assert!(
            texts.iter().any(|t| *t == format!("recent question {i}")),
            "recent turn {i} must survive verbatim: {texts:?}"
        );
    }
    // The folded originals are gone from the wire...
    assert!(
        !texts.iter().any(|t| t.starts_with("old question 0")),
        "a folded message must not also be sent"
    );
    // ...but still held, which is what lets a later compaction re-read them.
    assert!(
        m.items().iter().any(|i| i.summarized && i.message.text().starts_with("old question 0")),
        "the original must be kept, flagged rather than discarded"
    );
    assert!(m.tokens() < 800, "compaction must actually get under the window: {}", m.tokens());
}

/// A provider rejects a `tool` message with no matching `tool_calls`, so a fold that splits a tool group is a
/// 400 rather than a smaller request. The boundary has to move rather than cut.
#[tokio::test]
async fn folding_never_orphans_a_tool_result() {
    let (_model, s) = summarizer("Earlier work, summarised.");
    let mut m = ContextManager::new(tight()).with_summarizer(s);

    let mut messages = vec![Message::system("be helpful")];
    for i in 0..6 {
        messages.push(Message::user(format!("q{i} {}", "padding ".repeat(200))));
        messages.push(Message::assistant_calls(
            String::new(),
            vec![ToolCall { id: format!("c{i}"), name: "read_file".into(), arguments: "{}".into() }],
        ));
        messages.push(Message::tool_result(format!("c{i}"), format!("file {i} {}", "x".repeat(400))));
    }
    // The tail: four user turns, the first of which follows a tool group.
    for i in 0..4 {
        messages.push(Message::user(format!("recent {i}")));
    }

    let (wire, compacted) = m.prepare(&messages).await;
    // Without this the orphan check below passes vacuously on a conversation that was never folded.
    assert!(compacted, "the fixture must actually reach the threshold");
    assert!(
        m.items().iter().any(|i| i.summarized),
        "the fixture must actually fold something, or this asserts nothing"
    );

    let call_ids: Vec<String> = wire
        .iter()
        .flat_map(|msg| msg.tool_calls.iter().map(|c| c.id.clone()))
        .collect();
    for msg in wire.iter().filter(|m| m.role == "tool") {
        let id = msg.tool_call_id.clone().unwrap_or_default();
        assert!(
            call_ids.contains(&id),
            "tool result {id} was sent with no matching tool_calls — the provider would reject this"
        );
    }
}

/// The property that makes re-summarising safe: the second summary is built from the ORIGINALS, never from
/// the first summary. A summary of a summary drifts further from the truth every round, invisibly.
#[tokio::test]
async fn a_second_summary_is_built_from_the_originals_not_the_first_summary() {
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::text("FIRST-SUMMARY"),
        NormalizedTurn::text("SECOND-SUMMARY"),
    ]));
    let s = Summarizer::new(Arc::clone(&model) as Arc<dyn ModelClient>, "summary-model");
    let mut m = ContextManager::new(tight()).with_summarizer(s);

    let mut messages = long_conversation();
    m.prepare(&messages).await;

    // The conversation grows, pushing it over the threshold again.
    for i in 0..4 {
        messages.push(Message::user(format!("later question {i}: {}", "more ".repeat(300))));
        messages.push(Message::assistant(format!("later answer {i}")));
    }
    m.prepare(&messages).await;

    assert_eq!(model.request_count(), 2, "the second compaction must ask again");
    let second = &model.requests()[1];
    let source = second.messages.last().expect("the span").text().to_owned();
    assert!(
        source.contains("old question 0"),
        "the second summary must read the originals: {}",
        &source[..source.len().min(200)]
    );
    assert!(
        !source.contains("FIRST-SUMMARY"),
        "the second summary must not be a summary of a summary"
    );
}

/// A summariser that fails is not a run that fails: the caller falls through to truncation, which is worse
/// but always available.
#[tokio::test]
async fn a_failing_summariser_falls_back_to_compression() {
    let model = Arc::new(ScriptedModel::new(Vec::new()).then_fails("summariser is down"));
    let s = Summarizer::new(Arc::clone(&model) as Arc<dyn ModelClient>, "summary-model");
    let mut m = ContextManager::new(tight()).with_summarizer(s);

    let before = long_conversation();
    let (wire, compacted) = m.prepare(&before).await;

    assert_eq!(model.request_count(), 1, "the summariser must have been reached, and failed");
    assert!(compacted, "the run must still get under budget");
    assert!(m.summary().is_none(), "no summary was produced");
    assert!(!wire.is_empty());
    assert!(m.tokens() < 800, "truncation must still bring it under: {}", m.tokens());
}

/// The default is unchanged. A manager with no summariser must behave exactly as it did before this existed.
#[tokio::test]
async fn without_a_summariser_nothing_calls_a_model() {
    let mut m = ContextManager::new(tight());
    let (wire, compacted) = m.prepare(&long_conversation()).await;
    assert!(compacted);
    assert!(m.summary().is_none());
    assert!(
        wire.iter().all(|msg| !msg.text().contains("Summary of the earlier part")),
        "no summary may appear when none was configured"
    );
}
