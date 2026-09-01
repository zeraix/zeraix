//! Load tests for the loop (TODO §13).
//!
//! These assert *properties under load*, not timings. A test that fails when a machine is busy teaches people
//! to re-run it until it passes, which is worse than not having it — so nothing here measures wall clock.
//! Timings live in `scripts/runtime-bench.mjs`, which reports rather than gates.
//!
//! What each one is actually for:
//!
//!  - **long-running** — a run of many rounds must not accumulate state that grows without bound, and must
//!    still end for the reason it was going to end for.
//!  - **100+ tool calls** — the counters, the detector and the transcript have to stay consistent at a scale
//!    no unit test reaches.
//!  - **large context** — compaction has to keep working when it is the thing under pressure, rather than
//!    being correct once and then falling behind.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_context::{Budget, ContextManager};
use agent_core::CancellationToken;
use agent_loop::model::call;
use agent_loop::{
    AgentLoop, LoopConfig, Message, NormalizedTurn, ScriptedModel, StopPolicyConfig, StopReason, ToolCall,
    ToolExecutor, ToolOutcome,
};
use serde_json::json;

/// A tool whose every call is distinct, so the doom-loop detector never fires and the load is the variable.
struct Distinct {
    calls: AtomicUsize,
    /// Characters of output per call.
    bytes: usize,
}

