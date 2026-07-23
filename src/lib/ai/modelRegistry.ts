/**
 * Model Registry — implemented per docs/Model-Context-Window-Resolution-Spec.md.
 *
 * Layers: Provider Adapter (fetch + normalize per vendor) → Registry (in-memory cache + TTL) → Resolver (resolve the context window).
 * Resolution chain: exact value from the registry → heuristic on -8k/-32k/-1m style suffixes in the name → conservative default.
 *
 * Design trade-offs (aligned with this project's current state):
 *  - A built-in "static adapter" seeds the registry with each vendor's known context windows (no network, deterministic) and is the primary source of precision;
 *    OpenAI-compatible /models endpoints generally don't return context_length, so we can't rely on online discovery alone.
 *  - Example "online adapters" (e.g. OpenRouter) plus a refresh / hot-update mechanism are provided, but they are not registered and don't hit the network by default,
 *    to avoid unexpected network requests on the desktop; integrators opt in via registerAdapter + startAutoRefresh as needed.
 */

// ── 1) Standard model schema ────────────────────────────────────────────────────
export interface ModelInfo {
  id: string;
  provider?: string;
  contextWindow?: number; // context window (max input tokens)
  maxOutput?: number; // max output tokens
  updatedAt?: number; // write timestamp (for TTL / hot-update checks)
}

// ── 2) Provider adapter interface ────────────────────────────────────────────────
export interface ProviderAdapter {
  name: string;
  fetchModels(): Promise<unknown[]>;
  normalize(model: unknown): ModelInfo;
}

/**
 * Built-in static model table (primary source of precision): ctx = context window (max input tokens), out = max output tokens.
 * Values are taken from each vendor's official docs / model cards (verified 2026-07); when out is omitted it falls back to DEFAULT_MAX_OUTPUT
 * (mostly models with a "shared input+output window and no separate output cap", such as Moonshot / StepFun / SenseChat).
 * Entries marked "estimated" have no vendor-published hard cap and are inferred from the same family. Adjust as official specs change.
 */
