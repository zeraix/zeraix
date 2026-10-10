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
use serde_json::json;

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
    Budget { max_tokens: 800, compact_at: 0.75, target: 0.5, working_set: None }
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
    // Roomier than `tight()`, and with recent answers worth folding: the second compaction has to have a span a
    // summary can actually shrink, or it is right not to ask (see `a_span_too_small_to_shrink_is_not_sent`).
    let mut m = ContextManager::new(Budget { max_tokens: 3_000, compact_at: 0.75, target: 0.5, working_set: None })
        .with_summarizer(s);

    let mut messages = long_conversation();
    for msg in messages.iter_mut().filter(|msg| msg.text().starts_with("recent answer")) {
        *msg = Message::assistant(format!("{} {}", msg.text(), "because ".repeat(100)));
    }
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

// ---- What the summariser is shown, and what it is asked for -------------------------------------------------

/// The brief and the source the summariser was sent.
fn sent_to(model: &ScriptedModel) -> (String, String) {
    let request = model.requests().first().cloned().expect("the summariser was asked");
    let brief = request.messages.first().map(|m| m.text().to_owned()).unwrap_or_default();
    let source = request.messages.last().map(|m| m.text().to_owned()).unwrap_or_default();
    (brief, source)
}

/// Four short user turns to keep verbatim, so everything before them is foldable.
fn recent_turns() -> Vec<Message> {
    (0..4)
        .flat_map(|i| [Message::user(format!("recent question {i}")), Message::assistant(format!("recent answer {i}"))])
        .collect()
}

/// A budget the fixtures below cross while staying far inside the window, so a summary is asked for and the
/// summariser's own request has room for a verbatim transcript.
fn working_set() -> Budget {
    Budget::with_thresholds(100_000, 10_000, 6_000)
}

fn read_call(id: &str, path: &str) -> Message {
    Message::assistant_calls(
        String::new(),
        vec![ToolCall { id: id.into(), name: "read_file".into(), arguments: json!({ "path": path }).to_string() }],
    )
}

#[tokio::test]
async fn the_summariser_reads_whole_messages_under_the_chat_summarisers_brief() {
    let (model, s) = summarizer("A faithful summary.");
    let mut m = ContextManager::new(working_set()).with_summarizer(s);
    let mut messages = vec![Message::system("be helpful")];
    for i in 0..5 {
        // ~1,400 tokens each, the marker at the end — past the 400 tokens each message used to be cut to.
        messages.push(Message::user(format!("old question {i}: {} END-OF-QUESTION-{i}", "detail ".repeat(800))));
        messages.push(Message::assistant(format!("old answer {i}: {}", "because ".repeat(800))));
    }
    messages.extend(recent_turns());

    let (_, compacted) = m.prepare(&messages).await;
    assert!(compacted);

    let (brief, source) = sent_to(&model);
    for i in 0..5 {
        assert!(source.contains(&format!("END-OF-QUESTION-{i}")), "question {i} reached the summariser cut short");
    }
    assert!(brief.contains("key analysis findings"), "the brief is the chat summariser's: {brief}");
    assert!(brief.contains("Aim for at most about"), "with a length to aim for: {brief}");
    assert!(!brief.contains("under 400 words"));
}

/// Eliding runs before summarising. The summary must still be built from what the tool returned.
#[tokio::test]
async fn the_summariser_reads_what_a_tool_returned_not_the_stub_that_replaced_it() {
    let (model, s) = summarizer("The crash was a null deref in parse().");
    let mut m = ContextManager::new(working_set()).with_summarizer(s);
    let mut messages = vec![Message::system("be helpful"), Message::user("investigate the crash")];
    messages.push(read_call("c0", "crash.log"));
    messages.push(Message::tool_result("c0", format!("FINDING-42: null deref in parse() {}", "log line ".repeat(3_000))));
    messages.push(Message::assistant("found the cause"));
    for i in 0..4 {
        messages.push(Message::user(format!("follow-up {i}: {}", "context ".repeat(1_000))));
        messages.push(Message::assistant("ok"));
    }
    messages.extend(recent_turns());

    m.prepare(&messages).await;

    assert_eq!(model.request_count(), 1, "eliding alone must not have been enough, or nothing was summarised");
    let (_, source) = sent_to(&model);
    assert!(source.contains("FINDING-42"), "the finding the brief asks for never reached the summariser");
    assert!(!source.contains("tool output removed"), "the summariser was shown the stub");
}

