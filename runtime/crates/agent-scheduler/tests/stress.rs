//! Stress and leak tests (spec §26, TODO §10).
//!
//! ## Why there is no `loom` test here
//!
//! The TODO asks for `loom` coverage of "critical scheduler and cancellation logic paths". `loom`
//! exhaustively explores thread interleavings against shared mutable state — atomics, locks, lock-free
//! structures. This scheduler deliberately has none: all mutable state lives in one driver task and is
//! reached only by message, so there is no interleaving for `loom` to explore and no way to drive a
//! Tokio runtime under it.
//!
//! That is a design outcome, not a gap to paper over with a token `loom` test that proves nothing. The
//! failures this design *can* actually have are leaks and starvation under load — tasks that never
//! settle, permits that are never returned, a queue that stops draining — so those are what is tested
//! here. If shared mutable state is ever introduced (a lock-free ready queue, say), `loom` becomes the
//! right tool at that moment and this note should be replaced with one.

use agent_core::RuntimeError;
use agent_events::EventBus;
use agent_resource::{Limits, ResourceClass, ResourceManager};
use agent_scheduler::{Outcome, Priority, Scheduler, TaskContext, TaskSpec};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn sched(limits: Limits) -> (Scheduler, ResourceManager) {
    let rm = ResourceManager::new(limits);
    (Scheduler::start(rm.clone(), EventBus::new(4096)), rm)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thousand_tasks_all_settle_and_leak_nothing() {
    let limits = Limits { agents: 4, sub_agents: 4, tools: 16, processes: 8, mcp_requests: 16 };
    let (s, rm) = sched(limits);
    let done = Arc::new(AtomicU32::new(0));

    for i in 0..1000 {
        let done = Arc::clone(&done);
        s.submit(
            TaskSpec::new(format!("t{i}"), ResourceClass::Tool).with_priority(
                if i % 10 == 0 { Priority::High } else { Priority::Normal },
            ),
            Box::new(move |_ctx: TaskContext| {
                let done = Arc::clone(&done);
                Box::pin(async move {
                    tokio::task::yield_now().await;
                    done.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            }),
        )
        .await
        .unwrap();
    }

    // Drain rather than sleeping a fixed amount: a fixed sleep either flakes or wastes time.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while done.load(Ordering::SeqCst) < 1000 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert_eq!(done.load(Ordering::SeqCst), 1000, "not every task ran");
    let snap = s.snapshot().await;
    assert_eq!(snap.len(), 1000);
    assert!(snap.iter().all(|r| r.state.is_terminal()), "some tasks never settled");

    // The leak check: every permit returned. RAII makes this hard to get wrong, which is exactly why
    // it is worth asserting — a regression here would be silent until the runtime wedged.
    for class in ResourceClass::ALL {
        assert_eq!(rm.in_use(class), 0, "{} permits leaked", class.as_str());
    }
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mass_cancellation_settles_everything() {
    let (s, rm) = sched(Limits { agents: 2, sub_agents: 2, tools: 4, processes: 2, mcp_requests: 2 });

    let mut ids = Vec::new();
    for i in 0..200 {
        let spec = TaskSpec::new(format!("t{i}"), ResourceClass::Tool);
        ids.push(spec.id.clone());
        s.submit(
            spec,
            Box::new(|ctx: TaskContext| {
                Box::pin(async move {
                    ctx.cancel.cancelled().await;
                    Err(RuntimeError::cancelled())
                })
            }),
        )
        .await
        .unwrap();
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    for id in &ids {
        s.cancel(id);
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let snap = s.snapshot().await;
        if snap.iter().all(|r| r.state.is_terminal()) || std::time::Instant::now() > deadline {
            assert!(
                snap.iter().all(|r| r.state.is_terminal()),
                "{} task(s) never settled after cancellation",
                snap.iter().filter(|r| !r.state.is_terminal()).count()
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    for class in ResourceClass::ALL {
        assert_eq!(rm.in_use(class), 0, "{} permits leaked after cancellation", class.as_str());
    }
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deep_dependency_chain_completes_in_order() {
    let (s, _) = sched(Limits { agents: 4, sub_agents: 4, tools: 8, processes: 4, mcp_requests: 4 });

    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut prev: Option<agent_core::TaskId> = None;
    let mut last_id = None;

    for i in 0..100 {
        let mut spec = TaskSpec::new(format!("link{i}"), ResourceClass::Tool);
        if let Some(p) = prev.take() {
            spec = spec.depends_on([p]);
        }
        prev = Some(spec.id.clone());
        last_id = Some(spec.id.clone());

        let order = Arc::clone(&order);
        s.submit(
            spec,
            Box::new(move |_ctx| {
                let order = Arc::clone(&order);
                Box::pin(async move {
                    order.lock().unwrap().push(i);
                    Ok(())
                })
            }),
        )
        .await
        .unwrap();
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while order.lock().unwrap().len() < 100 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let seen = order.lock().unwrap().clone();
    assert_eq!(seen.len(), 100, "the chain stalled");
    assert_eq!(seen, (0..100).collect::<Vec<_>>(), "dependencies did not serialise the chain");
    let _ = last_id;
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_busy_scheduler_still_answers_promptly() {
    // Starvation check: with the queue saturated, control operations must not be delayed behind work.
    let (s, _) = sched(Limits { agents: 1, sub_agents: 1, tools: 2, processes: 1, mcp_requests: 1 });
    for i in 0..300 {
        s.submit(
            TaskSpec::new(format!("busy{i}"), ResourceClass::Tool),
            Box::new(|_ctx| Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok(())
            })),
        )
        .await
        .unwrap();
    }

    for _ in 0..20 {
        let t = std::time::Instant::now();
        let _ = s.snapshot().await;
        assert!(t.elapsed() < Duration::from_millis(250), "snapshot took {:?} under load", t.elapsed());
    }
    let outcome = s
        .run_to_completion(
            TaskSpec::new("urgent", ResourceClass::Tool).with_priority(Priority::Critical),
            Box::new(|_ctx| Box::pin(async move { Ok(()) })),
        )
        .await
        .unwrap();
    assert_eq!(outcome, Outcome::Completed);
    s.shutdown().await;
}
