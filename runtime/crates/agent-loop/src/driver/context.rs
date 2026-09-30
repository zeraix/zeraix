//! The context seam: how the conversation is prepared for each request, and the strategy that changes nothing.

use crate::model::Message;

/// How the conversation is kept within the model's window.
///
/// A trait for the same reason [`ModelClient`](crate::ModelClient) and [`ToolExecutor`](super::ToolExecutor) are: the loop owns *when* the context is
/// prepared — once per round, before the request is built — and nothing about *how*. Budgets, memory tiers and
/// compaction live in `agent-context`, which depends on this crate; putting them behind a trait is what keeps
/// that dependency pointing one way.
///
/// ## Why it is async
///
/// Dropping and truncating are decisions a strategy can make on its own. Summarising is not: it is a model
/// call, and it is the only technique that keeps what a conversation MEANT rather than merely what fitted. A
/// synchronous seam quietly rules it out, so the strategy that most needs to exist could not be written behind
/// it. The cost is one boxed future per round, against a request that takes seconds.
#[async_trait::async_trait]
pub trait ContextStrategy: Send + Sync {
    /// Produce the messages for this round.
    ///
    /// Returns the wire array and whether anything was compacted to produce it. The loop uses the flag to move
    /// the execution state — §6.1 makes the round after a compaction a planning round, because the model is
    /// about to be handed a conversation it has not seen before.
    async fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool);
}

/// The default: hand the conversation over untouched.
///
/// A loop with no strategy is not a loop with a broken one — it is a loop whose caller has not asked for
/// context management, and it must behave exactly as it did before the trait existed.
pub struct PassThroughContext;
#[async_trait::async_trait]
impl ContextStrategy for PassThroughContext {
    async fn prepare(&mut self, messages: &[Message]) -> (Vec<Message>, bool) {
        (messages.to_vec(), false)
    }
}
