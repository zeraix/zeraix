//! Loop scenarios — how the runtime reacts to a particular sequence of model outputs.
//!
//! Every test here scripts a model and asserts on what the loop did with it. That is only possible because
//! `ScriptedModel` exists: against a live provider none of these assertions would be deterministic, and the
//! ones that matter most (a cancelled fan-out, a provider failure on round eleven, three stalled rounds) are
//! the hardest to arrange on purpose.
//!
//! The recurring shape is a fake [`ToolExecutor`] that records what it was asked to run, so a test can assert
//! on the two things a response cannot show: the order the loop did things in, and what it did *not* do.

use std::sync::{Arc, Mutex};

use agent_core::CancellationToken;
use agent_loop::{
    AgentLoop, ExecutionPhase, LoopConfig, ModelCapabilities, NormalizedTurn, ScriptedModel, StopPolicyConfig,
    StopReason, ToolCall, ToolExecutor, ToolOutcome,
};
use agent_loop::model::call;
use serde_json::json;

/// A tool executor with a scripted answer per tool name, defaulting to a bland success.
///
/// Records every call in order, and can be told to cancel the run partway — which is how the fan-out test
/// arranges an interruption at a precise point rather than racing a timer.
struct FakeTools {
    ran: Mutex<Vec<String>>,
    /// tool name → (content, ok). Anything unlisted succeeds with "ok".
    answers: Mutex<std::collections::HashMap<String, (String, bool)>>,
    /// Cancel this token once this many calls have run.
    cancel_after: Mutex<Option<(usize, CancellationToken)>>,
}

impl FakeTools {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            ran: Mutex::new(Vec::new()),
            answers: Mutex::new(std::collections::HashMap::new()),
            cancel_after: Mutex::new(None),
        })
    }

    fn answering(self: &Arc<Self>, name: &str, content: &str, ok: bool) -> Arc<Self> {
        self.answers.lock().unwrap().insert(name.into(), (content.into(), ok));
        Arc::clone(self)
    }

    fn cancel_after(self: &Arc<Self>, n: usize, token: CancellationToken) -> Arc<Self> {
        *self.cancel_after.lock().unwrap() = Some((n, token));
        Arc::clone(self)
    }

    fn ran(&self) -> Vec<String> {
        self.ran.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ToolExecutor for FakeTools {
    async fn execute(
        &self,
        call: &ToolCall,
        _token: &CancellationToken,
    ) -> (String, serde_json::Value, ToolOutcome) {
        let count = {
            let mut ran = self.ran.lock().unwrap();
            ran.push(call.name.clone());
            ran.len()
        };
        if let Some((n, token)) = self.cancel_after.lock().unwrap().as_ref() {
            if count >= *n {
                token.cancel();
            }
        }
        let args: serde_json::Value = serde_json::from_str(&call.arguments).unwrap_or(json!({}));
        let answer = self.answers.lock().unwrap().get(&call.name).cloned();
        let outcome = match answer {
            Some((content, true)) => ToolOutcome::ok(content),
            Some((content, false)) => ToolOutcome::failed(content),
            None => ToolOutcome::ok("ok"),
        };
        (call.name.clone(), args, outcome)
    }
}

fn loop_with(model: ScriptedModel, tools: Arc<FakeTools>, cfg: LoopConfig) -> AgentLoop {
    AgentLoop::new(Arc::new(model), tools, cfg)
}

#[tokio::test]
async fn a_model_that_answers_immediately_completes_in_one_round() {
    let model = ScriptedModel::new(vec![NormalizedTurn::text("here is the answer")]);
    let tools = FakeTools::new();
    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(out.turns.len(), 1);
    assert_eq!(out.final_text(), "here is the answer");
    assert!(tools.ran().is_empty());
    assert_eq!(out.state.phase(), ExecutionPhase::Completed);
}

/// The full cycle: the model calls a tool, reads its result, and answers.
#[tokio::test]
async fn a_tool_call_round_feeds_its_result_back_and_the_next_round_answers() {
    let model = ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
        NormalizedTurn::text("the file says hello"),
    ]);
    let tools = FakeTools::new().answering("read_file", "hello", true);
    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![agent_loop::Message::user("read a.ts")], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(tools.ran(), vec!["read_file"]);
    assert_eq!(out.state.tool_calls(), 1);

    // The transcript has to read in the order it happened: user, assistant+calls, tool result, assistant.
    let roles: Vec<&str> = out.messages.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(roles, vec!["user", "assistant", "tool", "assistant"]);
    assert_eq!(out.messages[2].tool_call_id.as_deref(), Some("c1"));
    assert_eq!(out.messages[2].content, "hello");
}

