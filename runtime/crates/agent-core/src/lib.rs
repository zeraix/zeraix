//! Core types shared by every runtime crate: identifiers, the error model, and the agent/task state
//! machines.
//!
//! Deliberately dependency-light — no tokio runtime, no IPC, no tools. Anything that needs to name a
//! task, report a failure, or describe where an agent is in its life depends on this crate; this crate
//! depends on nothing in the workspace. That is what keeps the boundaries in spec §3 real rather than
//! nominal.

pub mod error;
pub mod ids;
pub mod state;

pub use error::{ErrorClass, ErrorPayload, Result, RuntimeError};
pub use ids::{AgentId, CallId, TaskId};
pub use state::{AgentState, TaskState};

/// Re-exported so every crate cancels through the same token type rather than inventing its own.
///
/// Spec §14 forbids boolean cancellation. Making the token part of the core vocabulary is the cheapest
/// way to make the correct thing also the obvious thing.
pub use tokio_util::sync::CancellationToken;
