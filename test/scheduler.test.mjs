/**
 * Cron parsing and the catch-up scheduler (§12.2).
 *
 * The exit criterion from the design doc's roadmap is behavioural, not structural: kill the app
 * across a scheduled window, relaunch, and the correct number of runs fire per policy with no window
 * ever replayed twice. That is what the second half of this file actually asserts -- a "closed app"
 * is simulated by advancing an injected clock between catch-up passes, which is exactly what the
 * scheduler cannot tell apart from a real one.
 *
 * The clock is injected rather than mocked globally because `Date.now()` is what the whole mechanism
 * is about; a test that froze it would be testing a different program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setAutomationRoot } from "../electron/automation/storage.mjs";
import { removeRoot } from "./helpers/tempRoot.mjs";
import { openDb, closeDb } from "../electron/automation/db.mjs";
import { saveWorkflow } from "../electron/automation/definitions.mjs";
import { createScheduler, BACKFILL_CAP, nextScheduledFire } from "../electron/automation/scheduler.mjs";
import { parseCron, fireTimesBetween, nextFireAfter, isValidCron, describeCron } from "../electron/automation/cron.mjs";
import * as repo from "../electron/automation/repo.mjs";

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-sched-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

/** Local-time helper: cron is evaluated in local time, so tests must build their bounds the same way. */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/* ------------------------------------------------------------------ cron parsing */

test("parses the field forms cron actually uses", () => {
  assert.deepEqual([...parseCron("0 9 * * *").sets.hour], [9]);
  assert.deepEqual([...parseCron("*/15 * * * *").sets.minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron("0 9-11 * * *").sets.hour], [9, 10, 11]);
  assert.deepEqual([...parseCron("0 0 * * 1,3").sets.dayOfWeek], [1, 3]);
  // Names and aliases, so a pasted expression from elsewhere still works.
  assert.deepEqual([...parseCron("0 9 * * MON").sets.dayOfWeek], [1]);
  assert.deepEqual([...parseCron("@daily").sets.hour], [0]);
  // 7 is a second spelling of Sunday.
  assert.deepEqual([...parseCron("0 0 * * 7").sets.dayOfWeek], [0]);
});

test("rejects malformed expressions instead of silently never firing", () => {
  for (const bad of ["", "0 9 * *", "0 99 * * *", "0 9 * * 9", "nonsense", "*/0 * * * *"]) {
    assert.equal(isValidCron(bad), false, `"${bad}" must not parse`);
  }
  // The message names the offending field -- "invalid cron" alone is not actionable.
  assert.match(String((() => { try { parseCron("0 99 * * *"); } catch (e) { return e.message; } })()), /hour/);
});

test("the lower bound is exclusive, so the last fire is not run twice", () => {
  const nine = at(2026, 3, 10, 9, 0);
  const { times } = fireTimesBetween("0 9 * * *", nine, at(2026, 3, 10, 23, 59));
  assert.equal(times.length, 0, "a fire exactly at `after` has already been accounted for");
});

test("collects every fire in the window, in order", () => {
  const { times } = fireTimesBetween("0 9 * * *", at(2026, 3, 10, 0, 0), at(2026, 3, 13, 12, 0));
  assert.deepEqual(times, [at(2026, 3, 10, 9), at(2026, 3, 11, 9), at(2026, 3, 12, 9), at(2026, 3, 13, 9)]);
});

test("limit caps the walk and reports that more were due", () => {
  const { times, truncated } = fireTimesBetween("*/10 * * * *", at(2026, 3, 10, 0, 0), at(2026, 3, 10, 6, 0), { limit: 5 });
  assert.equal(times.length, 5);
  assert.equal(truncated, true, "truncated must be reported, not inferred from length");
});

test("day-of-month and day-of-week are OR'd when both are restricted", () => {
  // 2026-04-01 is a Wednesday; the expression is "the 1st, and every Monday".
  const { times } = fireTimesBetween("0 0 1 * MON", at(2026, 4, 1, 0, 0) - 1, at(2026, 4, 7, 23, 59));
  const days = times.map((ms) => new Date(ms).getDate());
  assert.ok(days.includes(1), "the 1st must fire even though it is not a Monday");
  assert.ok(days.includes(6), "Monday the 6th must fire even though it is not the 1st");
});

