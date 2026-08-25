/**
 * Provider Turn — one model request, as a thing the Runtime can name.
 *
 * Spec: docs/agent-runtime-loop.md §7.
 *
 * Today a "turn" is ambiguous in this codebase, and the ambiguity is load-bearing in the wrong direction.
 * `turnId` is generated once per `send()`, so it identifies the whole USER turn — everything from the user
 * pressing enter to the final answer, however many model requests that took. The individual requests inside
 * it are anonymous: the loop is a bare `while (true)` whose iterations are not numbered, not recorded, and
 * not attributable. The usage log can group spend by user turn but cannot say which of eleven provider
 * requests inside it was the expensive one.
 *
 * So this module introduces the missing level, and is careful not to collide with the existing one:
 *
 *   session   — a conversation. Identified by `convId`. Already exists.
 *   user turn — one user message and everything done in response. Identified by `turnId`. Already exists.
 *   provider turn — ONE model request and the tool calls it produced. Identified by `round` within a user
 *                   turn, and by `providerTurnId` globally. This is what was missing.
 *
 * §7's `AgentTurn` names `turnId` and `sessionId` as separate fields, which is exactly this hierarchy; the
 * naming here keeps the repository's existing words rather than introducing a third vocabulary for the two
 * levels that already have one.
 *
 * Nothing here mutates. A provider turn is a record of something that happened, so it is built once, when the
 * round completes, and read afterwards — by the Stop Policy (§11), by doom-loop detection (§12), and by
 * observability (§19). Execution State (§4.2, milestone M3) is the mutable accumulation over these.
 */
import type { ToolCall } from "@/app/agent/chat/types";

/** The result of executing one tool call. */
export interface ToolResult {
  /** Pairs with `ToolCall.id`, which is what keeps assistant.tool_calls aligned with its results. */
  toolCallId: string;
  /** The RESOLVED tool name, never the dispatcher's — a routed call must not be recorded as `call_tool`. */
  name: string;
  /** Arguments as executed, after routing resolved them. */
  args: Record<string, unknown>;
  /** The text fed back to the model, after any capping. */
  content: string;
  ok: boolean;
  /** Wall-clock execution time, for §19. */
  ms: number;
}

/**
 * One model request and everything it produced.
 *
 * `toolCalls` and `toolResults` are separate arrays rather than one paired list because they are populated at
 * different times — the calls arrive with the response, the results only after execution, and a turn that is
 * cancelled mid-execution has fewer results than calls. That asymmetry is real and worth being able to see:
 * it is how a cancelled round is told apart from a completed one.
 */
export interface AgentTurn {
  /** Unique across the session. */
  providerTurnId: string;
  /** The user turn this belongs to (the existing `turnId`). */
  turnId: string;
  /** The conversation (the existing `convId`). */
  sessionId: string;
  /** 0-based index within the user turn. Round 0 is the first request after the user's message. */
  round: number;
  /** The model id actually sent, not a display label — a session can switch models mid-conversation. */
  modelId: string;
  /** Which agent ran this: "main", or a sub-agent id. Sub-agents run the same loop (§15). */
  agentId: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  /** Assistant text. Empty on a pure tool-call round. */
  content: string;
  /** Reasoning body, when the provider returned one separately. */
  reasoning: string;
  startedAt: number;
  endedAt: number;
  promptTokens: number;
  completionTokens: number;
}

/** Everything needed to open a turn; the rest is filled in as it runs. */
export interface TurnInit {
  turnId: string;
  sessionId: string;
  round: number;
  modelId: string;
  agentId?: string;
  startedAt: number;
}

/**
 * Open a provider turn.
 *
 * `providerTurnId` is derived from the identifiers rather than randomised: the same round of the same user
 * turn always produces the same id, which is what lets a test assert on it and what lets a resumed or
 * replayed turn be recognised as the same turn rather than a new one. `Math.random` here would make every
 * §19 record unstable and every test that names an id flaky.
 */
export function openTurn(init: TurnInit): AgentTurn {
  return {
    providerTurnId: `${init.turnId}#${init.round}`,
    turnId: init.turnId,
    sessionId: init.sessionId,
    round: init.round,
    modelId: init.modelId,
    agentId: init.agentId ?? "main",
    toolCalls: [],
    toolResults: [],
    content: "",
    reasoning: "",
    startedAt: init.startedAt,
    endedAt: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/** Record what the model returned. Returns a new turn; the input is not mutated. */
export function withResponse(
  turn: AgentTurn,
  res: { content: string; reasoning: string; toolCalls: ToolCall[]; promptTokens?: number; completionTokens?: number },
): AgentTurn {
  return {
    ...turn,
    content: res.content,
    reasoning: res.reasoning,
    toolCalls: res.toolCalls,
    promptTokens: res.promptTokens ?? turn.promptTokens,
    completionTokens: res.completionTokens ?? turn.completionTokens,
  };
}

/** Record one executed tool. Returns a new turn. */
export function withToolResult(turn: AgentTurn, result: ToolResult): AgentTurn {
  return { ...turn, toolResults: [...turn.toolResults, result] };
}

/** Close the turn. */
export function closeTurn(turn: AgentTurn, endedAt: number): AgentTurn {
  return { ...turn, endedAt };
}

/**
 * Did this turn ask for tools?
 *
 * The loop's continuation condition, named rather than inlined, because it is the single most important
 * predicate in the Runtime: a turn with no tool calls is the model's final answer and ends the user turn.
 */
export const wantsTools = (turn: AgentTurn): boolean => turn.toolCalls.length > 0;

/**
 * Were any of this turn's tool calls left unexecuted?
 *
 * True for a round cut short by cancellation. Worth a name because the wire requires every
 * `assistant.tool_calls` entry to be answered — an unanswered one makes the provider reject the whole
 * conversation on the next request, which is why `send()` back-fills placeholders today.
 */
export const hasUnansweredCalls = (turn: AgentTurn): boolean =>
  turn.toolCalls.some((c) => !turn.toolResults.some((r) => r.toolCallId === c.id));

/** Total tokens attributed to a turn, for §19. */
export const turnTokens = (turn: AgentTurn): number => turn.promptTokens + turn.completionTokens;

/** How long the turn took end to end; 0 while it is still open. */
export const turnDuration = (turn: AgentTurn): number =>
  turn.endedAt > 0 ? turn.endedAt - turn.startedAt : 0;
