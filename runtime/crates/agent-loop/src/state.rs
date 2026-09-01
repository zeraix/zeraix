//! Agent Execution State — what the Runtime knows about how the task is going.
//!
//! Ported from `src/lib/agent/executionState.ts` (spec §4.2, §6.1). The port is deliberate rather than a
//! rewrite: that module is under test on the TypeScript side, and the two have to agree for as long as both
//! exist, so the phase rules and their precedence are reproduced exactly. Where Rust allows something the
//! TypeScript could not — an enum instead of a string union, a private field that cannot be mutated past the
//! constructor — the shape changes and the behaviour does not.
//!
//! ## Why phase is derived, not declared
//!
//! §6.1 wants the phase *observable, not guessed*. [`ExecutionState::phase`] is therefore a pure function of
//! facts the runtime already recorded: did the last tool fail, was anything compacted since the last round,
//! did the plan change, has the model claimed completion. Nothing asks a model what phase it is in and no
//! heuristic reads intent out of message text. A phase that cannot be established from a recorded fact is
//! [`ExecutionPhase::Executing`], which is the phase that changes nothing.
//!
//! This module decides the phase. It does not decide what the phase *means* for reasoning effort — that is
//! §6.3, kept separate so the policy can change without touching the state machine feeding it.

use serde::{Deserialize, Serialize};

/// §6.1's five phases.
///
/// `Verifying` and `Completed` are distinct on purpose, and the distinction is the whole reason an
/// independent evaluator exists: the model believing it is finished and the task actually being finished are
/// different claims, and only the second ends the run. A model that says "done" reaches `Verifying`; only the
/// stop policy reaches `Completed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionPhase {
    Planning,
    Executing,
    Recovering,
    Verifying,
    Completed,
}

impl ExecutionPhase {
    /// Is this a phase the runtime may economise on?
    ///
    /// §6.3's table reduces to this one question, and answering it here rather than in the reasoning policy
    /// means there is one answer rather than one per caller. Only `Executing` may be reduced: `Recovering`
    /// and `Verifying` are where correctness matters most, and `Planning` and `Completed` keep the user's
    /// setting for the same reason.
    pub fn may_reduce_effort(self) -> bool {
        matches!(self, ExecutionPhase::Executing)
    }
}

/// The accumulation over one user turn.
///
/// Every mutator re-derives the phase, so `phase` is never stale with respect to the fields it reads. That is
/// enforced by construction rather than by discipline: the fields are private and the only way to change one
/// is through a method that ends by re-deriving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionState {
    phase: ExecutionPhase,
    /// Provider turns issued in this user turn. 0 before the first request.
    round: u32,
    /// Tool calls executed in this user turn, across all rounds.
    tool_calls: u32,
    /// Tool calls in the current unbroken run of tool-calling rounds; reset by a round that calls none.
    consecutive_tool_calls: u32,
    /// Failures in the current unbroken run; any success resets it.
    consecutive_failures: u32,
    last_tool: Option<String>,
    last_tool_succeeded: Option<bool>,
    /// The round at which the plan last changed, and the round at which context was last compacted.
    ///
    /// §6.1 makes both "immediately after" conditions for `Planning`, so what has to be remembered is *when*,
    /// not merely *that* — otherwise a compaction on round 2 would leave the run in `Planning` forever.
    plan_changed_at_round: u32,
    compacted_at_round: u32,
    /// The model has signalled it believes the work is done, and nothing has confirmed it. Cleared the moment
    /// any further tool runs, because a model that is still working has evidently not finished.
    claims_complete: bool,
}

impl Default for ExecutionState {
    fn default() -> Self {
        Self::new()
    }
}

impl ExecutionState {
    /// A fresh state, for the start of a user turn.
    pub fn new() -> Self {
        Self {
            phase: ExecutionPhase::Planning,
            round: 0,
            tool_calls: 0,
            consecutive_tool_calls: 0,
            consecutive_failures: 0,
            last_tool: None,
            last_tool_succeeded: None,
            plan_changed_at_round: 0,
            compacted_at_round: 0,
            claims_complete: false,
        }
    }

