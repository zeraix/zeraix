/**
 * Bridge between the renderer layer and app.config (an INI file sitting next to the executable).
 *
 * Responsibilities: bidirectionally map the Agent module's "local-storage dot paths"
 * (agent.llm.* / agent.limits.* / agent.mode / agent.locale) to INI [section]key, and:
 *  - mirrorConfigWrite: persist to app.config whenever local storage is written (called by putStorage);
 *  - hydrateAppConfig: on startup, load file values into local storage (file wins), and backfill into the file
 *    any whitelisted values that exist locally but are missing from the file (existing settings show up in app.config on an upgraded user's first launch).
 *
 * Only effective under Electron via the window.appConfig exposed by preload; a no-op in Web / browser environments.
 * Note: here we read/write directly with zztool's setStorage / getStorage rather than putStorage — to avoid
 * re-triggering mirroring during hydration and causing a loop.
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import {
  AGENT_LLM_CUSTOM_ENDPOINT_KEY,
  AGENT_LLM_CUSTOM_MODEL_KEY,
  AGENT_LLM_PROVIDER_KEY,
  AGENT_LOCALE_KEY,
  AGENT_MAX_CONSECUTIVE_TIMEOUTS_KEY,
  AGENT_MAX_SAME_TOOL_CALLS_KEY,
  AGENT_MAX_SUBAGENT_ROUNDS_KEY,
  AGENT_MAX_TOOL_ROUNDS_KEY,
  AGENT_MODE_KEY,
} from "@/constants/Agent";

interface AppConfigBridge {
  getAllSync(): Record<string, Record<string, string>>;
  set(section: string, key: string, value: string): Promise<void>;
  remove(section: string, key: string): Promise<void>;
  openFile?(): Promise<{ ok: boolean; path: string; error?: string }>;
  getPath?(): Promise<string>;
}

declare global {
  interface Window {
    appConfig?: AppConfigBridge;
  }
}

function bridge(): AppConfigBridge | null {
  return typeof window !== "undefined" && window.appConfig ? window.appConfig : null;
}

/** Whether the current environment provides app.config (Electron only). */
export function isAppConfigAvailable(): boolean {
  return !!bridge();
}

/**
 * Explicitly persist the "official API key" to app.config ([llm] key_official). An empty value deletes the key.
 * Reuses the mirror mapping (agent.llm.keys.official → [llm] key_official, consistent with what hydrate reads back); Electron only.
 * Called by the settings page after getApiKey succeeds and after regeneration, ensuring app.config is written every time.
 */
export function saveOfficialApiKeyToConfig(key: string | null | undefined): void {
  const v = key && key.trim() ? key.trim() : null;
  mirrorConfigWrite("agent.llm.keys.official", v);
}

