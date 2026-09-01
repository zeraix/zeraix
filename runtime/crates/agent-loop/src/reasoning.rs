//! Reasoning policy — how hard the model thinks on *this* round.
//!
//! Ported from `src/lib/agent/reasoningPolicy.ts` (spec §6.2, §6.3). Two rules carry the whole module, and
//! both are about who is allowed to overrule whom:
//!
//!  - **The user's setting is a ceiling, not a starting value.** Nothing raises it. A model that asks for more
//!    deliberation than the user configured is answered with the user's number, and the call still succeeds —
//!    silently having no effect is the documented behaviour, because erroring would teach the model to
//!    re-ask.
//!  - **Off is not a starting point to negotiate from.** If the user turned thinking off, no phase and no
//!    model request reopens it.
//!
//! The runtime's own default exists for exactly one phase. [`ExecutionPhase::may_reduce_effort`] answers
//! which, and it answers `Executing` alone: recovery and verification are where correctness matters more than
//! tokens do.

use serde::{Deserialize, Serialize};

use crate::model::ModelCapabilities;
use crate::state::ExecutionPhase;

/// The effort ladder. Ordered, because clamping is a comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// What the runtime settles on when a round may be economised.
pub const EXECUTING_DEFAULT_EFFORT: Effort = Effort::Low;

/// The name the model calls to set its own effort for the next turn.
pub const REASONING_TOOL_NAME: &str = "set_reasoning_effort";

/// The user's setting: the on/off switch and the ceiling. Never modified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkingConfig {
    pub enabled: bool,
    pub effort: Effort,
}

impl Default for ThinkingConfig {
    fn default() -> Self {
        Self { enabled: true, effort: Effort::Medium }
    }
}

/// Where the resolved effort came from. Carried for the log, so a round's cost can be explained after the
/// fact rather than guessed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningSource {
    User,
    ModelOverride,
    PhaseDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReasoningDecision {
    pub config: ThinkingConfig,
    pub source: ReasoningSource,
}

impl ReasoningDecision {
    /// The value to put on the request, or `None` when thinking is off.
    pub fn effort_param(&self) -> Option<String> {
        self.config.enabled.then(|| self.config.effort.as_str().to_owned())
    }
}

/// Resolve the effort for one round.
///
/// `model_request` is what the model asked for via `set_reasoning_effort`, for **this round only**. An
/// override that persisted would quietly become a second user setting, with no way for the model to hand
/// control back — so the caller clears it after each round, and this function never sees a stale one.
pub fn resolve_reasoning(
    user: ThinkingConfig,
    phase: ExecutionPhase,
    capabilities: &ModelCapabilities,
    model_request: Option<Effort>,
) -> ReasoningDecision {
    // Off is not a starting point to negotiate from. The config is returned untouched so that nothing
    // downstream can mistake it for a reduced-effort request.
    if !user.enabled {
        return ReasoningDecision { config: user, source: ReasoningSource::User };
    }

    // A model that cannot vary effort per request gets the user's setting, whatever the phase thinks. Sending
    // a reduced effort to a provider with no per-request knob would be ignored or rejected, and the absence
    // of the knob has to degrade silently.
    if !capabilities.supports_per_turn_reasoning_effort {
        return ReasoningDecision { config: user, source: ReasoningSource::User };
    }

    // The model asked, and its decision outranks the runtime's default — still clamped to the user's ceiling.
    if let Some(requested) = model_request {
        return ReasoningDecision { config: clamp(user, requested), source: ReasoningSource::ModelOverride };
    }

    if phase.may_reduce_effort() {
        return ReasoningDecision {
            config: clamp(user, EXECUTING_DEFAULT_EFFORT),
            source: ReasoningSource::PhaseDefault,
        };
    }

    ReasoningDecision { config: user, source: ReasoningSource::User }
}

/// Never above the user's setting; below it is always allowed.
fn clamp(user: ThinkingConfig, requested: Effort) -> ThinkingConfig {
    ThinkingConfig { enabled: user.enabled, effort: requested.min(user.effort) }
}