const STATIC_MODELS: Record<string, { ctx: number; out?: number }> = {
  // DeepSeek (official: 1M context / 384K output)
  "deepseek-v4-flash": { ctx: 1_000_000, out: 384_000 },
  "deepseek-v4-pro": { ctx: 1_000_000, out: 384_000 },
  // Zhipu GLM
  "glm-4-plus": { ctx: 128_000, out: 4_096 },
  "glm-4-air": { ctx: 128_000, out: 16_384 },
  "glm-4-airx": { ctx: 8_192, out: 4_096 },
  "glm-4-flash": { ctx: 128_000, out: 16_384 },
  "glm-4-long": { ctx: 1_000_000, out: 4_096 },
  "glm-4v-plus": { ctx: 16_384, out: 16_384 },
  // Alibaba Qwen (app name → qwen-plus / qwen-flash: 1M context / 32K output)
  "qwen3.7-plus": { ctx: 1_000_000, out: 32_768 },
  "qwen3.6-plus": { ctx: 1_000_000, out: 32_768 },
  "qwen3.6-flash": { ctx: 1_000_000, out: 32_768 },
  "qwen3.5-flash": { ctx: 1_000_000, out: 32_768 },
  // ByteDance Doubao
  "doubao-1.5-pro-32k": { ctx: 32_768, out: 12_288 },
  "doubao-pro-32k": { ctx: 32_768, out: 4_096 },
  "doubao-pro-256k": { ctx: 262_144, out: 4_096 },
  "doubao-lite-32k": { ctx: 32_768, out: 4_096 }, // out estimated
  // Baidu ERNIE ("8k" is the total window shared by input+output; separate output cap is 2K)
  "ernie-4.0-8k": { ctx: 8_192, out: 2_048 },
  "ernie-4.0-turbo-8k": { ctx: 8_192, out: 2_048 },
  "ernie-3.5-8k": { ctx: 8_192, out: 2_048 },
  "ernie-speed-8k": { ctx: 8_192, out: 2_048 },
  "ernie-lite-8k": { ctx: 8_192, out: 2_048 },
  // Tencent Hunyuan (legacy retired models; values are the vendor's original launch specs · estimated)
  "hunyuan-turbo": { ctx: 32_000, out: 4_000 },
  "hunyuan-pro": { ctx: 32_000, out: 4_000 },
  "hunyuan-standard": { ctx: 32_000, out: 2_000 },
  "hunyuan-lite": { ctx: 256_000, out: 6_000 },
  // iFlytek Spark
  "4.0Ultra": { ctx: 8_192, out: 8_192 },
  "max-32k": { ctx: 32_768, out: 8_192 },
  "generalv3.5": { ctx: 8_192, out: 8_192 },
  "pro-128k": { ctx: 131_072, out: 4_096 },
  "lite": { ctx: 8_192, out: 4_096 },
  // Moonshot Kimi (input+output share the window, no separate output cap)
  "moonshot-v1-8k": { ctx: 8_192 },
  "moonshot-v1-32k": { ctx: 32_768 },
  "moonshot-v1-128k": { ctx: 131_072 },
  // MiniMax (input+output share the budget · abab series is estimated)
  "MiniMax-Text-01": { ctx: 1_000_000 },
  "abab6.5s-chat": { ctx: 245_760 },
  "abab6.5g-chat": { ctx: 8_192 },
  // 01.AI Yi (out estimated)
  "yi-lightning": { ctx: 64_000, out: 4_096 },
  "yi-large": { ctx: 32_000, out: 4_096 },
  "yi-medium": { ctx: 32_000, out: 4_096 },
  "yi-large-turbo": { ctx: 16_000, out: 4_096 },
  // StepFun (-Nk is the total window, shared by input+output)
  "step-2-16k": { ctx: 16_000 },
  "step-1-8k": { ctx: 8_000 },
  "step-1-32k": { ctx: 32_000 },
  "step-1v-8k": { ctx: 8_000 },
  // Baichuan (out estimated)
  "Baichuan4-Turbo": { ctx: 32_768, out: 8_192 },
  "Baichuan4-Air": { ctx: 32_768, out: 8_192 },
  "Baichuan4": { ctx: 32_768, out: 8_192 },
  "Baichuan3-Turbo": { ctx: 32_768, out: 8_192 },
  // SenseTime SenseChat (input+output share the window)
  "SenseChat-5": { ctx: 131_072 },
  "SenseChat-Turbo": { ctx: 32_768 },
  // SiliconFlow (open-source models, Hugging Face model cards)
  "deepseek-ai/DeepSeek-V3": { ctx: 131_072 },
  "deepseek-ai/DeepSeek-R1": { ctx: 131_072, out: 32_768 },
  "Qwen/Qwen2.5-72B-Instruct": { ctx: 131_072, out: 8_192 },
  "Qwen/Qwen2.5-7B-Instruct": { ctx: 131_072, out: 8_192 },
  "THUDM/glm-4-9b-chat": { ctx: 131_072 },
  // OpenAI (official max_output_tokens)
  "gpt-4o-mini": { ctx: 128_000, out: 16_384 },
  "gpt-4o": { ctx: 128_000, out: 16_384 },
  "gpt-4.1": { ctx: 1_047_576, out: 32_768 },
  "gpt-4.1-mini": { ctx: 1_047_576, out: 32_768 },
  "o4-mini": { ctx: 200_000, out: 100_000 }, // output includes reasoning tokens
  // ── Major overseas models (verified against official docs, 2026-07) ──
  // OpenAI ChatGPT (GPT-5.x; context measured as input+output combined)
  "gpt-5.5": { ctx: 1_050_000, out: 128_000 },
  "gpt-5.4-mini": { ctx: 400_000, out: 128_000 },
  "gpt-5.4-nano": { ctx: 400_000, out: 128_000 },
  "o3": { ctx: 200_000, out: 100_000 }, // output includes reasoning tokens
  // Anthropic Claude (official: 1M context / 128K output; Haiku is 200K/64K)
  "claude-opus-4-8": { ctx: 1_000_000, out: 128_000 },
  "claude-sonnet-5": { ctx: 1_000_000, out: 128_000 },
  "claude-haiku-4-5": { ctx: 200_000, out: 64_000 },
  "claude-fable-5": { ctx: 1_000_000, out: 128_000 },
  // Google Gemini (official ai.google.dev: 1,048,576 context / 65,536 output, multimodal)
  "gemini-3.1-pro-preview": { ctx: 1_048_576, out: 65_536 },
  "gemini-3.5-flash": { ctx: 1_048_576, out: 65_536 },
  "gemini-3.1-flash-lite": { ctx: 1_048_576, out: 65_536 },
};

