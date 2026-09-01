//! The Agent Loop, in Rust.
//!
//! This is the crate TODO §2.1 asks for: the Model → Agent → Tool → Result cycle running inside the runtime
//! rather than inside a renderer. It is the first stage of that migration and is **additive** — nothing routes
//! to it yet, exactly as `agent-scheduler`, `agent-process` and `agent-permission` each landed before the
//! stage that wired them.
//!
//! ## What is here
//!
//! | Module | What it decides |
//! |---|---|
//! | [`state`] | How the task is going — the five phases, derived from recorded facts, never guessed. |
//! | [`stop`] | Whether the run ends here. One decision point, so a run cannot end for a reason nobody reported. |
//! | [`doom`] | Whether the turn is still going anywhere, and how loudly to say so. |
//! | [`reasoning`] | How hard the model thinks on this round, under the user's ceiling. |
//! | [`model`] | The provider seam, and the scripted stand-in that makes the loop's scenarios exact. |
//! | [`driver`] | The loop itself. |
//!
//! ## What is deliberately not here
//!
//! **The transport.** [`model::ModelClient`] is a trait with one method; the HTTP implementation, its retries
//! and its provider-rejection fallbacks are a later stage. Building them now would mean a second request path
//! competing with `chatRequest.ts` while both are live.
//!
//! **Context management.** The loop takes a message array and appends to it. Compaction, the tier model and
//! the token budget belong to a context crate that does not exist yet (TODO §8) — and putting a provisional
//! version here would make the eventual one a rewrite rather than an addition.
//!
//! **Tool resolution.** [`driver::ToolExecutor`] is a trait for the same reason: reading a call's `arguments`
//! string, routing a dispatcher and applying permission are three decisions with their own rules, and the
//! loop is not where any of them belong.
//!
//! ## Its relationship to the TypeScript loop
//!
//! `src/lib/agent/` holds the same loop, extracted out of React during milestones M1–M6, and it is the one
//! that runs today. These are ports rather than reinterpretations: while both exist, two runtimes disagreeing
//! about whether a call repeated, or about which phase a round is in, would be a difference nobody could see
//! and nobody could explain. Where a rule is subtle the Rust carries the same comment as the TypeScript, so
//! the two can be diffed by eye.

pub mod doom;
pub mod driver;
pub mod model;
pub mod reasoning;
pub mod state;
pub mod stop;

pub use doom::{CallObservation, CallVerdict, DoomLoop, DoomSignal, RoundVerdict};
pub use driver::{
    AgentLoop, AgentTurnRecord, ContextStrategy, LoopConfig, LoopObserver, LoopOutcome, NoObserver,
    PassThroughContext, ToolExecutor, ToolOutcome, ToolRecord,
};
pub use model::{
    Message, ModelCapabilities, ModelClient, ModelRequest, NormalizedTurn, ScriptedModel, ToolCall, Usage,
};
pub use reasoning::{Effort, ReasoningDecision, ReasoningSource, ThinkingConfig, resolve_reasoning};
pub use state::{ExecutionPhase, ExecutionState};
pub use stop::{StopDecision, StopInput, StopPolicyConfig, StopReason, decide_stop};