test("an expression that can never match terminates instead of looping", () => {
  // Feb 30 exists in no year; the walk must hit its horizon and return empty.
  const { times } = fireTimesBetween("0 0 30 2 *", at(2026, 1, 1), at(2027, 1, 1));
  assert.deepEqual(times, []);
});

test("nextFireAfter agrees with the walk that actually fires", () => {
  const from = at(2026, 3, 10, 10, 0);
  assert.equal(nextFireAfter("0 9 * * *", from), at(2026, 3, 11, 9));
});

test("describeCron only claims to understand shapes the picker can produce", () => {
  assert.deepEqual(describeCron("30 9 * * *"), { kind: "daily", time: "09:30" });
  assert.deepEqual(describeCron("0 9 * * 1,5"), { kind: "weekly", time: "09:00", days: [1, 5] });
  assert.deepEqual(describeCron("*/15 * * * *"), { kind: "everyMinutes", minutes: 15 });
  // Hand-written cron gets null so the caller shows the expression rather than mis-describing it.
  assert.equal(describeCron("0 9 3 */2 *"), null);
});

/* --------------------------------------------------------------- catch-up policy */

/**
 * A workflow whose single node is instant, so a fired run cannot outlive the assertion.
 *
 * `parallel` rather than `single`: a backfill enqueues several runs at once, and the single-run guard
 * would legitimately refuse all but the first — turning a policy assertion into a concurrency one.
 */
const scheduled = (id, expression, missedRunPolicy) => ({
  id,
  name: id,
  triggers: [{ id: "t1", type: "cron", config: { expression }, missedRunPolicy }],
  limits: { concurrency: "parallel" },
  nodes: [{ id: "only", runtime: "shell", config: { command: "echo scheduled" }, inputs: [] }],
  edges: [],
});

/**
 * Save and assert it took.
 *
 * saveWorkflow reports rejection in its return value rather than throwing, so a fixture with an
 * invalid field saves nothing and every later assertion fails somewhere far away with a count of
 * zero. Checking here turns that into one obvious failure at the line that caused it.
 */
function save(def) {
  const res = saveWorkflow(def);
  assert.ok(res.ok, `fixture rejected by the schema: ${JSON.stringify(res.errors)}`);
  return res;
}

/** Records what the scheduler asked for without running anything. */
function fakeManager() {
  const created = [];
  return {
    created,
    createRun({ workflowId, triggerType }) {
      created.push({ workflowId, triggerType });
      return { ok: true, runId: `run-${created.length}` };
    },
    executeRun: async () => ({ ok: true }),
  };
}

test("first sight of a trigger starts the clock rather than backfilling history", () => {
  const root = freshRoot();
  save(scheduled("wf-first", "0 9 * * *", "backfill"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 12, 0);

  createScheduler({ getManager: () => manager, now: () => clock, log: () => {} }).catchUp();

  assert.equal(manager.created.length, 0, "a newly-seen schedule must not fire for the past");
  assert.equal(repo.getTriggerLastFired("wf-first", "t1"), clock, "but its position must be recorded");
  closeDb();
  removeRoot(root);
});

test("a fire the scheduler watched come due runs, even under 'skip'", () => {
  // The regression this guards is total: `skip` used to be applied to *every* due fire, not just the
  // ones missed during a gap. Each tick would notice the fire, advance the position past it and
  // enqueue nothing — so a workflow set to "every 5 minutes" never ran once, and the only visible
  // symptom was silence. `skip` answers "what about fires you missed while I was closed"; a fire
  // that came due while the scheduler was ticking was never missed.
  const root = freshRoot();
  save(scheduled("wf-live", "*/5 * * * *", "skip"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 9, 1);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: () => {}, tickMs: 60_000 });

  // Tick minute by minute, the way the real interval does — a jump between passes would be a gap,
  // which is a different scenario (and the one the policy is actually for).
  sched.catchUp(); // first pass: establishes the position and this process's liveness
  for (const minute of [2, 3, 4, 5]) {
    clock = at(2026, 3, 10, 9, minute);
    sched.catchUp();
  }

  assert.equal(manager.created.length, 1, "an on-time fire must run regardless of missedRunPolicy");
  assert.equal(manager.created[0].triggerType, "cron");
  closeDb();
  removeRoot(root);
});

