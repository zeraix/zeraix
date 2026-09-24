/**
 * Run one chat turn inside the Rust runtime, from the renderer.
 *
 * The renderer half of electron/agent/runtimeTurnBridge.mjs. `runAgentLoop` (agentLoop.ts) drives a turn one
 * round at a time from here; this hands the WHOLE turn to the runtime and answers what the runtime cannot do
 * itself: the tools implemented in this window, and — when asked — whether another round may start.
 *
 * ## Returns null rather than throwing when it cannot serve the turn
 *
 * No `window.agentRuntime` (the flag is off, or this is the browser build), a runtime too old for
 * `agent.run`, a missing workspace: each is "not served here", and the caller runs the turn on its own loop.
 * Null is only ever returned BEFORE the turn started, so falling back can never run a round twice. Anything
 * after that is a result or a throw, never a null.
 *
 * ## Deliberately import-free
 *
 * It depends on nothing but the preload surface, and uses only type syntax Node can strip — so the test
 * drives THIS module against the real main-process bridge and a real sidecar, rather than a copy of it.
 */

/** A provider request's worth of configuration, in the runtime's own terms. */
export interface RuntimeProvider {
  endpoint: string;
  apiKey: string;
  model: string;
  thinkingParams?: Record<string, unknown>;
  stream?: boolean;
  supportsPerTurnReasoningEffort?: boolean;
  /** `thinkingParams` for each effort a round may be issued at — the loop lowers effort on routine rounds. */
  thinkingByEffort?: Record<string, Record<string, unknown>>;
  temperature?: number;
  /** Sent on every request of the turn, e.g. `X-Conversation-Id` for a local llama-server's KV cache. */
  headers?: Record<string, string>;
  /** What this model is already known to refuse, so the runtime does not pay a failed request to relearn it. */
  known?: RuntimeQuirks;
}

/** Features a model has refused. Sent as `known`, and reported back as `learned`. */
export interface RuntimeQuirks {
  thinking_unsupported?: boolean;
  reasoning_context_unsupported?: boolean;
  vision_unsupported?: boolean;
}

/** Who a turn's model calls are billed to in the usage log. The main process writes the entries. */
export interface RuntimeTurnMeta {
  convId?: string;
  turnId?: string;
  /** Defaults to "chat". */
  source?: string;
  /** Defaults to "main". */
  actor?: string;
  /** The provider id, as the usage viewer groups by it. */
  provider?: string;
}

export interface RuntimeTurnParams {
  provider: RuntimeProvider;
  /** The conversation so far, in the provider's message shape. */
  messages: unknown[];
  /** Tool declarations, in the provider's shape. */
  tools: unknown[];
  /** The model's window. Turns on context management in the runtime; omit when unknown. */
  contextWindow?: number | null;
  summarizerModel?: string | null;
  /** Usage-log attribution. Never sent to the runtime. */
  meta?: RuntimeTurnMeta;
  /** Tools that may run side by side when the model asks for several in a row (only consecutive ones batch). */
  parallelTools?: string[];
  /** Send each round's thinking back within the turn — the same policy the wire applies to earlier turns. */
  replayReasoning?: boolean;
  /**
   * Hand EVERY tool call to `runTool`, the runtime's own tools and `ask_user` included. A chat window sets it: its
   * tool path carries consent under the user's approval mode, the tool's row and its log entry, and already ends
   * in the runtime's registry.
   */
  hostToolsOnly?: boolean;
  /** The user's thinking setting: the switch, and the ceiling no round's effort exceeds. */
  thinking?: { enabled: boolean; effort: string };
}

/** A tool call in the provider's shape — how the runtime reports it and how the chat stores it. */
export interface RuntimeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool call, as it starts and as it ends. Arguments on start, the result on end. */
export interface RuntimeToolEvent {
  phase: "start" | "end";
  id: string;
  name: string;
  /** The raw arguments string the model produced (start only). */
  arguments?: string;
  /** The arguments as executed, after routing (end only). */
  args?: unknown;
  /** What the tool returned (end only). */
  content?: string;
  ok?: boolean;
  ms?: number;
}

