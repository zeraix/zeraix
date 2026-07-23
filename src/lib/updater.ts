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

/** Statuses that mean "there is an update the user can act on right now". */
const ACTIONABLE: ReadonlySet<UpdaterStatus> = new Set(["available", "downloading", "downloaded"]);
/** Statuses that carry no verdict — a check in flight, or the absence of one. */
const TRANSIENT: ReadonlySet<UpdaterStatus> = new Set(["checking", "not-available", "idle"]);

/**
 * Fold a pushed state into the previous one, keeping a known update alive.
 *
 * The main process reports the state of the LAST CHECK, but the UI has to represent something else:
 * whether an update is waiting for the user. Those diverge the moment a second check runs — and one
 * always does, because the About panel has a "Check for updates" button and the notifier schedules its
 * own check on mount. The push order is then `available` → (user starts acting) → `checking`, and both
 * components key their entire UI off `status`, so the card and the panel's Download button vanished the
 * instant the new check began. If that check then returned `not-available` (or the feed hiccuped) the
 * update was erased for the session: the user saw the prompt flash and disappear, with no way left to
 * install it.
 *
 * So a status that carries no verdict never overwrites one that does.
 *
 * `error` gets the same protection, but only over `available` / `downloaded` — a background re-check
 * that fails (offline for a moment, feed rate-limited) says nothing about the update already waiting,
 * and letting it through removed the card and the Download button just the same. Over `downloading` an
 * error passes through untouched: there it IS the download failing, which the user must see and retry.
 *
 * Fields are merged rather than replaced for the same reason as before: a push that omits `supported`
 * must not read as "updates are unsupported here".
 */
export function mergeUpdaterState(
  prev: UpdaterState | null,
  next: Partial<UpdaterState>,
): UpdaterState {
  const merged = { ...prev, ...next } as UpdaterState;
  if (!prev || !next.status) return merged;
  const erasesAKnownUpdate =
    (TRANSIENT.has(next.status) && ACTIONABLE.has(prev.status)) ||
    (next.status === "error" && (prev.status === "available" || prev.status === "downloaded"));
  // Keep what described the pending update; let everything else (error text, supported, …) through.
  return erasesAKnownUpdate
    ? { ...merged, status: prev.status, version: prev.version, percent: prev.percent }
    : merged;
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
