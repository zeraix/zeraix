/**
 * Renderer crash policy: reload, or give up and say so (docs/agent-runtime-crash-recovery.md C7).
 *
 * The window used to be left blank after a renderer crash, with a comment explaining why: auto-reloading a renderer
 * that crashes on load spins forever. That reasoning is right about the danger and wrong about the conclusion — the
 * fix for a loop is a bound, not a refusal to recover. A crash is far more often one bad frame than a page that
 * cannot load, and the user's conversation is restored either way (the chat store is on disk, and the interrupted
 * turn is reported by C2's checkpoint).
 *
 * So: reload up to MAX_RELOADS times within WINDOW_MS, then stop and show a page that says what happened and where
 * the log is. The counter is a sliding window rather than a session total, so an app left open for days does not
 * eventually refuse to recover from an unrelated crash.
 *
 * Pure and side-effect free, so the policy is testable without an Electron window.
 */

/** Reloads allowed inside the window before the crash is treated as persistent. */
export const MAX_RELOADS = 2;
/** The sliding window. Two crashes minutes apart are unrelated; two seconds apart are the same bug. */
export const WINDOW_MS = 5 * 60 * 1000;
/**
 * How long a renderer must stay up before its record is forgiven.
 *
 * NOT "until it finishes loading". A renderer that loads and then dies a second later would clear its own history on
 * every attempt, and the bound would never be reached — precisely the infinite reload this policy exists to prevent.
 * Proof of health is surviving a while, so the clock starts at load and only a crash after this much uptime is
 * treated as a new problem rather than a continuation of the old one.
 */
export const STABLE_MS = 60 * 1000;

/**
 * Reasons that are not crashes. `clean-exit` and `killed` are what Electron reports when WE end the process —
 * quitting, closing the window, a reload we asked for — and reloading in response to our own teardown would fight
 * the shutdown it is reacting to.
 */
const NOT_A_CRASH = new Set(["clean-exit", "killed"]);

/** Track crashes for one window. */
export function createCrashPolicy({ maxReloads = MAX_RELOADS, windowMs = WINDOW_MS, stableMs = STABLE_MS } = {}) {
  /** @type {number[]} timestamps of crashes still inside the window */
  let recent = [];
  /** When the renderer last finished loading, or 0. Used only to decide whether it has proved itself. */
  let loadedAt = 0;
  return {
    /**
     * Record a crash and decide what to do about it.
     * @returns {{ action: "ignore" | "reload" | "giveUp", count: number, reason: string }}
     */
    onCrash(details, { now = Date.now(), quitting = false } = {}) {
      const reason = details?.reason ?? "";
      if (quitting || NOT_A_CRASH.has(reason)) return { action: "ignore", count: recent.length, reason };
      // A renderer that ran for a while before dying is a new problem, not a continuation of the last one.
      if (loadedAt && now - loadedAt >= stableMs) recent = [];
      recent = recent.filter((t) => now - t < windowMs);
      recent.push(now);
      loadedAt = 0; // the next load has to earn its own uptime
      return { action: recent.length > maxReloads ? "giveUp" : "reload", count: recent.length, reason };
    },
    /**
     * The renderer finished loading. This starts its uptime clock; it does NOT clear the history, because a page that
     * loads and then crashes immediately would otherwise reset the bound on every attempt and loop forever.
     */
    noteLoaded(now = Date.now()) {
      loadedAt = now;
    },
    /** Forget everything. For the give-up page's "Try again", which is the user deliberately asking for a fresh budget. */
    reset() {
      recent = [];
      loadedAt = 0;
    },
    crashCount() {
      return recent.length;
    },
  };
}