impl Distinct {
    fn new(bytes: usize) -> Arc<Self> {
        Arc::new(Self { calls: AtomicUsize::new(0), bytes })
    }
    fn count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl ToolExecutor for Distinct {
    async fn execute(
        &self,
        c: &ToolCall,
        _token: &CancellationToken,
    ) -> (String, serde_json::Value, ToolOutcome) {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        (
            c.name.clone(),
            json!({ "path": format!("file-{n}.txt") }),
            ToolOutcome::ok(format!("result {n}: {}", "x".repeat(self.bytes))),
        )
    }
}

/// One round asking for `per_round` tool calls.
fn round(index: usize, per_round: usize) -> NormalizedTurn {
    NormalizedTurn::calls(
        (0..per_round)
            .map(|i| call(&format!("c{index}-{i}"), "read_file", json!({ "path": format!("f{index}-{i}.ts") })))
            .collect(),
    )
}

/// A long run must end for the reason it was going to end for, with its counters intact.
#[tokio::test]
async fn a_long_running_task_stays_consistent_over_two_hundred_rounds() {
    const ROUNDS: usize = 200;
    let mut script: Vec<NormalizedTurn> = (0..ROUNDS).map(|i| round(i, 1)).collect();
    script.push(NormalizedTurn::text("finished"));

    let tools = Distinct::new(64);
    let out = AgentLoop::new(Arc::new(ScriptedModel::new(script)), Arc::clone(&tools) as Arc<dyn ToolExecutor>, LoopConfig::default())
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .expect("the run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed), "detail: {:?}", out.stop.detail);
    assert_eq!(out.state.round(), (ROUNDS + 1) as u32);
    assert_eq!(out.state.tool_calls(), ROUNDS as u32);
    assert_eq!(tools.count(), ROUNDS);
    // One record per round, and the transcript grew by exactly what the loop appended.
    assert_eq!(out.turns.len(), ROUNDS + 1);
    // user + (assistant + tool) per round + final assistant
    assert_eq!(out.messages.len(), 1 + ROUNDS * 2 + 1);
}

/// §13's "100+ Tool Call Test", with the calls fanned out rather than serialised.
#[tokio::test]
async fn a_single_run_executes_more_than_a_hundred_tool_calls() {
    const ROUNDS: usize = 12;
    const PER_ROUND: usize = 10;
    let mut script: Vec<NormalizedTurn> = (0..ROUNDS).map(|i| round(i, PER_ROUND)).collect();
    script.push(NormalizedTurn::text("done"));

    let tools = Distinct::new(32);
    let out = AgentLoop::new(Arc::new(ScriptedModel::new(script)), Arc::clone(&tools) as Arc<dyn ToolExecutor>, LoopConfig::default())
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .expect("the run");

    let total = ROUNDS * PER_ROUND;
    assert!(total > 100, "the test should exceed a hundred calls");
    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(out.state.tool_calls(), total as u32);
    assert_eq!(tools.count(), total);

    // Every call has its result, in order. A fan-out that lost or reordered one would show here and nowhere
    // else — a provider rejects an `assistant.tool_calls` whose `tool` message is missing.
    let call_ids: Vec<&str> =
        out.messages.iter().flat_map(|m| m.tool_calls.iter().map(|c| c.id.as_str())).collect();
    let result_ids: Vec<&str> = out.messages.iter().filter_map(|m| m.tool_call_id.as_deref()).collect();
    assert_eq!(call_ids.len(), total);
    assert_eq!(result_ids, call_ids, "results must pair with calls, in order");
}

/// Compaction under sustained pressure, which is the case it is least likely to survive.
#[tokio::test]
async fn a_large_context_stays_within_its_window_for_the_whole_run() {
    const ROUNDS: usize = 60;
    const WINDOW: u64 = 4000;

    let mut script: Vec<NormalizedTurn> = (0..ROUNDS).map(|i| round(i, 2)).collect();
    script.push(NormalizedTurn::text("done"));
    let model = Arc::new(ScriptedModel::new(script));

    let mut manager = ContextManager::new(Budget { max_tokens: WINDOW, compact_at: 0.85, target: 0.5 });
    manager.memory_mut().user_goal = Some("the goal that must survive all of it".into());
    manager.memory_mut().add_constraint("and the constraint too");

    let out = AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Distinct::new(3000),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager))
    .run(vec![Message::user("go")], CancellationToken::new())
    .await
    .expect("the run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed), "detail: {:?}", out.stop.detail);

    // Every request stayed inside the window — not just the first few, and not on average.
    for (i, request) in model.requests().iter().enumerate() {
        let tokens: u64 = request.messages.iter().map(agent_context::estimate_message).sum();
        assert!(tokens <= WINDOW, "round {i} sent {tokens} tokens against a {WINDOW}-token window");
    }

    // And after sixty rounds of pressure the task state is still there.
    let last = model.requests().last().cloned().expect("a final request");
    let text: String = last.messages.iter().map(|m| m.text().to_owned()).collect::<Vec<_>>().join("\n");
    assert!(text.contains("the goal that must survive all of it"), "the goal was lost");
    assert!(text.contains("and the constraint too"), "the constraint was lost");
}

/// Cancellation has to remain responsive when there is a great deal in flight.
#[tokio::test]
async fn cancelling_a_large_fan_out_stops_promptly_and_leaves_a_consistent_record() {
    const PER_ROUND: usize = 200;
    /// Cancels once enough calls have run, so the interruption lands at a known point rather than a timed one.
    struct CancelPartway {
        seen: AtomicUsize,
        at: usize,
        token: Mutex<Option<CancellationToken>>,
    }
    #[async_trait::async_trait]
    impl ToolExecutor for CancelPartway {
        async fn execute(
            &self,
            c: &ToolCall,
            _token: &CancellationToken,
        ) -> (String, serde_json::Value, ToolOutcome) {
            let n = self.seen.fetch_add(1, Ordering::SeqCst) + 1;
            if n >= self.at {
                if let Some(t) = self.token.lock().unwrap().as_ref() {
                    t.cancel();
                }
            }
            (c.name.clone(), json!({ "n": n }), ToolOutcome::ok(format!("r{n}")))
        }
    }

    let token = CancellationToken::new();
    let tools = Arc::new(CancelPartway {
        seen: AtomicUsize::new(0),
        at: 25,
        token: Mutex::new(Some(token.clone())),
    });

    let out = AgentLoop::new(
        Arc::new(ScriptedModel::new(vec![round(0, PER_ROUND)])),
        Arc::clone(&tools) as Arc<dyn ToolExecutor>,
        LoopConfig::default(),
    )
    .run(vec![], token)
    .await
    .expect("the run");

    assert_eq!(out.stop.reason, Some(StopReason::Cancelled));
    assert!(
        tools.seen.load(Ordering::SeqCst) < PER_ROUND,
        "the remaining calls should not have run: {} of {PER_ROUND}",
        tools.seen.load(Ordering::SeqCst)
    );
    // Fewer results than calls is how a cancelled round is told apart from a completed one.
    assert_eq!(out.turns[0].tool_calls.len(), PER_ROUND);
    assert!(out.turns[0].tool_results.len() < PER_ROUND);
}

/// A delegation's caps have to hold under load, since nobody is watching one.
#[tokio::test]
async fn a_sub_agent_under_load_is_stopped_by_its_tool_call_cap() {
    let script: Vec<NormalizedTurn> = (0..200).map(|i| round(i, 10)).collect();
    let cfg = LoopConfig { stop_policy: StopPolicyConfig::for_sub_agent(), ..Default::default() };

    let out = AgentLoop::new(Arc::new(ScriptedModel::new(script)), Distinct::new(16), cfg)
        .run(vec![], CancellationToken::new())
        .await
        .expect("the run");

    let reason = out.stop.reason.expect("a stop reason");
    assert!(
        matches!(reason, StopReason::MaxToolCalls | StopReason::MaxTurns),
        "expected a cap to stop it, got {reason:?}"
    );
    assert!(!reason.is_successful());
    assert!(out.state.tool_calls() <= 130, "the cap should bound it: {}", out.state.tool_calls());
}
