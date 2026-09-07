/**
 * The session lock: how a launch knows whether the previous session ended cleanly.
 *
 * docs/agent-runtime-crash-recovery.md C9. `<userData>/session.lock` is written at startup with the pid, the start
 * time and the app version, and removed at the END of before-quit — after the kill list ran — so a crash during
 * teardown still counts as unclean (the teardown did not finish, which is precisely what the next launch needs to
 * know). A lock found at launch whose pid is no longer alive is an unclean shutdown: the previous process died
 * without reaching the end of before-quit.
 *
 * This is the marker every other recovery category reads from: the orphan sweep and the sidecar journal replay
 * already run unconditionally, but "what was interrupted" can only be reported honestly when the app knows that
 * something was. No electron import, for the same reason as recoveryLog.mjs: the folder is handed in.
 */
import fs from "node:fs";
import path from "node:path";
import { recordRecovery } from "./recoveryLog.mjs";

const NAME = "session.lock";

let current = null; // { path, session: { pid, startedAt, version }, previous, unclean }

/** Whether a pid names a live process. EPERM means it exists but is not ours — still alive. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock for this process. Returns what was found:
 *   { unclean, previous } — `previous` is the stale lock's content (or null); `unclean` is true when a previous
 *   session left its lock behind and its process is gone.
 *
 * A previous lock whose pid is still alive is not condemned: the single-instance lock normally makes that
 * impossible, and a reused pid after a reboot is the one case it can happen — reported as `pidReused` rather
 * than guessed either way.
 */
export function acquireSessionLock({ dir, version = "", now = Date.now() }) {
  const file = path.join(dir, NAME);
  const previous = readLock(file);
  const alive = previous ? pidAlive(previous.pid) : false;
  const unclean = !!previous && !alive;
  const session = { pid: process.pid, startedAt: now, version };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[session] could not write the session lock:", e?.message ?? e);
  }
  current = { path: file, session, previous, unclean, pidReused: !!previous && alive };
  if (unclean) {
    recordRecovery("session", "unclean-shutdown", {
      previousPid: previous.pid,
      previousStartedAt: previous.startedAt,
      previousVersion: previous.version,
    });
  }
  return { unclean, previous, pidReused: current.pidReused };
}

/** Remove the lock: the session ended cleanly. Called last in before-quit, after the kill list ran. */
export function releaseSessionLock() {
  if (!current) return;
  try {
    // Only our own lock: a newer process may have replaced it (it should not, but deleting someone else's
    // marker would hide their crash).
    const onDisk = readLock(current.path);
    if (!onDisk || onDisk.pid === process.pid) fs.rmSync(current.path, { force: true });
  } catch {
    /* ignore */
  }
  current = null;
}

/** What acquireSessionLock found, for the renderer's one-time notice. */
export function lastSession() {
  if (!current) return { unclean: false, previous: null, pidReused: false };
  return { unclean: current.unclean, previous: current.previous, pidReused: current.pidReused };
}
