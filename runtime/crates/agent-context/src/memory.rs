//! Task memory — the seven things §8.3 says compaction must never lose.
//!
//! > The Agent must not lose its task state after compaction.
//!
//! The way to satisfy that requirement is not to compact carefully. It is to keep task state somewhere
//! compaction cannot reach, and to render it into the wire from there — so "did the goal survive?" stops being
//! a question about which messages were dropped.
//!
//! That is what this module is. [`TaskMemory`] is a small, structured record held **beside** the conversation
//! rather than inside it. Compaction operates on the conversation; the memory is re-rendered afterwards,
//! intact, because it was never a candidate.
//!
//! ## Why structured rather than a pinned message
//!
//! A pinned message would survive too, and it was the first design. It fails on the second compaction: the
//! plan changes, and now there are two pinned messages disagreeing about what the plan is, with nothing able
//! to tell which is current. A record has one field per fact, and updating it is an assignment.

use serde::{Deserialize, Serialize};

/// The state a task must not lose. §8.3's list, one field each.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskMemory {
    /// What the user asked for. The one thing that makes every other field mean anything.
    pub user_goal: Option<String>,
    /// The plan as it currently stands. Replaced, never appended to — see the module header.
    pub current_plan: Option<String>,
    /// Where the run is: the execution phase, as a string so this crate does not depend on the loop's enum.
    pub current_phase: Option<String>,
    pub completed_tasks: Vec<String>,
    pub pending_tasks: Vec<String>,
    /// Decisions that would be expensive to re-make, and whose absence would let the agent contradict itself.
    pub important_decisions: Vec<String>,
    /// Constraints the user or the environment imposed. Losing one of these is how an agent does the thing it
    /// was told not to do, confidently.
    pub important_constraints: Vec<String>,
}

impl TaskMemory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_goal(mut self, goal: impl Into<String>) -> Self {
        self.user_goal = Some(goal.into());
        self
    }

    /// Replace the plan. The previous one is gone on purpose: two plans is worse than one.
    pub fn set_plan(&mut self, plan: impl Into<String>) {
        self.current_plan = Some(plan.into());
    }

    pub fn set_phase(&mut self, phase: impl Into<String>) {
        self.current_phase = Some(phase.into());
    }

    /// Move a task from pending to completed. Idempotent, because a model that reports the same step twice
    /// should not produce two entries.
    pub fn complete(&mut self, task: &str) {
        self.pending_tasks.retain(|t| t != task);
        if !self.completed_tasks.iter().any(|t| t == task) {
            self.completed_tasks.push(task.to_owned());
        }
    }

    pub fn add_pending(&mut self, task: impl Into<String>) {
        let task = task.into();
        if !self.pending_tasks.contains(&task) && !self.completed_tasks.contains(&task) {
            self.pending_tasks.push(task);
        }
    }

    pub fn record_decision(&mut self, decision: impl Into<String>) {
        let d = decision.into();
        if !self.important_decisions.contains(&d) {
            self.important_decisions.push(d);
        }
    }

    pub fn add_constraint(&mut self, constraint: impl Into<String>) {
        let c = constraint.into();
        if !self.important_constraints.contains(&c) {
            self.important_constraints.push(c);
        }
    }

    /// Is there anything here worth putting on the wire?
    pub fn is_empty(&self) -> bool {
        self.user_goal.is_none()
            && self.current_plan.is_none()
            && self.current_phase.is_none()
            && self.completed_tasks.is_empty()
            && self.pending_tasks.is_empty()
            && self.important_decisions.is_empty()
            && self.important_constraints.is_empty()
    }

    /// Render as the text that goes on the wire.
    ///
    /// Written for a model to act on rather than for a human to admire: headings it can scan, and no prose
    /// around them. Empty sections are omitted entirely — a heading with nothing under it reads as "there are
    /// no constraints", which is a different claim from "constraints were not recorded".
    pub fn render(&self) -> String {
        let mut out = String::from("## Task state\n\nCarried across compaction; this is authoritative.\n");
        if let Some(goal) = &self.user_goal {
            out.push_str(&format!("\n**Goal:** {goal}\n"));
        }
        if let Some(plan) = &self.current_plan {
            out.push_str(&format!("\n**Current plan:** {plan}\n"));
        }
        if let Some(phase) = &self.current_phase {
            out.push_str(&format!("\n**Phase:** {phase}\n"));
        }
        for (heading, items) in [
            ("Completed", &self.completed_tasks),
            ("Still to do", &self.pending_tasks),
            ("Decisions already made", &self.important_decisions),
            ("Constraints", &self.important_constraints),
        ] {
            if items.is_empty() {
                continue;
            }
            out.push_str(&format!("\n**{heading}:**\n"));
            for item in items {
                out.push_str(&format!("- {item}\n"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_memory_renders_nothing_worth_sending() {
        assert!(TaskMemory::new().is_empty());
    }

    #[test]
    fn the_plan_is_replaced_rather_than_accumulated() {
        let mut m = TaskMemory::new();
        m.set_plan("first plan");
        m.set_plan("second plan");
        assert_eq!(m.current_plan.as_deref(), Some("second plan"));
        assert!(!m.render().contains("first plan"), "two plans is worse than one");
    }

    #[test]
    fn completing_a_task_moves_it_and_does_not_duplicate_it() {
        let mut m = TaskMemory::new();
        m.add_pending("write the tests");
        m.add_pending("run them");
        m.complete("write the tests");
        m.complete("write the tests");
        assert_eq!(m.completed_tasks, vec!["write the tests"]);
        assert_eq!(m.pending_tasks, vec!["run them"]);
    }

    #[test]
    fn a_task_already_completed_is_not_re_added_as_pending() {
        let mut m = TaskMemory::new();
        m.add_pending("a");
        m.complete("a");
        m.add_pending("a");
        assert!(m.pending_tasks.is_empty());
        assert_eq!(m.completed_tasks, vec!["a"]);
    }

    #[test]
    fn decisions_and_constraints_do_not_repeat_themselves() {
        let mut m = TaskMemory::new();
        m.record_decision("use sqlite");
        m.record_decision("use sqlite");
        m.add_constraint("no network");
        m.add_constraint("no network");
        assert_eq!(m.important_decisions.len(), 1);
        assert_eq!(m.important_constraints.len(), 1);
    }

    /// An empty heading reads as a claim that there are none, which is a different thing from silence.
    #[test]
    fn empty_sections_are_omitted_rather_than_rendered_empty() {
        let m = TaskMemory::new().with_goal("ship it");
        let rendered = m.render();
        assert!(rendered.contains("ship it"));
        assert!(!rendered.contains("Constraints"));
        assert!(!rendered.contains("Still to do"));
    }

    #[test]
    fn every_field_reaches_the_rendered_text() {
        let mut m = TaskMemory::new().with_goal("g");
        m.set_plan("p");
        m.set_phase("executing");
        m.add_pending("pending-one");
        m.add_pending("done-one");
        m.complete("done-one");
        m.record_decision("decided-this");
        m.add_constraint("never-that");

        let r = m.render();
        for expected in ["g", "p", "executing", "pending-one", "done-one", "decided-this", "never-that"] {
            assert!(r.contains(expected), "{expected} missing from:\n{r}");
        }
    }
}
