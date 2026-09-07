/**
 * Render-layer access to the main process's crash-recovery state (docs/agent-runtime-crash-recovery.md C9 / C10).
 *
 * Exposed by preload as `window.recovery`; absent in a browser tab and under an older preload, in which case every
 * call answers "nothing to report" rather than throwing — a missing bridge must never look like a crash.
 */

export interface LastSession {
  /** The previous session left its lock behind and its process is gone: it died before its teardown finished. */
  unclean: boolean;
  previous: { pid?: number; startedAt?: number; version?: string } | null;
  pidReused?: boolean;
}

export interface RecoveryEntry {
  at: string;
  component: string;
  event: string;
  detail: Record<string, unknown>;
}

/** The Rust sidecar supervisor's current state (docs/agent-runtime-crash-recovery.md C3). */
export interface BridgeStatus {
  state: "ready" | "starting" | "backoff" | "disabled" | "off" | "stopped";
  failures: number;
  maxFailures: number;
  retryInMs: number;
  recovered: {
    /** Tasks that had begun when the previous runtime stopped. Reported, never re-run. */
    interrupted: { id: string; label: string; attempts: number }[];
    /** How many were queued and never started. */
    resumable: number;
    tornTail: boolean;
    corruptLines: number;
  } | null;
}

interface RecoveryBridge {
  lastSession(): Promise<LastSession>;
  read(limit?: number): Promise<RecoveryEntry[]>;
  bridgeStatus?(): Promise<BridgeStatus>;
}

declare global {
  interface Window {
    recovery?: RecoveryBridge;
  }
}

const NONE: LastSession = { unclean: false, previous: null };

/** How the previous session ended. */
export async function lastSession(): Promise<LastSession> {
  if (typeof window === "undefined" || !window.recovery) return NONE;
  try {
    return (await window.recovery.lastSession()) ?? NONE;
  } catch {
    return NONE;
  }
}

/** The recent recovery-log entries, oldest first. */
export async function readRecoveryLog(limit = 200): Promise<RecoveryEntry[]> {
  if (typeof window === "undefined" || !window.recovery) return [];
  try {
    return (await window.recovery.read(limit)) ?? [];
  } catch {
    return [];
  }
}

/** The sidecar supervisor's state, or null when the bridge is unavailable (a browser tab, an older preload). */
export async function bridgeStatus(): Promise<BridgeStatus | null> {
  if (typeof window === "undefined" || !window.recovery?.bridgeStatus) return null;
  try {
    return (await window.recovery.bridgeStatus()) ?? null;
  } catch {
    return null;
  }
}
