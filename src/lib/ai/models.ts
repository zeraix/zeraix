/**
 * Model list and API key management (renderer layer, persisted to localStorage / app.config).
 *
 * A unified "model" abstraction: the user maintains a list of selectable models in settings (official catalog + custom),
 * the home composer picks from it, and the chat page resolves endpoint / model / apiKey from the "currently selected model" to send.
 *
 * Storage (via putStorage over a dot-path, mirrored to app.config under Electron):
 *  - agent.llm.modelList      —— JSON: AgentModel[] (the model list added by the user)
 *  - agent.llm.selectedModelId —— string: id of the currently selected model
 *  - agent.llm.keys.<ref>     —— string: API key. ref = official providerId (shared per vendor)
 *                                or custom model id (each custom model is independent). Reuses agentLlmKeyOf.
 *
 * Compatibility: on first use, if the list is empty, migrate one entry from the legacy agent.llm.provider/keys/models so existing config is not lost.
 */
import { getStorage } from "@zzcpt/zztool";
import { putStorage } from "@/lib/ai/agentStorage";
import {
  agentLlmKeyOf,
  agentLlmModelOf,
  AGENT_LLM_PROVIDER_KEY,
  AGENT_LLM_CUSTOM_ENDPOINT_KEY,
  AGENT_LLM_CUSTOM_MODEL_KEY,
} from "@/constants/Agent";
import { PROVIDERS, DEFAULT_PROVIDER, type Provider } from "@/app/agent/chat/providers";
import { getApiKey, type ApiKeyInfo } from "@/lib/api/agent";

export { PROVIDERS, DEFAULT_PROVIDER };
export type { Provider };

const MODEL_LIST_KEY = "agent.llm.modelList";
const SELECTED_MODEL_KEY = "agent.llm.selectedModelId";
const SEEDED_KEY = "agent.llm.modelsSeeded"; // flag marking that migration ran once (after the list is emptied, it won't auto-migrate back)

/** One selectable model (an official-catalog entry or a user-defined one). */
export interface AgentModel {
  /** Stable id: official is `${providerId}::${model}`, custom is `custom::${uuid}`. */
  id: string;
  /** Official provider id, or "custom" for custom models. */
  providerId: string;
  /** The model string sent to the API. */
  model: string;
  /** Display name. */
  label: string;
  /** Custom models only; official ones compose it from provider.baseUrl. Already resolved to a full endpoint (operation path included). */
  endpoint?: string;
  custom: boolean;
  /** API format (currently openai-chat only). */
  apiFormat?: string;
  /** Whether it is multimodal (can send images). */
  multimodal?: boolean;
  /** The entry's real context window (tokens). For a local model = the -c passed when llama-server starts;
   *  when set, it takes precedence over resolveContextWindow's registry / naming heuristics / 1M default. */
  contextWindow?: number;
}