/**
 * Vision (image input) capability per model id.
 *
 * Why this table exists: the model list stores `multimodal` per entry, but nothing ever filled it in
 * for catalog / official-platform models (only the custom-model form has a toggle). Every such entry
 * therefore resolved to multimodal:false, and the chat page strips EVERY image_url part from the wire
 * for a non-multimodal model — so a user attaching a screenshot to GPT-5.5 or Claude got "sorry, I
 * can't view images". This table restores the capability at resolve time.
 *
 * Only listed as `true` where the vendor documents image input. Being wrong in the optimistic
 * direction is the expensive mistake: a text-only endpoint rejects the entire request with
 * HTTP 400 "unknown variant `image_url`", so a model whose status is unclear is left out and the user
 * can still flip the per-model toggle in Settings → Models.
 */
const VISION_MODELS: Record<string, boolean> = {
  // OpenAI — GPT-4o and everything after it takes images; the o-series reasoning models do too.
  "gpt-4o": true,
  "gpt-4o-mini": true,
  "gpt-4.1": true,
  "gpt-4.1-mini": true,
  "gpt-5.5": true,
  "gpt-5.4-mini": true,
  "gpt-5.4-nano": true,
  "o3": true,
  "o4-mini": true,
  // Anthropic — the whole Claude family accepts images.
  "claude-opus-4-8": true,
  "claude-sonnet-5": true,
  "claude-haiku-4-5": true,
  "claude-fable-5": true,
  // Google — Gemini is natively multimodal across the line.
  "gemini-3.1-pro-preview": true,
  "gemini-3.5-flash": true,
  "gemini-3.1-flash-lite": true,
  // Vision variants of otherwise text-only Chinese families.
  "glm-4v-plus": true,
  "step-1v-8k": true,
  // Deliberately absent (text-only at the time of writing): deepseek-*, qwen3.x-plus/flash
  // (the vision line is qwen-vl-*), moonshot-v1-* (vision is moonshot-v1-*-vision-preview),
  // MiniMax-Text-01 / abab*, ernie-*, hunyuan-*, yi-*, Baichuan*, SenseChat-*.
};

/**
 * Name-shape fallback for models not in the table (manually added ids, official-platform catalog
 * entries, third-party gateways). Matches only naming conventions vendors use consistently for
 * image-capable models, so an unknown text model stays false and never triggers a 400.
 */
