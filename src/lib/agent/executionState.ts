/**
 * Agent Execution State — what the Runtime knows about how the task is going.
 *
 * Spec: docs/agent-runtime-loop.md §4.2, §6.1.
 *
 * M0 found this to be the single largest genuine gap (problem P1): nothing in the codebase models the
 * progress of a task. What exists is scattered and answers other questions. `goalState.run.turnCount` counts
 * GOAL rounds — whole user turns, each of which may contain twenty model requests — so it cannot say
 * anything about the round in progress. `loopGuard` tracked repetition and threw it away at turn end. Six
 * `let` flags inside `send()` (`didToolCall`, `finalizeNudged`, `riskyChangePending`, …) each remember one
 * boolean for the length of one turn.
 *
 * None of that can answer "is this turn recovering from a failure right now", which is the question §6's
 * reasoning policy, §11's Stop Policy and §12's proportional doom-loop response all need answered.
 *
 * ── Why phase is derived, not declared ──────────────────────────────────────────────────────────────────────
 *
 * §6.1 is emphatic that the phase is *observable, not guessed*, and the implementation honours that
 * literally: `derivePhase` is a pure function of facts the Runtime already recorded — did the last tool fail,
 * has anything been compacted since the last round, has the plan changed, has the model claimed completion.
 * Nothing asks a model what phase it is in, and no heuristic infers intent from message text. If a phase
 * cannot be established from a recorded fact, the answer is `executing`, which is the phase that changes
 * nothing about the Runtime's behaviour.
 *
 * This module decides the phase. It does NOT decide what the phase means for reasoning effort — that is §6.3
 * and milestone M4, deliberately separate, so that the policy can be changed without touching the state
 * machine that feeds it.
 *
 * Everything here is a pure function over a plain object. No React, no I/O, no clock reads except the ones
 * passed in.
 */
import type { ToolResult } from "./turn";

/**
 * §6.1's five phases.
 *
 * `verifying` and `completed` are distinct on purpose and the distinction is the entire point of having an
 * independent evaluator: the model believing it is finished and the task actually being finished are
 * different claims, and only the second ends the run. A model that says "done" moves to `verifying`; only
 * the Stop Policy moves anything to `completed`.
 */
export type ExecutionPhase = "planning" | "executing" | "recovering" | "verifying" | "completed";

export interface AgentExecutionState {
  phase: ExecutionPhase;
  /** Provider turns issued in this user turn. 0 before the first request. */
  round: number;
  /** Tool calls executed in this user turn, across all rounds. */
  toolCalls: number;
  /** Tool calls in the current unbroken run of tool-calling rounds; reset by a round that calls none. */
  consecutiveToolCalls: number;
  /** Failures in the current unbroken run; any success resets it. */
  consecutiveFailures: number;
  lastTool?: string;
  lastToolSucceeded?: boolean;
  /**
   * The round at which the plan last changed, or context was last compacted.
   *
   * §6.1 makes both "immediately after" conditions for `planning`, so what has to be remembered is *when*,
   * not merely *that* — otherwise a compaction on round 2 would leave the run in `planning` forever.
   */
  planChangedAtRound: number;
  compactedAtRound: number;
  /**
   * The model has signalled it believes the work is done (every todo complete, or an explicit done signal),
   * and nothing has confirmed it yet. Cleared the moment any further tool runs, because a model that is
   * still working has evidently not finished.
   */
  claimsComplete: boolean;
}

/** A fresh state, for the start of a user turn. */
export function initExecutionState(): AgentExecutionState {
  return {
    phase: "planning",
    round: 0,
    toolCalls: 0,
    consecutiveToolCalls: 0,
    consecutiveFailures: 0,
    planChangedAtRound: 0,
    compactedAtRound: 0,
    claimsComplete: false,
  };
}

/**
 * Open a round.
 *
 * Increments the round counter and re-derives the phase from what is now known. Called once per provider
 * turn, before the request goes out, so the phase is available to whoever is configuring that request —
 * which is precisely what M4's reasoning policy needs.
 */
export function beginRound(prev: AgentExecutionState): AgentExecutionState {
  const round = prev.round + 1;
  const next = { ...prev, round };
  return { ...next, phase: derivePhase(next) };
}

