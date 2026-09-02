//! Stop Policy — the single decision about whether the run ends here.
//!
//! Ported from `src/lib/agent/stopPolicy.ts` (spec §11). One decision point, because two of them is how a run
//! ends for a reason nobody reported: the TypeScript loop reached this shape after the same lesson, where
//! `MAX_GOAL_AUTO_ROUNDS`, a per-sub-agent cap and the cancel path each ended runs independently and only one
//! of them said why.
//!
//! ## Why the limits default to off
//!
//! `max_turns` and `max_tool_calls` are `None` by default, meaning unbounded, and that is not timidity. A cap
//! that fires mid-task turns a long job into a truncated one with no way for the user to ask for the rest, and
//! this runtime already has three mechanisms that stop a run for a *reason*: cancellation, the doom-loop
//! detector, and consecutive failures. A turn cap is the blunt one, so it is available and off.
//!
//! That now holds for [`StopPolicyConfig::for_sub_agent`] too. It used to be the exception, on the reasoning
//! that a delegation the user is not watching cannot be asked whether it wants to keep going — but the count
//! was doing the wrong job. A sub-agent that is working reaches 120 calls on any real exploration of a large
//! repository, and gets cut off mid-task; a sub-agent that is *stuck* is caught by the doom-loop detector
//! long before 120, and caught by what it is doing rather than by how much of it it has done. What is left
//! bounding an unwatched delegation is `task_timeout`, which measures the thing actually worth bounding.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::doom::STALLED_ROUNDS_TO_ESCALATE;
use crate::state::ExecutionState;

/// Why a run ended.
///
/// `Completed` is the only reason that means the work finished; everything else means it was cut short. That
/// distinction is load-bearing for everything user-facing — a run stopped by a doom loop or a limit must never
/// be presented as a completed task — so it is a method rather than something each caller re-decides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    Completed,
    Cancelled,
    Error,
    DoomLoop,
    MaxTurns,
    MaxToolCalls,
    ContextLimit,
    /// The whole run ran out of wall clock.
    TaskTimeout,
    /// One round did. Distinct from `TaskTimeout` because the fix is different: a run that took an hour was
    /// probably too big, while a single round that took an hour was stuck.
    RoundTimeout,
}

impl StopReason {
    /// Did the work finish, or was it cut short?
    pub fn is_successful(&self) -> bool {
        matches!(self, StopReason::Completed)
    }
}

// No `Eq`: `context_limit_fraction` is a fraction, and a float has no total equality to derive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StopPolicyConfig {
    /// Provider turns allowed in one user turn. `None` is unbounded.
    pub max_turns: Option<u32>,
    /// Tool calls allowed in one user turn. `None` is unbounded.
    pub max_tool_calls: Option<u32>,
    /// Consecutive tool failures after which the run is not going to recover on its own.
    pub max_consecutive_failures: Option<u32>,
    /// Fraction of the context window at which to stop rather than be truncated by the provider.
    pub context_limit_fraction: Option<f64>,
    /// Wall-clock ceiling for the whole run (§9.1's Task Timeout).
    ///
    /// `None` by default for the main agent, for the same reason the turn cap is: a deadline that fires
    /// mid-task turns a long job into a truncated one, and the user watching it can stop it themselves.
    pub task_timeout: Option<Duration>,
    /// Wall-clock ceiling for ONE round — one model call and the tools it asked for (§9.1's Runtime Timeout).
    ///
    /// Bounded by default even for the main agent, and that is the difference from the others: a round that
    /// has not finished in ten minutes is not working slowly, it is stuck, and the cost of that is a
    /// conversation the user cannot get an answer out of without pressing Stop.
    pub round_timeout: Option<Duration>,
}

impl Default for StopPolicyConfig {
    /// The main agent's policy: bounded only where a bound reports something real.
    fn default() -> Self {
        Self {
            max_turns: None,
            max_tool_calls: None,
            max_consecutive_failures: Some(6),
            context_limit_fraction: Some(0.95),
            task_timeout: None,
            round_timeout: Some(Duration::from_secs(600)),
        }
    }
}

impl StopPolicyConfig {
    /// A delegation's policy.
    ///
    /// Bounded in wall clock only. The count caps this used to carry (40 turns, 120 tool calls) are gone: they
    /// could not tell a delegation that was working from one that was stuck, and on a large repository an
    /// exploration reaches 120 lookups while doing exactly what it was asked to. Stopping there produced a
    /// truncated answer that read like a finished one, which is the worst of both.
    ///
    /// A stuck delegation is still caught, by the mechanisms that stop a run for a *reason* — the doom-loop
    /// detector and consecutive failures — and those fire on the behaviour rather than on the tally. The
    /// timeout stays because nobody is watching a delegation, so nobody notices it running for an hour until
    /// the bill does; that is a bound on the thing worth bounding.
    pub fn for_sub_agent() -> Self {
        Self {
            task_timeout: Some(Duration::from_secs(900)),
            ..Self::default()
        }
    }
}

