/**
 * The Simple-mode schedule picker, checked against the engine that has to honour it.
 *
 * The picker builds cron in the renderer (`blocks.ts`) while the authority on what an expression
 * *means* lives in the main process (`cron.mjs`), so the two could in principle drift. This file is
 * the seam: every preset is compiled by the renderer, validated by the real schema, and then walked
 * by the real scheduler clock. A preset that produced cron the engine rejects — or, far worse,
 * accepts and fires at the wrong time — fails here rather than becoming a schedule that silently
 * misbehaves on a user's machine.
 *
 * The round-trip assertions matter just as much: Simple mode reads a definition back into picker
 * state on every open, so a preset that does not survive write-then-read would visibly rewrite the
 * user's schedule the moment they looked at it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { validateDefinition } from "../electron/automation/schema.mjs";
import { fireTimesBetween, nextFireAfter } from "../electron/automation/cron.mjs";

// blocks.ts imports from "@/lib/workflows" (types only, but the specifier still has to resolve).
register("./helpers/srcResolve.mjs", import.meta.url);

const { scheduleToCron, readSchedule, applySchedule, DEFAULT_SCHEDULE, MINUTE_CHOICES } = await import(
  "../src/app/agent/automation/blocks.ts"
);

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/** A minimal valid workflow the picker can be applied to. */
const base = () => ({
  id: "wf-sched",
  version: 1,
  name: "sched",
  triggers: [{ id: "manual", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  nodes: [{ id: "only", runtime: "shell", config: { command: "echo hi" }, inputs: [] }],
  edges: [],
});

const PRESETS = [
  { preset: "daily", time: "09:00" },
  { preset: "daily", time: "23:45" },
  { preset: "weekdays", time: "08:30" },
  { preset: "hourly", time: "00:15" },
  ...MINUTE_CHOICES.map((minutes) => ({ preset: "everyMinutes", minutes })),
];

test("every preset compiles to cron the engine accepts", () => {
  for (const p of PRESETS) {
    const def = applySchedule(base(), { ...DEFAULT_SCHEDULE, ...p });
    const res = validateDefinition(def);
    assert.ok(res.ok, `${p.preset} produced a definition the schema rejects: ${JSON.stringify(res.errors)}`);
  }
});

test("every preset survives a write-then-read round trip", () => {
  for (const p of PRESETS) {
    const value = { ...DEFAULT_SCHEDULE, ...p };
    const back = readSchedule(applySchedule(base(), value));
    assert.equal(back.preset, p.preset, `${p.preset} did not read back as itself`);
    if (p.time) assert.equal(back.time, p.time, `${p.preset} lost its time`);
    if (p.minutes) assert.equal(back.minutes, p.minutes, `${p.preset} lost its interval`);
  }
});

test("'every day at 09:00' actually fires at 09:00, once a day", () => {
  // The end-to-end claim the picker makes to the user, checked against the scheduler's own walk.
  const expr = scheduleToCron({ ...DEFAULT_SCHEDULE, preset: "daily", time: "09:00" });
  const { times } = fireTimesBetween(expr, at(2026, 3, 10, 0, 0), at(2026, 3, 12, 23, 59));
  assert.deepEqual(times, [at(2026, 3, 10, 9), at(2026, 3, 11, 9), at(2026, 3, 12, 9)]);
});

test("'every weekday' skips the weekend", () => {
  const expr = scheduleToCron({ ...DEFAULT_SCHEDULE, preset: "weekdays", time: "08:30" });
  // 2026-03-13 is a Friday, so the next fire must be Monday the 16th, not Saturday the 14th.
  assert.equal(nextFireAfter(expr, at(2026, 3, 13, 9, 0)), at(2026, 3, 16, 8, 30));
});

test("the missed-run policy is carried through, defaulting to skip", () => {
  // `skip` is the safe default for anything with side effects (§12.2): a workflow that sends mail
  // must not fire four times because the laptop was shut for four days.
  assert.equal(DEFAULT_SCHEDULE.missedRunPolicy, "skip");
  const def = applySchedule(base(), { ...DEFAULT_SCHEDULE, preset: "daily", missedRunPolicy: "backfill" });
  assert.equal(def.triggers.find((t) => t.type === "cron").missedRunPolicy, "backfill");
  assert.equal(readSchedule(def).missedRunPolicy, "backfill");
});

test("a scheduled workflow keeps its manual trigger", () => {
  // Otherwise "run it now to check it works" disappears the moment a schedule is set, and the only
  // way to test a schedule is to wait for it.
  const def = applySchedule(base(), { ...DEFAULT_SCHEDULE, preset: "daily" });
  assert.ok(def.triggers.some((t) => t.type === "manual"), "the Run button must keep working");
  assert.ok(validateDefinition(def).ok);
});

test("switching back to manual removes the schedule", () => {
  const scheduled = applySchedule(base(), { ...DEFAULT_SCHEDULE, preset: "daily" });
  const manual = applySchedule(scheduled, { ...DEFAULT_SCHEDULE, preset: "manual" });
  assert.equal(manual.triggers.filter((t) => t.type === "cron").length, 0);
  assert.equal(readSchedule(manual).preset, "manual");
});

test("a hand-written schedule is reported as custom, never rewritten", () => {
  // Opening Simple mode must not quietly normalise cron someone tuned by hand in the JSON tab.
  const def = {
    ...base(),
    triggers: [
      { id: "manual", type: "manual", config: {} },
      { id: "s", type: "cron", config: { expression: "0 9 1-7 */3 *" }, missedRunPolicy: "skip" },
    ],
  };
  const value = readSchedule(def);
  assert.equal(value.preset, "custom");
  assert.equal(value.expression, "0 9 1-7 */3 *");
  // applySchedule refuses to touch it, so merely rendering the picker cannot destroy the schedule.
  assert.deepEqual(applySchedule(def, value), def);
});

test("a non-cron automatic trigger is not mistaken for manual", () => {
  // Reporting a file-watch workflow as "manual" would offer to overwrite a working trigger.
  const def = {
    ...base(),
    triggers: [{ id: "w", type: "file-watch", config: { path: "/tmp" }, missedRunPolicy: "skip" }],
  };
  assert.equal(readSchedule(def).preset, "custom");
});