/** A resolved model config that can be sent with directly. */
export interface ResolvedModel {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  apiKey: string;
  providerId: string;
  custom: boolean;
  /** The entry's own real context window (e.g. a local model's llama-server -c); if absent, inferred by resolveContextWindow. */
  contextWindow?: number;
}

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Stable id for an official model. */
export function officialModelId(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

// Context-window resolution has been extracted into a layered model registry (Provider Adapter → Registry → Resolver,
// see ./modelRegistry and docs/Model-Context-Window-Resolution-Spec.md). Re-exported here to
// keep the existing `@/lib/ai/models` imports unchanged.
export { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from "./modelRegistry";

// ── List read / write ────────────────────────────────────────────────────────────
export function loadModelList(): AgentModel[] {
  const raw = getStorage(MODEL_LIST_KEY);
  if (Array.isArray(raw)) return raw as AgentModel[];
  if (typeof raw === "string" && raw) {
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? (a as AgentModel[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Model-list change event: broadcast after writing the list within the same tab, so the chat page / home composer refresh the selectable models immediately
 *  (localStorage's native storage event only fires across tabs, so same-page writes must self-broadcast). */
export const MODEL_LIST_CHANGE_EVENT = "agent:model-list-changed";
export function saveModelList(list: AgentModel[]): void {
  putStorage(MODEL_LIST_KEY, JSON.stringify(list));
  try { if (typeof window !== "undefined") window.dispatchEvent(new Event(MODEL_LIST_CHANGE_EVENT)); } catch { /* ignore */ }
}

/**
 * Add a model from the official catalog (deduplicated by id). On first add, it is auto-selected.
 * label is optional: used to "manually add a new model for this vendor" — a model the app hasn't been updated for and isn't in the catalog;
 * the user only fills in the model ID + display name, while the endpoint and API key reuse that vendor's (providerId) config.
 */
export function addOfficialModel(providerId: string, model: string, label?: string): AgentModel {
  const id = officialModelId(providerId, model);
  const list = loadModelList();
  const existing = list.find((m) => m.id === id);
  if (existing) return existing;
  const entry: AgentModel = { id, providerId, model, label: label?.trim() || model, custom: false };
  saveModelList([...list, entry]);
  if (!getSelectedModelId()) setSelectedModelId(id);
  return entry;
}

/** API format → endpoint path suffix. */
export function apiFormatSuffix(apiFormat: string): string {
  return apiFormat === "openai-responses" ? "/responses" : "/chat/completions";
}

/**
 * Compose a provider's chat endpoint from its base URL.
 *
 * Provider.baseUrl carries no operation path (a provider is not only a chat endpoint — the same
 * base also serves /images/generations, /audio/speech, …), so the chat path is appended here:
 * the provider's own `chatPath` when it is non-standard (MiniMax), otherwise derived from the
 * model's apiFormat. For any other capability, compose from `baseUrl` the same way.
 */
export function providerChatEndpoint(p: Provider, apiFormat = "openai-chat"): string {
  const base = p.baseUrl.trim().replace(/\/+$/, "");
  if (!base) return ""; // "custom": the user supplies the whole endpoint
  return `${base}${p.chatPath ?? apiFormatSuffix(apiFormat)}`;
}

/**
 * Build a custom endpoint: a full URL is used as-is; otherwise strip trailing slashes and append, per the API format,
 * /chat/completions (Chat Completions) or /responses (Responses API).
 */
export function resolveCustomEndpoint(
  baseUrl: string,
  fullUrl: boolean,
  apiFormat = "openai-chat",
): string {
  const b = baseUrl.trim();
  return fullUrl ? b : `${b.replace(/\/+$/, "")}${apiFormatSuffix(apiFormat)}`;
}

/**
 * Add a custom model. baseUrl + fullUrl resolve to a full endpoint; optionally writes an API key along the way.
 * On first add, it is auto-selected.
 */
export function addCustomModel(input: {
  label?: string;
  baseUrl: string;
  fullUrl?: boolean;
  model: string;
  apiFormat?: string;
  multimodal?: boolean;
  apiKey?: string;
}): AgentModel {
  const entry: AgentModel = {
    id: `custom::${uid()}`,
    providerId: "custom",
    model: input.model,
    label: input.label?.trim() || input.model,
    endpoint: resolveCustomEndpoint(input.baseUrl, !!input.fullUrl, input.apiFormat),
    custom: true,
    apiFormat: input.apiFormat || "openai-chat",
    multimodal: !!input.multimodal,
  };
  saveModelList([...loadModelList(), entry]);
  if (input.apiKey?.trim()) setModelApiKey(entry, input.apiKey.trim());
  if (!getSelectedModelId()) setSelectedModelId(entry.id);
  return entry;
}

/** Remove a model; if the removed one was the current selection, select the first entry in the list instead. Returns the list after removal. */
export function removeModel(id: string): AgentModel[] {
  const next = loadModelList().filter((m) => m.id !== id);
  saveModelList(next);
  if (getSelectedModelId() === id) setSelectedModelId(next[0]?.id ?? null);
  return next;
}

// ── Official platform models (via platform /v1, sent with the official API key) ─────────
const DIRECT_API_VERSION = process.env.NEXT_PUBLIC_DIRECTAPIVERSION || "v1";
/** The providerId all official models are grouped under; its API key is the "official API key" (keys.official). */
export const OFFICIAL_PROVIDER_ID = "official";

/** Official platform chat completions endpoint (NEXT_PUBLIC_API_BASE_URL + /v1/chat/completions). */
export function officialPlatformEndpoint(): string {
  const base = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${DIRECT_API_VERSION}/chat/completions`;
}

/**
 * Normalize the endpoint of every official platform model (OFFICIAL_PROVIDER_ID) in the list to the value
 * computed now from the current NEXT_PUBLIC_API_BASE_URL. Cleans up historical leftovers — stale endpoints that were
 * frozen when a model was seeded under a local override (e.g. localhost:10000), keeping persisted data (app.config /
 * localStorage) consistent with the actual send address.
 * Idempotent and cheap: writes only when there is an actual difference; skipped when the environment has no base URL configured, to avoid writing a host-less relative address.
 */
export function normalizeOfficialEndpoints(): void {
  const base = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return;
  const target = officialPlatformEndpoint();
  const list = loadModelList();
  let changed = false;
  const next = list.map((m) => {
    if (m.providerId === OFFICIAL_PROVIDER_ID && m.endpoint !== target) {
      changed = true;
      return { ...m, endpoint: target };
    }
    return m;
  });
  if (changed) saveModelList(next);
}

/**
 * One-time cleanup for a shipped-then-reverted design.
 *
 * An earlier build auto-added image engines (glm-image, cogview-*) to the model list as selectable
 * entries tagged `type: "image"`. That approach is gone — generation engines are resolved per
 * capability from src/lib/ai/generation/registry.ts and never appear in the picker
 * (docs/generation-capabilities-design.md). But the entries were persisted to
 * agent.llm.modelList / app.config, so deleting the writer is not enough: without this they would
 * linger in the picker forever, and selecting one would send chat messages to /images/generations.
 *
 * Reads `type` off the raw record rather than AgentModel, which no longer declares it.
 * Idempotent; writes only when something is actually removed. Safe to delete once no installs
 * predate the change.
 */
export function purgeLegacyImageModels(): void {
  const list = loadModelList();
  const kept = list.filter((m) => (m as { type?: string }).type !== "image");
  if (kept.length === list.length) return;
  saveModelList(kept);
  // The selection may have pointed at an entry we just dropped.
  const sel = getSelectedModelId();
  if (sel && !kept.some((m) => m.id === sel)) setSelectedModelId(kept[0]?.id ?? null);
}

/** Add an official platform model (from GET /v1/models). Deduplicated by id; auto-selected on first add. */
export function addOfficialModelFromCatalog(
  modelId: string,
  opts?: { label?: string; multimodal?: boolean },
): AgentModel {
  const id = `official::${modelId}`;
  const list = loadModelList();
  const existing = list.find((m) => m.id === id);
  if (existing) return existing;
  const entry: AgentModel = {
    id,
    providerId: OFFICIAL_PROVIDER_ID,
    model: modelId,
    label: opts?.label || modelId,
    endpoint: officialPlatformEndpoint(),
    custom: false,
    multimodal: !!opts?.multimodal,
  };
  saveModelList([...list, entry]);
  if (!getSelectedModelId()) setSelectedModelId(id);
  return entry;
}

/** Read/Write "Official API Key" (used for sending requests to official models). */
export function getPlatformApiKey(): string {
  return getApiKeyByRef(OFFICIAL_PROVIDER_ID);
}
export function setPlatformApiKey(key: string): void {
  setApiKeyByRef(OFFICIAL_PROVIDER_ID, key);
}

/**
 * Synchronizes the existing official API key from the server and stores it locally (`putStorage` mirrors the value to `app.config`).
 * Retrieves only the existing plaintext key via `getApiKey`; does not automatically generate a new key (generation must be triggered manually on the settings page).
 * Returns the plaintext key if found; returns an empty string silently if no key exists or if any failure occurs (no exception is thrown to avoid interrupting the login or startup process).
 * Called after login: since the account may differ from the one previously used on the device, a forced refresh based on the server's data is required.
 */
export async function syncPlatformApiKeyFromServer(): Promise<string> {
  try {
    const res = await getApiKey();
    if (res.success) {
      // Handle the backend returning either a single item or a list.
      const raw = res.data as unknown;
      const arr: ApiKeyInfo[] = Array.isArray(raw) ? (raw as ApiKeyInfo[]) : raw ? [raw as ApiKeyInfo] : [];
      const active = arr.find((k) => k?.key);
      if (active?.key) {
        setPlatformApiKey(active.key);
        return active.key;
      }
    }
  } catch {
    /* fail silently */
  }
  return "";
}

/**
 * Ensures the local storage has the official API key; returns it directly if present (including from app.config), otherwise syncs from the server.
 * Used at app startup: reads app.config → fetches if no official key is found.
 */
export async function ensurePlatformApiKey(): Promise<string> {
  const existing = getPlatformApiKey();
  if (existing) return existing;
  return syncPlatformApiKeyFromServer();
}

// ── Selected item ─────────────────────────────────────────────────────────────────
export function getSelectedModelId(): string | null {
  const v = getStorage(SELECTED_MODEL_KEY);
  return typeof v === "string" && v ? v : null;
}

export function setSelectedModelId(id: string | null): void {
  putStorage(SELECTED_MODEL_KEY, id);
}

/** The currently selected model; falls back to the first entry when the selection is missing; returns null when the list is empty. */
export function getSelectedModel(): AgentModel | null {
  const list = loadModelList();
  if (list.length === 0) return null;
  const id = getSelectedModelId();
  return list.find((m) => m.id === id) ?? list[0];
}

// ── API Key ────────────────────────────────────────────────────────────────────
/** Key ownership ref: official keyed by providerId (shared per vendor), custom keyed by model id. */
export function apiKeyRefOf(m: AgentModel): string {
  return m.custom ? m.id : m.providerId;
}

export function getApiKeyByRef(ref: string): string {
  return str(getStorage(agentLlmKeyOf(ref)));
}

export function setApiKeyByRef(ref: string, key: string): void {
  putStorage(agentLlmKeyOf(ref), key.trim() ? key : null);
}

export function getModelApiKey(m: AgentModel): string {
  return getApiKeyByRef(apiKeyRefOf(m));
}

export function setModelApiKey(m: AgentModel, key: string): void {
  setApiKeyByRef(apiKeyRefOf(m), key);
}

// ── Resolve send config ───────────────────────────────────────────────────────────
export function resolveModel(m: AgentModel): ResolvedModel {
  const prov = PROVIDERS.find((p) => p.id === m.providerId);
  // Official platform models: Always calculate the endpoint dynamically based on the current NEXT_PUBLIC_API_BASE_URL; never rely on the persisted `m.endpoint`.
  // Endpoints are "frozen" when a model is added. If a model was seeded while a local override was active (e.g., `localhost:10000` in `.env`),
  // the old value remains in `agent.llm.modelList` even after the environment reverts to the production domain, causing AI requests to be sent to an invalid address. Dynamic calculation ensures self-healing.
  // Custom models continue to use their own endpoints, while others (official catalog models connecting
  // directly to the provider) compose one from `provider.baseUrl` + the chat path for their apiFormat.
  const endpoint =
    m.providerId === OFFICIAL_PROVIDER_ID
      ? officialPlatformEndpoint()
      : m.endpoint
        ? str(m.endpoint)
        : prov
          ? providerChatEndpoint(prov, m.apiFormat)
          : "";
  return {
    id: m.id,
    label: m.label,
    endpoint,
    model: m.model,
    apiKey: getModelApiKey(m),
    providerId: m.providerId,
    custom: m.custom,
    ...(m.contextWindow && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
  };
}

/** Resolve the currently selected model into a sendable config; returns null when no model is available. */
export function resolveActiveModel(): ResolvedModel | null {
  const m = getSelectedModel();
  return m ? resolveModel(m) : null;
}

/** Resolve a model from the list by id into a sendable config; returns null if not found (used for session-level binding). */
export function resolveModelById(id: string | null | undefined): ResolvedModel | null {
  if (!id) return null;
  const m = loadModelList().find((x) => x.id === id);
  return m ? resolveModel(m) : null;
}

// ── Migration / seeding ────────────────────────────────────────────────────────────
/**
 * If the list is empty, migrate one entry from the legacy single-select config (agent.llm.provider + keys/models, or a custom endpoint),
 * so existing config is not lost when upgrading from "inline config on the chat page" to "the model list on the settings page". Idempotent.
 */
export function ensureModelListSeeded(): void {
  // Run the official-endpoint normalization every time (idempotent, writes only on a difference): fixes historically stale endpoints,
  // and is unaffected by the "seed only once" flag below (users whose SEEDED_KEY is already set must still self-heal).
  normalizeOfficialEndpoints();
  // Strip image engines a previous build wrote into the list; they must never appear in the picker.
  purgeLegacyImageModels();
  // Seed only once: after the flag is set, we no longer auto-migrate back to the old config even if the user empties the list.
  if (getStorage(SEEDED_KEY)) return;
  putStorage(SEEDED_KEY, "1");
  if (loadModelList().length > 0) return;
  const legacyProvider = str(getStorage(AGENT_LLM_PROVIDER_KEY));
  if (!legacyProvider) return;
  if (legacyProvider === "custom") {
    const endpoint = str(getStorage(AGENT_LLM_CUSTOM_ENDPOINT_KEY));
    const model = str(getStorage(AGENT_LLM_CUSTOM_MODEL_KEY));
    // The legacy custom endpoint stores a full URL, so use it as-is with fullUrl.
    if (endpoint && model) addCustomModel({ label: model, baseUrl: endpoint, fullUrl: true, model });
    return;
  }
  const prov = PROVIDERS.find((p) => p.id === legacyProvider);
  if (!prov) return;
  const model = str(getStorage(agentLlmModelOf(legacyProvider))) || prov.models[0];
  if (model) addOfficialModel(legacyProvider, model);
}