/// A failing tool is the model's problem to solve, not a reason to abort the turn.
#[tokio::test]
async fn a_failing_tool_moves_the_run_to_recovering_and_the_run_continues() {
    let model = ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "run_command", json!({"command": "npm test"}))]),
        NormalizedTurn::calls(vec![call("c2", "read_file", json!({"path": "a.ts"}))]),
        NormalizedTurn::text("fixed it"),
    ]);
    let tools = FakeTools::new().answering("run_command", "3 tests failed", false);
    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(tools.ran(), vec!["run_command", "read_file"]);
    assert_eq!(out.turns.len(), 3);
    assert!(!out.turns[0].tool_results[0].ok);
}

/// The reasoning policy is applied before the request exists, so it cannot be forgotten downstream.
#[tokio::test]
async fn a_recovery_round_is_issued_at_full_effort_and_an_executing_round_is_not() {
    let varying = ModelCapabilities { supports_per_turn_reasoning_effort: true, ..Default::default() };
    let model = ScriptedModel::new(vec![
        // Round 1 (planning) → a successful tool.
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
        // Round 2 (executing, because nothing failed) → a failing tool.
        NormalizedTurn::calls(vec![call("c2", "run_command", json!({"command": "x"}))]),
        // Round 3 must be issued at the user's full effort: the previous round failed.
        NormalizedTurn::text("done"),
    ])
    .with_capabilities(varying);
    let model = Arc::new(model);
    let tools = FakeTools::new().answering("run_command", "boom", false);

    let cfg = LoopConfig {
        thinking: agent_loop::ThinkingConfig { enabled: true, effort: agent_loop::Effort::High },
        ..Default::default()
    };
    let out = AgentLoop::new(Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>, tools, cfg)
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    let efforts: Vec<Option<String>> =
        model.requests().into_iter().map(|r| r.reasoning_effort).collect();
    assert_eq!(efforts[0].as_deref(), Some("high"), "planning keeps the user's effort");
    assert_eq!(efforts[1].as_deref(), Some("low"), "executing may be economised on");
    assert_eq!(efforts[2].as_deref(), Some("high"), "recovering must keep the user's effort");
    assert_eq!(out.stop.reason, Some(StopReason::Completed));
}

/// Cancellation must reach the calls that have not run yet, not merely the run as a whole.
#[tokio::test]
async fn cancelling_a_fan_out_stops_at_the_interrupted_call() {
    let token = CancellationToken::new();
    let model = ScriptedModel::new(vec![NormalizedTurn::calls(vec![
        call("c1", "read_file", json!({"path": "a.ts"})),
        call("c2", "read_file", json!({"path": "b.ts"})),
        call("c3", "read_file", json!({"path": "c.ts"})),
        call("c4", "read_file", json!({"path": "d.ts"})),
    ])]);
    let tools = FakeTools::new().cancel_after(2, token.clone());

    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], token)
        .await
        .expect("run");

    assert_eq!(tools.ran().len(), 2, "the remaining calls must not run");
    assert_eq!(out.stop.reason, Some(StopReason::Cancelled));
    // Fewer results than calls is how a cancelled round is told apart from a completed one.
    assert_eq!(out.turns[0].tool_calls.len(), 4);
    assert_eq!(out.turns[0].tool_results.len(), 2);
}

#[tokio::test]
async fn a_run_cancelled_before_it_starts_issues_no_request_at_all() {
    let token = CancellationToken::new();
    token.cancel();
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("never asked")]));
    let out = AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        FakeTools::new(),
        LoopConfig::default(),
    )
    .run(vec![], token)
    .await
    .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Cancelled));
    assert_eq!(model.request_count(), 0);
    assert!(out.turns.is_empty());
}

/// A provider failure on a late round must not cost the user the rounds that did complete.
#[tokio::test]
async fn a_provider_failure_ends_the_run_but_keeps_the_rounds_that_completed() {
    let model = ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
        NormalizedTurn::calls(vec![call("c2", "read_file", json!({"path": "b.ts"}))]),
    ])
    .then_fails("502 Bad Gateway");
    let tools = FakeTools::new();

    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("a provider failure is a stop reason, not an Err");

    assert_eq!(out.stop.reason, Some(StopReason::Error));
    assert!(out.stop.detail.unwrap().contains("502"));
    assert_eq!(tools.ran().len(), 2, "the work that did happen is still reported");
    assert_eq!(out.turns.len(), 3, "including the round that failed");
}

