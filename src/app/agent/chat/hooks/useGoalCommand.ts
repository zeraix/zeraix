"use client";

import { useRef } from "react";
import { toast } from "sonner";
import {
  emptyGoal,
  isGoalEmpty,
  isGoalActive,
  startGoal,
  clearGoal,
  type GoalState,
} from "../goal/goalState";
import { GOAL_CLEAR_ALIASES, type GoalCommand } from "../goal/goalCommand";

export interface GoalCommandApi {
  /** A goal set before its conversation record exists; flushed onto the record when the first send creates it. */
  pendingGoalRef: React.RefObject<GoalState | null>;
  /** Execute a parsed `/goal` command. Returns the text the send should continue with, or null. */
  handleGoalCommand: (cmd: Exclude<GoalCommand, { kind: "none" }>) => string | null;
  /** The goal bar's own "clear" button. */
  clearGoalFromBar: () => void;
}

/**
 * The user's side of the goal loop: `/goal` typed into the composer, and the goal bar's clear button.
 *
 * The goal itself is per-conversation state owned by usePerConvState; this hook only holds the one goal that has
 * no conversation to belong to yet, and turns commands into writes against whichever applies.
 */
export function useGoalCommand({
  convIdRef,
  goalFor,
  setGoalFor,
  showPendingGoal,
  setGoalExpanded,
  t,
}: {
  convIdRef: React.RefObject<string | null>;
  goalFor: (convId: string | null) => GoalState;
  setGoalFor: (convId: string | null, g: GoalState) => void;
  showPendingGoal: (g: GoalState | null) => void;
  setGoalExpanded: (v: boolean) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}): GoalCommandApi {
  /**
   * A goal set before its conversation record exists.
   *
   * `/goal <condition>` on an empty chat runs before the first send has created the conversation, so there is no
   * id to key the goal by yet. Stashed here and flushed the moment the record is created, exactly as the
   * composed system prompt already is (pendingSystemPromptRef).
   */
  const pendingGoalRef = useRef<GoalState | null>(null);

  /**
   * Execute a parsed `/goal` command.
   *
   * Returns the text the send should continue with, or null when the command is complete in itself. Setting a
   * goal returns the condition, because the doc's contract is that `/goal <condition>` starts working on it
   * immediately — the user should not have to type the same sentence again as a separate message.
   *
   * Feedback is a toast plus the goal bar rather than a chat message: the bar already shows the condition, the
   * elapsed time, the round count, the spend and the last verdict continuously, so a bare `/goal` has nothing
   * to print that is not already on screen — it just opens the bar.
   */
  const handleGoalCommand = (cmd: Exclude<GoalCommand, { kind: "none" }>): string | null => {
    const convId = convIdRef.current;
    const current = convId ? goalFor(convId) : (pendingGoalRef.current ?? emptyGoal());
    /** Write to the conversation when there is one, otherwise stash for the record that is about to exist. */
    const write = (g: GoalState) => {
      if (convId) setGoalFor(convId, g);
      else {
        pendingGoalRef.current = isGoalEmpty(g) ? null : g;
        showPendingGoal(isGoalEmpty(g) ? null : g);
      }
    };

    if (cmd.kind === "error") {
      toast.error(t("goal.unknownSub", { sub: cmd.detail, aliases: GOAL_CLEAR_ALIASES.join(" / ") }));
      return null;
    }

    if (cmd.kind === "status") {
      if (isGoalActive(current) || current.status === "achieved") setGoalExpanded(true);
      else toast.info(t("goal.noneSet"));
      return null;
    }

    if (cmd.kind === "clear") {
      if (!isGoalActive(current)) {
        toast.info(t("goal.noneSet"));
        return null;
      }
      // Clearing takes effect immediately, mid-turn included: the end-of-turn check re-reads the goal and finds
      // it inactive, so a loop running right now stops after the round it is in rather than at the next one.
      write(clearGoal(current));
      toast.success(t("goal.cleared", { condition: current.condition }));
      return null;
    }

    // cmd.kind === "set" — replacing whatever was there, with no confirmation but with the displaced condition
    // named, so a goal the user had forgotten about cannot vanish silently.
    const replaced = isGoalActive(current) ? current.condition : "";
    write(startGoal(cmd.condition, { now: Date.now(), source: "user" }));
    setGoalExpanded(false);
    toast.success(replaced ? t("goal.replaced", { condition: replaced }) : t("goal.set"));
    // Advisory only, and after the success: the goal IS set. A condition is not paid for once like an ordinary
    // message — it is re-rendered into the wire every turn and handed to the evaluator every round — and that
    // is the one thing about its length a user cannot see for themselves.
    if (cmd.long) {
      toast.info(t("goal.longCondition", { len: String(cmd.condition.length) }));
    }
    // The condition itself becomes this round's instruction.
    return cmd.condition;
  };

  const clearGoalFromBar = () => {
    const g = goalFor(convIdRef.current);
    if (!isGoalActive(g)) return;
    setGoalFor(convIdRef.current, clearGoal(g));
    toast.success(t("goal.cleared", { condition: g.condition }));
  };

  return { pendingGoalRef, handleGoalCommand, clearGoalFromBar };
}
