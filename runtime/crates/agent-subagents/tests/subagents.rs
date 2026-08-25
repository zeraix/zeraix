//! Sub-agent Runtime tests (spec §9, TODO §3).
//!
//! The semantics under test are ported from `subagentScheduler.ts`, whose own test suite is the
//! acceptance criteria. The additions are `a_panicking_delegation_does_not_affect_its_siblings` and the
//! cancellation-propagation cases — the properties the JS version structurally cannot have, because a
//! delegation there is a promise in the same renderer as its parent.

use agent_core::{CancellationToken, TaskId};
use agent_events::EventBus;
use agent_permission::Grant;
use agent_subagents::{
    DelegationBody, DelegationContext, JobState, JoinMode, SubAgentSupervisor, CANCELLED_RESULT,
};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn sup(parallel: usize) -> (SubAgentSupervisor<String>, CancellationToken) {
    let root = CancellationToken::new();
    let s = SubAgentSupervisor::new(TaskId::from_host("turn1"), &root, EventBus::new(128))
        .with_parallel(parallel);
    (s, root)
}

/// A body that returns `text` after `ms`.
fn answering(text: &str, ms: u64) -> DelegationBody {
    let text = text.to_owned();
    Box::new(move |_ctx: DelegationContext| {
        Box::pin(async move {
            if ms > 0 {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            Ok(text)
        })
    })
}

/// A body that watches its token and reports how far it got.
fn cooperative(flag: Arc<AtomicU32>) -> DelegationBody {
    Box::new(move |ctx: DelegationContext| {
        Box::pin(async move {
            ctx.cancel.cancelled().await;
            flag.store(1, Ordering::SeqCst);
            Ok("stopped early".to_owned())
        })
    })
}

#[tokio::test]
async fn a_delegation_runs_and_its_conclusion_comes_back() {
    let (s, _root) = sup(3);
    let r = s.spawn("explore".into(), None, Grant::empty(), answering("found it", 10));
    assert!(r.refused.is_none());
    assert!(!r.coalesced);

    let j = s.join(std::slice::from_ref(&r.id), JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(j.ready.len(), 1);
    assert_eq!(j.ready[0].1.result, "found it");
    assert_eq!(j.ready[0].1.state, JobState::Done);
    assert!(j.pending.is_empty() && j.unknown.is_empty() && !j.timed_out);
}

#[tokio::test]
async fn results_are_reported_in_spawn_order_not_completion_order() {
    // Whoever finishes first, a fan-out must read the same way every time.
    let (s, _root) = sup(3);
    let slow = s.spawn("a".into(), None, Grant::empty(), answering("slow", 120));
    let fast = s.spawn("b".into(), None, Grant::empty(), answering("fast", 5));

    let j = s.join(&[], JoinMode::All, Some(Duration::from_secs(5)), true).await;
    let order: Vec<&str> = j.ready.iter().map(|(_, o)| o.result.as_str()).collect();
    assert_eq!(order, vec!["slow", "fast"], "spawn order was not preserved");
    let _ = (slow, fast);
}

#[tokio::test]
async fn an_outcome_is_delivered_exactly_once() {
    // Reporting a conclusion twice makes the model believe the work happened twice.
    let (s, _root) = sup(3);
    let r = s.spawn("a".into(), None, Grant::empty(), answering("once", 5));

    let first = s.join(std::slice::from_ref(&r.id), JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(first.ready.len(), 1);

    let second = s.join(std::slice::from_ref(&r.id), JoinMode::All, Some(Duration::from_millis(50)), true).await;
    assert!(second.ready.is_empty(), "the same outcome was reported twice");
    assert!(second.pending.is_empty());

    // The automatic drain must not resurrect it either.
    assert!(s.drain().is_empty());
}

#[tokio::test]
async fn identical_spawns_coalesce_into_one_job() {
    let (s, _root) = sup(3);
    let counter = Arc::new(AtomicU32::new(0));

    let body = |c: Arc<AtomicU32>| -> DelegationBody {
        Box::new(move |_ctx| {
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(60)).await;
                Ok("done".to_owned())
            })
        })
    };

    let key = Some("review:src/a.rs".to_owned());
    let a = s.spawn("review".into(), key.clone(), Grant::empty(), body(counter.clone()));
    let b = s.spawn("review".into(), key.clone(), Grant::empty(), body(counter.clone()));

    assert!(!a.coalesced);
    assert!(b.coalesced, "an identical in-flight delegation was not folded in");
    assert_eq!(a.id, b.id);

    s.join(&[], JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(counter.load(Ordering::SeqCst), 1, "the body ran twice despite coalescing");
}

#[tokio::test]
async fn a_settled_job_does_not_absorb_a_later_identical_spawn() {
    // Coalescing is about work still in flight. Once it has settled, a fresh request is a fresh job —
    // the finished-delegation repeat guard is a different mechanism, at a different layer.
    let (s, _root) = sup(3);
    let key = Some("k".to_owned());
    let a = s.spawn("x".into(), key.clone(), Grant::empty(), answering("first", 0));
    s.join(std::slice::from_ref(&a.id), JoinMode::All, Some(Duration::from_secs(5)), true).await;

    let b = s.spawn("x".into(), key, Grant::empty(), answering("second", 0));
    assert!(!b.coalesced);
    assert_ne!(a.id, b.id);
}

#[tokio::test]
async fn concurrency_is_capped_and_the_rest_queue() {
    let (s, _root) = sup(2);
    let live = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));

    for _ in 0..6 {
        let live = live.clone();
        let peak = peak.clone();
        s.spawn(
            "w".into(),
            None,
            Grant::empty(),
            Box::new(move |_ctx| {
                Box::pin(async move {
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                    Ok("ok".to_owned())
                })
            }),
        );
    }

    s.join(&[], JoinMode::All, Some(Duration::from_secs(10)), true).await;
    assert_eq!(peak.load(Ordering::SeqCst), 2, "the parallel limit was exceeded");
}

