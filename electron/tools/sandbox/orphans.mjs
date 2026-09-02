/**
 * Cleaning up command trees that outlived the app.
 *
 * ## What this is for
 *
 * `stopAll()` takes down every running command, and `before-quit` calls it. That covers a *graceful*
 * exit and nothing else. Task Manager's End Task, a crash, a SIGKILL, the OS closing the session — none
 * of them run a line of our code, and on Windows a child is simply re-parented when its parent dies:
 * no signal, no process group to sweep, nothing to notice. The tree keeps running.
 *
 * That is not a small leak. The case this was written for was `pnpm run check` on a large monorepo,
 * which is jest and tsc and eslint across every package: a core and a gigabyte, still going after the
 * app it belonged to was gone, with nothing in any UI to connect the two.
 *
 * The Rust runtime solves this properly with a Windows job object (`agent-process/src/job.rs`), where
 * the kernel does the killing and no code of ours has to run. This file is the same guarantee for the
 * Node path — weaker, because it can only act at the *next* start, but the Node path is what runs
 * whenever the sidecar is absent, so leaving it uncovered would leave the reported bug in place.
 *
 * ## Why the start-time check, and why a failed check does nothing
 *
 * A pid is not an identity. By the time the app runs again the OS may well have reused the number, and
 * "kill whatever holds pid 8452 now" is how a cleanup routine takes down something that has nothing to
 * do with it. So a recorded pid is killed only when the process holding it *now* started when we say we
 * started it — checked against the real start time the OS reports, with a wide tolerance because only
 * the reuse case is being excluded, not a stopwatch.
 *
 * When the start time cannot be determined the entry is skipped, not killed. An orphan that survives one
 * more launch is a nuisance; killing an unrelated process is a bug we would never see the far end of.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/**
 * Where the record lives, or `null` when there is nowhere to put it.
 *
 * `app` is reached the same way `rustRuntime.mjs::stateDirArgs` reaches it, and for the same reason: this
 * module is imported by the sandbox engine, which the test suite loads under plain node with a stubbed
 * `electron`. A static `import { app } from "electron"` fails to link there and takes every test that
 * touches command execution down with it.
 *
 * A null path is not a degraded mode worth warning about — it means no app, so no session that could
 * leave orphans behind, so nothing to record.
 */
let cachedPath;
function recordPath() {
  if (cachedPath !== undefined) return cachedPath;
  cachedPath = null;
  // An explicit override, honoured before anything else. The record is written by one run and read by the
  // next, so the only way to exercise the reaper is to hand it a file some other process wrote — which
  // needs a path that does not come from an Electron `app` object the test harness does not have.
  if (process.env.ZERAIX_ORPHAN_RECORD) {
    cachedPath = process.env.ZERAIX_ORPHAN_RECORD;
    return cachedPath;
  }
  if (process.versions.electron) {
    try {
      const { app } = createRequire(import.meta.url)("electron");
      cachedPath = path.join(app.getPath("userData"), "agent", "running-commands.json");
    } catch {
      /* no app object (a stubbed harness, a preload-less context): nothing to record */
    }
  }
  return cachedPath;
}

/**
 * How far the OS-reported start time may sit from ours before the pid is treated as reused.
 *
 * Generous on purpose. The two clocks are the same clock, and the gap between `spawn` returning and the
 * record being written is milliseconds — but Windows reports `StartTime` at second granularity, a busy
 * machine can stretch the spawn itself, and the only thing being ruled out is a pid that was recycled,
 * which takes far longer than this. Tightening it buys nothing and starts skipping real orphans.
 */
const START_TOLERANCE_MS = 60_000;

/** Entries older than this are dropped unexamined: a stale file from weeks ago is not worth acting on. */
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

/** pid -> { startedAt, command }. Mirrors the file so a write never has to read first. */
const live = new Map();

/** Coalesces the writes: a burst of commands should not mean a burst of fsyncs. */
let writeTimer = null;

function flush() {
  writeTimer = null;
  const file = recordPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [...live.entries()].map(([pid, v]) => ({ pid, ...v }));
    fs.writeFileSync(file, JSON.stringify(rows), "utf8");
  } catch {
    // Best effort throughout. Failing to record an orphan must never fail the command that would have
    // become one — this is cleanup for an exit that may not happen, not part of running the command.
  }
}

