/**
 * Adapter from the runner's neutral loop to an OpenAI-compatible chat-completions endpoint.
 *
 * This is the piece `sub-agent-runner.ts` deliberately does not contain. The runner owns the security
 * property — verify every tool call against the grant before it executes — and knows nothing about wire
 * formats; this module owns the wire format and knows nothing about permissions. Keeping them apart is what
 * lets the same enforcement run against whatever model a user has integrated, and it means a new provider
 * is a new adapter rather than a change to the code that decides what may run.
 *
 * OpenAI-compatible is the right first adapter for this app specifically: everything already goes through
 * the main-process proxy in `src/lib/ai/llm.ts` as an OpenAI-shaped body, so one adapter covers every
 * provider reachable that way. It is not privileged — an Anthropic-native or Gemini-native adapter is the
 * same exercise against the same `ModelClient` interface.
 *
 * ## The one translation that is not mechanical
 *
 * The neutral history carries a turn's tool results as a single `tool_results` entry, because that is how
 * Anthropic-shaped APIs want them: one user message containing every `tool_result` block. OpenAI-compatible
 * APIs want the opposite — one `role: "tool"` message per call, each carrying its own `tool_call_id`. So
 * this adapter fans one entry out into N messages. That asymmetry is exactly why the runner holds a neutral
 * shape instead of a provider one: a runner built around either convention would have made the other
 * adapter reconstruct information it had already thrown away.
 */

import type {
  ConversationEntry,
  ModelClient,
  ModelRequest,
  ModelTurn,
  StopReason,
  ToolCall,
} from "./sub-agent-runner";

/** A tool as the chat-completions API declares it. */
export interface ChatCompletionsTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatCompletionsMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatCompletionsMessage[];
  max_tokens: number;
  tools?: ChatCompletionsTool[];
  tool_choice?: "auto" | "none" | "required";
}

/**
 * How the request actually reaches the provider.
 *
 * Supplied by the host — `chatViaProxy` in Electron, a direct `fetch` on the web, a vendor SDK, a test
 * double. It returns the parsed response body and throws on transport or HTTP failure; everything about
 * endpoints, keys, headers and retries lives on the host's side of this function, which is why none of it
 * appears anywhere in this subsystem.
 */
export type ChatCompletionsTransport = (body: ChatCompletionsRequest) => Promise<unknown>;

/** Raised when the provider's response is not a shape we can read. */
export class MalformedChatResponseError extends Error {
  readonly name = "MalformedChatResponseError";
  readonly payload: unknown;

  constructor(reason: string, payload: unknown) {
    super(`Chat completion response was unusable: ${reason}`);
    this.payload = payload;
  }
}

export interface OpenAiCompatibleClientOptions {
  /** The model id, as the configured provider names it. */
  model: string;
  send: ChatCompletionsTransport;
  /**
   * Extra body fields merged into every request — a provider's `reasoning_effort`, `top_p`, or whatever
   * else it needs. Kept as an escape hatch rather than modelled, because the set is per-provider and
   * guessing at a union of them would date instantly. Cannot override `messages` or `tools`.
   */
  extraBody?: Record<string, unknown>;
}

// ── Request translation ───────────────────────────────────────────────────────────────────

/**
 * Exported so a host that already owns its own request function — keys, endpoint, proxy, retry, usage
 * logging — can build a `ModelClient` from these three pieces instead of routing a second HTTP path through
 * `createOpenAiCompatibleClient`. That is the normal case in an app that already talks to models.
 */
export function toChatTools(tools: ModelRequest["tools"]): ChatCompletionsTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Rebuild an assistant turn.
 *
 * Prefers `raw` — the provider's own message object, kept verbatim by the runner — because a provider that
 * returned fields this adapter does not model (reasoning payloads, refusal objects, vendor extensions) will
 * generally want them back unchanged, and rebuilding from `text` + `toolCalls` would silently drop them.
 * The reconstruction below is the fallback for a `ModelTurn` that came from somewhere else.
 */
function toAssistantMessage(entry: Extract<ConversationEntry, { role: "assistant" }>): ChatCompletionsMessage {
  if (entry.raw && typeof entry.raw === "object") {
    return entry.raw as ChatCompletionsMessage;
  }
  const message: ChatCompletionsMessage = { role: "assistant", content: entry.text || null };
  if (entry.toolCalls.length > 0) {
    message.tool_calls = entry.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.input) },
    }));
  }
  return message;
}