#[tokio::test]
async fn the_per_turn_cap_refuses_rather_than_queueing_forever() {
    let (s, _root) = sup(2);
    let s = s.with_max_jobs(3);
    for _ in 0..3 {
        assert!(s.spawn("w".into(), None, Grant::empty(), answering("ok", 5)).refused.is_none());
    }
    let over = s.spawn("w".into(), None, Grant::empty(), answering("ok", 5));
    assert!(over.refused.is_some(), "the per-turn cap did not refuse");
    assert!(over.refused.unwrap().contains("cap"));
}

#[tokio::test]
async fn join_any_returns_as_soon_as_one_settles() {
    let (s, _root) = sup(3);
    s.spawn("slow".into(), None, Grant::empty(), answering("slow", 400));
    s.spawn("fast".into(), None, Grant::empty(), answering("fast", 10));

    let started = std::time::Instant::now();
    let j = s.join(&[], JoinMode::Any, Some(Duration::from_secs(5)), true).await;
    assert!(!j.ready.is_empty());
    assert!(started.elapsed() < Duration::from_millis(300), "Any waited for everything");
    assert!(!j.pending.is_empty(), "the slow job should still be pending");
}

#[tokio::test]
async fn a_non_blocking_join_harvests_without_waiting() {
    // What lets the main agent stay in control of its own time: pick up finished work in passing
    // without committing the turn to a wait.
    let (s, _root) = sup(3);
    s.spawn("slow".into(), None, Grant::empty(), answering("slow", 500));

    let started = std::time::Instant::now();
    let j = s.join(&[], JoinMode::All, None, false).await;
    assert!(started.elapsed() < Duration::from_millis(100), "a non-blocking join blocked");
    assert!(j.ready.is_empty());
    assert_eq!(j.pending.len(), 1);
    assert!(!j.timed_out);
}

#[tokio::test]
async fn join_reports_a_timeout_without_losing_the_work() {
    let (s, _root) = sup(3);
    let r = s.spawn("slow".into(), None, Grant::empty(), answering("eventually", 300));

    let j = s.join(std::slice::from_ref(&r.id), JoinMode::All, Some(Duration::from_millis(50)), true).await;
    assert!(j.timed_out);
    assert_eq!(j.pending, vec![r.id.clone()]);

    // The delegation kept running; a later join still gets it.
    let j2 = s.join(&[r.id], JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(j2.ready.len(), 1);
    assert_eq!(j2.ready[0].1.result, "eventually");
}

#[tokio::test]
async fn an_invented_handle_is_reported_as_unknown() {
    let (s, _root) = sup(3);
    let j = s
        .join(&["s99".to_owned()], JoinMode::All, Some(Duration::from_millis(50)), true)
        .await;
    assert_eq!(j.unknown, vec!["s99".to_owned()]);
    assert!(j.ready.is_empty() && j.pending.is_empty());
}

#[tokio::test]
async fn duplicate_ids_in_one_join_are_reported_once() {
    let (s, _root) = sup(3);
    let a = s.spawn("a".into(), None, Grant::empty(), answering("A", 0));
    let ids = vec![a.id.clone(), a.id.clone(), a.id.clone()];
    let j = s.join(&ids, JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(j.ready.len(), 1);
}

#[tokio::test]
async fn drain_returns_work_that_finished_while_nobody_was_looking() {
    // Why the model never needs to poll: a delegation that landed while it was busy rides back on the
    // next tool result.
    let (s, _root) = sup(3);
    s.spawn("a".into(), None, Grant::empty(), answering("landed", 5));
    tokio::time::sleep(Duration::from_millis(80)).await;

    let drained = s.drain();
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].1.result, "landed");
    assert!(s.drain().is_empty(), "drain reported the same outcome twice");
}

