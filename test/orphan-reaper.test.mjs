/**
 * Reaping command trees left behind by a session that never got to clean up after itself.
 *
 * `stopAll()` only runs on a graceful quit. End Task, a crash and an OS shutdown all skip it, and on
 * Windows a child outlives its parent with no signal and no process group to sweep — so a build the
 * agent started keeps running with no app left to stop it. The reaper is the next launch's chance to
 * finish the job.
 *
 * The property under test is not "it kills things" — that part is easy and safe to get wrong in the
 * dangerous direction. It is **which** things: a pid is not an identity, the OS reuses the number, and a
 * cleanup routine that kills whatever holds pid 8452 today is strictly worse than the leak it fixes. So
 * the tests here are mostly about what the reaper must REFUSE to kill.
 *
 * `recordChild` writes through Electron's `app.getPath`, which does not exist under plain node, so these
 * drive `reapOrphans` through a hand-written record file instead. That is also the honest shape of the
 * thing: the file is written by one process and read by a different one, and a test that kept the state
 * in memory would not be exercising the path that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The reaper resolves its record path once, through Electron. Under node that yields null and every entry
 * point turns into a no-op, so it has to be pointed at a temp file before the first call resolves it.
 *
 * The redirection is an env var the module checks first (`ZERAIX_ORPHAN_RECORD`), rather than an argument
 * threaded through every call site: the reaper is invoked once, from `app.whenReady`, and a parameter
 * there would exist for no reason except this file. The cache is resolved on first use, so each test
 * re-imports the module with a fresh query string to get a fresh lookup.
 */
async function loadReaper(dir) {
  const file = path.join(dir, "running-commands.json");
  process.env.ZERAIX_ORPHAN_RECORD = file;
  const mod = await import(`../electron/tools/sandbox/orphans.mjs?t=${Date.now()}`);
  return { mod, file };
}

/** A child that will outlive the test by a wide margin, so surviving the reaper is unambiguous. */
function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a recorded process that is still running is killed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { mod, file } = await loadReaper(dir);

  const child = spawnSleeper();
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already dead, which is the point of the test */
    }
  });
  // Recorded as having started now, which is true — that is what makes it eligible.
  fs.writeFileSync(file, JSON.stringify([{ pid: child.pid, startedAt: Date.now(), command: "sleep" }]));

  const killed = await mod.reapOrphans();
  assert.deepEqual(
    killed.map((k) => k.pid),
    [child.pid],
    "the orphan should have been reported as killed",
  );
  await delay(300);
  assert.equal(alive(child.pid), false, "the orphan should actually be gone");
});

test("a pid the OS has since reused is left alone", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { mod, file } = await loadReaper(dir);

  const child = spawnSleeper();
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  });
  // The same pid, but recorded as having started a day before this process actually did. That is exactly
  // what pid reuse looks like from the reaper's side, and it must decline.
  const aDayAgo = Date.now() - 12 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify([{ pid: child.pid, startedAt: aDayAgo, command: "not ours" }]));

  const killed = await mod.reapOrphans();
  assert.deepEqual(killed, [], "a mismatched start time must not be killed");
  await delay(200);
  assert.equal(alive(child.pid), true, "the unrelated process must still be running");
});

test("the record is cleared even when nothing is killed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { mod, file } = await loadReaper(dir);

  // A pid that cannot be running: nothing to kill, but the entry must not survive to be retried next
  // time, when the number may well have been handed to something real.
  fs.writeFileSync(file, JSON.stringify([{ pid: 0x7ffffffe, startedAt: Date.now(), command: "gone" }]));

  const killed = await mod.reapOrphans();
  assert.deepEqual(killed, []);
  assert.equal(fs.existsSync(file), false, "the record should be consumed, not left for the next run");
});

test("a missing or corrupt record is not an error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { mod, file } = await loadReaper(dir);

  assert.deepEqual(await mod.reapOrphans(), [], "no file at all is the normal, clean-exit case");

  fs.writeFileSync(file, "{ this is not json");
  assert.deepEqual(await mod.reapOrphans(), [], "a truncated write must not break startup");

  fs.writeFileSync(file, JSON.stringify({ notAnArray: true }));
  assert.deepEqual(await mod.reapOrphans(), [], "a wrong-shaped record must not break startup");
});

test("entries older than a day are ignored without being examined", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { mod, file } = await loadReaper(dir);

  const child = spawnSleeper();
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  });
  // Stale beyond the cutoff. Even a live pid must not be touched: after a day the number means nothing.
  fs.writeFileSync(
    file,
    JSON.stringify([{ pid: child.pid, startedAt: Date.now() - 48 * 60 * 60 * 1000, command: "ancient" }]),
  );

  assert.deepEqual(await mod.reapOrphans(), []);
  assert.equal(alive(child.pid), true);
});
