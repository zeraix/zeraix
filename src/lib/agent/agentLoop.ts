/**
 * The Agent Loop — the control flow, with none of the I/O.
 *
 * Spec: docs/agent-runtime-loop.md §3, §7, §11, §12, §14. Milestone M5c.
 *
 * §3 says the loop should be "a `while(true)` (or equivalent) inside a plain, UI-framework-agnostic module
 * that page.tsx calls into". This is that module. What makes it possible for it to be small is that
 * everything it decides WITH was built first: execution state (M3), the stop policy (M3), doom-loop detection
 * (M3), the reasoning policy (M4), the provider-turn record (M2a), and the boundary it reports through (M2).
 *
 * ── What this owns, and what it refuses to own ──────────────────────────────────────────────────────────────
 *
 * It owns the ORDER of a run: open a round, decide how hard to think, ask the host to execute the round,
 * fold what came back into execution state and the doom-loop detector, ask the stop policy whether to
 * continue, and repeat. Every one of those is a decision about how the task proceeds, which §22's final
 * principle assigns to the Runtime.
 *
 * It owns nothing else. It does not build the wire (that is `contextManager`), send a request, execute a
 * tool, render anything, or persist anything — all of which arrive through `runRound`, a callback the host
 * supplies. That single seam is deliberate: it is what lets the identical control flow drive the real
 * application, a sub-agent (§15), and a scripted test with no provider and no renderer (§18), instead of
 * three loops that resemble each other.
 *
 * ── The exit conditions, and why there is no `while (true)` guard clause ────────────────────────────────────
 *
 * There is exactly one exit: the stop policy says so. A final response, a cancellation, a doom loop, a
 * provider error and each configured limit all reach the same `decideStop` call and produce a structured
 * reason. That is §20 rule 7 taken literally — the loop itself has no opinion about when to stop, so it
 * cannot develop a second one.
 */
import type { RuntimeBoundary, StopReason } from "./runtimeBoundary";
import type { ToolResult, AgentTurn } from "./turn";
import { openTurn, withResponse, withToolResult, closeTurn } from "./turn";
import {
  initExecutionState,
  beginRound,
  recordToolResult,
  endRoundWithoutTools,
  markCompacted,
  markClaimsComplete,
  markCompleted,
  type AgentExecutionState,
} from "./executionState";
import { createDoomLoopState, observeCall, closeRound, type CallVerdict, type DoomSignal } from "./doomLoop";
import { decideStop, DEFAULT_STOP_POLICY, type StopDecision, type StopPolicyConfig } from "./stopPolicy";
import { resolveReasoning, type ReasoningDecision } from "./reasoningPolicy";
import type { ModelCapabilities } from "./modelAdapter";
import type { ThinkingConfig, ThinkingEffort } from "@/lib/ai/thinking";

/** What the host is asked to do for one Provider Turn. */
export interface RoundRequest {
  /** State as of the start of this round, including the phase the reasoning decision was made from. */
  state: AgentExecutionState;
  /** The reasoning configuration this round must be issued with. */
  reasoning: ReasoningDecision;
  /** The turn record to fill in. */
  turn: AgentTurn;
}

/** What the host reports back. */
export interface RoundResult {
  content: string;
  reasoning: string;
  /** Empty means the model called no tools, which is its final response. */
  toolResults: ToolResult[];
  /** The tool calls issued, for pairing and for the turn record. */
  toolCallCount: number;
  /** Set when the request itself failed. Ends the run with reason `error`. */
  providerError?: string | null;
  /** Context was compacted before this round; makes the next one a planning round (§6.1). */
  compacted?: boolean;
  /**
   * The model asked to change its effort for the next turn (§6.2). One turn only.
   * Null or absent means it did not ask.
   */
  reasoningRequest?: ThinkingEffort | null;
  /** The model signalled it believes the task is done (e.g. every todo complete). */
  claimsComplete?: boolean;
  /**
   * The host has injected a reminder and wants another round, even though this one called no tools.
   *
   * The main agent's loop has four such guards — an empty reply after real work, delegations still running
   * when the turn tries to end, an unreviewed risky change, an unrecorded lesson. Each nudges the model and
   * goes round again, and each is latched so it fires at most once per turn: a guard that could re-fire would
   * turn "try to conclude, get told to do X, decline" into a loop with no exit.
   *
   * The loop takes this at face value and does NOT count it as a final response. It cannot police the
   * latching, because the guards are the host's; what it can do is refuse to let this bypass the stop policy,
   * which is why every other stop condition is still evaluated below.
   */
  forceContinue?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  /** Current context size, for the context-limit stop condition. */
  contextTokens?: number;
}