// ── Fault isolation and cancellation: the properties the JS version cannot have ────────────────────

#[tokio::test]
async fn a_panicking_delegation_does_not_affect_its_siblings() {
    let (s, _root) = sup(3);
    let boom: DelegationBody = Box::new(|_ctx| Box::pin(async { panic!("delegation exploded") }));
    let bad = s.spawn("bad".into(), None, Grant::empty(), boom);
    let good = s.spawn("good".into(), None, Grant::empty(), answering("fine", 20));

    let j = s.join(&[], JoinMode::All, Some(Duration::from_secs(5)), true).await;
    let by_id = |id: &str| j.ready.iter().find(|(v, _)| v.id == id).map(|(_, o)| o.clone()).unwrap();

    let failed = by_id(&bad.id);
    assert_eq!(failed.state, JobState::Failed, "a panic should be a failed outcome");
    // The sibling completed normally, and the supervisor is still usable.
    assert_eq!(by_id(&good.id).state, JobState::Done);
    assert_eq!(by_id(&good.id).result, "fine");

    let later = s.spawn("after".into(), None, Grant::empty(), answering("still working", 0));
    assert!(later.refused.is_none());
}

#[tokio::test]
async fn a_failing_delegation_reports_its_error_as_an_outcome() {
    let (s, _root) = sup(3);
    let failing: DelegationBody =
        Box::new(|_ctx| Box::pin(async { Err("the model returned nothing".to_owned()) }));
    let r = s.spawn("f".into(), None, Grant::empty(), failing);
    let j = s.join(&[r.id], JoinMode::All, Some(Duration::from_secs(5)), true).await;
    assert_eq!(j.ready[0].1.state, JobState::Failed);
    assert_eq!(j.ready[0].1.result, "the model returned nothing");
}

#[tokio::test]
async fn cancelling_the_parent_turn_reaches_every_delegation() {
    let (s, root) = sup(3);
    let saw_it = Arc::new(AtomicU32::new(0));
    s.spawn("a".into(), None, Grant::empty(), cooperative(saw_it.clone()));
    s.spawn("b".into(), None, Grant::empty(), answering("never", 5_000));

    tokio::time::sleep(Duration::from_millis(40)).await;
    // Only the PARENT token is cancelled; derivation must carry it down.
    root.cancel();

    let j = s.join(&[], JoinMode::All, Some(Duration::from_secs(10)), true).await;
    assert_eq!(j.ready.len(), 2);
    assert!(j.ready.iter().all(|(_, o)| o.state != JobState::Done || o.result == "stopped early"));
    assert_eq!(saw_it.load(Ordering::SeqCst), 1, "the body never observed the cancellation");
}

#[tokio::test]
async fn cancel_all_settles_queued_work_instead_of_stranding_it() {
    // A caller awaiting an outcome must be answered, not left hanging on a lost sender.
    let (s, _root) = sup(1);
    s.spawn("running".into(), None, Grant::empty(), answering("slow", 5_000));
    let queued = s.spawn("queued".into(), None, Grant::empty(), answering("never runs", 10));
    tokio::time::sleep(Duration::from_millis(30)).await;

    s.cancel_all(CANCELLED_RESULT);

    let j = s.join(&[], JoinMode::All, Some(Duration::from_secs(10)), true).await;
    let q = j.ready.iter().find(|(v, _)| v.id == queued.id).expect("the queued job was stranded");
    assert_eq!(q.1.state, JobState::Cancelled);
    assert_eq!(q.1.result, CANCELLED_RESULT);
}

#[tokio::test]
async fn spawning_after_cancellation_is_refused() {
    let (s, _root) = sup(2);
    s.cancel_all(CANCELLED_RESULT);
    let r = s.spawn("late".into(), None, Grant::empty(), answering("x", 0));
    assert!(r.refused.is_some());
}

#[tokio::test]
async fn outstanding_reports_only_unsettled_work() {
    let (s, _root) = sup(2);
    let quick = s.spawn("q".into(), None, Grant::empty(), answering("done", 0));
    let slow = s.spawn("s".into(), None, Grant::empty(), answering("later", 400));

    s.join(std::slice::from_ref(&quick.id), JoinMode::All, Some(Duration::from_secs(5)), true).await;
    let out = s.outstanding();
    assert_eq!(out, vec![slow.id], "outstanding should list only what has not settled");
}

#[tokio::test]
async fn counts_track_the_state_machine() {
    let (s, _root) = sup(1);
    s.spawn("a".into(), None, Grant::empty(), answering("a", 150));
    s.spawn("b".into(), None, Grant::empty(), answering("b", 10));
    tokio::time::sleep(Duration::from_millis(40)).await;

    let (queued, running, settled, total) = s.counts();
    assert_eq!(total, 2);
    assert_eq!(running, 1, "one slot means one runner");
    assert_eq!(queued, 1);
    assert_eq!(settled, 0);
}