#[tokio::test]
async fn a_turn_with_an_image_keeps_its_question_in_the_transcript() {
    let (model, s) = summarizer("The user asked about a red button.");
    let mut m = ContextManager::new(working_set()).with_summarizer(s);
    let mut messages = vec![
        Message::system("be helpful"),
        Message::parts(
            "user",
            vec![
                json!({ "type": "text", "text": "WHY-IS-THIS-BUTTON-RED?" }),
                json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }),
            ],
        ),
        Message::assistant(format!("because {}", "reason ".repeat(6_000))),
    ];
    messages.extend(recent_turns());

    m.prepare(&messages).await;

    let (_, source) = sent_to(&model);
    assert!(source.contains("WHY-IS-THIS-BUTTON-RED?"), "the question went with the image");
    assert!(source.contains("[image]"), "and the image is marked, not silently dropped");
}

/// More than the summariser's request can carry: tool output gives first, the questions stay whole.
#[tokio::test]
async fn an_oversized_span_is_fitted_and_keeps_the_question_whole() {
    let (model, s) = summarizer("Twelve files were read.");
    // A 40K window: the summariser's source may be at most the window's 24K target.
    let mut m = ContextManager::new(Budget::with_thresholds(40_000, 8_000, 5_000)).with_summarizer(s);
    let question = format!("QUESTION: {} END-OF-QUESTION", "requirement ".repeat(150));
    let mut messages = vec![Message::system("be helpful"), Message::user(question)];
    for i in 0..12 {
        let id = format!("r{i}");
        messages.push(read_call(&id, &format!("r{i}.txt")));
        messages.push(Message::tool_result(id.clone(), format!("{id} {}", "y".repeat(30_000))));
    }
    messages.push(Message::assistant("prose ".repeat(4_000)));
    messages.extend(recent_turns());

    m.prepare(&messages).await;

    let (_, source) = sent_to(&model);
    let size = agent_context::estimate(&source);
    assert!(size <= 24_000, "the source must fit the summariser's window: {size}");
    assert!(source.contains("END-OF-QUESTION"), "the question was cut to make room for tool output");
    for i in 0..12 {
        assert!(source.contains(&format!("r{i} ")), "result {i} vanished instead of being shortened");
    }
}

#[tokio::test]
async fn a_summary_no_smaller_than_its_span_is_rejected() {
    let (model, s) = summarizer(&"verbose ".repeat(10_000));
    let mut m = ContextManager::new(tight()).with_summarizer(s);

    let (wire, compacted) = m.prepare(&long_conversation()).await;

    assert_eq!(model.request_count(), 1);
    assert!(m.summary().is_none(), "a summary larger than what it replaces is not a compaction");
    assert!(compacted, "the fallback still brings it down");
    assert!(wire.iter().all(|msg| !msg.text().contains("verbose verbose")));
}

// ---- After a fold --------------------------------------------------------------------------------------------

/// A folded message is not on the wire. Trimming it saves nothing, and counting that "saving" stopped compaction
/// while the wire was still over target.
#[tokio::test]
async fn folded_messages_are_neither_trimmed_nor_counted_as_savings() {
    let (_model, s) = summarizer("S");
    // Compacts above 85K, down to 60K.
    let mut m = ContextManager::new(Budget::with_window(100_000)).with_summarizer(s);
    let folded_answer = "a".repeat(160_000); // ~40K
    let mut messages = vec![Message::system("be helpful"), Message::user("q0")];
    messages.push(read_call("c0", "c0.rs"));
    messages.push(Message::tool_result("c0", "x".repeat(120_000))); // ~30K
    messages.push(Message::assistant(folded_answer.clone()));
    for i in 1..4 {
        messages.push(Message::user(format!("q{i}")));
        messages.push(Message::assistant(format!("a{i}")));
    }
    messages.push(Message::user("q4")); // the turn in progress starts here
    messages.push(Message::assistant("p".repeat(40_000))); // ~10K of this turn's prose
    messages.push(read_call("r1", "r1.rs"));
    // ~78K, not yet seen: with the prose, the turn alone stays over the 85K threshold once the head is folded.
    messages.push(Message::tool_result("r1", "y".repeat(312_000)));

    m.prepare(&messages).await;

    let item = |text_start: &str| {
        m.items().iter().find(|i| i.message.text().starts_with(text_start)).map(|i| i.message.text().len())
    };
    assert!(m.summary().is_some(), "the fixture must fold the head");
    assert_eq!(item("aaaa"), Some(folded_answer.len()), "a folded answer was trimmed — it is not even sent");
    assert!(item("pppp").is_some_and(|n| n < 40_000), "the prose that IS on the wire is what had to give");
}