/**
 * A round's boundaries. `response` comes between them: the model's reply, BEFORE any of its tools run, with the
 * calls as they will be replayed — the copy to store, so the assistant turn lands ahead of its results.
 */
export interface RuntimeRoundEvent {
  phase: "start" | "response" | "end";
  round: number;
  effort?: string | null;
  /** On `end`, how many calls the round made. On `response`, the calls themselves. */
  tool_calls?: number | RuntimeToolCall[];
  /** `response` only. */
  content?: string;
  /** `response` only. */
  reasoning?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  /** The provider reported no usage and the runtime counted the request itself. */
  estimated?: boolean;
  /** The whole round, tools included. */
  ms?: number;
  /** The model request alone. */
  model_ms?: number;
}

/** A request that failed and is about to be tried again. */
export interface RuntimeRetryEvent {
  /** The attempt that failed, 1-based. */
  attempt: number;
  attempts: number;
  kind: "network" | "rate-limit" | "server";
  delay_ms: number;
  message: string;
}

/**
 * Streamed text. Normally the NEW text since the last delta. With `reset`, the request was retried: drop what
 * this round has streamed so far and start again from `content` / `reasoning`, which are then the whole text.
 */
export interface RuntimeDelta {
  content: string;
  reasoning: string;
  reset?: boolean;
}

/** The round that just closed, as the gate is told about it. */
export interface RuntimeRoundSummary {
  contentEmpty: boolean;
  hasReasoning: boolean;
  /** Every call that ran: the resolved name and the arguments as executed. */
  calls: { id: string; name: string; args: unknown; ok: boolean }[];
  /** Repetitions the loop detector noticed — "identical" | "equivalent" | "failing" | "resource". */
  signals: { callId: string; name: string; signal: string; repeat: number; failStreak: number; resourceHits: number }[];
}

export interface RuntimeRoundInfo {
  round: number;
  promptTokens: number;
  completionTokens: number;
  /** The last round was a final answer: the turn ends unless the answer says `resume`. */
  final: boolean;
  last: RuntimeRoundSummary | null;
}

export interface RuntimeRoundAnswer {
  proceed?: boolean;
  detail?: string;
  withdrawTools?: boolean;
  inject?: unknown[];
  /** Appended to the turn's latest tool result, joined with a blank line — where a reminder goes. */
  nudge?: string;
  /** After a final answer: run another round instead of ending the turn. */
  resume?: boolean;
}

/** `AgentRunResult`, as the runtime reports it. */
export interface RuntimeTurnResult {
  stop_reason: string;
  detail?: string;
  content: string;
  rounds: number;
  tool_calls: number;
  /** Verbatim — compaction changes what the model was sent, never this. */
  messages: unknown[];
  /** Indices into `messages` the HOST injected. Keep them on the wire; leave them out of what a person reads. */
  injected: number[];
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  /** At least one round's usage was counted by the runtime because the provider reported none. */
  estimated: boolean;
  /** Refusals discovered this turn, to be remembered and sent back as `known` next time. */
  learned: RuntimeQuirks;
}

export interface RuntimeTurnHandlers {
  /** Run a tool the runtime does not implement. Always resolves to the text the model reads. */
  runTool(name: string, args: unknown): Promise<{ ok: boolean; content: string }>;
  /** Answer "may another round start?". Omit to run ungated, which saves a round trip per round. */
  round?(info: RuntimeRoundInfo): Promise<RuntimeRoundAnswer>;
  onDelta?(delta: RuntimeDelta): void;
  onTool?(event: RuntimeToolEvent): void;
  onRound?(event: RuntimeRoundEvent): void;
  /** A failed request is being retried — the "Retrying… (2/3)" line the renderer's own loop shows. */
  onRetry?(event: RuntimeRetryEvent): void;
}

interface Envelope {
  runId: string;
  kind: string;
  payload: unknown;
}