export function toChatMessages(system: string, history: readonly ConversationEntry[]): ChatCompletionsMessage[] {
  const messages: ChatCompletionsMessage[] = [{ role: "system", content: system }];
  for (const entry of history) {
    switch (entry.role) {
      case "user":
        messages.push({ role: "user", content: entry.text });
        break;
      case "assistant":
        messages.push(toAssistantMessage(entry));
        break;
      case "tool_results":
        // The fan-out described in the header: one `role: "tool"` message per result, each matched back to
        // its call by id. Order is preserved because some providers validate that every tool_call in the
        // preceding assistant turn is answered before the next assistant turn.
        for (const r of entry.results) {
          messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
        }
        break;
    }
  }
  return messages;
}

// ── Response translation ──────────────────────────────────────────────────────────────────

function mapFinishReason(finish: unknown, hasToolCalls: boolean): StopReason {
  switch (finish) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refused";
    default:
      // Providers vary and some omit it entirely. Falling back to the presence of tool calls keeps a
      // conforming-but-undocumented provider working; anything else terminates rather than looping, because
      // an unrecognised stop reason is not a reason to keep sampling.
      return hasToolCalls ? "tool_use" : "other";
  }
}

/**
 * Decode a tool call's arguments.
 *
 * A model can emit arguments that are not valid JSON — truncated output, a stray prose preamble, a provider
 * that double-encodes. That is a recoverable formatting slip, not a security event, so it does not throw:
 * the call goes through with an empty input and the tool's own validation produces an error result the model
 * can read and retry from. This is the same path a well-formed-but-wrong argument set takes, which is the
 * point — tool implementations must validate their input regardless of how good the model is, so there is no
 * second mechanism to build here.
 *
 * What it must never do is guess. Repairing malformed JSON would mean inventing arguments the model did not
 * send, for a call that is about to actually run.
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readToolCalls(message: Record<string, unknown>): ToolCall[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    const fn = entry?.function as Record<string, unknown> | undefined;
    const name = fn?.name;
    if (typeof name !== "string" || name === "") continue;
    calls.push({
      // Some providers omit the id on single-call responses. A synthesised one keeps the tool-result
      // messages matchable; it is only ever used to pair a result with its call.
      id: typeof entry?.id === "string" && entry.id !== "" ? entry.id : `call_${i}`,
      name,
      input: parseArguments(fn?.arguments),
    });
  }
  return calls;
}

/**
 * Read the provider's response.
 *
 * Defensive throughout, because this is remote data from an endpoint the user configured — not a trusted
 * internal structure. A response that cannot be read fails loudly here rather than becoming an empty turn
 * the runner would report as a completed task with no output.
 */
export function toModelTurn(payload: unknown): ModelTurn {
  if (typeof payload !== "object" || payload === null) {
    throw new MalformedChatResponseError("response was not an object", payload);
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new MalformedChatResponseError("no choices returned", payload);
  }
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message;
  if (typeof message !== "object" || message === null) {
    throw new MalformedChatResponseError("choice contained no message", payload);
  }

  const msg = message as Record<string, unknown>;
  const content = msg.content;
  const toolCalls = readToolCalls(msg);
  const stopReason = mapFinishReason(choice.finish_reason, toolCalls.length > 0);

  return {
    text: typeof content === "string" ? content : "",
    // A truncated turn's tool calls are not trustworthy — the arguments may have been cut mid-object, and
    // running a tool on half its input is worse than reporting the truncation. Dropped so the runner takes
    // its max_tokens path instead of executing them.
    toolCalls: stopReason === "max_tokens" ? [] : toolCalls,
    stopReason,
    raw: msg,
  };
}

// ── The client ────────────────────────────────────────────────────────────────────────────

/**
 * Build a `ModelClient` backed by an OpenAI-compatible chat-completions endpoint.
 *
 * The returned client is bound to one model and one transport — which is why the runner takes no model id
 * and no provider settings. Choosing those is the host's job, made once, here.
 */
export function createOpenAiCompatibleClient(opts: OpenAiCompatibleClientOptions): ModelClient {
  const { model, send, extraBody } = opts;

  return {
    async send(req: ModelRequest): Promise<ModelTurn> {
      const body: ChatCompletionsRequest = {
        ...extraBody,
        model,
        messages: toChatMessages(req.system, req.messages),
        max_tokens: req.maxTokens,
      };

      // Omitted rather than sent empty: a grant can legitimately contain no tools (the depth-limit case),
      // and several OpenAI-compatible providers reject `tools: []` outright instead of treating it as
      // "no tools". `tool_choice` goes with it — it is meaningless without them.
      if (req.tools.length > 0) {
        body.tools = toChatTools(req.tools);
        body.tool_choice = "auto";
      }

      return toModelTurn(await send(body));
    },
  };
}