test("a stale stored position does not burst on a live pass", () => {
  // A schedule removed and re-added keeps its old trigger_state row, so a live tick can find hours of
  // fires outstanding. The on-time span and the gap span then coexist in one pass: only the fire that
  // actually just happened may run, and the rest are the policy's business — here, dropped.
  const root = freshRoot();
  save(scheduled("wf-stale", "*/5 * * * *", "skip"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 9, 1);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: () => {}, tickMs: 60_000 });
  sched.catchUp();

  // Backdate the position by three hours, as re-enabling a schedule would.
  repo.setTriggerLastFired("wf-stale", "t1", at(2026, 3, 10, 6, 0));

  clock = at(2026, 3, 10, 9, 2);
  sched.catchUp(); // live pass, but with three hours of fires in range

  assert.equal(manager.created.length, 0, "a three-hour backlog under 'skip' must not run");
  clock = at(2026, 3, 10, 9, 5);
  sched.catchUp();
  sched.catchUp();
  assert.ok(manager.created.length <= 1, `expected at most the on-time fire, got ${manager.created.length}`);
  closeDb();
  removeRoot(root);
});

test("'skip' forgets the missed window entirely", () => {
  const root = freshRoot();
  save(scheduled("wf-skip", "0 9 * * *", "skip"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 8, 0);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: () => {} });

  sched.catchUp(); // establishes position
  clock = at(2026, 3, 14, 8, 0); // four 09:00s went by while closed
  const summary = sched.catchUp();

  assert.equal(manager.created.length, 0, "'skip' must enqueue nothing");
  assert.equal(summary.skippedWindows, 1, "but it must report that a window was passed over");
  // The position still advances, or the same window is reconsidered forever.
  assert.equal(repo.getTriggerLastFired("wf-skip", "t1"), clock);
  closeDb();
  removeRoot(root);
});

test("'run-once-on-launch' enqueues exactly one run regardless of gap size", () => {
  const root = freshRoot();
  save(scheduled("wf-once", "0 9 * * *", "run-once-on-launch"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 8, 0);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: () => {} });

  sched.catchUp();
  clock = at(2026, 5, 1, 8, 0); // ~7 weeks closed
  sched.catchUp();

  assert.equal(manager.created.length, 1, "a 5-day gap and a 7-week gap are the same instruction");
  assert.equal(manager.created[0].triggerType, "cron");
  closeDb();
  removeRoot(root);
});

test("'backfill' runs each missed fire, capped, and says what it dropped", () => {
  const root = freshRoot();
  save(scheduled("wf-back", "0 9 * * *", "backfill"));
  const manager = fakeManager();
  const logged = [];
  let clock = at(2026, 3, 10, 8, 0);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: (m) => logged.push(m) });

  sched.catchUp();
  clock = at(2026, 3, 13, 12, 0); // 09:00 on the 10th, 11th, 12th and 13th — four, under the cap
  sched.catchUp();
  assert.equal(manager.created.length, 4);

  // Now overshoot the cap.
  clock = at(2026, 6, 1, 12, 0);
  const summary = sched.catchUp();
  assert.equal(manager.created.length, 4 + BACKFILL_CAP, "backfill must stop at the cap");
  assert.equal(summary.dropped, 1);
  assert.ok(
    logged.some((m) => /dropping the rest/.test(m)),
    "an over-cap truncation must be logged, never silent",
  );
  closeDb();
  removeRoot(root);
});

/* ------------------------------------------------- the roadmap's exit criterion */

