//! The model seam: what the loop is allowed to know about a provider, and the scripted stand-in that makes
//! the loop testable without one.
//!
//! Ported from `src/lib/agent/modelAdapter.ts` and `testModelAdapter.ts` (spec §5, §5.1), with one deliberate
//! difference. On the TypeScript side the adapter *shapes* requests and reads responses but does not send
//! them — transport stayed in `chatRequest.ts`, because a second request path would have duplicated three
//! provider-rejection fallbacks. In Rust the loop is the thing being moved, so the seam has to include
//! sending: [`ModelClient`] is that seam, and it is narrow on purpose. Retries, provider fallbacks and usage
//! logging belong to the implementation behind it, not to the loop in front of it.
//!
//! Nothing here performs I/O. [`ScriptedModel`] is what every loop scenario runs against, which is what makes
//! those scenarios exact rather than merely plausible: asserting on how a runtime reacts to a particular
//! sequence of model outputs is untestable against a live model.

use std::collections::VecDeque;
use std::sync::Mutex;

use agent_core::{ErrorClass, Result, RuntimeError};
use serde::{Deserialize, Serialize};

/// What a model can do, as far as anything can actually be known.
///
/// Reasoning support and *per-turn effort* are separate questions, and conflating them is how a policy ends up
/// offering a lever that silently does nothing: a model can reason while offering no way to ask for less of
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub supports_reasoning: bool,
    pub supports_tool_calling: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_streaming: bool,
    pub supports_structured_output: bool,
    /// Whether reasoning effort can be set per request — the gate for a per-turn effort override.
    pub supports_per_turn_reasoning_effort: bool,
    pub supports_images: bool,
    pub context_window: Option<u64>,
}

impl Default for ModelCapabilities {
    /// The OpenAI-compatible baseline, which is what every provider this app talks to speaks.
    ///
    /// `supports_tool_calling` is true unconditionally, and that is a statement about this codebase rather
    /// than about language models in general: a provider that could not call tools could not run this app at
    /// all. If one is ever added, this is the function that must learn about it.
    fn default() -> Self {
        Self {
            supports_reasoning: true,
            supports_tool_calling: true,
            supports_parallel_tool_calls: true,
            supports_streaming: true,
            supports_structured_output: false,
            supports_per_turn_reasoning_effort: false,
            supports_images: false,
            context_window: None,
        }
    }
}

/// One tool call as the provider emitted it.
///
/// `arguments` stays a string, unparsed, because that is what arrives on the wire and because reading it is a
/// decision with its own rules — a truncated payload must report that nothing ran rather than run with `{}`.
/// The loop hands the raw string to whoever owns those rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// One provider response, reduced to what the loop acts on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedTurn {
    /// Assistant text. Empty string rather than null, so callers never branch on the difference.
    pub content: String,
    /// The separate reasoning body, under whichever field name the provider used. Empty when there is none.
    pub reasoning: String,
    /// Never absent — an empty vector means "no tools", which is the loop's exit condition.
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
}

impl NormalizedTurn {
    /// A plain answer with no tool calls: the normal end of a run.
    pub fn text(content: impl Into<String>) -> Self {
        Self { content: content.into(), ..Default::default() }
    }

    /// A round that calls tools and says nothing.
    pub fn calls(calls: Vec<ToolCall>) -> Self {
        Self { tool_calls: calls, ..Default::default() }
    }
}

/// One message on the wire.
///
/// Deliberately not a rich enum over roles: the loop appends assistant turns and tool results and hands the
/// array back to the client, and a shape that mirrors what providers accept keeps the client from having to
/// translate twice.
///
/// `content` is a `Value` rather than a `String` because that is what the OpenAI-compatible schema actually
/// permits — a string, *or* an array of typed parts, which is how an image is sent. Modelling it as a string
/// would put the transport in the position of having to reconstruct a shape the loop had already flattened,
/// and the image fallback in `agent-provider` depends on being able to see the parts to strip them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(default, skip_serializing_if = "is_empty_content")]
    pub content: serde_json::Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Set on a `tool` message, pairing it with the call it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// A replayed thinking block, when the user has asked for reasoning to be sent as context.
    ///
    /// An output-side field in the OpenAI-compatible schema, so a strict provider answers a *request* carrying
    /// it with a 400 — which is one of the three rejections `agent-provider` recovers from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

