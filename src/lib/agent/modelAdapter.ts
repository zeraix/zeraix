/**
 * Model Adapter — the only place in the Agent Runtime that knows what a specific provider wants.
 *
 * Spec: docs/agent-runtime-loop.md §5, §5.1, §20 rules 1, 2, 13.
 *
 * The Runtime is meant to decide what to do next from CAPABILITIES and execution state, never from a model
 * name. Today the loop does the opposite in several places at once: `thinkingParams` picks a request field by
 * regex on the model id, `applyReasoningPolicy` branches on `isLocalModel`, image stripping branches on
 * `activeModel.multimodal`, and each of those decisions is made inline in `send()`. None of them is wrong —
 * they encode real provider contracts — but they are scattered through orchestration code, which is what
 * makes the orchestration model-specific.
 *
 * This module does not replace any of them. It WRAPS them (§5: "do not rewrite that table from scratch, wrap
 * it") behind one interface, so that the Runtime built in later milestones can ask "does this model support
 * per-turn reasoning effort?" instead of testing a regex it should not own.
 *
 * ── What is honest here, and what is a guess ────────────────────────────────────────────────────────────────
 *
 * Capability reporting is only useful if it is TRUE, so each flag below records how it is known:
 *
 *  - `supportsReasoning` — from the runtime rejection set, and only from there. Every branch of
 *    `thinkingParams` sends some reasoning field, unrecognised models included, so family membership decides
 *    HOW to ask rather than WHETHER it works. A provider that 400s on the parameter is recorded by
 *    `chatRequest.ts`, and from that moment this must report false or the Runtime plans around a knob that
 *    does not exist.
 *  - `supportsPerTurnReasoningEffort` — true only where the family's "on" spelling actually carries the
 *    effort per request. This is the capability §6.2's `set_reasoning_effort` tool is gated on, and §6.2
 *    requires it to degrade silently, so a false here must mean "do not offer the tool", never an error.
 *  - `supportsStructuredOutput` — **false everywhere.** Nothing in this app sends `response_format` today,
 *    so there is no evidence any configured provider honours it. Reporting it optimistically would be
 *    inventing a capability; §5 wants detection, not optimism.
 *  - `supportsImages` — passed in, not computed. `models.ts:modelAcceptsImages` already folds the
 *    local-mmproj question together with the "a provider rejected images for this model recently" verdict,
 *    and it reads app state to do it. The caller resolves it and hands over the answer, which keeps this
 *    module free of I/O and free of storage access.
 *
 * Nothing here performs I/O, and nothing imports React. That is the point: §18's scenarios run against
 * `createScriptedAdapter` (§5.1, testModelAdapter.ts) with no provider and no renderer involved.
 */
import { thinkingParams, type ThinkingConfig, type ThinkingEffort } from "@/lib/ai/thinking";
import type { ChatResponse, ToolCall, Usage } from "@/app/agent/chat/types";

/**
 * What a model can do, as far as anything can actually be known.
 *
 * §5's five flags, plus two this codebase already has real answers for (`supportsImages`, `contextWindow`)
 * and one §6.2 needs but §5 did not name (`supportsPerTurnReasoningEffort`). Reasoning support and *per-turn
 * effort* are different questions: a model can reason while offering no way to ask for less of it.
 */
export interface ModelCapabilities {
  supportsReasoning: boolean;
  supportsToolCalling: boolean;
  supportsParallelToolCalls: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  /** Whether reasoning effort can be set per request — the gate for §6.2's model-driven override. */
  supportsPerTurnReasoningEffort: boolean;
  supportsImages: boolean;
  contextWindow?: number;
}

/** One provider response, reduced to what the Runtime acts on. */
export interface NormalizedTurn {
  /** Assistant text. Empty string rather than null, so callers never branch on the difference. */
  content: string;
  /** The separate reasoning body, under whichever field name the provider used. "" when there is none. */
  reasoning: string;
  /** Never undefined — an empty array means "no tools", which is the loop's exit condition. */
  toolCalls: ToolCall[];
  usage?: Usage;
}

/**
 * The contract the Runtime programs against.
 *
 * Deliberately narrow. Transport, retries and usage logging stay in `chatRequest.ts`, which already handles
 * three separate provider-rejection fallbacks; duplicating any of that here would create the second request
 * path §20 rule 9 exists to prevent. The adapter shapes requests and reads responses. It does not send them.
 */
export interface ModelAdapter {
  /** The model id actually sent to the provider, not a display label. */
  readonly id: string;
  capabilities(): ModelCapabilities;
  /**
   * Provider fields for a reasoning configuration, spread into the request body.
   *
   * Takes the config as an argument rather than reading a global so a single turn can be issued at a
   * different effort from the session default — which is the whole mechanism §6 needs.
   */
  reasoningParams(cfg: ThinkingConfig): Record<string, unknown>;
  normalizeResponse(data: ChatResponse): NormalizedTurn;
}

