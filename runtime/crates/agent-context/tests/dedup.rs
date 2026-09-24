//! Stale-read deduplication: dropping the reads the conversation already contains a newer version of.
//!
//! The property that matters is not "it makes things smaller" — every technique here does that. It is that
//! this one loses NOTHING: it only touches a read whose file is shown again, later, in the same conversation.
//! A test suite that only checked the size would happily pass an implementation that stubbed the most recent
//! read of a file and left the model blind.

use std::sync::Arc;

use agent_context::{Budget, ContextManager, Summarizer};
use agent_loop::{Message, ModelClient, NormalizedTurn, ScriptedModel, ToolCall};

/// Big enough to be worth stubbing, and distinguishable per call.
fn body(tag: &str) -> String {
    format!("{tag} {}", "line of file ".repeat(200))
}

fn read_call(id: &str, path: &str, offset: Option<u64>, limit: Option<u64>) -> Message {
    let mut args = serde_json::json!({ "path": path });
    if let Some(o) = offset {
        args["offset"] = serde_json::json!(o);
    }
    if let Some(l) = limit {
        args["limit"] = serde_json::json!(l);
    }
    Message::assistant_calls(
        String::new(),
        vec![ToolCall { id: id.into(), name: "read_file".into(), arguments: args.to_string() }],
    )
}

fn write_call(id: &str, path: &str) -> Message {
    Message::assistant_calls(
        String::new(),
        vec![ToolCall {
            id: id.into(),
            name: "write_file".into(),
            arguments: serde_json::json!({ "path": path, "content": "x" }).to_string(),
        }],
    )
}

/// Tight enough that compaction always runs, loose enough that dedup alone can satisfy it.
fn budget() -> Budget {
    Budget { max_tokens: 900, compact_at: 0.6, target: 0.55 }
}

/// A manager that would never summarise, so any shrinking seen is dedup's doing.
fn manager() -> ContextManager {
    ContextManager::new(budget())
}

/// The same, with enough headroom that removing the stale reads is on its own enough.
///
/// Used where a test asserts what SURVIVES. Under a tighter budget elision runs after dedup and stubs the
/// remaining tool output too — correct behaviour, and it would make "the current read is still there" a claim
/// about the budget rather than about dedup.
fn roomy() -> ContextManager {
    ContextManager::new(Budget { max_tokens: 2000, compact_at: 0.6, target: 0.55 })
}

/// Run one compaction and report what each technique did.
///
/// Assertions here are on the REPORT rather than on the wire, because the wire cannot tell the techniques
/// apart: eliding also stubs tool results, oldest first, so "the first read is gone" is true whether dedup
/// judged it stale or elision simply reached it. The counts distinguish them, and so do the two stub texts.
async fn compact(m: &mut ContextManager, messages: &[Message]) -> agent_context::CompactionReport {
    m.sync_from(messages);
    let report = m.compact().await;
    // Under the threshold `compact` returns immediately and no technique runs. A fixture that stopped
    // triggering would make every assertion below vacuously true, which is how a dedup that does nothing
    // passes its own suite.
    assert!(report.ran, "the fixture must be over the compaction threshold");
    report
}

/// The wording only dedup writes. Elision has its own, so finding this proves which step ran.
fn deduped_text(m: &ContextManager, index: usize) -> bool {
    m.items()[index].message.text().contains("earlier read of")
}

#[tokio::test]
async fn a_read_superseded_by_a_later_full_read_is_stubbed() {
    let mut m = roomy();
    let messages = vec![
        Message::user("look at the file"),
        read_call("c1", "src/a.rs", None, None),
        Message::tool_result("c1", body("FIRST-READ")),
        read_call("c2", "src/a.rs", None, None),
        Message::tool_result("c2", body("SECOND-READ")),
    ];
    let report = compact(&mut m, &messages).await;

    assert_eq!(report.deduped, 1, "exactly the superseded read");
    assert!(deduped_text(&m, 2), "the stub must say what was removed and why");
    assert!(m.items()[4].message.text().contains("SECOND-READ"), "the current read must survive");
}