    pub fn phase(&self) -> ExecutionPhase {
        self.phase
    }
    pub fn round(&self) -> u32 {
        self.round
    }
    pub fn tool_calls(&self) -> u32 {
        self.tool_calls
    }
    pub fn consecutive_tool_calls(&self) -> u32 {
        self.consecutive_tool_calls
    }
    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }
    pub fn last_tool(&self) -> Option<&str> {
        self.last_tool.as_deref()
    }
    pub fn last_tool_succeeded(&self) -> Option<bool> {
        self.last_tool_succeeded
    }
    pub fn claims_complete(&self) -> bool {
        self.claims_complete
    }

    /// Open a round.
    ///
    /// Increments the round counter and re-derives the phase from what is now known. Called once per provider
    /// turn, *before* the request goes out, so the phase is available to whoever is configuring that
    /// request — which is precisely what the reasoning policy needs.
    pub fn begin_round(&mut self) {
        self.round += 1;
        self.rederive();
    }

    /// Record one executed tool.
    ///
    /// `consecutive_failures` counts a run of failures regardless of which tool produced them, while
    /// `last_tool` / `last_tool_succeeded` describe only the most recent. Both matter and they answer
    /// different questions: a stop policy cares that six things in a row failed, a recovery prompt cares which
    /// one just did.
    pub fn record_tool_result(&mut self, name: impl Into<String>, ok: bool) {
        self.tool_calls += 1;
        self.consecutive_tool_calls += 1;
        self.consecutive_failures = if ok { 0 } else { self.consecutive_failures + 1 };
        self.last_tool = Some(name.into());
        self.last_tool_succeeded = Some(ok);
        // Still working, so any earlier claim of completion is stale. This is what stops a model from ticking
        // every todo, calling six more tools, and still being treated as `Verifying`.
        self.claims_complete = false;
        self.rederive();
    }

    /// A round that called no tools ends the consecutive run — the model answered instead of acting.
    pub fn end_round_without_tools(&mut self) {
        self.consecutive_tool_calls = 0;
        self.rederive();
    }

    /// Context was compacted. §6.1 makes the round after a compaction a planning round.
    pub fn mark_compacted(&mut self) {
        self.compacted_at_round = self.round;
        self.rederive();
    }

    /// The plan or the goal changed, so the next round is a planning round.
    pub fn mark_plan_changed(&mut self) {
        self.plan_changed_at_round = self.round;
        self.rederive();
    }

    /// The model signalled it believes the task is complete.
    ///
    /// Ends nothing. It moves the run to `Verifying`, which is a request for confirmation that only the stop
    /// policy can answer. Nothing the model emits may set `Completed`.
    pub fn mark_claims_complete(&mut self) {
        self.claims_complete = true;
        self.rederive();
    }

    /// The stop policy confirmed completion. The only route to `Completed`.
    pub fn mark_completed(&mut self) {
        self.phase = ExecutionPhase::Completed;
    }

    /// §6.1's phase rules, in their stated precedence.
    ///
    /// The order is not arbitrary. `Completed` is terminal, so nothing re-derives away from it. Recovery
    /// outranks everything below because a failure is the most consequential fact available: §6.3 requires
    /// recovery to keep the user's full reasoning effort, so a state that is both "just failed" and "just
    /// compacted" must resolve to `Recovering`, or the run would economise exactly when it should not.
    /// `Planning` then covers the three "start of something" cases, and `Executing` is the residue.
    fn derive_phase(&self) -> ExecutionPhase {
        if self.phase == ExecutionPhase::Completed {
            return ExecutionPhase::Completed;
        }
        if self.last_tool_succeeded == Some(false) {
            return ExecutionPhase::Recovering;
        }
        if self.claims_complete {
            return ExecutionPhase::Verifying;
        }
        // Round 1 is the first request of the turn: nothing has been tried, so it is planning by definition.
        if self.round <= 1 {
            return ExecutionPhase::Planning;
        }
        // "Immediately after" means the round following the event, not every round since.
        if self.compacted_at_round > 0 && self.round == self.compacted_at_round + 1 {
            return ExecutionPhase::Planning;
        }
        if self.plan_changed_at_round > 0 && self.round == self.plan_changed_at_round + 1 {
            return ExecutionPhase::Planning;
        }
        ExecutionPhase::Executing
    }

    fn rederive(&mut self) {
        self.phase = self.derive_phase();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_turn_is_planning_and_stays_planning_for_its_first_round() {
        let mut s = ExecutionState::new();
        assert_eq!(s.phase(), ExecutionPhase::Planning);
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Planning);
        assert_eq!(s.round(), 1);
    }

    #[test]
    fn the_second_round_is_executing_when_nothing_notable_happened() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.record_tool_result("read_file", true);
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Executing);
    }

    #[test]
    fn a_failed_tool_moves_the_run_to_recovering() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.record_tool_result("run_command", false);
        assert_eq!(s.phase(), ExecutionPhase::Recovering);
        assert_eq!(s.consecutive_failures(), 1);
        assert_eq!(s.last_tool(), Some("run_command"));
    }

    #[test]
    fn a_success_clears_the_failure_streak_but_a_run_of_failures_accumulates() {
        let mut s = ExecutionState::new();
        // Two rounds, so the phase assertion below is about recovery ending rather than about round 1 always
        // being a planning round.
        s.begin_round();
        s.begin_round();
        s.record_tool_result("a", false);
        s.record_tool_result("b", false);
        assert_eq!(s.consecutive_failures(), 2);
        assert_eq!(s.phase(), ExecutionPhase::Recovering);
        s.record_tool_result("c", true);
        assert_eq!(s.consecutive_failures(), 0);
        assert_eq!(s.phase(), ExecutionPhase::Executing, "a success ends the recovery phase");
    }

    /// The precedence that matters most: recovery must win, or the run economises exactly when it should not.
    #[test]
    fn recovery_outranks_a_compaction_that_happened_in_the_same_round() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.begin_round();
        s.mark_compacted();
        s.record_tool_result("edit_file", false);
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Recovering);
        assert!(!s.phase().may_reduce_effort());
    }

    #[test]
    fn compaction_makes_the_next_round_planning_and_only_the_next_one() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.begin_round();
        s.mark_compacted();
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Planning);
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Executing);
    }

    #[test]
    fn a_plan_change_makes_the_next_round_planning() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.begin_round();
        s.mark_plan_changed();
        s.begin_round();
        assert_eq!(s.phase(), ExecutionPhase::Planning);
    }

    #[test]
    fn claiming_completion_asks_for_verification_rather_than_ending_anything() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.begin_round();
        s.mark_claims_complete();
        assert_eq!(s.phase(), ExecutionPhase::Verifying);
        assert!(!s.phase().may_reduce_effort());
    }

    /// A model that ticks every todo and then keeps working has evidently not finished.
    #[test]
    fn any_further_tool_call_withdraws_a_claim_of_completion() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.mark_claims_complete();
        s.record_tool_result("write_file", true);
        assert!(!s.claims_complete());
        assert_ne!(s.phase(), ExecutionPhase::Verifying);
    }

    #[test]
    fn completed_is_terminal_and_nothing_re_derives_away_from_it() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.mark_completed();
        s.begin_round();
        s.record_tool_result("read_file", false);
        assert_eq!(s.phase(), ExecutionPhase::Completed);
    }

    #[test]
    fn a_round_without_tools_ends_the_consecutive_run() {
        let mut s = ExecutionState::new();
        s.begin_round();
        s.record_tool_result("a", true);
        s.record_tool_result("b", true);
        assert_eq!(s.consecutive_tool_calls(), 2);
        s.end_round_without_tools();
        assert_eq!(s.consecutive_tool_calls(), 0);
        // The cumulative count is not reset — it is the turn's total, not the run's.
        assert_eq!(s.tool_calls(), 2);
    }

    #[test]
    fn only_executing_may_be_economised_on() {
        assert!(ExecutionPhase::Executing.may_reduce_effort());
        for p in [
            ExecutionPhase::Planning,
            ExecutionPhase::Recovering,
            ExecutionPhase::Verifying,
            ExecutionPhase::Completed,
        ] {
            assert!(!p.may_reduce_effort(), "{p:?} must keep the user's effort");
        }
    }
}
