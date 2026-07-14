/**
 * Local-storage utilities for the Agent module: built on @zzcpt/zztool's getStorage / setStorage / removeStorage,
 * grouping all data under a top-level `agent` object (see the dot-path constants in @/constants/Agent).
 *
 * Additional responsibilities:
 *  - putStorage: setStorage is a no-op for "falsy" values ("", 0, false), so empty values are cleared via removeStorage instead,
 *    avoiding "cleared the input field, yet the old value still lingers in storage".
 *  - migrateLegacyAgentStorage: migrates legacy flat keys (llm_provider / llm_key_* / agent_mode …)
 *    into the `agent` object once and deletes the old keys, eliminating scattered variables in storage. Idempotent; safe to call from multiple entry points.
 */
import { removeStorage, setStorage } from "@zzcpt/zztool";
import { AGENT_WORKDIR_KEY, WORKDIR_CLEAR_EVENT } from "@/constants/Agent";
import { mirrorConfigWrite } from "./appConfig";

/** Write a string: when the value is empty, delete the path instead (bypassing setStorage's no-op on falsy values).
 *  Also mirrors whitelisted keys to app.config ([llm] / [limits] / [ui]); no-op outside Electron. */
export function putStorage(path: string, val: string | null | undefined): void {
  if (val) setStorage(path, val);
  else removeStorage(path);
  mirrorConfigWrite(path, val);
}

/** Clear the selected work directory: remove the persisted path and broadcast an event so the home / chat pages reset their selection state. */
export function clearAgentWorkdir(): void {
  removeStorage(AGENT_WORKDIR_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WORKDIR_CLEAR_EVENT));
  }
}

let migrated = false;

/** Migrate legacy flat keys → the `agent` object once, and delete the old keys. Idempotent. */
export function migrateLegacyAgentStorage(): void {
  if (migrated || typeof window === "undefined") return;
  migrated = true;
  try {
    const ls = window.localStorage;

    // Old values are all stored as "raw strings" (not JSON): move them directly.
    const strMoves: [oldKey: string, newPath: string][] = [
      ["llm_provider", "agent.llm.provider"],
      ["llm_custom_endpoint", "agent.llm.customEndpoint"],
      ["llm_custom_model", "agent.llm.customModel"],
      ["agent_mode", "agent.mode"],
    ];
    for (const [oldKey, newPath] of strMoves) {
      const v = ls.getItem(oldKey);
      if (v == null) continue;
      if (v) setStorage(newPath, v);
      ls.removeItem(oldKey);
    }

    // Per-provider key / model: scan by prefix (iterate in reverse so we can read while deleting).
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (!k) continue;
      if (k.startsWith("llm_key_")) {
        const v = ls.getItem(k);
        if (v) setStorage(`agent.llm.keys.${k.slice("llm_key_".length)}`, v);
        ls.removeItem(k);
      } else if (k.startsWith("llm_model_")) {
        const v = ls.getItem(k);
        if (v) setStorage(`agent.llm.models.${k.slice("llm_model_".length)}`, v);
        ls.removeItem(k);
      }
    }

    // Skills: the legacy version stored these as a JSON string, so parse first then write back (setStorage will serialize again).
    const skillsRaw = ls.getItem("agent_skills_v1");
    if (skillsRaw != null) {
      try {
        const arr = JSON.parse(skillsRaw);
        if (Array.isArray(arr) && arr.length) setStorage("agent.skills", arr);
      } catch {
        /* Discard the old value if parsing fails */
      }
      ls.removeItem("agent_skills_v1");
    }
  } catch {
    /* Migration failure should not block functionality */
  }
}