/**
 * Families whose "on" spelling carries the effort per request.
 *
 * Mirrors — deliberately, not duplicates — the shape of `thinking.ts`'s FAMILIES table. The two answer
 * different questions: that table answers "what field do I send", this one answers "can effort vary per
 * request at all". They are kept separate because a family can gain the first without gaining the second,
 * and because importing a private table would couple the Runtime to the request path's internals.
 *
 * Local models are excluded on purpose: `chat_template_kwargs.enable_thinking` is a boolean, so a local model
 * can be told whether to think but not how hard. Reporting otherwise would make §6.2 offer a tool that
 * silently does nothing.
 */
const PER_TURN_EFFORT = /(^|[^a-z])o[1-9]([^0-9]|$)|gpt-[5-9]|gemini|claude/;

/** Everything the adapter needs to describe a model. Supplied by the caller; nothing is read from storage. */
export interface AdapterModel {
  /** The id sent on the wire. */
  model: string;
  /** A local llama.cpp build: different reasoning lever, no remote image fetch, stricter chat template. */
  local: boolean;
  multimodal: boolean;
  contextWindow?: number;
  /**
   * This model has already rejected the thinking parameter at runtime (`chatRequest.ts` records it).
   * Reported as "cannot reason" from then on: the capability is about what will actually work, not what the
   * family table would like to be true.
   */
  thinkingRejected?: boolean;
}

/**
 * Capabilities for an OpenAI-compatible provider, which is every provider this app talks to.
 *
 * `supportsToolCalling` and `supportsStreaming` are true unconditionally, and that is a statement about this
 * codebase rather than about language models in general: every configured provider goes through the same
 * OpenAI-compatible `chat/completions` path, and one that could not call tools could not run this app at all.
 * If a provider that cannot is ever added, this is the function that must learn about it.
 */
export function describeCapabilities(m: AdapterModel): ModelCapabilities {
  return {
    // A recorded rejection is the ONLY thing that disqualifies a model here, and that is not a shortcut: every
    // branch of `thinkingParams` sends something — a family's own spelling, the local template kwarg, or
    // `reasoning_effort` for an unrecognised model, which it treats as opt-in. So the family a model belongs
    // to does not decide whether it can reason; it decides how to ask. What decides is whether the provider
    // has already answered "no" at runtime.
    supportsReasoning: !m.thinkingRejected,
    supportsToolCalling: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    // See the header: nothing sends response_format today, so there is no evidence to report.
    supportsStructuredOutput: false,
    supportsPerTurnReasoningEffort:
      !m.thinkingRejected && !m.local && PER_TURN_EFFORT.test(m.model.toLowerCase()),
    supportsImages: m.multimodal,
    contextWindow: m.contextWindow,
  };
}

/**
 * Read the assistant message out of a provider response.
 *
 * Shared by every adapter because the shape is the wire format, not a provider's dialect. The three reasoning
 * field names are the ones observed in the wild (`reasoning_content` from Qwen / DeepSeek, `reasoning`
 * elsewhere); an absent one yields "" rather than undefined so no caller has to null-check before trimming.
 */
export function normalizeChatResponse(data: ChatResponse): NormalizedTurn {
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? "",
    reasoning: (msg?.reasoning_content ?? msg?.reasoning ?? "") || "",
    toolCalls: msg?.tool_calls ?? [],
    usage: data.usage,
  };
}

/**
 * The adapter for real providers.
 *
 * `reasoningParams` is a straight pass-through to `thinkingParams`, and that is the intended relationship:
 * the family table stays the single source of truth for request spelling (§5), while this type is what lets
 * the Runtime stop reaching for it directly.
 */
export function createModelAdapter(m: AdapterModel): ModelAdapter {
  const caps = describeCapabilities(m);
  return {
    id: m.model,
    capabilities: () => caps,
    reasoningParams: (cfg) => thinkingParams(cfg, { local: m.local, model: m.model }),
    normalizeResponse: normalizeChatResponse,
  };
}

/**
 * Clamp a requested effort against what the user allowed (§6.1, §6.3).
 *
 * The Runtime may lower effort for routine tool follow-ups and may never raise it, never turn thinking on
 * when the user turned it off, and never reduce it for recovery or verification. Expressed here as a pure
 * function so the policy is testable on its own and so §6's rule has exactly one implementation.
 *
 * Returns the config to send. When the user has thinking off, the answer is always their config unchanged —
 * that is rule 4 in §20, and it is not negotiable by phase or by the model.
 */
export function clampEffort(user: ThinkingConfig, requested: ThinkingEffort | null): ThinkingConfig {
  if (!user.enabled || requested === null) return user;
  const order: ThinkingEffort[] = ["low", "medium", "high"];
  const userIdx = order.indexOf(user.effort);
  const wantIdx = order.indexOf(requested);
  if (wantIdx < 0 || userIdx < 0) return user;
  // Downward only. A model asking for MORE than the user allowed gets the user's ceiling, which is what
  // makes §6.2's override safe to expose: it can economise, it cannot spend beyond the budget.
  return wantIdx < userIdx ? { ...user, effort: requested } : user;
}