/**
 * Record one executed tool.
 *
 * `consecutiveFailures` counts a run of failures regardless of which tool produced them, while
 * `lastTool` / `lastToolSucceeded` describe only the most recent. Both matter and they answer different
 * questions: a Stop Policy cares that six things in a row failed, a recovery prompt cares which one just did.
 */
export function recordToolResult(prev: AgentExecutionState, result: ToolResult): AgentExecutionState {
  const next: AgentExecutionState = {
    ...prev,
    toolCalls: prev.toolCalls + 1,
    consecutiveToolCalls: prev.consecutiveToolCalls + 1,
    consecutiveFailures: result.ok ? 0 : prev.consecutiveFailures + 1,
    lastTool: result.name,
    lastToolSucceeded: result.ok,
    // Still working, so any earlier claim of completion is stale. This is what stops a model from ticking
    // every todo, calling six more tools, and still being treated as "verifying".
    claimsComplete: false,
  };
  return { ...next, phase: derivePhase(next) };
}

/** A round that called no tools ends the consecutive run — the model answered instead of acting. */
export function endRoundWithoutTools(prev: AgentExecutionState): AgentExecutionState {
  const next = { ...prev, consecutiveToolCalls: 0 };
  return { ...next, phase: derivePhase(next) };
}

/** Context was compacted. §6.1 makes the round after a compaction a planning round. */
export function markCompacted(prev: AgentExecutionState): AgentExecutionState {
  const next = { ...prev, compactedAtRound: prev.round };
  return { ...next, phase: derivePhase(next) };
}

/**
 * The plan or the goal changed.
 *
 * §6.1 names `set_goal` / `update_plan` as the triggers. Neither tool exists in this codebase any more — the
 * goal is the user's, set with `/goal`, and the model tracks its own steps with `update_todos` — so the
 * triggers here are: the user setting or clearing a goal, and `update_todos` rewriting the checklist. The
 * spirit is unchanged (the strategy just moved, so the next round is a planning round); only the names of
 * the events differ, which is recorded in the M3 report as a deviation.
 */
export function markPlanChanged(prev: AgentExecutionState): AgentExecutionState {
  const next = { ...prev, planChangedAtRound: prev.round };
  return { ...next, phase: derivePhase(next) };
}

/**
 * The model signalled it believes the task is complete.
 *
 * Does not end anything. It moves the run to `verifying`, which is a request for confirmation, and only the
 * Stop Policy and the goal evaluator can answer it. Nothing the model emits may set `completed`.
 */
export function markClaimsComplete(prev: AgentExecutionState): AgentExecutionState {
  const next = { ...prev, claimsComplete: true };
  return { ...next, phase: derivePhase(next) };
}

/** The Stop Policy confirmed completion. The only route to `completed`. */
export function markCompleted(prev: AgentExecutionState): AgentExecutionState {
  return { ...prev, phase: "completed" };
}

/**
 * §6.1's phase rules, in their stated precedence.
 *
 * Order matters and is not arbitrary. `completed` is terminal, so nothing re-derives away from it. Recovery
 * outranks everything below it because a failure is the most consequential fact available: §6.3 requires
 * recovery to keep the user's full reasoning effort, so a state that is both "just failed" and "just
 * compacted" must resolve to `recovering` or the run would be economising exactly when it should not.
 * `planning` then covers the three "start of something" cases, and `executing` is the residue — the phase
 * that asks for no special treatment.
 */
export function derivePhase(s: AgentExecutionState): ExecutionPhase {
  if (s.phase === "completed") return "completed";
  if (s.lastToolSucceeded === false) return "recovering";
  if (s.claimsComplete) return "verifying";
  // Round 1 is the first request of the turn: nothing has been tried yet, so it is planning by definition.
  if (s.round <= 1) return "planning";
  // "Immediately after" means the round following the event, not every round since.
  if (s.compactedAtRound > 0 && s.round === s.compactedAtRound + 1) return "planning";
  if (s.planChangedAtRound > 0 && s.round === s.planChangedAtRound + 1) return "planning";
  return "executing";
}

/**
 * Is this phase one the Runtime is allowed to economise on?
 *
 * §6.3's table reduces to a single question, and putting it here rather than in the reasoning policy means
 * there is one answer rather than one per caller. Only `executing` may be reduced. `recovering` and
 * `verifying` explicitly may not — correctness matters most there — and `planning` and `completed` keep the
 * user's setting for the same reason.
 */
export const mayReduceEffort = (phase: ExecutionPhase): boolean => phase === "executing";
