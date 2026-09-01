/**
 * Stopping a running command.
 *
 * The Stop button used to abort only the renderer's turn loop, and the loop checks its signal BETWEEN tool
 * calls — so while `run_command` was blocked on a child process, stopping did nothing visible until the
 * command exited or hit its 60s timeout (10 minutes for a download). The fix threads the run's AbortSignal
 * down to the process itself; these tests pin the two properties that make it a real stop rather than a
 * cosmetic one: it RETURNS promptly, and the child is actually dead afterwards.
 *
 * The native engine is exercised directly — it is the one that runs on the host, and the qemu engine's
 * cancellation is a guest-side kill that needs a booted VM to test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { run } from "../electron/tools/sandbox/native.mjs";

/** A command that would outlive the test by a wide margin, so returning early can only mean cancellation. */
const SLEEP_60S = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},60000)"`;

test("aborting mid-run returns promptly instead of waiting for the command", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = run(SLEEP_60S, { timeoutMs: 60_000, signal: ac.signal });
  await delay(100); // let the child actually start, so this is a kill and not a pre-flight refusal
  ac.abort();
  const r = await p;
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `expected an early return, took ${elapsed}ms`);
  assert.equal(r.canceled, true, "the result must say it was canceled");
});

test("cancellation is distinguishable from a timeout", async () => {
  // Both end in a killed child, and the caller words them very differently — a timeout invites one retry,
  // a cancellation must never be retried. So `canceled` has to be false when nobody cancelled.
  const r = await run(`${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},5000)"`, {
    timeoutMs: 300,
  });
  assert.equal(r.canceled, false);
  assert.equal(r.killed, true);
});

test("a command that finishes normally is not reported as canceled", async () => {
  const ac = new AbortController();
  const r = await run(`${JSON.stringify(process.execPath)} -e "console.log('done')"`, {
    timeoutMs: 10_000,
    signal: ac.signal,
  });
  assert.equal(r.code, 0);
  assert.equal(r.canceled, false);
  assert.match(r.stdout, /done/);
});

test("the child process is killed, not merely abandoned", async () => {
  // The distinction the whole change exists for. A promise that resolves early while `npm install` keeps
  // writing to node_modules is not a stop. Proven by side effect: the command would create a file after a
  // delay, and that file must never appear.
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cancel-"));
  const marker = path.join(dir, "written-after-abort.txt");
  const script = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'x')},1500)`;

  const ac = new AbortController();
  const p = run(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, {
    timeoutMs: 60_000,
    signal: ac.signal,
  });
  await delay(200);
  ac.abort();
  await p;
  await delay(2_000); // well past when the surviving child would have written

  await assert.rejects(fs.access(marker), "the child kept running after the abort");
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Stop pressed while the runtime was still starting.
 *
 * `run` checks the signal at its top and then AWAITS the sidecar, so a stop landing during that await reaches
 * the Node fallback with an already-aborted signal. `addEventListener("abort", …)` does not fire for one of
 * those, so the child would be spawned with nothing left to kill it and would run to its full timeout —
 * sixty seconds of a command the user had already stopped, reported as a clean completion.
 *
 * This was invisible while the runtime was off by default under plain node: the await returned in
 * microseconds and the window did not exist. It appeared the moment the runtime became the default.
 */
test("a stop that lands before the child is spawned is still a stop", async () => {
  const ac = new AbortController();
  ac.abort(); // already aborted, exactly as it would be after a slow sidecar start
  const started = Date.now();
  const r = await run(SLEEP_60S, { timeoutMs: 60_000, signal: ac.signal });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `expected an immediate return, took ${elapsed}ms`);
  assert.equal(r.canceled, true, "the result must say it was canceled");
});
