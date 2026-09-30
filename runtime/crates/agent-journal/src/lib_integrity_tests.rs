//! `integrity_tests` for `lib.rs`, kept out of the source file (declared there as `mod integrity_tests`).

use super::*;

fn submitted(task: &str) -> JournalEvent {
    JournalEvent::Submitted {
        task: task.into(),
        label: "l".into(),
        priority: "normal".into(),
        resource: "tool".into(),
        parent: None,
    }
}

fn lines(events: Vec<JournalEvent>) -> String {
    let mut out = String::new();
    let mut link = 0u64;
    for (seq, event) in events.into_iter().enumerate() {
        let seq = seq as u64;
        link = chain(link, seq, 0, &event);
        out.push_str(&serde_json::to_string(&JournalEntry { seq, at_ms: 0, event, link }).unwrap());
        out.push('\n');
    }
    out
}

#[test]
fn an_untouched_journal_verifies() {
    let plan = replay_str(&lines(vec![submitted("a"), submitted("b"), submitted("c")]));
    assert_eq!(plan.integrity_broken_at, None);
}

/// Editing a record in place is the tampering this is for.
#[test]
fn altering_a_record_is_detected_and_located() {
    let text = lines(vec![submitted("a"), submitted("b"), submitted("c")]);
    let tampered = text.replace("\"task\":\"b\"", "\"task\":\"ELSEWHERE\"");
    assert_ne!(tampered, text, "the fixture did not actually change");

    let plan = replay_str(&tampered);
    assert_eq!(plan.integrity_broken_at, Some(1), "the second record is the one that was altered");
}

/// Quietly deleting a line — the way you would hide an action you took.
#[test]
fn removing_a_record_is_detected() {
    let text = lines(vec![submitted("a"), submitted("b"), submitted("c")]);
    let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| *i != 1).map(|(_, l)| l).collect();
    let plan = replay_str(&(kept.join("\n") + "\n"));
    assert!(plan.integrity_broken_at.is_some(), "a deleted record must break the chain");
}

#[test]
fn reordering_two_records_is_detected() {
    let text = lines(vec![submitted("a"), submitted("b"), submitted("c")]);
    let l: Vec<&str> = text.lines().collect();
    let swapped = format!("{}\n{}\n{}\n", l[0], l[2], l[1]);
    assert!(replay_str(&swapped).integrity_broken_at.is_some());
}

/// Only the FIRST break is reported: one altered line should not report every later line as broken too.
#[test]
fn the_first_break_is_the_one_reported() {
    let text = lines(vec![submitted("a"), submitted("b"), submitted("c"), submitted("d")]);
    let tampered = text.replace("\"task\":\"b\"", "\"task\":\"X\"");
    assert_eq!(replay_str(&tampered).integrity_broken_at, Some(1));
}

/// A tampered journal is exactly when its contents matter most; reading must still work.
#[test]
fn a_broken_chain_does_not_stop_recovery_from_reading_what_is_there() {
    let text = lines(vec![
        submitted("a"),
        JournalEvent::Started { task: "a".into(), attempt: 1 },
        submitted("b"),
    ]);
    let tampered = text.replace("\"task\":\"b\"", "\"task\":\"c\"");
    let plan = replay_str(&tampered);
    assert!(plan.integrity_broken_at.is_some());
    assert_eq!(plan.interrupted.len(), 1, "the readable part is still reported");
}

/// A restart must extend the chain, not start a second one that looks like tampering at the seam.
#[tokio::test]
async fn reopening_a_journal_continues_its_chain() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");

    let first = Journal::open(&path).await.unwrap();
    first.record(submitted("a"));
    first.flush().await.unwrap();
    drop(first);

    let second = Journal::open(&path).await.unwrap();
    second.record(submitted("b"));
    second.flush().await.unwrap();
    drop(second);

    let plan = replay(&path).await.unwrap();
    assert_eq!(plan.integrity_broken_at, None, "a restart must not look like tampering");
}
