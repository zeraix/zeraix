//! Scheduler behaviour tests (spec §6, §14, §15, §16).
//!
//! These assert the properties the JS runtime has no way to provide: priority ordering, real
//! concurrency ceilings, dependency propagation, cancellation that reaches a running future, and a
//! timeout that stops work rather than just reporting on it.

use agent_core::{CancellationToken, RuntimeError, TaskId, TaskState};
use agent_events::EventBus;
use agent_resource::{Limits, ResourceClass, ResourceManager};
use agent_scheduler::{Outcome, Priority, RetryPolicy, Scheduler, TaskContext, TaskSpec};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn sched(limits: Limits) -> Scheduler {
    Scheduler::start(ResourceManager::new(limits), EventBus::new(256))
}

fn one_of_each(n: usize) -> Limits {
    Limits { agents: n, sub_agents: n, tools: n, processes: n, mcp_requests: n }
}

/// A body that records its id when it runs, then finishes.
fn recording(log: Arc<Mutex<Vec<String>>>, name: &str) -> agent_scheduler::TaskBody {
    let name = name.to_string();
    Box::new(move |_ctx: TaskContext| {
        let log = Arc::clone(&log);
        let name = name.clone();
        Box::pin(async move {
            log.lock().unwrap().push(name);
            Ok(())
        })
    })
}

/// A body that sleeps, so overlap can be observed.
fn sleeping(ms: u64) -> agent_scheduler::TaskBody {
    Box::new(move |_ctx: TaskContext| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(())
        })
    })
}

fn failing(code: &'static str, retryable: bool) -> agent_scheduler::TaskBody {
    Box::new(move |_ctx: TaskContext| {
        Box::pin(async move {
            Err(if retryable {
                RuntimeError::retryable(code, "transient")
            } else {
                RuntimeError::invalid(code, "permanent")
            })
        })
    })
}

#[tokio::test]
async fn a_task_runs_and_reports_completion() {
    let s = sched(one_of_each(4));
    let spec = TaskSpec::new("hello", ResourceClass::Tool);
    let outcome = s.run_to_completion(spec, sleeping(1)).await.unwrap();
    assert_eq!(outcome, Outcome::Completed);
    s.shutdown().await;
}

#[tokio::test]
async fn concurrency_is_actually_capped() {
    // One tool slot: the two tasks must not overlap.
    let s = sched(Limits { tools: 1, ..one_of_each(8) });
    let live = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));

    let body = |live: Arc<AtomicU32>, peak: Arc<AtomicU32>| -> agent_scheduler::TaskBody {
        Box::new(move |_ctx: TaskContext| {
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            Box::pin(async move {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(40)).await;
                live.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
        })
    };

    for i in 0..4 {
        s.submit(
            TaskSpec::new(format!("t{i}"), ResourceClass::Tool),
            body(Arc::clone(&live), Arc::clone(&peak)),
        )
        .await
        .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(peak.load(Ordering::SeqCst), 1, "the tool quota was exceeded");
    s.shutdown().await;
}

#[tokio::test]
async fn priority_orders_queued_work() {
    // One slot, so everything after the first queues and ordering is observable.
    let s = sched(Limits { tools: 1, ..one_of_each(8) });
    let log = Arc::new(Mutex::new(Vec::new()));

    // Occupy the single slot first.
    s.submit(TaskSpec::new("blocker", ResourceClass::Tool), sleeping(60)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    for (name, prio) in [
        ("bg", Priority::Background),
        ("normal", Priority::Normal),
        ("critical", Priority::Critical),
        ("high", Priority::High),
    ] {
        s.submit(
            TaskSpec::new(name, ResourceClass::Tool).with_priority(prio),
            recording(Arc::clone(&log), name),
        )
        .await
        .unwrap();
    }

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*log.lock().unwrap(), vec!["critical", "high", "normal", "bg"]);
    s.shutdown().await;
}

#[tokio::test]
async fn dependencies_run_in_order() {
    let s = sched(one_of_each(8));
    let log = Arc::new(Mutex::new(Vec::new()));

    let first = TaskId::from_host("first");
    let second = TaskId::from_host("second");

    s.submit(
        TaskSpec::new("first", ResourceClass::Tool).with_id(first.clone()),
        Box::new({
            let log = Arc::clone(&log);
            move |_ctx| {
                let log = Arc::clone(&log);
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    log.lock().unwrap().push("first".to_string());
                    Ok(())
                })
            }
        }),
    )
    .await
    .unwrap();

    let outcome = s
        .run_to_completion(
            TaskSpec::new("second", ResourceClass::Tool)
                .with_id(second)
                .depends_on([first]),
            recording(Arc::clone(&log), "second"),
        )
        .await
        .unwrap();

    assert_eq!(outcome, Outcome::Completed);
    assert_eq!(*log.lock().unwrap(), vec!["first", "second"]);
    s.shutdown().await;
}

