//! The runtime event bus (spec §13).
//!
//! Every significant state change is published here, and the UI *subscribes* rather than polls. That
//! inversion is the point of the module: today the renderer learns what the agent is doing because the
//! agent loop lives in the renderer and writes React state directly. Once the loop is in the runtime,
//! the only way the UI can stay honest is if the runtime tells it — and the only way a trace can be
//! reconstructed afterwards is if the same stream is recorded.
//!
//! ## Why broadcast, and what it costs
//!
//! `tokio::sync::broadcast` gives every subscriber its own cursor over a bounded ring, so a slow
//! consumer cannot block the producer — a scheduler must never stall because a UI stopped reading.
//! The trade is that a slow consumer *loses* events, and it is told so (`RecvError::Lagged`).
//!
//! That trade is only acceptable because of how the stream is used. Events drive presentation and
//! diagnostics; they are not the system of record. Task state lives in the scheduler's own snapshot
//! and the conversation lives in Electron's store, so a dropped event costs a UI update, never a
//! fact. Anything that *must* not be lost does not belong on this bus — if a future caller needs
//! guaranteed delivery, it needs a different channel, not a bigger ring.

use agent_core::{AgentId, CallId, TaskId};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

/// Ring capacity. Sized so a UI that stops reading for a few seconds during a busy fan-out still
/// catches up rather than lagging; past that, dropping is the correct behaviour.
pub const DEFAULT_CAPACITY: usize = 1024;

/// What happened. Payloads carry the ids needed to place the event in a trace (spec §22).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    TaskSubmitted { task: TaskId, parent: Option<TaskId>, priority: String },
    TaskStarted { task: TaskId },
    TaskCompleted { task: TaskId, duration_ms: u64 },
    TaskFailed { task: TaskId, code: String, message: String },
    /// A cancellation was *asked for*. Paired with `TaskCancelled` to measure how long propagation
    /// actually took — the number spec §22 wants and nothing currently reports.
    TaskCancelRequested { task: TaskId },
    TaskCancelled { task: TaskId },
    /// Held at someone's request, and released again. Distinct from the runtime's own `Waiting`.
    TaskPaused { task: TaskId },
    TaskResumed { task: TaskId },
    TaskTimedOut { task: TaskId, after_ms: u64 },
    TaskRetrying { task: TaskId, attempt: u32, delay_ms: u64 },

    AgentStateChanged { agent: AgentId, from: String, to: String },

    SubAgentCreated { task: TaskId, agent: AgentId },
    SubAgentCompleted { task: TaskId, agent: AgentId },

    ToolRequested { call: CallId, name: String },
    ToolCompleted { call: CallId, name: String, ok: bool, duration_ms: u64 },

    /// What confined one command. `"not requested"` and `"requested and unavailable"` are different
    /// facts, and the audit trail needs to tell them apart.
    SandboxDecided { call: CallId, filesystem: String, network: String },

    /// One MCP call, and whether it reached the server. `delivered: false` covers a refusal, a disconnected
    /// server and a timeout alike — the `detail` says which.
    McpCalled { call: CallId, server: String, tool: String, delivered: bool, detail: Option<String> },

    PermissionRequested { call: CallId, capability: String },
    PermissionDecided { call: CallId, capability: String, granted: bool },

    RuntimeShutdown,
}

/// An event with its envelope. `seq` is monotonic per bus, which is what lets a consumer detect a gap
/// rather than merely be told it lagged.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub seq: u64,
    /// Milliseconds since the Unix epoch, stamped at publication.
    pub at_ms: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
    seq: Arc<AtomicU64>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx, seq: Arc::new(AtomicU64::new(0)) }
    }

    /// Publish. Returns the sequence number assigned.
    ///
    /// Deliberately infallible: `broadcast::send` errors only when there are no subscribers, which is
    /// the normal state for a headless run and emphatically not a reason for a scheduler to care.
    pub fn publish(&self, kind: EventKind) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let event = Event { seq, at_ms: now_ms(), kind };
        let _ = self.tx.send(event);
        seq
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_receive_in_order() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();
        bus.publish(EventKind::RuntimeShutdown);
        bus.publish(EventKind::TaskStarted { task: TaskId::from_host("t1") });

        assert_eq!(rx.recv().await.unwrap().seq, 0);
        let second = rx.recv().await.unwrap();
        assert_eq!(second.seq, 1);
        assert!(matches!(second.kind, EventKind::TaskStarted { .. }));
    }

    #[tokio::test]
    async fn publishing_without_subscribers_is_not_an_error() {
        let bus = EventBus::new(4);
        // A headless run has no UI attached; this must be a no-op, not a failure the scheduler handles.
        assert_eq!(bus.publish(EventKind::RuntimeShutdown), 0);
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn a_slow_consumer_lags_rather_than_blocking_the_producer() {
        let bus = EventBus::new(2);
        let mut rx = bus.subscribe();
        for _ in 0..10 {
            bus.publish(EventKind::RuntimeShutdown);
        }
        // The producer never blocked; the consumer is told it missed events rather than silently
        // receiving a truncated history.
        assert!(matches!(rx.recv().await, Err(broadcast::error::RecvError::Lagged(_))));
    }
}