fn is_empty_content(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::String(s) => s.is_empty(),
        serde_json::Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self::of("system", content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::of("user", content)
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::of("assistant", content)
    }

    fn of(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_owned(),
            content: serde_json::Value::String(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    /// A message whose content is an array of typed parts — text and images.
    pub fn parts(role: &str, parts: Vec<serde_json::Value>) -> Self {
        Self {
            role: role.to_owned(),
            content: serde_json::Value::Array(parts),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    /// The assistant turn that carries tool calls. Kept alongside its text: a provider that returned both
    /// must be replayed with both, or the next request contradicts the transcript it is continuing.
    pub fn assistant_calls(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self { tool_calls, ..Self::of("assistant", content) }
    }

    /// One tool's result, paired with the call that produced it.
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self { tool_call_id: Some(tool_call_id.into()), ..Self::of("tool", content) }
    }

    pub fn with_reasoning(mut self, reasoning: impl Into<String>) -> Self {
        self.reasoning_content = Some(reasoning.into());
        self
    }

    /// The content as text. Empty for a parts array — callers wanting the parts should read `content`.
    pub fn text(&self) -> &str {
        self.content.as_str().unwrap_or("")
    }

    /// Does this message carry an image part?
    pub fn has_images(&self) -> bool {
        self.content
            .as_array()
            .is_some_and(|parts| parts.iter().any(|p| p["type"] == "image_url"))
    }
}

/// One request the loop wants issued.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<Message>,
    /// Tool declarations, already in the provider's shape. Empty withdraws tools for this request, which is
    /// how a wrap-up round asks for a final answer and nothing else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<serde_json::Value>,
    /// The effort this particular request should run at, when the model supports varying it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// The transport seam.
///
/// One method, because the loop only ever needs one thing from a provider. Everything a real implementation
/// also has to do — retries, the three provider-rejection fallbacks, usage accounting — lives behind it, so
/// that this crate can be tested without any of it and so that there is one request path rather than two.
#[async_trait::async_trait]
pub trait ModelClient: Send + Sync {
    /// The model id actually sent to the provider, not a display label.
    fn id(&self) -> &str;

    fn capabilities(&self) -> ModelCapabilities;

    async fn complete(&self, request: &ModelRequest) -> Result<NormalizedTurn>;
}

/// A model that returns a prepared sequence of turns.
///
/// This is what makes the loop's scenarios exact. Every assertion about how the runtime reacts to a
/// particular sequence of model outputs — a tool call, then a failure, then a repeat, then a final answer — is
/// non-deterministic against a live model and pinned against this one.
///
/// It also records what it was asked, which is how a test asserts on the things the loop is responsible for
/// but a response cannot show: that tool results were replayed in the right order, that a wrap-up round
/// withdrew the tools, that the effort varied with the phase.
pub struct ScriptedModel {
    id: String,
    capabilities: ModelCapabilities,
    script: Mutex<VecDeque<ScriptedStep>>,
    seen: Mutex<Vec<ModelRequest>>,
}

enum ScriptedStep {
    Turn(NormalizedTurn),
    Failure(String),
}

impl ScriptedModel {
    /// A model that will answer with each of `turns` in order.
    pub fn new(turns: Vec<NormalizedTurn>) -> Self {
        Self {
            id: "scripted".into(),
            capabilities: ModelCapabilities::default(),
            script: Mutex::new(turns.into_iter().map(ScriptedStep::Turn).collect()),
            seen: Mutex::new(Vec::new()),
        }
    }

    /// Queue a provider failure at this point in the script.
    pub fn then_fails(self, message: impl Into<String>) -> Self {
        self.script.lock().expect("script").push_back(ScriptedStep::Failure(message.into()));
        self
    }

    pub fn with_capabilities(mut self, capabilities: ModelCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// Every request this model was asked to complete, in order.
    pub fn requests(&self) -> Vec<ModelRequest> {
        self.seen.lock().expect("seen").clone()
    }

    pub fn request_count(&self) -> usize {
        self.seen.lock().expect("seen").len()
    }
}

#[async_trait::async_trait]
impl ModelClient for ScriptedModel {
    fn id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> ModelCapabilities {
        self.capabilities.clone()
    }

    async fn complete(&self, request: &ModelRequest) -> Result<NormalizedTurn> {
        self.seen.lock().expect("seen").push(request.clone());
        let next = self.script.lock().expect("script").pop_front();
        match next {
            Some(ScriptedStep::Turn(turn)) => Ok(turn),
            Some(ScriptedStep::Failure(message)) => {
                Err(RuntimeError::retryable("model.failed", message))
            }
            // Running off the end of a script is a test that did not describe what it was testing — an
            // exhausted model must not look like a model that chose to stop, or a loop that ran one round too
            // many would read as a clean completion.
            None => Err(RuntimeError::new(
                "model.script_exhausted",
                ErrorClass::Internal,
                "the scripted model ran out of turns: the loop asked for more rounds than the test described",
            )),
        }
    }
}

/// One tool call, for building scripts.
pub fn call(id: &str, name: &str, arguments: serde_json::Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), arguments: arguments.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn a_scripted_model_answers_in_order_and_records_what_it_was_asked() {
        let m = ScriptedModel::new(vec![
            NormalizedTurn::calls(vec![call("c1", "read_file", json!({"path": "a.ts"}))]),
            NormalizedTurn::text("done"),
        ]);
        let req = ModelRequest { model: "scripted".into(), ..Default::default() };

        let first = m.complete(&req).await.expect("first turn");
        assert_eq!(first.tool_calls.len(), 1);
        assert_eq!(first.tool_calls[0].name, "read_file");

        let second = m.complete(&req).await.expect("second turn");
        assert_eq!(second.content, "done");
        assert!(second.tool_calls.is_empty());

        assert_eq!(m.request_count(), 2);
    }

    /// A test that runs off the end of its own script has not described what it is testing.
    #[tokio::test]
    async fn an_exhausted_script_fails_rather_than_looking_like_a_model_that_stopped() {
        let m = ScriptedModel::new(vec![NormalizedTurn::text("only one")]);
        let req = ModelRequest::default();
        m.complete(&req).await.expect("scripted turn");
        let err = m.complete(&req).await.expect_err("must not answer past the script");
        assert_eq!(err.code, "model.script_exhausted");
    }

    #[tokio::test]
    async fn a_scripted_provider_failure_surfaces_as_an_upstream_error() {
        let m = ScriptedModel::new(vec![]).then_fails("502 from the provider");
        let err = m.complete(&ModelRequest::default()).await.expect_err("scripted failure");
        assert_eq!(err.class, ErrorClass::Retryable);
        assert!(err.message.contains("502"));
    }

    #[test]
    fn an_assistant_turn_carrying_tool_calls_keeps_its_text() {
        let m = Message::assistant_calls("I will read it", vec![call("c1", "read_file", json!({}))]);
        assert_eq!(m.role, "assistant");
        assert_eq!(m.text(), "I will read it");
        assert_eq!(m.tool_calls.len(), 1);
    }

    #[test]
    fn a_tool_message_is_paired_with_the_call_it_answers() {
        let m = Message::tool_result("c1", "contents");
        assert_eq!(m.role, "tool");
        assert_eq!(m.tool_call_id.as_deref(), Some("c1"));
    }
}
