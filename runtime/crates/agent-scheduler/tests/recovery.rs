//! Crash recovery — what a scheduler leaves behind when the process does not come back.
//!
//! These run a real scheduler against a real journal file and then read that file the way a fresh runtime
//! would. The distinction every test here circles is the one the journal exists for: a task that was only
//! ever *queued* can be submitted again, and a task that had *begun* cannot be, because the difference
//! between them is whether something already happened to the user's machine.
//!
//! A crash is simulated by dropping the scheduler without calling `shutdown()`, which is exactly what a
//! killed process does — the driver task stops, and whatever the journal already has on disk is all there is.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use agent_core::TaskId;
use agent_events::EventBus;
use agent_journal::{Journal, replay};
use agent_resource::{Limits, ResourceClass, ResourceManager};
use agent_scheduler::{Priority, Scheduler, TaskSpec};

fn spec(label: &str, id: &str) -> TaskSpec {
    TaskSpec::new(label, ResourceClass::Tool).with_id(TaskId::from_host(id))
}

async fn journalled(path: &std::path::Path) -> (Scheduler, Journal) {
    let journal = Journal::open(path).await.expect("open the journal");
    let scheduler =
        Scheduler::start_journalled(ResourceManager::default(), EventBus::default(), journal.clone());
    (scheduler, journal)
}

/// The ordinary case: work that ran to completion leaves nothing to recover.
#[tokio::test]
async fn a_run_that_finishes_cleanly_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let (scheduler, _journal) = journalled(&path).await;

    scheduler
        .run_to_completion(spec("read", "t1"), Box::new(|_ctx| Box::pin(async { Ok(()) })))
        .await
        .expect("the task to run");
    scheduler.shutdown().await;

    let plan = replay(&path).await.unwrap();
    assert!(plan.is_empty(), "a completed task is not recovered");
    assert!(plan.clean_shutdown, "shutdown() must be recorded, or a clean stop reads as a crash");
}

/// The case the whole design turns on.
#[tokio::test]
async fn a_task_interrupted_mid_flight_is_reported_rather_than_offered_for_resubmission() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let started = Arc::new(tokio::sync::Notify::new());

    {
        let (scheduler, journal) = journalled(&path).await;
        let signal = Arc::clone(&started);
        scheduler
            .submit(
                spec("npm install", "t1"),
                Box::new(move |_ctx| {
                    let signal = Arc::clone(&signal);
                    Box::pin(async move {
                        signal.notify_one();
                        // Never returns within the test: this is a task that was still running when the
                        // process died.
                        std::future::pending::<()>().await;
                        Ok(())
                    })
                }),
            )
            .await
            .unwrap();

        started.notified().await;
        // The body has begun. Flush so the assertions below read what a crash at this instant would leave —
        // the `Started` record is written durably by the task itself, but the `Submitted` before it is not.
        journal.flush().await.unwrap();
        // Dropped without shutdown(): a killed process, not a stopped one.
    }

    let plan = replay(&path).await.unwrap();
    assert!(!plan.clean_shutdown, "a dropped scheduler must not look like a clean stop");
    assert_eq!(plan.resumable.len(), 0, "a task that BEGAN must never be offered as safe to re-run");
    assert_eq!(plan.interrupted.len(), 1);
    assert_eq!(plan.interrupted[0].id, "t1");
    assert_eq!(plan.interrupted[0].label, "npm install");
    assert_eq!(plan.interrupted[0].attempts, 1);
}

/// The other half: work that never started is safe, and saying so is the point of splitting the lists.
#[tokio::test]
async fn work_still_queued_behind_a_full_quota_comes_back_as_resumable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    // One slot, so everything after the first task is queued and never starts.
    let resources = ResourceManager::new(Limits { tools: 1, ..Limits::default() });
    let started = Arc::new(tokio::sync::Notify::new());

    {
        let journal = Journal::open(&path).await.unwrap();
        let scheduler = Scheduler::start_journalled(resources, EventBus::default(), journal.clone());

        let signal = Arc::clone(&started);
        scheduler
            .submit(
                spec("the one that ran", "running"),
                Box::new(move |_ctx| {
                    let signal = Arc::clone(&signal);
                    Box::pin(async move {
                        signal.notify_one();
                        std::future::pending::<()>().await;
                        Ok(())
                    })
                }),
            )
            .await
            .unwrap();
        started.notified().await;

        for id in ["queued_a", "queued_b"] {
            scheduler
                .submit(spec(id, id), Box::new(|_ctx| Box::pin(async { Ok(()) })))
                .await
                .unwrap();
        }
        journal.flush().await.unwrap();
    }

    let plan = replay(&path).await.unwrap();
    assert_eq!(
        plan.resumable.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["queued_a", "queued_b"],
        "queued work never touched anything, so it is safe to submit again — in submission order"
    );
    assert_eq!(plan.interrupted.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["running"]);
}

