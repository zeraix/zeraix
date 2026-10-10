//! Measuring the context by the provider's own count, not by the estimate alone.
//!
//! The estimate cannot see what a provider counts beside the messages — tool declarations are thousands of tokens on
//! every request — nor the provider's tokenizer. Both grok-build and ZCode take the provider's prompt count for the
//! last request and add an estimate of what came after; so does this. These pin both directions, the guard against a
//! count that means something else, and that the loop actually reports the count.

use std::sync::Arc;

use agent_context::{Budget, ContextManager};
use agent_core::CancellationToken;
use agent_loop::model::call;
use agent_loop::{
    AgentLoop, ContextStrategy, LoopConfig, Message, NormalizedTurn, ScriptedModel, ToolCall, ToolExecutor, ToolOutcome,
    Usage,
};
use serde_json::json;

const REMOVED: &str = "tool output removed";

fn read(id: &str) -> Message {
    Message::assistant_calls("", vec![call(id, "read_file", json!({ "path": format!("{id}.rs") }))])
}

/// A read and its result of about `tokens` tokens.
fn round(id: &str, tokens: usize) -> [Message; 2] {
    [read(id), Message::tool_result(id, format!("{id} {}", "x".repeat(tokens * 4)))]
}

fn sent<'a>(prepared: &'a [Message], id: &str) -> &'a str {
    prepared.iter().find(|m| m.tool_call_id.as_deref() == Some(id)).map(Message::text).expect("the result")
}

fn window() -> ContextManager {
    ContextManager::new(Budget::with_window(100_000)) // compacts above 85K, down to 60K
}

/// The provider counts ~20K the estimate cannot see: compaction must start from what the provider counts.
#[tokio::test]
async fn a_count_above_the_estimate_brings_compaction_forward() {
    let mut conversation = vec![Message::user("look")];
    for (id, tokens) in [("c0", 25_000), ("c1", 25_000), ("c2", 24_000)] {
        conversation.extend(round(id, tokens));
    }
    let mut m = window();
    let (_, compacted) = m.prepare(&conversation).await;
    assert!(!compacted, "~74K by the estimate is under the 85K threshold");

    m.observe_prompt_tokens(94_000);
    conversation.extend(round("c3", 1_000));
    let (prepared, compacted) = m.prepare(&conversation).await;

    assert!(compacted, "~95K as the provider counts it is over the threshold");
    assert!(sent(&prepared, "c0").contains(REMOVED));
    assert!(m.measured_tokens() <= 60_000, "down to the window's target as measured: {}", m.measured_tokens());

    let mut estimate_only = window();
    let (_, compacted) = estimate_only.prepare(&conversation).await;
    assert!(!compacted, "the control: the estimate alone would have let it through");
}

/// The estimate ran high (dense non-ASCII text, say): the provider's lower count defers a compaction it does not need.
#[tokio::test]
async fn a_count_below_the_estimate_scales_it_down() {
    let mut conversation = vec![Message::user("look")];
    conversation.extend(round("c0", 35_000));
    conversation.extend(round("c1", 35_000));
    let mut m = window();
    m.prepare(&conversation).await;

    m.observe_prompt_tokens(47_000); // two thirds of the ~70K estimate
    conversation.extend(round("c2", 20_000));
    let (_, compacted) = m.prepare(&conversation).await;
    assert!(!compacted, "~90K estimated is ~60K as the provider counts it");

    let mut estimate_only = window();
    let (_, compacted) = estimate_only.prepare(&conversation).await;
    assert!(compacted, "the control: the estimate alone crosses 85K");
}

/// A count far below the estimate is a different quantity (cached tokens left out), not a better measurement.
#[tokio::test]
async fn an_implausibly_low_count_is_ignored() {
    let mut conversation = vec![Message::user("look")];
    conversation.extend(round("c0", 35_000));
    conversation.extend(round("c1", 35_000));
    let mut m = window();
    m.prepare(&conversation).await;

    m.observe_prompt_tokens(10_000); // a seventh of the estimate
    conversation.extend(round("c2", 20_000));
    let (_, compacted) = m.prepare(&conversation).await;
    assert!(compacted, "trusting that count would have held compaction back until the request overflowed");
}

/// A count is only meaningful against the request it measured.
#[tokio::test]
async fn a_count_with_no_request_behind_it_is_ignored() {
    let mut m = window();
    m.observe_prompt_tokens(500_000);
    assert_eq!(m.measured_tokens(), m.tokens(), "nothing was prepared, so there is nothing to set the count against");
}

/// Two reads of different files, each result distinct, so the loop's doom detector has nothing to object to.
struct Reads;

#[async_trait::async_trait]
impl ToolExecutor for Reads {
    async fn execute(&self, c: &ToolCall, _token: &CancellationToken) -> (String, serde_json::Value, ToolOutcome) {
        (c.name.clone(), json!({}), ToolOutcome::ok(format!("{} {}", c.id, "x".repeat(4_000))))
    }
}

/// The loop reports the provider's count, and the next round is measured by it.
#[tokio::test]
async fn the_loop_reports_the_providers_count_to_the_strategy() {
    async fn third_request(reported: Option<Usage>) -> Vec<Message> {
        let script = vec![
            NormalizedTurn::calls(vec![call("c0", "read_file", json!({ "path": "a.rs" }))]),
            NormalizedTurn { usage: reported, ..NormalizedTurn::calls(vec![call("c1", "read_file", json!({ "path": "b.rs" }))]) },
            NormalizedTurn::text("done"),
        ];
        let model = Arc::new(ScriptedModel::new(script));
        AgentLoop::new(Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>, Arc::new(Reads), LoopConfig::default())
            .with_context(Box::new(window()))
            .run(vec![Message::user("go")], CancellationToken::new())
            .await
            .expect("the run");
        model.requests().get(2).expect("a third request").messages.clone()
    }

    // ~2K of messages, but the provider counted 90K for the request before: tool declarations, a system prompt.
    let counted = third_request(Some(Usage { prompt_tokens: 90_000, ..Default::default() })).await;
    assert!(sent(&counted, "c0").contains(REMOVED), "the count put the run over its window's threshold");
    assert!(sent(&counted, "c1").starts_with("c1 "), "the result not yet seen stays");

    let unreported = third_request(None).await;
    assert!(sent(&unreported, "c0").starts_with("c0 "), "the control: without a count, ~2K is nowhere near");

    let estimated = third_request(Some(Usage { prompt_tokens: 90_000, estimated: true, ..Default::default() })).await;
    assert!(sent(&estimated, "c0").starts_with("c0 "), "an estimated usage is no count, and must not be treated as one");
}