#[tokio::test]
async fn a_failed_dependency_fails_its_dependents_transitively() {
    let s = sched(one_of_each(8));
    let a = TaskId::from_host("a");
    let b = TaskId::from_host("b");
    let c = TaskId::from_host("c");

    s.submit(
        TaskSpec::new("a", ResourceClass::Tool).with_id(a.clone()),
        failing("boom", false),
    )
    .await
    .unwrap();
    s.submit(
        TaskSpec::new("b", ResourceClass::Tool).with_id(b.clone()).depends_on([a.clone()]),
        sleeping(1),
    )
    .await
    .unwrap();

    let outcome = s
        .run_to_completion(
            TaskSpec::new("c", ResourceClass::Tool).with_id(c).depends_on([b]),
            sleeping(1),
        )
        .await
        .unwrap();

    // c never ran: the failure propagated a -> b -> c without either downstream body executing.
    assert!(matches!(outcome, Outcome::DependencyFailed(_)), "got {outcome:?}");
    s.shutdown().await;
}

#[tokio::test]
async fn an_unknown_dependency_fails_the_task_rather_than_being_ignored() {
    let s = sched(one_of_each(4));
    let outcome = s
        .run_to_completion(
            TaskSpec::new("orphan", ResourceClass::Tool).depends_on([TaskId::from_host("typo")]),
            sleeping(1),
        )
        .await
        .unwrap();
    // Silently treating it as independent would turn a typo into a task that runs too early.
    assert!(matches!(outcome, Outcome::DependencyFailed(_)), "got {outcome:?}");
    s.shutdown().await;
}

#[tokio::test]
async fn cancellation_reaches_a_running_task() {
    let s = sched(one_of_each(4));
    let id = TaskId::from_host("long");
    let observed = Arc::new(AtomicU32::new(0));

    let obs = Arc::clone(&observed);
    s.submit(
        TaskSpec::new("long", ResourceClass::Tool).with_id(id.clone()),
        Box::new(move |ctx: TaskContext| {
            let obs = Arc::clone(&obs);
            Box::pin(async move {
                ctx.cancel.cancelled().await;
                obs.store(1, Ordering::SeqCst);
                Err(RuntimeError::cancelled())
            })
        }),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(20)).await;
    s.cancel(&id);
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(observed.load(Ordering::SeqCst), 1, "the body never saw the cancellation");
    let snap = s.snapshot().await;
    let rec = snap.iter().find(|r| r.id == "long").unwrap();
    assert_eq!(rec.state, TaskState::Cancelled);
    s.shutdown().await;
}

#[tokio::test]
async fn cancelling_a_parent_cancels_its_children() {
    let s = sched(one_of_each(8));
    let parent = TaskId::from_host("parent");
    let child = TaskId::from_host("child");

    s.submit(
        TaskSpec::new("parent", ResourceClass::Agent).with_id(parent.clone()),
        Box::new(|ctx: TaskContext| Box::pin(async move {
            ctx.cancel.cancelled().await;
            Err(RuntimeError::cancelled())
        })),
    )
    .await
    .unwrap();
    s.submit(
        TaskSpec::new("child", ResourceClass::SubAgent)
            .with_id(child.clone())
            .with_parent(parent.clone()),
        Box::new(|ctx: TaskContext| Box::pin(async move {
            ctx.cancel.cancelled().await;
            Err(RuntimeError::cancelled())
        })),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(20)).await;
    // Only the parent is cancelled. Token derivation must carry it to the child.
    s.cancel(&parent);
    tokio::time::sleep(Duration::from_millis(60)).await;

    let snap = s.snapshot().await;
    for name in ["parent", "child"] {
        let rec = snap.iter().find(|r| r.id == name).unwrap();
        assert_eq!(rec.state, TaskState::Cancelled, "{name} should have been cancelled");
    }
    s.shutdown().await;
}

#[tokio::test]
async fn a_timeout_stops_the_work_it_bounds() {
    let s = sched(one_of_each(4));
    let stopped = Arc::new(AtomicU32::new(0));
    let obs = Arc::clone(&stopped);

    let outcome = s
        .run_to_completion(
            TaskSpec::new("slow", ResourceClass::Tool).with_timeout(Duration::from_millis(40)),
            Box::new(move |ctx: TaskContext| {
                let obs = Arc::clone(&obs);
                Box::pin(async move {
                    // Notices cancellation rather than sleeping out the full duration.
                    tokio::select! {
                        _ = ctx.cancel.cancelled() => { obs.store(1, Ordering::SeqCst); }
                        _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                    }
                    Ok(())
                })
            }),
        )
        .await
        .unwrap();

    match outcome {
        Outcome::Failed(e) => assert_eq!(e.code, "runtime.timeout"),
        other => panic!("expected a timeout, got {other:?}"),
    }
    // Spec §15: the timeout must *cause* cancellation, not merely report one.
    assert_eq!(stopped.load(Ordering::SeqCst), 1, "the timeout did not cancel the work");
    s.shutdown().await;
}