interface Request {
  requestId: string;
  runId: string;
  kind: string;
  name?: string;
  args?: unknown;
  round?: number;
  promptTokens?: number;
  completionTokens?: number;
  final?: boolean;
  last?: RuntimeRoundSummary | null;
}

interface AgentRuntimeApi {
  start(runId: string, params: RuntimeTurnParams, gated: boolean): Promise<RuntimeTurnResult | null>;
  cancel(runId: string): void;
  reply(requestId: string, body: { result?: unknown; error?: string }): void;
  onEvent(cb: (e: Envelope) => void): () => void;
  onRequest(cb: (r: Request) => void): () => void;
}

function api(): AgentRuntimeApi | null {
  const w = globalThis as unknown as { agentRuntime?: AgentRuntimeApi };
  return w.agentRuntime ?? null;
}

/** Whether this build can run a chat turn in the runtime at all. */
export function runtimeChatAvailable(): boolean {
  return api() !== null;
}

let seq = 0;

/**
 * Run one turn in the runtime. Null means "not served here" — run it on `runAgentLoop` instead.
 */
export async function runTurnInRuntime(
  params: RuntimeTurnParams,
  handlers: RuntimeTurnHandlers,
  signal?: AbortSignal,
): Promise<RuntimeTurnResult | null> {
  const runtime = api();
  if (!runtime) return null;
  // Nothing has started, so the caller may still decide — exactly as it could without this module.
  if (signal?.aborted) return null;

  const runId = `chat-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Both subscriptions go up BEFORE the turn starts. The runtime can ask for a tool in the same round trip
  // that starts it, and a request that arrives before its listener exists is simply lost — the turn then
  // waits out a thirty-minute tool timeout for an answer nobody was listening for.
  const offEvent = runtime.onEvent((e) => {
    if (e.runId !== runId) return;
    try {
      if (e.kind === "delta") handlers.onDelta?.(e.payload as RuntimeDelta);
      else if (e.kind === "tool") handlers.onTool?.(e.payload as RuntimeToolEvent);
      else if (e.kind === "turn") handlers.onRound?.(e.payload as RuntimeRoundEvent);
      else if (e.kind === "retry") handlers.onRetry?.(e.payload as RuntimeRetryEvent);
    } catch (err) {
      // A display callback that throws must not end the turn: the run is still going and still paying.
      console.warn("[runtime-turn] an event handler threw:", err);
    }
  });
  const offRequest = runtime.onRequest((r) => {
    if (r.runId !== runId) return;
    void answer(r);
  });

  // Every path ends in a reply. The runtime is blocked on each of these, and silence would read as a tool
  // that is still running.
  async function answer(r: Request): Promise<void> {
    try {
      let result: unknown;
      if (r.kind === "tool") {
        result = await handlers.runTool(String(r.name ?? ""), r.args ?? {});
      } else if (r.kind === "round") {
        result = handlers.round
          ? await handlers.round({
              round: Number(r.round ?? 0),
              promptTokens: Number(r.promptTokens ?? 0),
              completionTokens: Number(r.completionTokens ?? 0),
              final: Boolean(r.final),
              last: r.last ?? null,
            })
          : { proceed: true };
      } else {
        throw new Error(`the renderer has no handler for a ${r.kind} request`);
      }
      runtime!.reply(r.requestId, { result });
    } catch (err) {
      runtime!.reply(r.requestId, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const onAbort = () => runtime.cancel(runId);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await runtime.start(runId, params, Boolean(handlers.round));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    offEvent();
    offRequest();
  }
}

/**
 * The transcript a person reads: `messages` without the ones the host injected.
 *
 * The model must keep them — it answered them — but the user never said them, and an injected instruction
 * carries `role: "user"`, so rendering `messages` as-is would put words in the user's mouth.
 */
export function userVisibleMessages(result: RuntimeTurnResult): unknown[] {
  const injected = new Set(result.injected ?? []);
  return result.messages.filter((_, i) => !injected.has(i));
}