/// The detector's whole job, end to end: a model that will not stop repeating itself is stopped.
#[tokio::test]
async fn a_model_that_repeats_one_call_forever_is_stopped_as_a_doom_loop() {
    let repeat = || NormalizedTurn::calls(vec![call("c", "read_file", json!({"path": "a.ts"}))]);
    let model = ScriptedModel::new((0..10).map(|_| repeat()).collect());
    let tools = FakeTools::new().answering("read_file", "always the same", true);

    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::DoomLoop));
    assert!(!out.stop.reason.unwrap().is_successful());
    // Round 1 establishes the call; rounds 2-4 are the three stalled rounds that escalate.
    assert_eq!(tools.ran().len(), 4);
}

/// The false positive the detector must not have, proven through the loop rather than the unit.
#[tokio::test]
async fn re_running_a_command_over_changing_output_is_never_a_doom_loop() {
    struct ChangingTools {
        runs: Mutex<u32>,
    }
    #[async_trait::async_trait]
    impl ToolExecutor for ChangingTools {
        async fn execute(
            &self,
            call: &ToolCall,
            _token: &CancellationToken,
        ) -> (String, serde_json::Value, ToolOutcome) {
            let mut runs = self.runs.lock().unwrap();
            *runs += 1;
            (call.name.clone(), json!({"command": "npm test"}), ToolOutcome::ok(format!("{} failing", 9 - *runs)))
        }
    }

    let same_call = || NormalizedTurn::calls(vec![call("c", "run_command", json!({"command": "npm test"}))]);
    let mut script: Vec<NormalizedTurn> = (0..6).map(|_| same_call()).collect();
    script.push(NormalizedTurn::text("all green"));

    let out = AgentLoop::new(
        Arc::new(ScriptedModel::new(script)),
        Arc::new(ChangingTools { runs: Mutex::new(0) }),
        LoopConfig::default(),
    )
    .run(vec![], CancellationToken::new())
    .await
    .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Completed), "changing output is progress, not a loop");
    assert_eq!(out.state.tool_calls(), 6);
}

#[tokio::test]
async fn a_sub_agents_turn_cap_stops_a_run_that_will_not_end() {
    let busy = || NormalizedTurn::calls(vec![call("c", "read_file", json!({"path": "a.ts"}))]);
    let model = ScriptedModel::new((0..60).map(|_| busy()).collect());
    // Distinct output each time, so the doom detector never fires and the cap is what stops it.
    struct Fresh {
        n: Mutex<u32>,
    }
    #[async_trait::async_trait]
    impl ToolExecutor for Fresh {
        async fn execute(
            &self,
            call: &ToolCall,
            _token: &CancellationToken,
        ) -> (String, serde_json::Value, ToolOutcome) {
            let mut n = self.n.lock().unwrap();
            *n += 1;
            (call.name.clone(), json!({"path": format!("f{n}.ts")}), ToolOutcome::ok(format!("body {n}")))
        }
    }

    let cfg = LoopConfig { stop_policy: StopPolicyConfig::for_sub_agent(), ..Default::default() };
    let out = AgentLoop::new(Arc::new(model), Arc::new(Fresh { n: Mutex::new(0) }), cfg)
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::MaxTurns));
    assert_eq!(out.turns.len(), 40);
}

/// Six consecutive failures across DIFFERENT tools is a run that is not recovering on its own.
///
/// Different tools on purpose: `fail_streak` is per tool name, so a run of failures from one tool trips the
/// detector's `failing` signal first and is reported as a doom loop — which is the more specific diagnosis and
/// the one the next test pins. This is the other shape, where nothing repeats and the run is simply going
/// wrong.
#[tokio::test]
async fn a_run_of_failures_across_different_tools_stops_the_turn() {
    let tools_named = ["a", "b", "c", "d", "e", "f", "g"];
    let model = ScriptedModel::new(
        tools_named
            .iter()
            .map(|n| NormalizedTurn::calls(vec![call("c", n, json!({"path": format!("{n}.ts")}))]))
            .collect(),
    );

    struct AlwaysFails;
    #[async_trait::async_trait]
    impl ToolExecutor for AlwaysFails {
        async fn execute(
            &self,
            call: &ToolCall,
            _token: &CancellationToken,
        ) -> (String, serde_json::Value, ToolOutcome) {
            let args: serde_json::Value = serde_json::from_str(&call.arguments).unwrap_or(json!({}));
            (call.name.clone(), args, ToolOutcome::failed(format!("{} exploded", call.name)))
        }
    }

    let out = AgentLoop::new(Arc::new(model), Arc::new(AlwaysFails), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::Error));
    assert!(out.stop.detail.unwrap().contains("consecutive tool failures"));
    assert_eq!(out.state.consecutive_failures(), 6);
}

