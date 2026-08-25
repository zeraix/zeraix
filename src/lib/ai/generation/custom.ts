/**
 * User-added generation engines.
 *
 * The registry beside this file (`registry.ts`) lists the vendors this app knows how to talk to for image
 * and video generation, and picks one automatically from whichever API keys the user already has. That is
 * deliberately zero-configuration — no dialog, no settings deep-link — and it works well until the user's
 * vendor is not one of the four in the list. Then there is no way to use it at all, which is the gap this
 * fills.
 *
 * ── Why these are NOT entries in the chat model list ────────────────────────────────────────────────────────
 *
 * Because that was tried and reverted, and `models.ts:purgeLegacyImageModels` exists to clean up after it. An
 * earlier build added image engines to `agent.llm.modelList` tagged `type: "image"`, and the consequence is
 * recorded there in one line: they "linger in the picker forever, and selecting one would send chat messages
 * to /images/generations". A model list whose entries are not all chat models is a list every consumer has to
 * remember to filter, and the one consumer that forgets sends a conversation to an endpoint that cannot hold
 * one.
 *
 * So an image engine is stored here instead. Nothing merges the two lists, no filtering is required anywhere,
 * and the failure that purge exists to undo cannot recur — a wrong entry here can produce a failed image, not
 * a chat sent to the wrong endpoint.
 *
 * The Settings form may still present both under one "add a model" flow; where the entry LANDS is what
 * matters, not where the user typed it.
 */
import { getStorage } from "@zzcpt/zztool";
// putStorage, not setStorage: setStorage is a no-op for falsy values, so clearing a key needs the wrapper.
import { putStorage } from "@/lib/ai/agentStorage";
import { agentLlmKeyOf } from "@/constants/Agent";
import { geminiImageAdapter, openaiImageAdapter, qwenImageAdapter, zhipuImageAdapter } from "./adapters";
import type { CapabilityAdapter, CapabilityId } from "./types";

const CUSTOM_ENGINE_KEY = "agent.generation.customEngines";

/**
 * The response shapes this app can read.
 *
 * A generation endpoint's REQUEST is near-uniform across vendors; its RESPONSE is not — one returns base64
 * under `data[0].b64_json`, another a hosted URL, another its own envelope. The adapter is the part that
 * cannot be guessed, so the user names it. Defaulting silently would produce a request that succeeds and a
 * result nothing can read, which is the least debuggable failure available.
 */
export const ENGINE_FORMATS = ["openai-image", "zhipu-image", "gemini-image", "qwen-image"] as const;
export type EngineFormat = (typeof ENGINE_FORMATS)[number];

const ADAPTERS: Record<EngineFormat, CapabilityAdapter> = {
  "openai-image": openaiImageAdapter,
  "zhipu-image": zhipuImageAdapter,
  "gemini-image": geminiImageAdapter,
  "qwen-image": qwenImageAdapter,
};

/** One engine the user added. Its API key lives under the same `agent.llm.keys.<ref>` scheme models use. */
export interface CustomEngine {
  /** Stable id, and the API-key ref. Shaped like a custom model's for the same reason: it is per-entry. */
  id: string;
  label: string;
  capability: CapabilityId;
  /** Full endpoint URL, already resolved — this file does not guess paths. */
  endpoint: string;
  /** The model string sent as `model`. */
  model: string;
  format: EngineFormat;
}

/** The adapter for an engine, or null when its format predates this build (never assume one — see above). */
export function adapterFor(engine: CustomEngine): CapabilityAdapter | null {
  return ADAPTERS[engine.format] ?? null;
}

const isEngine = (v: unknown): v is CustomEngine => {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.endpoint === "string" &&
    typeof e.model === "string" &&
    (e.capability === "image_generation" || e.capability === "video_generation") &&
    ENGINE_FORMATS.includes(e.format as EngineFormat)
  );
};

/**
 * Every engine the user has added.
 *
 * Malformed entries are dropped rather than repaired: unlike a conversation record, nothing here represents
 * work the user would lose, and an engine with a missing endpoint can only produce a confusing failure at the
 * moment they ask for an image.
 */
export function loadCustomEngines(): CustomEngine[] {
  const raw = getStorage(CUSTOM_ENGINE_KEY);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEngine) : [];
  } catch {
    return [];
  }
}

export function saveCustomEngines(list: CustomEngine[]): void {
  putStorage(CUSTOM_ENGINE_KEY, JSON.stringify(list));
}

/** Add one, writing its API key alongside when given. Returns the stored entry. */
export function addCustomEngine(input: {
  label?: string;
  capability: CapabilityId;
  endpoint: string;
  model: string;
  format: EngineFormat;
  apiKey?: string;
}): CustomEngine {
  const entry: CustomEngine = {
    id: `engine::${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    label: input.label?.trim() || input.model,
    capability: input.capability,
    endpoint: input.endpoint.trim(),
    model: input.model.trim(),
    format: input.format,
  };
  saveCustomEngines([...loadCustomEngines(), entry]);
  if (input.apiKey?.trim()) putStorage(agentLlmKeyOf(entry.id), input.apiKey.trim());
  return entry;
}

/** Remove one, and its key with it — a stored key for an engine nobody can reach is only a liability. */
export function removeCustomEngine(id: string): CustomEngine[] {
  const kept = loadCustomEngines().filter((e) => e.id !== id);
  saveCustomEngines(kept);
  putStorage(agentLlmKeyOf(id), null);
  return kept;
}

/**
 * The user's engine for a capability, if they added one that can actually run.
 *
 * "Can run" means it has an endpoint, a model, a key, and an adapter this build understands. An engine
 * missing any of those is skipped rather than returned and failed on, so the registry fallback still gets its
 * chance — a half-configured entry should not take away the working default.
 */
export function findCustomEngine(capability: CapabilityId): CustomEngine | null {
  return (
    loadCustomEngines().find(
      (e) =>
        e.capability === capability &&
        !!e.endpoint &&
        !!e.model &&
        !!adapterFor(e) &&
        !!(getStorage(agentLlmKeyOf(e.id)) as string | null)?.toString().trim(),
    ) ?? null
  );
}
