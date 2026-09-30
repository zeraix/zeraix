//! The tool seam: what the loop asks of whatever executes a call, and what it gets back.

use agent_core::CancellationToken;

use crate::model::ToolCall;

/// What executing one tool produced.
///
/// There is no error variant, and that is deliberate: a tool that fails produces a *result* saying so, which
/// the model reads and responds to. An `Err` here would abort the turn, and a failing tool is the most
/// ordinary thing that happens in an agent run — the model is usually the right thing to hand it to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    /// The text fed back to the model, after any capping.
    pub content: String,
    pub ok: bool,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self { content: content.into(), ok: true }
    }
    pub fn failed(content: impl Into<String>) -> Self {
        Self { content: content.into(), ok: false }
    }
}

/// One executed call, as the loop records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRecord {
    /// Pairs with [`ToolCall::id`], which is what keeps the assistant turn aligned with its results.
    pub tool_call_id: String,
    /// The RESOLVED tool name, never a dispatcher's — a routed call must not be recorded as `call_tool`.
    pub name: String,
    /// Arguments as executed, after routing resolved them.
    pub args: serde_json::Value,
    pub content: String,
    pub ok: bool,
    pub ms: u64,
}

/// The tool seam.
///
/// Resolving a call — reading its `arguments` string, routing a dispatcher, applying permission — belongs to
/// the implementation, not to the loop. The loop needs three things back: what actually ran, what to tell the
/// model, and whether it worked.
#[async_trait::async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Execute one call. Must not panic and must honour `token`.
    ///
    /// The returned `name` and `args` are what the loop records and what the doom-loop detector sees, so an
    /// implementation that routes a call is expected to report the resolved name rather than the wrapper's.
    async fn execute(
        &self,
        call: &ToolCall,
        token: &CancellationToken,
    ) -> (String, serde_json::Value, ToolOutcome);

    /// The arguments to REPLAY for `call` on later requests, when they must differ from what the model sent.
    ///
    /// A call whose `arguments` are not valid JSON is refused by the provider on every later request that
    /// replays it — the conversation dies, not the round. The executor owns the rules for reading arguments, so
    /// it also says what a readable copy is. The call itself still executes as sent, so the error it reports is
    /// about what the model actually wrote. `None`, the default, replays the call byte for byte.
    fn replay_arguments(&self, call: &ToolCall) -> Option<String> {
        let _ = call;
        None
    }

    /// The name `call` will RUN as — what decides whether it may run beside its neighbours.
    ///
    /// An implementation that routes calls must resolve here too. The chat reaches its reads through a
    /// dispatcher — `call_tool{name: "read_file", …}` — and batching on the wrapper's name never recognised one
    /// as a read, so every batch of reads ran one at a time; the TypeScript loop had always batched on the
    /// resolved name. The default is the name as sent.
    fn resolved_name(&self, call: &ToolCall) -> String {
        call.name.clone()
    }
}