/// The case that makes path-only dedup wrong: an agent paging through a large file.
#[tokio::test]
async fn disjoint_page_reads_do_not_supersede_each_other() {
    let mut m = manager();
    let messages = vec![
        Message::user("walk the file"),
        read_call("c1", "big.txt", Some(1), Some(90)),
        Message::tool_result("c1", body("PAGE-ONE")),
        read_call("c2", "big.txt", Some(91), Some(90)),
        Message::tool_result("c2", body("PAGE-TWO")),
        read_call("c3", "big.txt", Some(181), Some(90)),
        Message::tool_result("c3", body("PAGE-THREE")),
    ];
    let report = compact(&mut m, &messages).await;

    assert_eq!(
        report.deduped, 0,
        "no page supersedes another — stubbing any of them would lose part of the file"
    );
}

/// A read to the end of the file covers every earlier page of it.
#[tokio::test]
async fn a_later_unbounded_read_supersedes_the_pages_before_it() {
    let mut m = roomy();
    let messages = vec![
        Message::user("walk then re-read"),
        read_call("c1", "big.txt", Some(1), Some(90)),
        Message::tool_result("c1", body("PAGE-ONE")),
        read_call("c2", "big.txt", None, None),
        Message::tool_result("c2", body("WHOLE-FILE")),
    ];
    let report = compact(&mut m, &messages).await;

    assert_eq!(report.deduped, 1, "a whole-file read supersedes an earlier page");
    assert!(deduped_text(&m, 2));
    assert!(m.items()[4].message.text().contains("WHOLE-FILE"), "the newest read stays");
}

/// A write makes every earlier read of that file stale, whatever its span.
#[tokio::test]
async fn a_write_supersedes_earlier_reads_of_the_same_file() {
    let mut m = manager();
    let messages = vec![
        Message::user("read then edit"),
        read_call("c1", "./src/a.rs", Some(1), Some(50)),
        Message::tool_result("c1", body("BEFORE-EDIT")),
        write_call("c2", "src/a.rs"),
        Message::tool_result("c2", "written"),
    ];
    let report = compact(&mut m, &messages).await;

    // `./src/a.rs` and `src/a.rs` are the same file written two ways.
    assert_eq!(report.deduped, 1, "a read from before a write is stale");
    assert!(deduped_text(&m, 2));
}

/// Reads of different files are unrelated, however many there are.
#[tokio::test]
async fn reads_of_other_files_are_untouched() {
    let mut m = manager();
    let messages = vec![
        Message::user("read two files"),
        read_call("c1", "a.rs", None, None),
        Message::tool_result("c1", body("FILE-A")),
        read_call("c2", "b.rs", None, None),
        Message::tool_result("c2", body("FILE-B")),
    ];
    let report = compact(&mut m, &messages).await;

    assert_eq!(report.deduped, 0, "reading b.rs says nothing about a.rs");
}

/// Dedup runs before summarising, and on a conversation it can satisfy alone it must be ENOUGH — no model
/// call, nothing else touched. The cheapest technique first is the whole ordering argument.
#[tokio::test]
async fn dedup_alone_can_settle_a_conversation_without_calling_the_summariser() {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("should not be needed")]));
    // A window where removing the five superseded reads is, on its own, enough to get under target. With a
    // tighter one elision would run too and the claim this test makes — that the cheapest step came first and
    // settled it — would not be the thing being tested.
    let mut m = ContextManager::new(Budget { max_tokens: 2000, compact_at: 0.6, target: 0.55 })
        .with_summarizer(Summarizer::new(Arc::clone(&model) as Arc<dyn ModelClient>, "summary-model"));

    let mut messages = vec![Message::user("read the same file repeatedly")];
    for i in 0..6 {
        messages.push(read_call(&format!("c{i}"), "src/a.rs", None, None));
        messages.push(Message::tool_result(format!("c{i}"), body(&format!("READ-{i}"))));
    }
    m.sync_from(&messages);
    let report = m.compact().await;
    let wire = m.wire();
    let compacted = report.ran;
    let sent = wire.iter().map(Message::text).collect::<Vec<_>>().join("\n");

    assert!(compacted, "the fixture must reach the threshold");
    assert_eq!(model.request_count(), 0, "dedup was enough; no summary should have been paid for");
    assert!(sent.contains("READ-5"), "the newest read must survive");
    assert!(!sent.contains("READ-0"), "every superseded read should be gone");
    // Without this the test passes on an implementation where dedup does nothing and elision, which also
    // stubs tool results oldest-first, happens to produce the same wire.
    assert_eq!(report.deduped, 5, "the five superseded reads are dedup's doing, not elision's");
    assert_eq!(report.elided, 0, "dedup alone should have been enough");
}