/// The precedence in the stop policy, proven end to end.
///
/// One tool failing over and over is *both* a run of failures and a loop, and the loop is what the user is
/// told — a more specific diagnosis, delivered sooner. Reversing this would report "6 consecutive tool
/// failures" for a model that was stuck on one call, which describes the symptom rather than the problem.
#[tokio::test]
async fn one_tool_failing_repeatedly_is_reported_as_a_loop_rather_than_as_the_failure_ceiling() {
    let failing = || NormalizedTurn::calls(vec![call("c", "run_command", json!({"command": "x"}))]);
    let model = ScriptedModel::new((0..10).map(|_| failing()).collect());
    let tools = FakeTools::new().answering("run_command", "same error", false);

    let out = loop_with(model, Arc::clone(&tools), LoopConfig::default())
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(StopReason::DoomLoop));
    assert!(out.state.consecutive_failures() < 6, "it stopped before the blunter limit could fire");
}

/// The loop must hand the model the conversation it is continuing, not a fresh one each round.
#[tokio::test]
async fn each_round_carries_the_whole_transcript_so_far() {
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
        NormalizedTurn::text("done"),
    ]));
    let _ = AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        FakeTools::new().answering("read_file", "contents", true),
        LoopConfig::default(),
    )
    .run(vec![agent_loop::Message::system("be helpful"), agent_loop::Message::user("read a.ts")], CancellationToken::new())
    .await
    .expect("run");

    let requests = model.requests();
    assert_eq!(requests[0].messages.len(), 2, "the first request is the conversation as given");
    // The second request must also carry the assistant turn and the tool result the first produced.
    let second: Vec<&str> = requests[1].messages.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(second, vec!["system", "user", "assistant", "tool"]);
}

/// The deadline has to fire against a real clock, not only against a hand-built `StopInput`.
#[tokio::test]
async fn a_run_that_outlives_its_task_deadline_is_stopped_by_it() {
    /// A tool that takes long enough to blow a very small budget.
    struct Slow;
    #[async_trait::async_trait]
    impl ToolExecutor for Slow {
        async fn execute(
            &self,
            c: &ToolCall,
            _token: &CancellationToken,
        ) -> (String, serde_json::Value, ToolOutcome) {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            (c.name.clone(), json!({ "path": "a.ts" }), ToolOutcome::ok("done"))
        }
    }

    let busy = || NormalizedTurn::calls(vec![call("c", "read_file", json!({ "path": "a.ts" }))]);
    let model = ScriptedModel::new((0..20).map(|_| busy()).collect());

    let cfg = LoopConfig {
        stop_policy: StopPolicyConfig {
            task_timeout: Some(std::time::Duration::from_millis(250)),
            ..Default::default()
        },
        ..Default::default()
    };
    let out = AgentLoop::new(Arc::new(model), Arc::new(Slow), cfg)
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");

    assert_eq!(out.stop.reason, Some(agent_loop::StopReason::TaskTimeout));
    assert!(!out.stop.reason.unwrap().is_successful());
    // It stopped early rather than running the whole 20-round script.
    assert!(out.turns.len() < 20, "expected an early stop, got {} rounds", out.turns.len());
}

/// A run comfortably inside its deadline must not be affected by having one.
#[tokio::test]
async fn a_deadline_that_is_not_reached_changes_nothing() {
    let model = ScriptedModel::new(vec![NormalizedTurn::text("quick")]);
    let cfg = LoopConfig {
        stop_policy: StopPolicyConfig {
            task_timeout: Some(std::time::Duration::from_secs(60)),
            ..Default::default()
        },
        ..Default::default()
    };
    let out = loop_with(model, FakeTools::new(), cfg)
        .run(vec![], CancellationToken::new())
        .await
        .expect("run");
    assert_eq!(out.stop.reason, Some(StopReason::Completed));
}
