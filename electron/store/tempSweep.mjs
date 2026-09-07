/**
 * Launch-time collection of the app's own temporary files (docs/agent-runtime-crash-recovery.md C4).
 *
 * Every atomic write in this app is `tmp` + `rename` (conversationStore, mediaStore, the session lock). That is what
 * makes a crash leave the *old* file intact rather than a torn one — but it also means a crash between the two steps
 * leaves the `.tmp` behind, and nothing ever removed it. One is harmless; one per crash, forever, is a slow leak in
 * the user's data folder that nobody is watching.
 *
 * Two rules keep this from ever deleting something that matters:
 *
 *  1. **Only names this app writes.** A fixed suffix, matched exactly, never a glob over user files. The stores all
 *     write `<final-name>.tmp` beside the file they are replacing, so the pattern is `*.tmp` and nothing else.
 *  2. **Only files older than one boot.** A `.tmp` younger than the threshold may belong to a write happening right
 *     now — a second window, a background flush — and deleting it would break the very operation the pattern exists
 *     to protect. Age is the only safe way to tell "abandoned" from "in progress" without a lock nobody holds.
 *
 * Bounded on purpose: one shallow pass per configured directory, no recursion into the conversation tree, and never
 * fatal. A sweep that cannot run is a leak; a sweep that throws is a launch failure.
 */
import fs from "node:fs";
import path from "node:path";
import { recordRecovery } from "./recoveryLog.mjs";

/** The one suffix this app's atomic writes produce. */
const TMP_SUFFIX = ".tmp";

/**
 * How old a leftover must be before it is assumed abandoned.
 *
 * An hour, not a minute: the cost of waiting is one stale file until the next launch, and the cost of being wrong is
 * deleting the temporary half of a write that is still running. The asymmetry is the whole choice.
 */
export const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Remove abandoned `*.tmp` files directly inside each of `dirs`.
 *
 * Returns what it deleted, for the caller to log. Never throws: a missing directory, a permission error and a file
 * that vanished between the listing and the unlink are all ordinary here.
 */
export function sweepTempFiles(dirs, { now = Date.now(), olderThanMs = ABANDONED_AFTER_MS } = {}) {
  const removed = [];
  const skipped = [];
  for (const dir of dirs) {
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // never created, or not ours to read
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(TMP_SUFFIX)) continue;
      const full = path.join(dir, entry.name);
      try {
        const age = now - fs.statSync(full).mtimeMs;
        if (age < olderThanMs) {
          skipped.push(full); // possibly a write in progress: leaving it is the safe error
          continue;
        }
        fs.rmSync(full, { force: true });
        removed.push(full);
      } catch {
        /* vanished, locked, or not ours — the next launch tries again */
      }
    }
  }
  return { removed, skipped };
}

/** Sweep, and record the result when there was anything to record. */
export function sweepAndRecord(dirs, opts) {
  const result = sweepTempFiles(dirs, opts);
  if (result.removed.length) {
    console.log(`[temp] removed ${result.removed.length} abandoned temporary file(s) from a previous run`);
    recordRecovery("temp", "swept", {
      removed: result.removed.length,
      skipped: result.skipped.length,
      // Names, not paths: a recovery log is read by a person and should not carry the user's directory layout.
      names: result.removed.map((f) => path.basename(f)).slice(0, 20),
    });
  }
  return result;
}
