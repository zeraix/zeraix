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
 * ── Defaults preserve today's behaviour, deliberately ───────────────────────────────────────────────────────
 *
 * §11 asks for a maximum-turns limit and is explicit that it is "currently absent — this is a genuinely new
 * limit; make it configurable and off by default if the product intentionally wants unbounded runs, so this
 * refactor doesn't silently change today's product behavior".
 *
 * It does want that. M0 confirmed the absence is a recorded decision, not an oversight: the settings that
 * used to configure round limits were removed, and the comment in `page.tsx` states that interruption is the
 * user's own. So `maxTurns` and `maxToolCalls` default to `null`, meaning unbounded, and a run that hits no
 * other condition behaves exactly as it does today. Turning them on is a product decision, not a refactor.
 *
 * What is NOT off by default is doom-loop escalation, because that is not a limit on healthy work — it fires
 * only when three consecutive rounds produced no new information at all, which is the definition of a run
 * that is no longer working.
 *
 * ── Existing limits are inputs, not competitors ─────────────────────────────────────────────────────────────
 *
 * §11 says to reuse existing limits rather than create a second one with a different value for the same
 * concept. So `MAX_GOAL_AUTO_ROUNDS` stays where it is and keeps governing the goal loop — that loop counts
 * whole user turns and this policy governs rounds inside one turn, which are genuinely different concepts,
 * and collapsing them would be the duplication the rule warns about. `MAX_TURNS_PER_SUBAGENT` likewise stays
 * with the brokered sub-agent runner; when §15 converges the sub-agent loops onto this one, it becomes this
 * policy's `maxTurns` for a sub-agent session rather than a separate mechanism.
 *
 * ── Both of those are now OFF by default ────────────────────────────────────────────────────────────────────
 *
 * The two named above still live where this says they live, and still govern what it says they govern — but
 * their defaults are `null`. Every ceiling that ended a run for its SIZE rather than for something going
 * wrong has been switched off, here and in the two loops above: a count cannot tell a run that is working
 * from one that is stuck, so it lands on the runs doing the most work and returns a truncated answer that
 * reads like a finished one.
 *
 * What still stops a run is unchanged and is all in `decideStop` below: cancellation, a provider error, a
 * doom loop, ten consecutive tool failures, and the model's own final answer. Each of those fires on
 * BEHAVIOUR, and each can say which one it was. A caller that wants a ceiling passes one explicitly.
 */
import type { StopReason } from "./runtimeBoundary";
import type { AgentExecutionState } from "./executionState";
import { STALLED_ROUNDS_TO_ESCALATE } from "./doomLoop";

export interface StopPolicyConfig {
  /**
   * Provider turns allowed in one user turn. `null` = unbounded, which is today's behaviour and the default.
   * See the header: making this a number is a product decision.
   */
  maxTurns: number | null;
  /** Tool calls allowed in one user turn. `null` = unbounded, and the default, for the same reason. */
  maxToolCalls: number | null;
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

/** Today's behaviour, exactly: nothing is capped except runaway failure and a detected doom loop. */
export const DEFAULT_STOP_POLICY: StopPolicyConfig = {
  maxTurns: null,
  maxToolCalls: null,
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
 *  5. **the limits** — last, so a run that was going to finish anyway is never reported as having hit one.
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

  if (cfg.maxTurns !== null && state.round >= cfg.maxTurns) {
    return { stop: true, reason: "max-turns", detail: `${state.round} of ${cfg.maxTurns}` };
  }
  if (cfg.maxToolCalls !== null && state.toolCalls >= cfg.maxToolCalls) {
    return { stop: true, reason: "max-tool-calls", detail: `${state.toolCalls} of ${cfg.maxToolCalls}` };
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