/// A cancelled task is finished, not interrupted: the runtime decided its fate before dying.
#[tokio::test]
async fn a_cancelled_task_is_settled_and_not_recovered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let (scheduler, journal) = journalled(&path).await;

    let id = TaskId::from_host("t1");
    scheduler
        .submit(
            spec("slow", "t1"),
            Box::new(|ctx| {
                Box::pin(async move {
                    ctx.cancel.cancelled().await;
                    Ok(())
                })
            }),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    scheduler.cancel(&id);
    tokio::time::sleep(Duration::from_millis(50)).await;
    journal.flush().await.unwrap();
    drop(scheduler);

    let plan = replay(&path).await.unwrap();
    assert!(plan.is_empty(), "a cancellation is a decision, so there is nothing left over");
}

/// A retried task must come back as one interrupted task, not several.
#[tokio::test]
async fn a_task_interrupted_on_its_third_attempt_reports_that_attempt_count() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let attempts = Arc::new(AtomicU32::new(0));

    {
        let (scheduler, journal) = journalled(&path).await;
        let seen = Arc::clone(&attempts);
        scheduler
            .submit(
                spec("flaky", "t1").with_retry(agent_scheduler::RetryPolicy::attempts(5)),
                Box::new(move |_ctx| {
                    let seen = Arc::clone(&seen);
                    Box::pin(async move {
                        let n = seen.fetch_add(1, Ordering::SeqCst) + 1;
                        if n >= 3 {
                            // The third attempt is the one that was still running when the process died.
                            std::future::pending::<()>().await;
                        }
                        Err(agent_core::RuntimeError::retryable("flaky.failed", "try again"))
                    })
                }),
            )
            .await
            .unwrap();

        // Long enough for two failures and their backoffs, and to enter the third attempt.
        tokio::time::sleep(Duration::from_millis(900)).await;
        journal.flush().await.unwrap();
    }

    let plan = replay(&path).await.unwrap();
    assert_eq!(plan.interrupted.len(), 1, "one task, however many attempts it made");
    assert_eq!(plan.interrupted[0].attempts, 3);
    assert!(plan.resumable.is_empty());
}

/// Durability is opt-in, and opting out must not change behaviour.
#[tokio::test]
async fn a_scheduler_without_a_journal_behaves_identically() {
    let scheduler = Scheduler::start(ResourceManager::default(), EventBus::default());
    let outcome = scheduler
        .run_to_completion(spec("read", "t1"), Box::new(|_ctx| Box::pin(async { Ok(()) })))
        .await
        .unwrap();
    assert!(outcome.is_success());
    scheduler.shutdown().await;
}

/// Priority and parentage survive, because a caller resubmitting has to reproduce them.
#[tokio::test]
async fn a_recovered_task_carries_what_is_needed_to_submit_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.jsonl");
    let resources = ResourceManager::new(Limits { tools: 1, ..Limits::default() });
    let started = Arc::new(tokio::sync::Notify::new());

    {
        let journal = Journal::open(&path).await.unwrap();
        let scheduler = Scheduler::start_journalled(resources, EventBus::default(), journal.clone());
        let signal = Arc::clone(&started);
        scheduler
            .submit(
                spec("parent", "parent"),
                Box::new(move |_ctx| {
                    let signal = Arc::clone(&signal);
                    Box::pin(async move {
                        signal.notify_one();
                        std::future::pending::<()>().await;
                        Ok(())
                    })
                }),
            )
            .await
            .unwrap();
        started.notified().await;

        scheduler
            .submit(
                spec("child", "child")
                    .with_priority(Priority::Critical)
                    .with_parent(TaskId::from_host("parent")),
                Box::new(|_ctx| Box::pin(async { Ok(()) })),
            )
            .await
            .unwrap();
        journal.flush().await.unwrap();
    }

    let plan = replay(&path).await.unwrap();
    let child = plan.resumable.iter().find(|t| t.id == "child").expect("the queued child");
    assert_eq!(child.priority, "critical");
    assert_eq!(child.parent.as_deref(), Some("parent"));
    assert_eq!(child.resource, "tool");
    assert_eq!(child.label, "child");
}
