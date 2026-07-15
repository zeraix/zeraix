/**
 * Auto-update bridge (renderer side of electron/ipc/updaterIpc.mjs).
 *
 * The main process reports state only and carries no user-facing strings; all copy is localized
 * here via src/locales/*.json, matching how notifications already work.
 *
 * Availability: Electron only, and only when packaged — `supported` is false in `next dev` and in a
 * browser, because an unpackaged app has no app-update.yml to read.
 */

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  percent: number;
  error: string | null;
  supported: boolean;
  currentVersion: string;
}

export interface UpdaterBridge {
  getState: () => Promise<UpdaterState>;
  check: () => Promise<{ ok: boolean; supported: boolean; error?: string }>;
  download: () => Promise<{ ok: boolean; error?: string }>;
  install: () => Promise<{ ok: boolean; error?: string }>;
  onState: (cb: (state: UpdaterState) => void) => () => void;
}

declare global {
  interface Window {
    updater?: UpdaterBridge;
  }
}

/** Retrieves the updater bridge (or `null` outside Electron). */
export function updaterBridge(): UpdaterBridge | null {
  return typeof window !== "undefined" && window.updater ? window.updater : null;
}

/** Whether auto-update is wired at all (Electron only; still false when unpackaged). */
export function isUpdaterAvailable(): boolean {
  return updaterBridge() !== null;
}

/**
 * Map a raw electron-updater error onto a locale key.
 *
 * macOS refuses to apply updates whose code signature does not match the running app
 * (Squirrel.Mac), so an unsigned build always fails here — it is a build/config fact, not a
 * transient failure, and is worth telling the user apart from "you are offline".
 */
export function errorKey(error: string | null): string {
  if (!error) return "update.error.generic";
  const e = error.toLowerCase();
  if (e.includes("code signature") || e.includes("could not get code signature")) {
    return "update.error.unsigned";
  }
  if (e.includes("net::") || e.includes("enotfound") || e.includes("econnrefused") || e.includes("etimedout")) {
    return "update.error.network";
  }
  if (e.includes("404") || e.includes("no published versions")) return "update.error.noRelease";
  return "update.error.generic";
}