test("a window is never replayed, even if the app dies mid-catch-up", () => {
  const root = freshRoot();
  save(scheduled("wf-crash", "0 9 * * *", "backfill"));
  const logged = [];
  let clock = at(2026, 3, 10, 8, 0);

  // A manager that dies on its first createRun -- the crash lands exactly between "position
  // persisted" and "runs enqueued", which is the ordering §12.2 is written to survive.
  const dying = {
    createRun() {
      throw new Error("process died mid-catch-up");
    },
  };
  const sched = createScheduler({ getManager: () => dying, now: () => clock, log: (m) => logged.push(m) });
  sched.catchUp(); // establishes position
  clock = at(2026, 3, 13, 12, 0);
  sched.catchUp(); // three fires due; blows up while enqueueing

  assert.equal(repo.getTriggerLastFired("wf-crash", "t1"), clock, "the position must already be persisted");

  // Relaunch: same clock, healthy manager. The lost window must NOT come back.
  const manager = fakeManager();
  const restarted = createScheduler({ getManager: () => manager, now: () => clock, log: () => {} });
  restarted.catchUp();

  assert.equal(manager.created.length, 0, "a window already accounted for must never fire again");
  closeDb();
  removeRoot(root);
});

test("repeated ticks inside one window do not re-fire it", () => {
  const root = freshRoot();
  save(scheduled("wf-tick", "0 9 * * *", "run-once-on-launch"));
  const manager = fakeManager();
  let clock = at(2026, 3, 10, 8, 0);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: () => {} });

  sched.catchUp();
  clock = at(2026, 3, 10, 9, 30); // 09:00 has now passed
  sched.catchUp();
  assert.equal(manager.created.length, 1);

  // Three more ticks in the same day must add nothing.
  for (const m of [40, 50, 59]) {
    clock = at(2026, 3, 10, 9, m);
    sched.catchUp();
  }
  assert.equal(manager.created.length, 1, "the fire was already accounted for");
  closeDb();
  removeRoot(root);
});

test("the schema refuses a cron expression the scheduler could not read", () => {
  const root = freshRoot();
  // A schedule that never fires is indistinguishable from a broken app, so this must fail loudly at
  // save time rather than quietly at run time.
  const res = saveWorkflow(scheduled("wf-nope", "every morning please", "skip"));
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => /valid cron expression/.test(e)),
    `expected a cron complaint, got ${JSON.stringify(res.errors)}`,
  );
  closeDb();
  removeRoot(root);
});

test("a malformed expression on disk is reported without stopping other workflows", () => {
  const root = freshRoot();
  save(scheduled("wf-bad", "0 9 * * *", "run-once-on-launch"));
  save(scheduled("wf-good", "0 9 * * *", "run-once-on-launch"));

  // Corrupt one on disk, behind the schema's back: this is the hand-edited-JSON case, and the state
  // any definition written before cron validation existed would already be in.
  const badFile = path.join(root, "workflows", "wf-bad", "v1.json");
  const bad = JSON.parse(fs.readFileSync(badFile, "utf8"));
  bad.triggers[0].config.expression = "not a cron";
  fs.writeFileSync(badFile, JSON.stringify(bad, null, 2));

  const manager = fakeManager();
  const logged = [];
  let clock = at(2026, 3, 10, 8, 0);
  const sched = createScheduler({ getManager: () => manager, now: () => clock, log: (m) => logged.push(m) });
  sched.catchUp();

  clock = at(2026, 3, 11, 12, 0);
  const summary = sched.catchUp();

  assert.equal(summary.errors.length, 1, "the broken one is reported");
  assert.match(summary.errors[0], /wf-bad/);
  assert.equal(manager.created.length, 1, "the healthy workflow still fires");
  assert.equal(manager.created[0].workflowId, "wf-good");
  closeDb();
  removeRoot(root);
});

test("nextScheduledFire reports the soonest trigger, or null when unscheduled", () => {
  const def = {
    triggers: [
      { id: "a", type: "cron", config: { expression: "0 18 * * *" } },
      { id: "b", type: "cron", config: { expression: "0 9 * * *" } },
      { id: "c", type: "manual", config: {} },
    ],
  };
  assert.equal(nextScheduledFire(def, at(2026, 3, 10, 10, 0)), at(2026, 3, 10, 18));
  assert.equal(nextScheduledFire({ triggers: [{ id: "m", type: "manual" }] }, Date.now()), null);
});
