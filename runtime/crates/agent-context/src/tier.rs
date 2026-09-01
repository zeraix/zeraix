//! §8.2's memory tiers — what may be lost, in what order, when the budget runs out.
//!
//! The tiers are a statement about *consequence*, not about age or size. A tool result from thirty seconds ago
//! is `Ephemeral` and the user's goal from an hour ago is `Critical`, because losing the first costs a re-read
//! and losing the second costs the task.
//!
//! Nothing infers a tier from message text. Every item is assigned one by whoever created it — the loop knows
//! it just executed a tool, the host knows the user set a goal — for the same reason §6.1's phase is derived
//! from recorded facts rather than guessed: a heuristic that reads intent out of prose is wrong occasionally
//! and silently, and the failure mode here is a task that forgets what it was doing.

use serde::{Deserialize, Serialize};

/// What a piece of context is worth keeping.
///
/// Ordered so that `Ephemeral < Normal < High < Critical`, which is what lets compaction sort by "cheapest to
/// lose first" without a second table to keep in step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Tool output, temporary search results, debug information.
    ///
    /// Re-derivable by doing the work again. The model paid for it once; losing it costs a repeat, not the
    /// task.
    Ephemeral,
    /// Conversation context and ordinary model output. Compressed rather than removed: the shape of the
    /// exchange is what keeps a reply coherent even when its detail has gone.
    Normal,
    /// Important decisions, important facts, current progress. Preserved.
    High,
    /// The user's goal, the task goal, the current plan, hard constraints. Preserved, always.
    ///
    /// §8.3's requirement — "the Agent must not lose its task state after compaction" — is this tier being
    /// unreachable by every reduction in [`crate::compact`].
    Critical,
}

impl Tier {
    /// May compaction remove this outright?
    pub fn is_removable(self) -> bool {
        self == Tier::Ephemeral
    }

    /// May compaction shorten this in place?
    pub fn is_compressible(self) -> bool {
        self == Tier::Normal
    }

    /// Is this beyond every reduction?
    pub fn is_preserved(self) -> bool {
        matches!(self, Tier::High | Tier::Critical)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Ephemeral => "ephemeral",
            Tier::Normal => "normal",
            Tier::High => "high",
            Tier::Critical => "critical",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ordering_is_cheapest_to_lose_first() {
        let mut tiers = [Tier::Critical, Tier::Ephemeral, Tier::High, Tier::Normal];
        tiers.sort();
        assert_eq!(tiers, [Tier::Ephemeral, Tier::Normal, Tier::High, Tier::Critical]);
    }

    /// The three predicates must partition the tiers: every tier has exactly one fate.
    #[test]
    fn every_tier_has_exactly_one_fate() {
        for tier in [Tier::Ephemeral, Tier::Normal, Tier::High, Tier::Critical] {
            let fates = [tier.is_removable(), tier.is_compressible(), tier.is_preserved()];
            assert_eq!(fates.iter().filter(|f| **f).count(), 1, "{tier:?} has {fates:?}");
        }
    }

    #[test]
    fn nothing_important_is_removable_or_compressible() {
        for tier in [Tier::High, Tier::Critical] {
            assert!(!tier.is_removable(), "{tier:?}");
            assert!(!tier.is_compressible(), "{tier:?}");
        }
    }
}
