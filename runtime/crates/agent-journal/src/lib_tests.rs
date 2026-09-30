//! `tests` for `lib.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;

fn submitted(task: &str) -> JournalEvent {
    JournalEvent::Submitted {
        task: task.into(),
        label: format!("{task} label"),
        priority: "normal".into(),
        resource: "tool".into(),
        parent: None,
    }
}

/// Build a well-formed journal, chain links included — otherwise every test would report a broken trail.
fn lines(events: Vec<JournalEvent>) -> String {
    let mut out = String::new();
    let mut link = 0u64;
    for (seq, event) in events.into_iter().enumerate() {
        let seq = seq as u64;
        link = chain(link, seq, 0, &event);
        let entry = JournalEntry { seq, at_ms: 0, event, link };
        out.push_str(&serde_json::to_string(&entry).unwrap());
        out.push('\n');
    }
    out
}

#[test]
fn an_absent_journal_recovers_nothing_rather_than_failing() {
    let plan = replay_str("");
    assert!(plan.is_empty());
    assert!(!plan.torn_tail);
}

/// The distinction the whole crate exists for.
#[test]
fn a_task_that_started_is_interrupted_and_one_that_only_queued_is_resumable() {
    let plan = replay_str(&lines(vec![
        submitted("queued"),
        submitted("running"),
        JournalEvent::Started { task: "running".into(), attempt: 1 },
    ]));
    assert_eq!(plan.resumable.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["queued"]);
    assert_eq!(plan.interrupted.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["running"]);
    assert_eq!(plan.interrupted[0].attempts, 1);
}

#[test]
fn a_settled_task_is_not_recovered_at_all() {
    for state in [TaskState::Completed, TaskState::Failed, TaskState::Cancelled] {
        let plan = replay_str(&lines(vec![
            submitted("t"),
            JournalEvent::Started { task: "t".into(), attempt: 1 },
            JournalEvent::Settled { task: "t".into(), state, detail: None },
        ]));
        assert!(plan.is_empty(), "{state:?} should leave nothing to recover");
    }
}

/// The property that justifies the append-only format.
#[test]
fn a_torn_final_line_is_discarded_and_everything_before_it_survives() {
    let mut text = lines(vec![
        submitted("a"),
        JournalEvent::Started { task: "a".into(), attempt: 1 },
        submitted("b"),
    ]);
    // A process killed mid-write leaves a fragment with no newline.
    text.push_str(r#"{"seq":3,"at_ms":0,"event":"started","task":"b","att"#);

    let plan = replay_str(&text);
    assert!(plan.torn_tail);
    assert_eq!(plan.interrupted.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
    // `b`'s Started record was the torn one, so it is reported as never having run. That is the safe
    // direction: it is offered for resubmission only because the record proving otherwise was lost.
    assert_eq!(plan.resumable.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
}

#[test]
fn a_corrupt_line_in_the_middle_is_counted_and_stepped_over() {
    let mut text = lines(vec![submitted("a")]);
    text.push_str("this is not json\n");
    text.push_str(&lines(vec![submitted("b")]));
    let plan = replay_str(&text);
    assert_eq!(plan.corrupt_lines, 1);
    assert_eq!(plan.resumable.len(), 2);
    assert!(!plan.torn_tail);
}

#[test]
fn a_clean_shutdown_is_distinguishable_from_a_crash() {
    let crashed = replay_str(&lines(vec![
        submitted("t"),
        JournalEvent::Started { task: "t".into(), attempt: 1 },
    ]));
    assert!(!crashed.clean_shutdown);
    assert_eq!(crashed.interrupted.len(), 1);

    let stopped = replay_str(&lines(vec![
        submitted("t"),
        JournalEvent::Started { task: "t".into(), attempt: 1 },
        JournalEvent::Settled { task: "t".into(), state: TaskState::Completed, detail: None },
        JournalEvent::ShutDown,
    ]));
    assert!(stopped.clean_shutdown);
}

/// A journal is appended to across restarts, so a run that recovers must not look clean afterwards.
#[test]
fn work_recorded_after_a_shutdown_marks_the_journal_live_again() {
    let plan = replay_str(&lines(vec![
        JournalEvent::ShutDown,
        submitted("t"),
        JournalEvent::Started { task: "t".into(), attempt: 1 },
    ]));
    assert!(!plan.clean_shutdown);
    assert_eq!(plan.interrupted.len(), 1);
}

#[test]
fn a_retried_task_reports_the_highest_attempt_it_reached() {
    let plan = replay_str(&lines(vec![
        submitted("t"),
        JournalEvent::Started { task: "t".into(), attempt: 1 },
        JournalEvent::Started { task: "t".into(), attempt: 2 },
        JournalEvent::Started { task: "t".into(), attempt: 3 },
    ]));
    assert_eq!(plan.interrupted[0].attempts, 3);
}

#[test]
fn recovery_preserves_submission_order() {
    let plan = replay_str(&lines(vec![submitted("c"), submitted("a"), submitted("b")]));
    assert_eq!(
        plan.resumable.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["c", "a", "b"]
    );
}

#[tokio::test]
async fn a_journal_round_trips_through_a_real_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("tasks.jsonl");

    let journal = Journal::open(&path).await.unwrap();
    journal.record(submitted("a"));
    journal.record_durable(JournalEvent::Started { task: "a".into(), attempt: 1 }).await.unwrap();
    journal.record(submitted("b"));
    journal.flush().await.unwrap();

    let plan = replay(&path).await.unwrap();
    assert_eq!(plan.interrupted.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
    assert_eq!(plan.resumable.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
}

/// A second crash must not be masked by the recovery from the first.
#[tokio::test]
async fn reopening_appends_rather_than_truncating_and_sequence_numbers_continue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");

    let first = Journal::open(&path).await.unwrap();
    first.record(submitted("a"));
    first.flush().await.unwrap();
    drop(first);

    let second = Journal::open(&path).await.unwrap();
    second.record(submitted("b"));
    second.flush().await.unwrap();

    let text = tokio::fs::read_to_string(&path).await.unwrap();
    let seqs: Vec<u64> = text
        .lines()
        .map(|l| serde_json::from_str::<JournalEntry>(l).unwrap().seq)
        .collect();
    assert_eq!(seqs, vec![0, 1], "the second run continues the sequence rather than restarting it");

    let plan = replay(&path).await.unwrap();
    assert_eq!(plan.resumable.len(), 2);
}

#[tokio::test]
async fn rotating_moves_the_file_aside_and_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let journal = Journal::open(&path).await.unwrap();
    journal.record(submitted("a"));
    journal.flush().await.unwrap();
    drop(journal);

    let moved = Journal::rotate(&path).await.unwrap().expect("a journal to rotate");
    assert!(tokio::fs::metadata(&moved).await.is_ok(), "the old journal is kept for diagnosis");
    assert!(replay(&path).await.unwrap().is_empty(), "the live path starts fresh");

    // Rotating when there is nothing there is not an error.
    assert!(Journal::rotate(&path).await.unwrap().is_none());
}

/// Durability off must not change any caller's control flow.
#[tokio::test]
async fn a_disabled_journal_still_answers_durable_writes() {
    let journal = Journal::disabled();
    journal.record(submitted("a"));
    journal.record_durable(JournalEvent::Started { task: "a".into(), attempt: 1 }).await.unwrap();
    journal.flush().await.unwrap();
    journal.shut_down().await.unwrap();
}
