/**
 * Stop Policy — the one place that decides a run is over.
 *
 * Spec: docs/agent-runtime-loop.md §11, §20 rule 7.
 *
 * Today the decision to stop is spread across the loop and made differently in each place: the `while (true)`
 * exits on a reply with no tool calls, `loopGuard` withdrew tools on its own authority, the goal loop counts
 * to `MAX_GOAL_AUTO_ROUNDS` in `decideNextRound`, sub-agents each stop for their own reasons, and cancel is
 * an `AbortController` checked in a dozen places. Rule 7 forbids competing policies, so this module is the
 * single decision and every other mechanism becomes an INPUT to it rather than a decision of its own.
 *
 * ── There are no round ceilings ─────────────────────────────────────────────────────────────────────────────
 *
 * `maxTurns` and `maxToolCalls` used to live here, defaulting to `null`. They are gone, and so are the
 * `agent.limits.maxToolRounds` / `maxSameToolCalls` / `maxSubagentRounds` / `maxGoalRounds` settings that were
 * their configuration surface, the `MAX_TURNS_PER_SUBAGENT` env var, and `MAX_GOAL_AUTO_ROUNDS`.
 *
 * They were removed for the reason `chat/constants.ts` gives for deleting their predecessors: nothing set any
 * of them, so they read as enforced limits while the loop was in fact unbounded — and a limit nothing reads is
 * worse than no limit, because it is how a second, competing Stop Policy gets written by mistake (§20 rule 7).
 *
 * The underlying judgement is older than the cleanup, and is recorded in the two loops these fed: a count
 * cannot tell a run that is working from one that is stuck, so a ceiling lands on the runs doing the MOST work
 * and returns a truncated answer that reads like a finished one.
 *
 * ── What still stops a run ──────────────────────────────────────────────────────────────────────────────────
 *
 * All of it is in `decideStop` below, and every one of them fires on BEHAVIOUR rather than on size, so each can
 * say which one it was: cancellation, a provider error, a doom loop, ten consecutive tool failures, a context
 * window about to overflow, and the model's own final answer.
 *
 * Timeouts are untouched and are the wall-clock backstop this leaves in place — per-tool `timeout_ms`, the
 * command timeouts, `GRANT_TTL_MS`, the poll budget, and `agent.limits.maxConsecutiveTimeouts`. A run with no
 * round ceiling is still not a run that can hang.
 */
import type { StopReason } from "./runtimeBoundary";
import type { AgentExecutionState } from "./executionState";
import { STALLED_ROUNDS_TO_ESCALATE } from "./doomLoop";

export interface StopPolicyConfig {
  /**
   * Consecutive tool failures before the run stops.
   *
   * On by default, unlike the two limits above, and set well clear of the doom-loop detector's own
   * failure threshold: this is the backstop for a tool that is failing for an environmental reason the model
   * cannot fix by rewording its arguments (a missing binary, a dead sandbox), where every retry is certain to
   * fail the same way. Ten is high enough that a model working through a genuinely awkward edit is not cut
   * off, and low enough that a hopeless loop does not run all night.
   */
  maxConsecutiveFailures: number | null;
  /**
   * Fraction of the context window at which the run stops rather than issuing another request.
   *
   * `null` = no limit, and that is the default because compaction already handles growth: it triggers well
   * below this and is designed to keep a long run inside its window indefinitely. This exists for the case
   * compaction cannot help with — a single turn whose live tail alone approaches the window — where the
   * alternative is a provider rejecting the request with an error the user cannot act on.
   */
  contextLimitFraction: number | null;
}

/** Nothing is capped by size; a run ends on runaway failure, a detected doom loop, or its own answer. */
export const DEFAULT_STOP_POLICY: StopPolicyConfig = {
  maxConsecutiveFailures: 10,
  contextLimitFraction: null,
};