/// Everything the decision reads. Assembled by the caller; this module performs no I/O and no model calls.
///
/// Built through [`StopInput::new`] rather than `Default`, because the state is borrowed and a reference has
/// no default. Callers set the fields that apply and leave the rest: `StopInput { cancelled: true,
/// ..StopInput::new(&state) }`.
#[derive(Debug, Clone)]
pub struct StopInput<'a> {
    /// The user asked to stop.
    pub cancelled: bool,
    /// The provider failed in a way the run cannot continue past.
    pub provider_error: Option<String>,
    /// The detector escalated: several consecutive rounds produced nothing new.
    pub doom_loop_escalated: bool,
    /// The model answered without calling tools — the normal exit.
    pub final_response: bool,
    /// Whether an active goal is met. `None` means no goal is active, which is *not* the same as unmet.
    ///
    /// Resolved by the caller, because evaluating a goal is an independent model call this pure function must
    /// not make.
    pub goal_met: Option<bool>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    /// How long the whole run has been going.
    pub elapsed: Option<Duration>,
    /// How long the round that just finished took.
    pub round_elapsed: Option<Duration>,
    pub state: &'a ExecutionState,
}

impl<'a> StopInput<'a> {
    /// The neutral input for a state: nothing cancelled, nothing failed, no goal in force.
    pub fn new(state: &'a ExecutionState) -> Self {
        Self {
            cancelled: false,
            provider_error: None,
            doom_loop_escalated: false,
            final_response: false,
            goal_met: None,
            context_tokens: None,
            context_window: None,
            elapsed: None,
            round_elapsed: None,
            state,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopDecision {
    pub stop: bool,
    pub reason: Option<StopReason>,
    /// Human-readable detail, carried on the stop event for the user and the log.
    pub detail: Option<String>,
}

impl StopDecision {
    fn go_on() -> Self {
        Self { stop: false, reason: None, detail: None }
    }
    fn halt(reason: StopReason, detail: Option<String>) -> Self {
        Self { stop: true, reason: Some(reason), detail }
    }
}

/// Decide whether the run ends here.
///
/// The order is a precedence, and each position is a judgement about what the user is owed:
///
///  1. **cancellation** — the user asked; nothing outranks that, and reporting any other reason for a run the
///     user stopped would be a lie.
///  2. **provider error** — the run cannot continue whatever anything else thinks.
///  3. **doom loop** — before the final-response condition, because a looping model that finally emits text is
///     still a looping model and the run should be reported as such.
///  4. **final response** — the normal exit. Gated on the goal: a goal in force means the model does not get
///     to declare itself finished, and an unmet goal turns its "final" answer into another round.
///  5. **the limits** — last, so a run that was going to finish anyway is never reported as having hit one.
pub fn decide_stop(input: &StopInput<'_>, cfg: &StopPolicyConfig) -> StopDecision {
    let s = input.state;

    if input.cancelled {
        return StopDecision::halt(StopReason::Cancelled, None);
    }
    if let Some(err) = &input.provider_error {
        return StopDecision::halt(StopReason::Error, Some(err.clone()));
    }
    if input.doom_loop_escalated {
        return StopDecision::halt(
            StopReason::DoomLoop,
            // The detector's own threshold, referenced rather than restated, so the number in the message
            // cannot drift away from the number that produced it.
            Some(format!("no new information for {STALLED_ROUNDS_TO_ESCALATE} consecutive rounds")),
        );
    }

    if input.final_response {
        // A goal in force and not met is the one thing that overrides the model's own ending.
        if input.goal_met == Some(false) {
            return StopDecision::go_on();
        }
        return StopDecision::halt(StopReason::Completed, None);
    }

    if let Some(max) = cfg.max_turns {
        if s.round() >= max {
            return StopDecision::halt(StopReason::MaxTurns, Some(format!("{} of {max}", s.round())));
        }
    }
    if let Some(max) = cfg.max_tool_calls {
        if s.tool_calls() >= max {
            return StopDecision::halt(StopReason::MaxToolCalls, Some(format!("{} of {max}", s.tool_calls())));
        }
    }
    if let Some(max) = cfg.max_consecutive_failures {
        if s.consecutive_failures() >= max {
            return StopDecision::halt(
                StopReason::Error,
                Some(format!("{} consecutive tool failures", s.consecutive_failures())),
            );
        }
    }
    if let (Some(limit), Some(elapsed)) = (cfg.task_timeout, input.elapsed) {
        if elapsed >= limit {
            return StopDecision::halt(
                StopReason::TaskTimeout,
                Some(format!("{}s of {}s", elapsed.as_secs(), limit.as_secs())),
            );
        }
    }
    if let (Some(limit), Some(elapsed)) = (cfg.round_timeout, input.round_elapsed) {
        if elapsed >= limit {
            return StopDecision::halt(
                StopReason::RoundTimeout,
                Some(format!("one round took {}s, over the {}s limit", elapsed.as_secs(), limit.as_secs())),
            );
        }
    }
    if let (Some(frac), Some(used), Some(window)) =
        (cfg.context_limit_fraction, input.context_tokens, input.context_window)
    {
        if window > 0 && used as f64 / window as f64 >= frac {
            return StopDecision::halt(StopReason::ContextLimit, Some(format!("{used} of {window} tokens")));
        }
    }

    StopDecision::go_on()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_after(rounds: u32, tool_calls: u32) -> ExecutionState {
        let mut s = ExecutionState::new();
        for _ in 0..rounds {
            s.begin_round();
        }
        for _ in 0..tool_calls {
            s.record_tool_result("read_file", true);
        }
        s
    }

    fn input(state: &ExecutionState) -> StopInput<'_> {
        StopInput::new(state)
    }

    #[test]
    fn an_ordinary_round_continues() {
        let s = state_after(2, 3);
        assert!(!decide_stop(&input(&s), &StopPolicyConfig::default()).stop);
    }

    #[test]
    fn a_reply_without_tool_calls_completes_the_run() {
        let s = state_after(2, 1);
        let d = decide_stop(&StopInput { final_response: true, ..input(&s) }, &StopPolicyConfig::default());
        assert_eq!(d.reason, Some(StopReason::Completed));
        assert!(d.reason.unwrap().is_successful());
    }

    /// Cancellation outranks everything, including a reply that would otherwise have completed the run.
    #[test]
    fn cancellation_outranks_every_other_reason() {
        let s = state_after(2, 1);
        let d = decide_stop(
            &StopInput {
                cancelled: true,
                final_response: true,
                provider_error: Some("boom".into()),
                doom_loop_escalated: true,
                ..input(&s)
            },
            &StopPolicyConfig::default(),
        );
        assert_eq!(d.reason, Some(StopReason::Cancelled));
    }

    /// A looping model that finally emits text is still a looping model.
    #[test]
    fn a_doom_loop_is_reported_even_when_the_model_produced_a_final_answer() {
        let s = state_after(4, 8);
        let d = decide_stop(
            &StopInput { doom_loop_escalated: true, final_response: true, ..input(&s) },
            &StopPolicyConfig::default(),
        );
        assert_eq!(d.reason, Some(StopReason::DoomLoop));
        assert!(!d.reason.unwrap().is_successful());
        assert!(d.detail.unwrap().contains(&STALLED_ROUNDS_TO_ESCALATE.to_string()));
    }

    #[test]
    fn an_unmet_goal_turns_a_final_answer_into_another_round() {
        let s = state_after(2, 1);
        let d = decide_stop(
            &StopInput { final_response: true, goal_met: Some(false), ..input(&s) },
            &StopPolicyConfig::default(),
        );
        assert!(!d.stop);
    }

    /// No goal active is not the same as a goal unmet.
    #[test]
    fn an_absent_goal_lets_the_final_answer_stand() {
        let s = state_after(2, 1);
        for goal in [None, Some(true)] {
            let d = decide_stop(
                &StopInput { final_response: true, goal_met: goal, ..input(&s) },
                &StopPolicyConfig::default(),
            );
            assert_eq!(d.reason, Some(StopReason::Completed), "goal_met = {goal:?}");
        }
    }

    #[test]
    fn the_limits_are_off_by_default_for_the_main_agent() {
        let cfg = StopPolicyConfig::default();
        assert_eq!(cfg.max_turns, None);
        assert_eq!(cfg.max_tool_calls, None);
        let s = state_after(500, 500);
        assert!(!decide_stop(&input(&s), &cfg).stop);
    }

    /// A delegation is not stopped for having done a lot of work.
    ///
    /// This asserted the opposite until the caps came off: 40 turns and 120 tool calls used to end a sub-agent
    /// mid-task. The tally never distinguished a delegation that was working from one that was stuck, and on a
    /// large repository an exploration passes 120 lookups while doing exactly what it was asked to.
    #[test]
    fn a_sub_agent_is_not_stopped_by_a_tally() {
        let cfg = StopPolicyConfig::for_sub_agent();
        assert_eq!(cfg.max_turns, None);
        assert_eq!(cfg.max_tool_calls, None);
        let s = state_after(500, 500);
        assert!(!decide_stop(&input(&s), &cfg).stop, "a busy delegation must not be cut off by its count");
    }

    #[test]
    fn a_run_of_failures_stops_the_turn_and_says_so() {
        let mut s = ExecutionState::new();
        s.begin_round();
        for _ in 0..6 {
            s.record_tool_result("run_command", false);
        }
        let d = decide_stop(&input(&s), &StopPolicyConfig::default());
        assert_eq!(d.reason, Some(StopReason::Error));
        assert_eq!(d.detail.as_deref(), Some("6 consecutive tool failures"));
    }

    #[test]
    fn a_nearly_full_context_stops_before_the_provider_truncates_it() {
        let s = state_after(3, 2);
        let d = decide_stop(
            &StopInput { context_tokens: Some(96_000), context_window: Some(100_000), ..input(&s) },
            &StopPolicyConfig::default(),
        );
        assert_eq!(d.reason, Some(StopReason::ContextLimit));
    }

    /// A run that was going to finish anyway must never be reported as having hit a limit.
    ///
    /// Written against an explicitly capped config rather than `for_sub_agent`, which no longer carries a
    /// count: against an uncapped policy this would pass without exercising anything, and a test that cannot
    /// fail is worse than no test. The first assertion pins that the cap really is live at this state, so the
    /// second one is about precedence rather than about there being nothing to take precedence over.
    #[test]
    fn a_final_answer_on_the_last_allowed_round_completes_rather_than_hitting_the_cap() {
        let cfg = StopPolicyConfig { max_turns: Some(40), ..StopPolicyConfig::default() };
        let s = state_after(40, 0);
        assert_eq!(decide_stop(&input(&s), &cfg).reason, Some(StopReason::MaxTurns));
        let d = decide_stop(&StopInput { final_response: true, ..input(&s) }, &cfg);
        assert_eq!(d.reason, Some(StopReason::Completed));
    }

    #[test]
    fn only_completion_counts_as_success() {
        assert!(StopReason::Completed.is_successful());
        for r in [
            StopReason::Cancelled,
            StopReason::Error,
            StopReason::DoomLoop,
            StopReason::MaxTurns,
            StopReason::MaxToolCalls,
            StopReason::ContextLimit,
            StopReason::TaskTimeout,
            StopReason::RoundTimeout,
        ] {
            assert!(!r.is_successful(), "{r:?} must not read as a finished task");
        }
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::*;

    fn state() -> ExecutionState {
        let mut s = ExecutionState::new();
        s.begin_round();
        s
    }

    #[test]
    fn a_run_that_exceeds_its_task_deadline_stops() {
        let s = state();
        let cfg = StopPolicyConfig { task_timeout: Some(Duration::from_secs(60)), ..Default::default() };
        let d = decide_stop(
            &StopInput { elapsed: Some(Duration::from_secs(61)), ..StopInput::new(&s) },
            &cfg,
        );
        assert_eq!(d.reason, Some(StopReason::TaskTimeout));
        assert_eq!(d.detail.as_deref(), Some("61s of 60s"));
    }

    /// A stuck round is a different failure from a long task, and is bounded even when the task is not.
    #[test]
    fn one_stuck_round_stops_the_run_even_with_no_task_deadline() {
        let s = state();
        let cfg = StopPolicyConfig::default();
        assert_eq!(cfg.task_timeout, None, "the main agent's task is unbounded by default");
        let d = decide_stop(
            &StopInput { round_elapsed: Some(Duration::from_secs(700)), ..StopInput::new(&s) },
            &cfg,
        );
        assert_eq!(d.reason, Some(StopReason::RoundTimeout));
    }

    #[test]
    fn an_ordinary_round_within_both_deadlines_continues() {
        let s = state();
        let cfg = StopPolicyConfig { task_timeout: Some(Duration::from_secs(600)), ..Default::default() };
        let d = decide_stop(
            &StopInput {
                elapsed: Some(Duration::from_secs(30)),
                round_elapsed: Some(Duration::from_secs(5)),
                ..StopInput::new(&s)
            },
            &cfg,
        );
        assert!(!d.stop);
    }

    /// A run that was going to finish anyway is never reported as having timed out.
    #[test]
    fn a_final_answer_outranks_both_deadlines() {
        let s = state();
        let cfg = StopPolicyConfig { task_timeout: Some(Duration::from_secs(1)), ..Default::default() };
        let d = decide_stop(
            &StopInput {
                final_response: true,
                elapsed: Some(Duration::from_secs(9999)),
                round_elapsed: Some(Duration::from_secs(9999)),
                ..StopInput::new(&s)
            },
            &cfg,
        );
        assert_eq!(d.reason, Some(StopReason::Completed));
    }

    #[test]
    fn a_delegation_is_bounded_in_wall_clock_because_nobody_is_watching_it() {
        assert!(StopPolicyConfig::for_sub_agent().task_timeout.is_some());
    }

    #[test]
    fn neither_timeout_reads_as_a_finished_task() {
        assert!(!StopReason::TaskTimeout.is_successful());
        assert!(!StopReason::RoundTimeout.is_successful());
    }
}
