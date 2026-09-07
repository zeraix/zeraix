/**
 * The sidecar supervisor's policy (docs/agent-runtime-crash-recovery.md C3).
 *
 * The bridge itself needs a real child process and a real pipe, so what is pinned here is the part that decides:
 * how long to wait before respawning, when to give up for the session, and what the host is told meanwhile. Those
 * used to be four scattered updates to two variables, and a site that bumped the counter without arming the wait is
 * exactly how "back off before retrying" silently becomes "retry immediately".
 *
 * The module is imported for its constants and its exported status shape; the failure ladder is reproduced here from
 * those constants rather than hard-coded, so a change to the schedule fails this test rather than drifting past it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.join(fileURLToPath(new URL("../", import.meta.url)), "electron/tools/rustRuntime.mjs"),
  "utf8",
);

/** Read a numeric array/scalar constant out of the module source, so the test asserts the shipped values. */
function constant(name) {
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\]|[\\d_]+)`).exec(src);
  assert.ok(m, `${name} is declared`);
  return JSON.parse(m[1].replace(/_/g, ""));
}

test("the respawn schedule waits longer each time and never gives up mid-schedule", () => {
  const backoff = constant("RESPAWN_BACKOFF_MS");
  const maxFailures = constant("MAX_SPAWN_FAILURES");

  assert.ok(Array.isArray(backoff) && backoff.length >= 2, "there is a schedule, not a single delay");
  for (let i = 1; i < backoff.length; i++) {
    assert.ok(backoff[i] > backoff[i - 1], `step ${i} waits longer than step ${i - 1}`);
  }
  assert.ok(backoff[0] >= 500, "the first retry is not immediate — that is the burst this prevents");
  assert.ok(backoff[backoff.length - 1] <= 60_000, "and never so long that a recovered sidecar goes unnoticed");
  // The ladder must cover the attempts the latch allows; otherwise the last waits repeat the previous one,
  // which is fine, but a schedule LONGER than the latch would be dead code.
  assert.ok(backoff.length <= maxFailures, "every step of the schedule is reachable before the latch fires");
});

test("the failure ladder ends in a latch rather than retrying forever", () => {
  const backoff = constant("RESPAWN_BACKOFF_MS");
  const maxFailures = constant("MAX_SPAWN_FAILURES");
  const waitFor = (failures) => backoff[Math.min(failures - 1, backoff.length - 1)];

  const seen = [];
  let disabled = false;
  for (let failures = 1; failures <= maxFailures; failures++) {
    if (failures >= maxFailures) disabled = true;
    else seen.push(waitFor(failures));
  }
  assert.equal(disabled, true, "a runtime that keeps failing stops being respawned for the session");
  assert.equal(seen.length, maxFailures - 1, "each attempt before the latch waits first");
  assert.deepEqual(seen, backoff.slice(0, maxFailures - 1));
});

test("the heartbeat is cheaper than the call timeout it replaces", () => {
  const interval = constant("HEARTBEAT_INTERVAL_MS");
  const hbTimeout = constant("HEARTBEAT_TIMEOUT_MS");
  const callTimeout = constant("CALL_TIMEOUT_MS");

  assert.ok(hbTimeout < interval, "a ping cannot outlive the gap to the next one");
  // The whole point: a wedged sidecar is caught in seconds by the heartbeat instead of minutes by a real call.
  assert.ok(hbTimeout * 4 < callTimeout, "the heartbeat notices a wedged runtime far sooner than a call would");
  assert.ok(interval <= 120_000, "and it checks often enough to matter within a turn");
});

test("the supervisor skips its ping while a real request is in flight", () => {
  // A reply to actual work proves liveness better than a ping, and pinging a busy runtime only queues more work.
  assert.match(src, /if \(s\.pending\.size > 0\) return;/, "busy runtimes are not pinged");
});

test("a heartbeat miss tears the runtime down instead of leaving callers to time out one by one", () => {
  const hb = src.slice(src.indexOf("function startHeartbeat"), src.indexOf("function stopHeartbeat"));
  assert.match(hb, /teardown\("heartbeat missed"\)/);
  assert.match(hb, /noteFailure\("heartbeat missed"\)/, "and it counts toward the latch like any other failure");
  assert.match(hb, /s\.child\.kill\(\)/, "the wedged process is killed, not merely abandoned");
});

test("every failure path goes through the one function that arms the backoff", () => {
  // The bug this prevents: a site that increments the counter without setting nextAttemptAt.
  const strayIncrements = src.match(/\+\+spawnFailures/g) ?? [];
  assert.deepEqual(strayIncrements, [], "spawnFailures is only advanced inside noteFailure");
  const noteFailureCalls = src.match(/noteFailure\(/g) ?? [];
  assert.ok(noteFailureCalls.length >= 5, `every failure site reports (found ${noteFailureCalls.length})`);
});

test("a successful handshake clears the backoff, not just the counter", () => {
  const ok = src.slice(src.indexOf("s.ready = true;"), src.indexOf("s.ready = true;") + 200);
  assert.match(ok, /spawnFailures = 0;/);
  assert.match(ok, /nextAttemptAt = 0;/, "otherwise a recovered runtime stays in a backoff window it already left");
});

test("the backoff never blocks a tool call: it declines and lets the JS handler serve", () => {
  assert.match(
    src,
    /if \(nextAttemptAt && Date\.now\(\) < nextAttemptAt\) return null;/,
    "returning null means 'not served here', which is the fallback path",
  );
});

test("the latch and the recovered work leave a record rather than a console line", () => {
  assert.match(src, /recordRecovery\("sidecar", "disabled"/);
  assert.match(src, /recordRecovery\("sidecar", "restart-scheduled"/);
  assert.match(src, /recordRecovery\("sidecar", "heartbeat-missed"/);
  assert.match(src, /recordRecovery\("sidecar", "journal-replayed"/);
});

test("interrupted work is exposed as data, and never as something to re-run", () => {
  const status = src.slice(src.indexOf("export function bridgeStatus"), src.indexOf("export function bridgeStatus") + 2000);
  assert.match(status, /interrupted:/);
  assert.match(status, /resumable:/);
  assert.match(status, /tornTail/);
  // Nothing in the supervisor resubmits recovered work; the journal's own rule is that `interrupted` is reported only.
  assert.doesNotMatch(src, /resubmit|reRun|re_run|retryTask/i);
});

test("a failure record is about one binary, and does not outlive it", () => {
  // Found by the sidecar tests: a deliberately-killed sidecar in one case armed the backoff, and the next case —
  // pointing at a DIFFERENT scripted binary — was refused a start and silently fell back. In a packaged app the
  // path never moves and this never fires; it matters wherever it can, which is a developer rebuilding the sidecar.
  assert.match(src, /if \(failedBin && failedBin !== bin\)/, "the history is discarded when the executable changes");
  const reset = src.slice(src.indexOf("if (failedBin && failedBin !== bin)"), src.indexOf("if (failedBin && failedBin !== bin)") + 260);
  for (const field of ["spawnFailures = 0", "nextAttemptAt = 0", "disabled = false"]) {
    assert.ok(reset.includes(field), `${field} is cleared with the rest`);
  }
});

test("the backoff is checked after the binary comparison, never before", () => {
  // Order matters: a stale window from the previous binary must not refuse a start for the new one.
  const body = src.slice(src.indexOf("async function ensureStarted"));
  const compare = body.indexOf("failedBin !== bin");
  const window = body.indexOf("Date.now() < nextAttemptAt");
  assert.ok(compare !== -1 && window !== -1);
  assert.ok(compare < window, "the history is scoped first, and only then consulted");
});

test("a deliberate shutdown ends the failure history with the lifecycle it belonged to", () => {
  const body = src.slice(src.indexOf("export async function shutdown"));
  for (const field of ["spawnFailures = 0", "nextAttemptAt = 0", "disabled = false", 'failedBin = ""']) {
    assert.ok(body.includes(field), `shutdown clears ${field}`);
  }
  // The same principle as the renderer crash page's "Try again": only a deliberate act grants a fresh budget.
});
