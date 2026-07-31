/**
 * Thinking mode: whether the model reasons before it answers, and how hard.
 *
 * Two controls, both surfaced in the chat composer's toolbar:
 *  - a master switch (off by default), and
 *  - three gears — low / medium / high — that only mean anything while the switch is on.
 *
 * The setting is global (like the selected model) rather than per-conversation, and is persisted under the
 * same `agent.*` storage root.
 *
 * What actually goes on the wire (see thinkingParams) is per-family, because there is no single spelling —
 * and, more importantly, because "off" is not the same thing as "say nothing". Most current cloud reasoners
 * think unless the request tells them not to, so an empty body reproduces the vendor default rather than the
 * user's choice. That is the whole reason FAMILIES below spells out both directions instead of only the on
 * one: switching thinking off used to send nothing at all, and the model went on thinking.
 *
 * The family is read off the model id because that is what survives every gateway: the same qwen3 model is
 * reached through DashScope, the platform's own endpoint, or a custom base URL, and the id is the one part
 * that still names it.
 *
 * Sending a switch a provider has never heard of is a 400, not a no-op, so anything unrecognised keeps the
 * old conservative behaviour (opt-in: silence means off). For the recognised ones the caller carries a
 * safety net — see isThinkingParamError, which turns that 400 into one retry without these fields.
 */
import { getStorage } from "@zzcpt/zztool";
import { putStorage } from "@/lib/ai/agentStorage";
import { AGENT_THINKING_ENABLED_KEY, AGENT_THINKING_EFFORT_KEY } from "@/constants/Agent";

/** The three gears, in display order. */
export const THINKING_EFFORTS = ["low", "medium", "high"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface ThinkingConfig {
  enabled: boolean;
  /** Retained while the switch is off, so turning it back on restores the gear the user last chose. */
  effort: ThinkingEffort;
}

/** Off by default: today no reasoning parameter is sent at all, and that is what "off" reproduces. */
export const DEFAULT_THINKING: ThinkingConfig = { enabled: true, effort: "medium" };

/** i18n key for a gear's label. */
export const effortLabelKey = (e: ThinkingEffort) => `composer.effort.${e}`;

export function loadThinking(): ThinkingConfig {
  const stored = getStorage(AGENT_THINKING_EFFORT_KEY);
  const effort = (THINKING_EFFORTS as readonly string[]).includes(String(stored))
    ? (stored as ThinkingEffort)
    : DEFAULT_THINKING.effort;
  return { enabled: getStorage(AGENT_THINKING_ENABLED_KEY) === "1", effort };
}

/**
 * Change broadcast, same pattern as MODEL_LIST_CHANGE_EVENT: the setting is global but is held in
 * component state in three places at once (the home composer, the chat composer, and the chat page that
 * actually sends), and the chat page is mounted permanently by AgentShell — so without this, toggling the
 * switch on the home page wrote storage that the sender, mounted long before, would never read again.
 * A stale sender is invisible and sends the opposite of what the toolbar shows.
 */
export const THINKING_CHANGE_EVENT = "agent:thinking-changed";

export function saveThinking(cfg: ThinkingConfig): void {
  // Cleared with null rather than "0", matching the other boolean flags under agent.*.
  putStorage(AGENT_THINKING_ENABLED_KEY, cfg.enabled ? "1" : null);
  putStorage(AGENT_THINKING_EFFORT_KEY, cfg.effort);
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(THINKING_CHANGE_EVENT));
  } catch { /* ignore */ }
}

/** Qwen's depth knob is a token cap rather than a label — the gears pick one. */
const QWEN_THINKING_BUDGET: Record<ThinkingEffort, number> = { low: 1024, medium: 4096, high: 16384 };

/** `thinking: {type}` — the switch shared by the families that copied Zhipu's spelling. */
const typeSwitch = (on: boolean) => ({ thinking: { type: on ? "enabled" : "disabled" } });

/**
 * Per-family spelling of BOTH directions, first id match wins.
 *
 * `off` is the half that earns its keep: for a family that reasons unless told otherwise, `{}` means
 * "keep reasoning", so every default-on family needs an explicit off here or the switch is decorative.
 */
const FAMILIES: Array<{
  test: RegExp;
  on: (effort: ThinkingEffort) => Record<string, unknown>;
  off: () => Record<string, unknown>;
}> = [
  // Qwen (DashScope): reasons by default; depth is a token cap rather than a label.
  {
    test: /qwen/,
    on: (e) => ({ enable_thinking: true, thinking_budget: QWEN_THINKING_BUDGET[e] }),
    off: () => ({ enable_thinking: false }),
  },
  // GLM (Zhipu) and DeepSeek's hybrid line: on by default, switched by type, no depth control.
  { test: /glm|deepseek/, on: () => typeSwitch(true), off: () => typeSwitch(false) },
  // OpenAI's o-series is a reasoning model end to end — there is no off, and asking for one is a 400.
  // Kept ahead of the gpt-5 rule so it cannot be swept up by it.
  { test: /(^|[^a-z])o[1-9]([^0-9]|$)/, on: (e) => ({ reasoning_effort: e }), off: () => ({}) },
  // GPT-5 and Gemini: both reason by default and both read reasoning_effort, whose off position is "none".
  {
    test: /gpt-[5-9]|gemini/,
    on: (e) => ({ reasoning_effort: e }),
    off: () => ({ reasoning_effort: "none" }),
  },
  // Anthropic: opt-in, so silence really is off, and the gears map straight onto the effort.
  { test: /claude/, on: (e) => ({ reasoning_effort: e }), off: () => ({}) },
];

/**
 * Request-body fields for the current setting; spread into the OpenAI-compatible payload.
 * `model` is the id actually being sent (not the display label), used to pick the family's spelling.
 */
export function thinkingParams(
  cfg: ThinkingConfig,
  opts: { local: boolean; model: string },
): Record<string, unknown> {
  // Local: the template kwarg is the only lever, and it carries both directions. llama.cpp drops kwargs it
  // does not recognise, so a template without a thinking switch is simply unaffected.
  if (opts.local) return { chat_template_kwargs: { enable_thinking: cfg.enabled } };

  const fam = FAMILIES.find((f) => f.test.test(opts.model.toLowerCase()));
  // Unrecognised (a custom base URL, a gateway alias, a model added by hand): treat as opt-in, which is
  // the only guess that cannot break the request. Such a model may keep reasoning while the switch is off.
  if (!fam) return cfg.enabled ? { reasoning_effort: cfg.effort } : {};
  return cfg.enabled ? fam.on(cfg.effort) : fam.off();
}

/** Every key thinkingParams can put on the wire — the names a rejection would have to mention. */
const THINKING_PARAM_KEYS = [
  "chat_template_kwargs",
  "enable_thinking",
  "thinking_budget",
  "thinking",
  "reasoning_effort",
] as const;

/**
 * Does this failure look like the provider rejecting the thinking switch itself?
 *
 * Matched narrowly — a 400 (the status a rejected argument gets) that names one of our own fields —
 * because the fallback it guards drops the user's setting silently. Anything broader would start
 * swallowing real failures and answering them with an un-switched request.
 */
export function isThinkingParamError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg.includes("400")) return false;
  return THINKING_PARAM_KEYS.some((k) => msg.includes(k));
}