export interface AgentLoopDeps {
  boundary: RuntimeBoundary;
  /** Identifiers for the turn records. */
  sessionId: string;
  turnId: string;
  modelId: string;
  agentId?: string;
  /** Execute one Provider Turn. Everything the Runtime does not own arrives through here. */
  runRound: (req: RoundRequest) => Promise<RoundResult>;
  /** The user's thinking setting. The ceiling; never modified. */
  thinking: ThinkingConfig;
  capabilities: ModelCapabilities;
  stopPolicy?: StopPolicyConfig;
  contextWindow?: number;
  /**
   * The goal evaluator's verdict, consulted only when the model produces a final response.
   *
   * A callback because it is a model call: §11 says to defer to `goalEvaluator.ts`, and the loop must not
   * make that decision itself. `undefined` means no goal is in force, which is not the same as unmet.
   */
  evaluateGoal?: (turns: AgentTurn[]) => Promise<boolean | undefined>;
  /** Injects a reminder for a doom-loop signal. The host decides how (reminders.ts). */
  onDoomSignal?: (signal: DoomSignal, result: ToolResult, verdict: CallVerdict) => void;
  /** A clock, injected so a test can be deterministic. */
  now?: () => number;
}

export interface AgentLoopResult {
  stop: StopDecision;
  state: AgentExecutionState;
  turns: AgentTurn[];
}

/**
 * Run the loop until the stop policy ends it.
 *
 * Every round follows the same six steps, and the order is the specification:
 *
 *  1. open the round — the execution state's phase is re-derived here, from facts recorded last round;
 *  2. resolve reasoning FROM that phase, so a recovery round is issued at full effort (§6.3);
 *  3. hand the round to the host;
 *  4. fold the results into execution state and the doom-loop detector, in that order;
 *  5. ask the stop policy;
 *  6. continue, or emit `stopped` and return.
 *
 * Doing (2) before (3) is what makes the reasoning policy real rather than advisory: the configuration is
 * decided before the request exists, so the host cannot forget to apply it.
 */
export async function runAgentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const {
    boundary,
    sessionId,
    turnId,
    modelId,
    agentId = "main",
    runRound,
    thinking,
    capabilities,
    stopPolicy = DEFAULT_STOP_POLICY,
    contextWindow,
    evaluateGoal,
    onDoomSignal,
    now = () => 0,
  } = deps;

  let state = initExecutionState();
  const doom = createDoomLoopState();
  const turns: AgentTurn[] = [];
  // Carried across exactly one round: §6.2's override applies to the next turn and then lapses.
  let pendingEffort: ThinkingEffort | null = null;

  for (;;) {
    // Cancellation is checked at the top rather than only after the request, so a run cancelled while a tool
    // was executing does not issue one more request before noticing.
    if (boundary.signal.aborted) {
      const stop: StopDecision = { stop: true, reason: "cancelled" };
      boundary.onEvent({ type: "stopped", reason: "cancelled" });
      return { stop, state, turns };
    }

    state = beginRound(state);
    const reasoning = resolveReasoning({
      user: thinking,
      phase: state.phase,
      capabilities,
      modelRequest: pendingEffort,
    });
    pendingEffort = null;

    let turn = openTurn({ turnId, sessionId, round: state.round - 1, modelId, agentId, startedAt: now() });
    boundary.onEvent({ type: "turn-start", turn });

    const result = await runRound({ state, reasoning, turn });

    turn = withResponse(turn, {
      content: result.content,
      reasoning: result.reasoning,
      // The calls themselves are the host's to report; the loop needs only their count and their results.
      toolCalls: [],
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });

    if (result.compacted) state = markCompacted(state);
    if (result.claimsComplete) state = markClaimsComplete(state);
    if (result.reasoningRequest) pendingEffort = result.reasoningRequest;

    // Fold the tools: execution state first (so the phase reflects a failure immediately), then the
    // doom-loop detector, whose verdicts are per call and whose escalation is per round.
    const verdicts: CallVerdict[] = [];
    for (const r of result.toolResults) {
      state = recordToolResult(state, r);
      turn = withToolResult(turn, r);
      const verdict = observeCall(doom, { name: r.name, args: r.args, result: r.content, ok: r.ok });
      verdicts.push(verdict);
      if (verdict.signal && onDoomSignal) onDoomSignal(verdict.signal, r, verdict);
      boundary.onEvent({ type: "tool-end", result: r });
    }
    const roundVerdict = closeRound(doom, verdicts);
    // A nudged round is not a final response: the host asked for another pass and the model has not had the
    // chance to answer it yet. Everything else about the round still counts — the tools it ran, the state it
    // moved, and every stop condition below.
    const finalResponse = result.toolCallCount === 0 && !result.forceContinue;
    if (result.toolCallCount === 0) state = endRoundWithoutTools(state);

    turn = closeTurn(turn, now());
    turns.push(turn);
    boundary.onEvent({ type: "turn-end", turn });

    // The goal is consulted only when the model believes it is finished — it is an extra model call, and
    // asking it every round would double the cost of the run for no decision it could influence.
    const goalMet = finalResponse && evaluateGoal ? await evaluateGoal(turns) : undefined;

    const stop = decideStop(
      {
        state,
        cancelled: boundary.signal.aborted,
        doomLoopEscalated: roundVerdict.escalate,
        providerError: result.providerError ?? null,
        finalResponse,
        contextTokens: result.contextTokens,
        contextWindow,
        goalMet,
      },
      stopPolicy,
    );

    if (stop.stop) {
      if (stop.reason === "completed") state = markCompleted(state);
      boundary.onEvent({ type: "stopped", reason: stop.reason as StopReason, detail: stop.detail });
      return { stop, state, turns };
    }
  }
}