/** Open app.config in the system default editor (Electron only). Returns whether it succeeded; false outright outside Electron. */
export async function openAppConfigFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const b = bridge();
  if (!b?.openFile) return { ok: false, error: "unavailable" };
  try {
    return await b.openFile();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Static mapping: local-storage dot path → [INI section, INI key].
const STATIC: Array<[dot: string, section: string, key: string]> = [
  [AGENT_LLM_PROVIDER_KEY, "llm", "provider"],
  [AGENT_LLM_CUSTOM_ENDPOINT_KEY, "llm", "custom_endpoint"],
  [AGENT_LLM_CUSTOM_MODEL_KEY, "llm", "custom_model"],
  // Model list / selected item / seeded flag (the list and selected item are JSON strings, persisted to app.config alongside the other settings).
  ["agent.llm.modelList", "llm", "model_list"],
  ["agent.llm.selectedModelId", "llm", "selected_model"],
  ["agent.llm.modelsSeeded", "llm", "models_seeded"],
  [AGENT_MAX_TOOL_ROUNDS_KEY, "limits", "max_tool_rounds"],
  [AGENT_MAX_SAME_TOOL_CALLS_KEY, "limits", "max_same_tool_calls"],
  [AGENT_MAX_CONSECUTIVE_TIMEOUTS_KEY, "limits", "max_consecutive_timeouts"],
  [AGENT_MAX_SUBAGENT_ROUNDS_KEY, "limits", "max_subagent_rounds"],
  [AGENT_MODE_KEY, "ui", "mode"],
  [AGENT_LOCALE_KEY, "ui", "locale"],
];

// Dynamic key prefixes grouped by provider: agent.llm.keys.<id> / agent.llm.models.<id>.
const KEYS_PREFIX = "agent.llm.keys.";
const MODELS_PREFIX = "agent.llm.models.";

function dotToIni(path: string): { section: string; key: string } | null {
  if (path.startsWith(KEYS_PREFIX))
    return { section: "llm", key: `key_${path.slice(KEYS_PREFIX.length)}` };
  if (path.startsWith(MODELS_PREFIX))
    return { section: "llm", key: `model_${path.slice(MODELS_PREFIX.length)}` };
  const hit = STATIC.find(([p]) => p === path);
  return hit ? { section: hit[1], key: hit[2] } : null;
}

function iniToDot(section: string, key: string): string | null {
  if (section === "llm" && key.startsWith("key_")) return `${KEYS_PREFIX}${key.slice(4)}`;
  if (section === "llm" && key.startsWith("model_")) return `${MODELS_PREFIX}${key.slice(6)}`;
  const hit = STATIC.find(([, s, k]) => s === section && k === key);
  return hit ? hit[0] : null;
}

function readLocal(path: string): string {
  const v = getStorage(path);
  return v == null || v === "" ? "" : String(v);
}

/** Local-storage write → mirror synchronously to app.config (whitelisted keys only; no-op outside Electron). */
export function mirrorConfigWrite(path: string, value: string | null | undefined): void {
  const b = bridge();
  if (!b) return;
  const ini = dotToIni(path);
  if (!ini) return;
  try {
    if (value) void b.set(ini.section, ini.key, String(value));
    else void b.remove(ini.section, ini.key);
  } catch {
    /* Mirror failure does not affect the main local-storage flow */
  }
}

let hydrated = false;

/** On startup, load app.config into local storage and backfill existing values missing from the file. Idempotent; effective only on the Electron client. */
export function hydrateAppConfig(): void {
  if (hydrated || typeof window === "undefined") return; // Don't mark on the server side; leave it for the client to run
  hydrated = true;
  const b = window.appConfig;
  if (!b) return; // Non-Electron (Web): no config file

  let snapshot: Record<string, Record<string, string>> = {};
  try {
    snapshot = b.getAllSync() || {};
  } catch {
    snapshot = {};
  }

  // 1) File → local storage (file wins), recording the dot paths already covered.
  const seeded = new Set<string>();
  for (const section of Object.keys(snapshot)) {
    for (const [k, v] of Object.entries(snapshot[section] || {})) {
      const dot = iniToDot(section, k);
      if (!dot || v === "" || v == null) continue;
      setStorage(dot, v);
      seeded.add(dot);
    }
  }

  // 2) Whitelisted values present locally but missing from the file → backfill into the file (an upgraded user's existing settings enter app.config on first launch).
  for (const [dot] of STATIC) {
    if (seeded.has(dot)) continue;
    const val = readLocal(dot);
    if (val) mirrorConfigWrite(dot, val);
  }
  backfillProviderMap("agent.llm.keys", seeded);
  backfillProviderMap("agent.llm.models", seeded);
}

/** Backfill the provider-grouped objects (keys / models): read the parent object and mirror each entry missing from the file. */
function backfillProviderMap(parentPath: string, seeded: Set<string>): void {
  const obj = getStorage(parentPath);
  if (!obj || typeof obj !== "object") return;
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    const dot = `${parentPath}.${id}`;
    if (seeded.has(dot) || !v) continue;
    mirrorConfigWrite(dot, String(v));
  }
}