function schedule() {
  if (writeTimer) return;
  // Short, and unref'd: this must not be the thing keeping the event loop alive at shutdown.
  writeTimer = setTimeout(flush, 200);
  writeTimer.unref?.();
}

/**
 * Note that `pid` is running, so a later launch can clean it up if this one never gets the chance.
 *
 * Called for foreground commands and background services alike: both outlive the app in exactly the same
 * way, and the record cannot tell them apart after the fact.
 */
export function recordChild(pid, command = "") {
  if (!pid) return;
  live.set(pid, { startedAt: Date.now(), command: String(command).slice(0, 500) });
  schedule();
}

/** Note that `pid` is finished. Cheap, and the common case — nearly every command ends normally. */
export function forgetChild(pid) {
  if (!pid || !live.delete(pid)) return;
  schedule();
}

/**
 * Drop every entry and write that out now, without waiting for the debounce.
 *
 * Called from the graceful shutdown path, after the children have actually been killed. Skipping it
 * would only leave a file full of dead pids — harmless, since the next launch finds nothing alive — but
 * "the record is empty because the exit was clean" is a much easier thing to reason about than a file
 * that is always stale by some amount.
 */
export function clearRecord() {
  live.clear();
  if (writeTimer) clearTimeout(writeTimer);
  flush();
}

/** Is anything holding this pid right now? Signal 0 tests for existence without delivering anything. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else — which, for a pid we recorded, means reuse.
    // Treated as alive so the start-time check gets to reject it explicitly.
    return e?.code === "EPERM";
  }
}

/** Run a helper and hand back stdout, or "" if it fails. Never throws; this is all best effort. */
function readCommand(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
    } catch {
      resolve("");
    }
  });
}

/**
 * When did the process holding `pid` actually start, in ms since the epoch? `null` when we cannot tell.
 *
 * One call per platform for the whole batch would be tidier, but this runs only when the previous run
 * ended abruptly and only over the handful of commands it had open, so the simple shape wins.
 */
async function startedAt(pid) {
  if (process.platform === "linux") {
    // Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot; /proc/stat's `btime` is
    // when boot was. The comm field (2) can contain spaces and parentheses, so parse after the LAST ')'.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]); // field 22 overall, minus pid and comm, zero-based
      const btime = /^btime (\d+)/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1];
      if (!Number.isFinite(ticks) || !btime) return null;
      // USER_HZ is 100 for /proc regardless of the kernel's internal HZ. Exactness is not needed here.
      return Number(btime) * 1000 + (ticks / 100) * 1000;
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    const out = await readCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`,
    ]);
    const ticks = Number(out.trim());
    if (!Number.isFinite(ticks) || ticks <= 0) return null;
    // FILETIME is 100ns intervals since 1601-01-01; 11644473600s separates that from the Unix epoch.
    return ticks / 10_000 - 11_644_473_600_000;
  }

  // macOS and the rest: ps reports the start time as a date string.
  const out = await readCommand("ps", ["-o", "lstart=", "-p", String(Number(pid))]);
  const ms = Date.parse(out.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Kill the whole tree under `pid`, the same way `killTree` does for a live child. */
function killTreeByPid(pid) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      // The group, because these were spawned detached into their own — see killTree in native.mjs.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone, or not ours any more — either way there is nothing to do */
  }
}

/**
 * Kill command trees left behind by a previous run, then clear the record.
 *
 * Called once at startup. Returns what it killed so the caller can log it: an app that silently kills
 * processes at boot is worse to debug than the orphans were.
 */
export async function reapOrphans() {
  const file = recordPath();
  if (!file) return [];
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // No file is the normal case: the last exit was clean.
  }
  // Clear it first. A crash midway through reaping must not leave entries that get retried forever
  // against pids that have since been reused.
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  if (!Array.isArray(rows)) return [];

  const killed = [];
  const now = Date.now();
  for (const row of rows) {
    const pid = Number(row?.pid);
    const recorded = Number(row?.startedAt);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!Number.isFinite(recorded) || now - recorded > MAX_RECORD_AGE_MS) continue;
    if (!alive(pid)) continue;

    const actual = await startedAt(pid);
    // Unverifiable, or verifiably a different process wearing the same number. Leave it alone.
    if (actual === null || Math.abs(actual - recorded) > START_TOLERANCE_MS) continue;

    killTreeByPid(pid);
    killed.push({ pid, command: String(row?.command ?? "") });
  }
  return killed;
}
