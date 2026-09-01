//! Compaction inside a running loop.
//!
//! The unit tests assert that `compact()` does the right thing to a `ContextManager`. What they cannot show is
//! the property §8.3 actually asks for, which is about a *run*: an agent whose conversation was compacted
//! several rounds ago still knows what it was asked to do.
//!
//! So these drive the real loop, with a scripted model that produces enough tool output to force compaction,
//! and then read what the model was actually sent on the last round.

use std::sync::{Arc, Mutex};

use agent_context::{Budget, ContextManager, Tier};
use agent_core::CancellationToken;
use agent_loop::model::call;
use agent_loop::{
    AgentLoop, LoopConfig, Message, NormalizedTurn, ScriptedModel, ToolCall, ToolExecutor, ToolOutcome,
};
use serde_json::json;

/// A tool that returns a great deal of text, which is what makes a context fill up.
///
/// Each call reads a DIFFERENT file and returns different content, because the doom-loop detector is right
/// about identical calls returning identical results: six of those is a loop, and a run that stopped for that
/// reason would end after four rounds and make every assertion below weaker than it appears.
struct Verbose {
    bytes: usize,
    calls: Mutex<usize>,
}

impl Verbose {
    fn new(bytes: usize) -> Self {
        Self { bytes, calls: Mutex::new(0) }
    }
}

#[async_trait::async_trait]
impl ToolExecutor for Verbose {
    async fn execute(
        &self,
        c: &ToolCall,
        _token: &CancellationToken,
    ) -> (String, serde_json::Value, ToolOutcome) {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        (
            c.name.clone(),
            json!({ "path": format!("big-{n}.txt") }),
            ToolOutcome::ok(format!("file {n}: {}", "x".repeat(self.bytes))),
        )
    }
}

fn manager_with_goal(window: u64) -> ContextManager {
    let mut m = ContextManager::new(Budget { max_tokens: window, compact_at: 0.85, target: 0.5 });
    {
        let memory = m.memory_mut();
        memory.user_goal = Some("migrate the runtime to Rust".into());
        memory.set_plan("finish the context crate, then wire it");
        memory.add_constraint("never lose the user's goal");
    }
    m
}

/// The property §8.3 is actually asking for.
#[tokio::test]
async fn an_agent_whose_context_was_compacted_still_knows_its_goal() {
    // Six rounds of large tool output, then an answer.
    let mut script: Vec<NormalizedTurn> = (0..6)
        .map(|i| NormalizedTurn::calls(vec![call(&format!("c{i}"), "read_file", json!({ "path": "big.txt" }))]))
        .collect();
    script.push(NormalizedTurn::text("done"));
    let model = Arc::new(ScriptedModel::new(script));

    let out = AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Arc::new(Verbose::new(4000)),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager_with_goal(2000)))
    .run(vec![Message::user("do the migration")], CancellationToken::new())
    .await
    .expect("the run");

    assert_eq!(out.stop.reason, Some(agent_loop::StopReason::Completed));

    // What the model saw on its LAST round — after several compactions.
    let last = model.requests().last().cloned().expect("a final request");
    let text: String = last.messages.iter().map(|m| m.text().to_owned()).collect::<Vec<_>>().join("\n");
    for expected in ["migrate the runtime to Rust", "finish the context crate", "never lose the user's goal"] {
        assert!(text.contains(expected), "the run lost {expected:?} to compaction");
    }
}

/// Compaction has to actually have happened, or the test above proves nothing.
#[tokio::test]
async fn the_conversation_is_kept_under_the_window_across_many_rounds() {
    let mut script: Vec<NormalizedTurn> = (0..10)
        .map(|i| NormalizedTurn::calls(vec![call(&format!("c{i}"), "read_file", json!({ "path": "big.txt" }))]))
        .collect();
    script.push(NormalizedTurn::text("done"));
    let model = Arc::new(ScriptedModel::new(script));

    let window = 2000;
    AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Arc::new(Verbose::new(4000)),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager_with_goal(window)))
    .run(vec![Message::user("go")], CancellationToken::new())
    .await
    .expect("the run");

    // Without compaction this grows unbounded: ten rounds of 4000 characters is ~10,000 tokens against a
    // 2000-token window.
    for (i, request) in model.requests().iter().enumerate() {
        let tokens: u64 = request.messages.iter().map(agent_context::estimate_message).sum();
        assert!(tokens <= window, "round {i} sent {tokens} tokens against a {window}-token window");
    }
}