/// A summary that failed (or came back no smaller) is not asked for again for the same span every round.
#[tokio::test]
async fn a_declined_summary_is_not_requested_again_for_the_same_span() {
    let model = Arc::new(ScriptedModel::new(Vec::new()).then_fails("summariser is down"));
    let s = Summarizer::new(Arc::clone(&model) as Arc<dyn ModelClient>, "summary-model");
    let mut m = ContextManager::new(working_set()).with_summarizer(s);
    let mut messages = vec![Message::system("be helpful")];
    for i in 0..5 {
        messages.push(Message::user(format!("old question {i}: {}", "detail ".repeat(800))));
        messages.push(Message::assistant(format!("old answer {i}: {}", "because ".repeat(800))));
    }
    messages.extend(recent_turns());

    m.prepare(&messages).await;
    messages.push(Message::assistant("still working"));
    m.prepare(&messages).await;
    m.prepare(&messages).await;

    assert_eq!(model.request_count(), 1, "the same refusal was paid for again on a later round");
}

/// A span that costs a few dozen tokens on the wire — its tool output already stubbed — is not worth a request that
/// reads its originals.
#[tokio::test]
async fn a_span_too_small_to_shrink_is_not_sent() {
    let (model, s) = summarizer("never needed");
    let mut m = ContextManager::new(working_set()).with_summarizer(s);
    let mut messages = vec![Message::system("be helpful"), Message::user("q0")];
    messages.push(read_call("c0", "c0.rs"));
    messages.push(Message::tool_result("c0", "x".repeat(48_000))); // ~12K, stubbed by the settled phase
    messages.push(Message::assistant("done"));
    messages.extend(recent_turns());
    messages.push(read_call("l0", "l0.rs"));
    messages.push(Message::tool_result("l0", "y".repeat(40_000))); // the turn in progress keeps it over budget

    m.prepare(&messages).await;

    assert_eq!(model.request_count(), 0, "a summary of a ~50-token span cannot pay for its request");
}

/// The last fitting step's per-line cap has to add up to the ceiling: an assistant turn is a line per call, and
/// each line carries a label and a cut marker beyond its text.
#[tokio::test]
async fn the_even_fit_counts_every_line_it_writes() {
    let (model, s) = summarizer("Ten questions, forty reads.");
    // A 10K window: the summariser's source may be at most its 6K target.
    let mut m = ContextManager::new(Budget::with_window(10_000)).with_summarizer(s);
    let mut messages = vec![Message::system("be helpful")];
    for q in 0..10 {
        messages.push(Message::user(format!("question {q}: {}", "requirement ".repeat(160))));
        let calls: Vec<ToolCall> = (0..4)
            .map(|c| ToolCall {
                id: format!("c{q}_{c}"),
                name: "read_file".into(),
                arguments: json!({ "path": format!("dir/{q}/{c}.rs"), "note": "n".repeat(300) }).to_string(),
            })
            .collect();
        messages.push(Message::assistant_calls(String::new(), calls));
        for c in 0..4 {
            messages.push(Message::tool_result(format!("c{q}_{c}"), format!("r{q}_{c} {}", "z".repeat(2_000))));
        }
    }
    messages.extend(recent_turns());

    m.prepare(&messages).await;

    let (_, source) = sent_to(&model);
    let size = agent_context::estimate(&source);
    assert!(size <= 6_000, "the transcript overran the summariser's 6K ceiling: {size}");
}