export function guessVision(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (/(^|[-_/])(vl|vision|multimodal|omni)([-_/.]|$)/.test(id)) return true; // qwen-vl-max, *-vision-preview, gpt-4o-omni
  if (/(^|[-_/])glm-\d+(\.\d+)?v/.test(id)) return true; // glm-4v-plus, glm-4.5v
  if (/(^|[-_/])step-\d+v/.test(id)) return true; // step-1v-8k
  if (/(^|[-_/])(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/.test(id)) return true; // OpenAI vision-era families
  if (/(^|[-_/])claude-/.test(id)) return true;
  if (/(^|[-_/])gemini-/.test(id)) return true;
  return false;
}

/**
 * Whether a model accepts image input: exact table entry → name-shape heuristic → false.
 * Used by resolveModel to fill in `multimodal` for catalog entries that never stored one.
 */
export function resolveVision(modelId: string): boolean {
  if (!modelId) return false;
  return VISION_MODELS[modelId] ?? guessVision(modelId);
}

/**
 * Default window for unknown / custom models. Deliberately large, to avoid prematurely triggering context compression when the window can't be identified and
 * summarizing away the analysis / conclusions / evidence from earlier questions (which shows up as "the next question seems to have forgotten the previous one").
 * Cost: if the connected model actually has a small window (e.g. a local 8K/32K model), a long conversation may overflow and error before compression kicks in —
 * such models should carry a real contextWindow in the model list (or use a 128k/1m name that guessContextWindow can parse).
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** Conservative default max output for unknown models (most vendors default to 4K–8K). */
export const DEFAULT_MAX_OUTPUT = 4096;

// ── 3) Registry (in-memory cache + TTL) ───────────────────────────────────────────
export class ModelRegistry {
  private cache = new Map<string, ModelInfo>();

  /** Write / overwrite one model entry, stamping it with a write timestamp. */
  set(model: ModelInfo): void {
    if (!model.id) return;
    this.cache.set(model.id, { ...model, updatedAt: nowMs() });
  }

  get(id: string): ModelInfo | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  all(): ModelInfo[] {
    return [...this.cache.values()];
  }

  /** Whether an entry has passed its TTL (used by hot-update to decide whether to re-fetch; defaults to 24h). */
  isStale(id: string, ttlMs = 24 * 60 * 60 * 1000): boolean {
    const m = this.cache.get(id);
    if (!m?.updatedAt) return true;
    return nowMs() - m.updatedAt > ttlMs;
  }
}

/** new Date() is disabled in some runtimes (e.g. workflow scripts), so we centralize the fallback here. */
function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/** Global singleton registry, seeded from the built-in static table on import (no network, synchronous). */
export const modelRegistry = new ModelRegistry();
for (const [id, { ctx, out }] of Object.entries(STATIC_MODELS)) {
  modelRegistry.set({ id, contextWindow: ctx, maxOutput: out, provider: "builtin" });
}

// ── 4) Online adapter example (unregistered / offline by default) + multi-source sync ───
/** OpenRouter: /models returns context_length, so it works as a sample adapter for "online discovery". */
export const openrouterAdapter: ProviderAdapter = {
  name: "openrouter",
  async fetchModels() {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const json = (await res.json()) as { data?: unknown[] };
    return Array.isArray(json?.data) ? json.data : [];
  },
  normalize(model) {
    const m = (model ?? {}) as { id?: string; context_length?: number };
    return { id: m.id ?? "", contextWindow: m.context_length, provider: "openrouter" };
  },
};

/** Registered online adapters (empty by default — makes no network requests). */
const liveAdapters: ProviderAdapter[] = [];
export function registerAdapter(adapter: ProviderAdapter): void {
  if (!liveAdapters.some((a) => a.name === adapter.name)) liveAdapters.push(adapter);
}

/** Iterate the registered online adapters; fetch, normalize, and write into the registry (online values override static ones — fresher). Failures are silent. */
export async function refreshModelRegistry(registry: ModelRegistry = modelRegistry): Promise<void> {
  for (const provider of liveAdapters) {
    try {
      const models = await provider.fetchModels();
      for (const raw of models) {
        const info = provider.normalize(raw);
        if (info.id && typeof info.contextWindow === "number") registry.set(info);
      }
    } catch {
      /* ignore network / parse failures: the static table and heuristics still provide a fallback */
    }
  }
}

// ── 5) Hot update (scheduled refresh) — off by default; integrators enable as needed ───
let refreshTimer: ReturnType<typeof setInterval> | undefined;
export function startAutoRefresh(intervalMs = 30 * 60 * 1000): void {
  if (refreshTimer || typeof window === "undefined") return; // already started / non-browser environment: skip
  void refreshModelRegistry();
  refreshTimer = setInterval(() => void refreshModelRegistry(), intervalMs);
}
export function stopAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

// ── 6) Heuristic fallback: -8k / -32k / -1m suffix in the name → token count ───────
export function guessContextWindow(modelId: string): number | undefined {
  const m = /(\d+)\s*([km])\b/i.exec(modelId); // 128k / 256k / 16k / 1m … (k = thousand, m = million)
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return m[2].toLowerCase() === "m" ? n * 1_000_000 : n * 1_000;
}

// ── 7) Final resolver: exact registry value → name-suffix heuristic → conservative default ───
export function resolveContextWindow(modelId: string): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  return (
    modelRegistry.get(modelId)?.contextWindow ??
    guessContextWindow(modelId) ??
    DEFAULT_CONTEXT_WINDOW
  );
}

/** Resolve a model's max output tokens: exact registry value → conservative default (the output cap can't be inferred from the name). */
export function resolveMaxOutput(modelId: string): number {
  if (!modelId) return DEFAULT_MAX_OUTPUT;
  return modelRegistry.get(modelId)?.maxOutput ?? DEFAULT_MAX_OUTPUT;
}