/// A tool result cannot simply vanish: the provider rejects an unpaired `assistant.tool_calls`.
#[tokio::test]
async fn every_tool_call_still_has_its_result_after_compaction() {
    let mut script: Vec<NormalizedTurn> = (0..8)
        .map(|i| NormalizedTurn::calls(vec![call(&format!("c{i}"), "read_file", json!({ "path": "big.txt" }))]))
        .collect();
    script.push(NormalizedTurn::text("done"));
    let model = Arc::new(ScriptedModel::new(script));

    AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Arc::new(Verbose::new(4000)),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager_with_goal(2000)))
    .run(vec![Message::user("go")], CancellationToken::new())
    .await
    .expect("the run");

    let last = model.requests().last().cloned().expect("a final request");
    let call_ids: Vec<&str> = last
        .messages
        .iter()
        .flat_map(|m| m.tool_calls.iter().map(|c| c.id.as_str()))
        .collect();
    let result_ids: Vec<&str> = last.messages.iter().filter_map(|m| m.tool_call_id.as_deref()).collect();

    for id in &call_ids {
        assert!(result_ids.contains(id), "tool call {id} lost its result; the provider would reject this");
    }
}

/// A round after a compaction is a planning round — the model is about to see a conversation it has not seen.
#[tokio::test]
async fn a_compaction_moves_the_execution_state_to_planning() {
    #[derive(Default)]
    struct Seen(Mutex<Vec<u32>>);
    impl agent_loop::LoopObserver for Seen {
        fn compacted(&self, round: u32) {
            self.0.lock().unwrap().push(round);
        }
    }

    let mut script: Vec<NormalizedTurn> = (0..6)
        .map(|i| NormalizedTurn::calls(vec![call(&format!("c{i}"), "read_file", json!({ "path": "big.txt" }))]))
        .collect();
    script.push(NormalizedTurn::text("done"));

    let seen = Arc::new(Seen::default());
    AgentLoop::new(
        Arc::new(ScriptedModel::new(script)),
        Arc::new(Verbose::new(4000)),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager_with_goal(2000)))
    .with_observer(Arc::clone(&seen) as Arc<dyn agent_loop::LoopObserver>)
    .run(vec![Message::user("go")], CancellationToken::new())
    .await
    .expect("the run");

    assert!(!seen.0.lock().unwrap().is_empty(), "compaction never fired, so this test proves nothing");
}

/// A run that never fills its window must be untouched — compaction is not a tax on short conversations.
#[tokio::test]
async fn a_short_conversation_is_sent_exactly_as_it_stands() {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("hello")]));
    let manager = ContextManager::new(Budget::with_window(100_000));

    AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Arc::new(Verbose::new(10)),
        LoopConfig::default(),
    )
    .with_context(Box::new(manager))
    .run(vec![Message::user("hi")], CancellationToken::new())
    .await
    .expect("the run");

    let sent = &model.requests()[0];
    assert_eq!(sent.messages.len(), 1, "nothing should have been added or removed");
    assert_eq!(sent.messages[0].text(), "hi");
}

/// The loop with no strategy must behave exactly as it did before the seam existed.
#[tokio::test]
async fn a_loop_without_a_context_strategy_is_unchanged() {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("hello")]));
    AgentLoop::new(
        Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
        Arc::new(Verbose::new(10)),
        LoopConfig::default(),
    )
    .run(vec![Message::system("be helpful"), Message::user("hi")], CancellationToken::new())
    .await
    .expect("the run");

    let sent = &model.requests()[0];
    assert_eq!(sent.messages.len(), 2);
    assert_eq!(sent.messages[0].role, "system");
}

/// Tiers are assigned by whoever knows, not inferred from prose.
#[tokio::test]
async fn a_caller_can_mark_a_turn_as_worth_keeping() {
    let mut m = ContextManager::new(Budget { max_tokens: 400, compact_at: 0.85, target: 0.5 });
    m.push(Message::assistant("the decision that matters"), Tier::High);
    m.push(Message::assistant("x".repeat(8000)), Tier::Normal);
    m.compact();

    let wire = m.wire();
    assert_eq!(wire[0].text(), "the decision that matters", "a High turn must survive untouched");
    assert!(wire[1].text().len() < 8000, "the Normal turn should have been compressed");
}