/** What the policy was asked about. Every field is a fact already recorded elsewhere. */
export interface StopPolicyInput {
  state: AgentExecutionState;
  /** The user cancelled — the existing per-conversation AbortController, not a second mechanism. */
  cancelled: boolean;
  /** The doom-loop detector escalated on this round (see doomLoop.closeRound). */
  doomLoopEscalated: boolean;
  /** The last provider request failed outright. */
  providerError?: string | null;
  /** The model answered with no tool calls: its final response. */
  finalResponse: boolean;
  /** Current context size and window, when known, for the context-limit condition. */
  contextTokens?: number;
  contextWindow?: number;
  /**
   * The goal evaluator's verdict, when a goal is in force.
   *
   * Passed in rather than computed: §11 says to defer to `goalEvaluator.ts`, and the evaluator is an
   * independent model call that this pure function must not make. `undefined` means no goal is active, which
   * is not the same as a goal being unmet.
   */
  goalMet?: boolean;
}

export interface StopDecision {
  stop: boolean;
  reason?: StopReason;
  /** Human-readable detail, carried on the `stopped` event for the user and the log. */
  detail?: string;
}

const CONTINUE: StopDecision = { stop: false };

/**
 * Decide whether the run ends here.
 *
 * The order is a precedence, and each position is a judgement about what the user is owed:
 *
 *  1. **cancellation** — the user asked; nothing outranks that, and reporting any other reason for a run the
 *     user stopped would be a lie.
 *  2. **provider error** — the run cannot continue whatever anything else thinks.
 *  3. **doom loop** — checked before the final-response condition, because a looping model that finally emits
 *     text is still a looping model and the run should be reported as such.
 *  4. **final response** — the normal exit. Gated on the goal, because a goal in force means the model does
 *     not get to declare itself finished; an unmet goal turns its "final" answer into another round.
 *  5. **runaway failure and context exhaustion** — last, so a run that was going to finish anyway is never
 *     reported as having hit one. Neither is a round ceiling: one fires when the same tool has failed ten
 *     times running, the other when the next request would not fit in the window.
 */
export function decideStop(input: StopPolicyInput, cfg: StopPolicyConfig = DEFAULT_STOP_POLICY): StopDecision {
  const { state } = input;

  if (input.cancelled) return { stop: true, reason: "cancelled" };
  if (input.providerError) return { stop: true, reason: "error", detail: input.providerError };
  if (input.doomLoopEscalated) {
    return {
      stop: true,
      reason: "doom-loop",
      // The detector's own threshold, imported rather than restated, so the number in the message cannot
      // drift away from the number that produced it.
      detail: `no new information for ${STALLED_ROUNDS_TO_ESCALATE} consecutive rounds`,
    };
  }

  if (input.finalResponse) {
    // A goal that is in force and not met is the one thing that can override the model's own ending. When no
    // goal is active `goalMet` is undefined, and the final response stands.
    if (input.goalMet === false) return CONTINUE;
    return { stop: true, reason: "completed" };
  }

  if (cfg.maxConsecutiveFailures !== null && state.consecutiveFailures >= cfg.maxConsecutiveFailures) {
    return {
      stop: true,
      reason: "error",
      detail: `${state.consecutiveFailures} consecutive tool failures`,
    };
  }
  if (
    cfg.contextLimitFraction !== null &&
    input.contextTokens != null &&
    input.contextWindow != null &&
    input.contextWindow > 0 &&
    input.contextTokens / input.contextWindow >= cfg.contextLimitFraction
  ) {
    return {
      stop: true,
      reason: "context-limit",
      detail: `${input.contextTokens} of ${input.contextWindow} tokens`,
    };
  }

  return CONTINUE;
}

/**
 * Does a stop reason mean the work finished, or that it was cut short?
 *
 * The distinction has to be explicit somewhere, because everything user-facing depends on it: a run stopped
 * by a doom loop or a limit must never be presented as a completed task, which is the failure mode the goal
 * loop's `exhausted` path already guards against by clearing the goal before its final round.
 */
export const isSuccessfulStop = (reason: StopReason | undefined): boolean => reason === "completed";