/// The `set_reasoning_effort` declaration, or `None` when the provider has no per-request knob.
///
/// `None` rather than an error is the whole of "must degrade silently": a provider without the capability
/// never shows the tool, the model never learns it exists, and nothing fails.
pub fn reasoning_tool_declaration(capabilities: &ModelCapabilities) -> Option<serde_json::Value> {
    if !capabilities.supports_reasoning || !capabilities.supports_per_turn_reasoning_effort {
        return None;
    }
    Some(serde_json::json!({
        "type": "function",
        "function": {
            "name": REASONING_TOOL_NAME,
            "description":
                "Set how hard you will think on your NEXT turn only. Call this when the work ahead is \
                 unusually hard and deserves more deliberation, or when the next few steps are mechanical \
                 and do not. It applies to one turn and then lapses, so set it again if you still want it. \
                 Your request cannot exceed the effort the user has configured, and it cannot turn thinking \
                 on when the user has turned it off — in those cases the call is accepted and has no effect.",
            "parameters": {
                "type": "object",
                "properties": {
                    "effort": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "How much deliberation the next turn should get."
                    }
                },
                "required": ["effort"]
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varying() -> ModelCapabilities {
        ModelCapabilities { supports_per_turn_reasoning_effort: true, ..Default::default() }
    }

    #[test]
    fn thinking_off_is_never_reopened_by_a_phase_or_by_the_model() {
        let user = ThinkingConfig { enabled: false, effort: Effort::High };
        for request in [None, Some(Effort::High)] {
            let d = resolve_reasoning(user, ExecutionPhase::Executing, &varying(), request);
            assert!(!d.config.enabled);
            assert_eq!(d.source, ReasoningSource::User);
            assert_eq!(d.effort_param(), None);
        }
    }

    #[test]
    fn a_model_with_no_per_request_knob_always_gets_the_users_setting() {
        let user = ThinkingConfig { enabled: true, effort: Effort::High };
        let d = resolve_reasoning(user, ExecutionPhase::Executing, &ModelCapabilities::default(), None);
        assert_eq!(d.config.effort, Effort::High);
        assert_eq!(d.source, ReasoningSource::User);
    }

    #[test]
    fn an_executing_round_is_economised_on_and_the_other_phases_are_not() {
        let user = ThinkingConfig { enabled: true, effort: Effort::High };
        let d = resolve_reasoning(user, ExecutionPhase::Executing, &varying(), None);
        assert_eq!(d.config.effort, EXECUTING_DEFAULT_EFFORT);
        assert_eq!(d.source, ReasoningSource::PhaseDefault);

        for phase in [ExecutionPhase::Planning, ExecutionPhase::Recovering, ExecutionPhase::Verifying] {
            let d = resolve_reasoning(user, phase, &varying(), None);
            assert_eq!(d.config.effort, Effort::High, "{phase:?} must keep the user's effort");
        }
    }

    /// The rule that matters: the user's setting is a ceiling, and asking for more is accepted and ignored.
    #[test]
    fn a_model_cannot_ask_for_more_effort_than_the_user_configured() {
        let user = ThinkingConfig { enabled: true, effort: Effort::Low };
        let d = resolve_reasoning(user, ExecutionPhase::Recovering, &varying(), Some(Effort::High));
        assert_eq!(d.config.effort, Effort::Low);
        assert_eq!(d.source, ReasoningSource::ModelOverride);
    }

    #[test]
    fn a_model_may_ask_for_less_and_it_outranks_the_phase_default() {
        let user = ThinkingConfig { enabled: true, effort: Effort::High };
        // Recovering would otherwise keep High.
        let d = resolve_reasoning(user, ExecutionPhase::Recovering, &varying(), Some(Effort::Low));
        assert_eq!(d.config.effort, Effort::Low);
        assert_eq!(d.source, ReasoningSource::ModelOverride);
    }

    #[test]
    fn the_effort_tool_is_hidden_from_a_provider_that_cannot_honour_it() {
        assert!(reasoning_tool_declaration(&ModelCapabilities::default()).is_none());
        assert!(
            reasoning_tool_declaration(&ModelCapabilities {
                supports_reasoning: false,
                supports_per_turn_reasoning_effort: true,
                ..Default::default()
            })
            .is_none()
        );
        let declared = reasoning_tool_declaration(&varying()).expect("declared when it can be honoured");
        assert_eq!(declared["function"]["name"], REASONING_TOOL_NAME);
    }
}