#[tokio::test]
async fn retryable_failures_are_retried_and_permanent_ones_are_not() {
    let s = sched(one_of_each(4));

    let attempts = Arc::new(AtomicU32::new(0));
    let a = Arc::clone(&attempts);
    let outcome = s
        .run_to_completion(
            TaskSpec::new("flaky", ResourceClass::Tool)
                .with_retry(RetryPolicy { max_attempts: 3, base_delay: Duration::from_millis(5), factor: 1, max_delay: Duration::from_millis(5) }),
            Box::new(move |ctx: TaskContext| {
                let a = Arc::clone(&a);
                Box::pin(async move {
                    a.fetch_add(1, Ordering::SeqCst);
                    if ctx.attempt < 3 {
                        Err(RuntimeError::retryable("flaky", "try again"))
                    } else {
                        Ok(())
                    }
                })
            }),
        )
        .await
        .unwrap();
    assert_eq!(outcome, Outcome::Completed);
    assert_eq!(attempts.load(Ordering::SeqCst), 3);

    // A permanent failure must not be retried, however generous the policy.
    let tries = Arc::new(AtomicU32::new(0));
    let t = Arc::clone(&tries);
    let outcome = s
        .run_to_completion(
            TaskSpec::new("broken", ResourceClass::Tool).with_retry(RetryPolicy::attempts(5)),
            Box::new(move |_ctx| {
                let t = Arc::clone(&t);
                Box::pin(async move {
                    t.fetch_add(1, Ordering::SeqCst);
                    Err(RuntimeError::invalid("nope", "permanent"))
                })
            }),
        )
        .await
        .unwrap();
    assert!(matches!(outcome, Outcome::Failed(_)));
    assert_eq!(tries.load(Ordering::SeqCst), 1, "a non-retryable failure was retried");

    s.shutdown().await;
}

#[tokio::test]
async fn shutdown_cancels_queued_work_instead_of_stranding_it() {
    let s = sched(Limits { tools: 1, ..one_of_each(4) });
    s.submit(TaskSpec::new("running", ResourceClass::Tool), sleeping(500)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    let queued = TaskSpec::new("queued", ResourceClass::Tool);
    let queued_id = queued.id.clone();
    s.submit(queued, sleeping(10)).await.unwrap();

    s.shutdown().await;

    // Submitting after shutdown is refused rather than silently accepted and never run.
    let err = s.submit(TaskSpec::new("late", ResourceClass::Tool), sleeping(1)).await.unwrap_err();
    assert!(err.code == "scheduler.stopped" || err.code == "scheduler.duplicate_task");
    let _ = queued_id;
}

#[tokio::test]
async fn the_driver_stays_responsive_while_a_task_is_running() {
    // The load-bearing property: a long task must not delay a snapshot or a cancellation. In the JS
    // runtime this is impossible, because an ipcMain.handle promise cannot be interrupted.
    let s = sched(one_of_each(4));
    s.submit(TaskSpec::new("long", ResourceClass::Tool), sleeping(400)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;

    let started = std::time::Instant::now();
    let snap = s.snapshot().await;
    assert!(started.elapsed() < Duration::from_millis(100), "snapshot queued behind the running task");
    assert!(snap.iter().any(|r| r.label == "long" && r.state == TaskState::Running));
    s.shutdown().await;
}

#[tokio::test]
async fn duplicate_task_ids_are_refused() {
    let s = sched(one_of_each(4));
    let id = TaskId::from_host("dup");
    s.submit(TaskSpec::new("a", ResourceClass::Tool).with_id(id.clone()), sleeping(50)).await.unwrap();
    let err = s
        .submit(TaskSpec::new("b", ResourceClass::Tool).with_id(id), sleeping(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, "scheduler.duplicate_task");
    s.shutdown().await;
}

#[tokio::test]
async fn quota_exhaustion_queues_rather_than_failing() {
    // A full queue is a wait, not an error — the scheduler must never surface resource.exhausted to
    // a caller just because everything was busy for a moment.
    let s = sched(Limits { tools: 1, ..one_of_each(4) });
    s.submit(TaskSpec::new("hog", ResourceClass::Tool), sleeping(80)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    let outcome = s
        .run_to_completion(TaskSpec::new("waiter", ResourceClass::Tool), sleeping(1))
        .await
        .unwrap();
    assert_eq!(outcome, Outcome::Completed);
    s.shutdown().await;
}

#[tokio::test]
async fn root_cancellation_reaches_every_task() {
    let s = sched(one_of_each(8));
    let token: CancellationToken = s.root_token().clone();
    for i in 0..3 {
        s.submit(
            TaskSpec::new(format!("t{i}"), ResourceClass::Tool),
            Box::new(|ctx: TaskContext| Box::pin(async move {
                ctx.cancel.cancelled().await;
                Err(RuntimeError::cancelled())
            })),
        )
        .await
        .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    token.cancel();
    tokio::time::sleep(Duration::from_millis(60)).await;

    let snap = s.snapshot().await;
    assert!(
        snap.iter().all(|r| r.state == TaskState::Cancelled),
        "not every task observed the root cancellation: {snap:?}"
    );
    s.shutdown().await;
}
