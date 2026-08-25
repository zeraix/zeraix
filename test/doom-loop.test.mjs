/**
 * The loop guard: what counts as progress, and what it takes to stop an unbounded turn.
 *
 * The tool loop has no round limit by design, so this module is the only thing standing between a model that
 * has stopped learning anything and a turn that runs until the user notices. Both halves of that are worth
 * pinning, and the second one more than the first:
 *
 *  - a loop is caught — a repeated call with a repeated result, and a tool failing over and over;
 *  - work is NOT caught — the same command returning different output, a mixed round with one real result,
 *    a failure that resolves. Every false positive here costs the user real work in progress, which is a
 *    worse outcome than one more round of a loop;
 *  - the break fires exactly once, so the round that follows it is an ordinary round.
 *
 * Pure module, no React and no model: the thresholds are testable directly, which is why the detection was
 * built as a reducer rather than inline in the loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const {
  createDoomLoopState,
  observeCall,
  closeRound,
  callKey,
  equivalentKey,
  resourceOf,
  resultHash,
  REPEAT_NOTE_AT,
  FAIL_NOTE_AT,
  RESOURCE_NOTE_AT,
  STALLED_ROUNDS_TO_ESCALATE,
} = await import("../src/lib/agent/doomLoop.ts");

/** One round of a single call, the shape most of these tests need. */
const round = (g, name, args, result, ok = true) => {
  const note = observeCall(g, { name, args, result, ok });
  return { note, verdict: closeRound(g, [note]) };
};

test("the same call is one identity however its arguments are ordered", () => {
  assert.equal(
    callKey("read_file", { path: "a.ts", limit: 10 }),
    callKey("read_file", { limit: 10, path: "a.ts" }),
  );
  // Arrays are ordered data, not a bag of keys — reordering one is a different call.
  assert.notEqual(callKey("x", { a: [1, 2] }), callKey("x", { a: [2, 1] }));
  assert.notEqual(callKey("read_file", { path: "a.ts" }), callKey("read_file", { path: "b.ts" }));
  // The tool name is part of the identity: same arguments to a different tool is a different question.
  assert.notEqual(callKey("read_file", { path: "a" }), callKey("file_info", { path: "a" }));
});

test("result identity survives size and distinguishes near-misses", () => {
  assert.equal(resultHash("hello"), resultHash("hello"));
  assert.notEqual(resultHash("hello"), resultHash("hellp"));
  // Length is part of the hash, so a truncation can never read as the full text.
  assert.notEqual(resultHash("ab"), resultHash("ab "));
  assert.equal(resultHash(""), resultHash(""));
});

test("a repeated call with a repeated result is reported on the second call, not the first", () => {
  const g = createDoomLoopState();
  const first = observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "X", ok: true });
  assert.equal(first.repeat, 1);
  assert.equal(first.unproductive, false);
  assert.equal(first.signal, null);

  const second = observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "X", ok: true });
  assert.equal(second.repeat, REPEAT_NOTE_AT);
  assert.equal(second.unproductive, true);
  assert.equal(second.signal, "identical");
});

test("the same call returning something new is productive every time", () => {
  const g = createDoomLoopState();
  // The case a naive same-call counter would flag: a test suite re-run while the code changes underneath it.
  for (const output of ["3 failed", "1 failed", "all passed"]) {
    const { note, verdict } = round(g, "run_command", { cmd: "npm test" }, output);
    assert.equal(note.repeat, 1, `"${output}" should be the first of its kind`);
    assert.equal(note.unproductive, false);
    assert.equal(verdict.stalledRounds, 0);
  }
});

test("consecutive failures of one tool are caught even though every result differs", () => {
  const g = createDoomLoopState();
  // The edit-retry loop: old_string never matches, and the error quotes the attempt, so no two results are
  // ever identical. Only the failure streak sees it.
  const attempt = (n) =>
    observeCall(g, {
      name: "edit_file",
      args: { path: "a.ts", old_string: `guess ${n}` },
      result: `no match for "guess ${n}"`,
      ok: false,
    });
  assert.equal(attempt(1).unproductive, false);
  assert.equal(attempt(2).unproductive, false);
  const third = attempt(3);
  assert.equal(third.failStreak, FAIL_NOTE_AT);
  assert.equal(third.unproductive, true);
  assert.equal(third.signal, "failing");
});

test("a success clears the failure streak, so a tool that recovers is not still on probation", () => {
  const g = createDoomLoopState();
  observeCall(g, { name: "edit_file", args: { n: 1 }, result: "e1", ok: false });
  observeCall(g, { name: "edit_file", args: { n: 2 }, result: "e2", ok: false });
  const fixed = observeCall(g, { name: "edit_file", args: { n: 3 }, result: "done", ok: true });
  assert.equal(fixed.failStreak, 0);
  const next = observeCall(g, { name: "edit_file", args: { n: 4 }, result: "e4", ok: false });
  assert.equal(next.failStreak, 1, "the streak restarts rather than resuming");
  assert.equal(next.unproductive, false);
});

test("failures of different tools do not add up into a streak", () => {
  const g = createDoomLoopState();
  observeCall(g, { name: "edit_file", args: { n: 1 }, result: "e", ok: false });
  observeCall(g, { name: "run_command", args: { n: 1 }, result: "e", ok: false });
  const third = observeCall(g, { name: "write_file", args: { n: 1 }, result: "e", ok: false });
  assert.equal(third.failStreak, 1);
  assert.equal(third.unproductive, false);
});

test("the loop breaks after enough fully unproductive rounds, and only then", () => {
  const g = createDoomLoopState();
  // Round 1 establishes the result; from round 2 on, nothing new is learned.
  assert.equal(round(g, "read_file", { path: "a.ts" }, "SAME").verdict.stalledRounds, 0);
  for (let i = 1; i < STALLED_ROUNDS_TO_ESCALATE; i++) {
    const { verdict } = round(g, "read_file", { path: "a.ts" }, "SAME");
    assert.equal(verdict.stalledRounds, i);
    assert.equal(verdict.escalate, false, `must not break on stalled round ${i}`);
  }
  const final = round(g, "read_file", { path: "a.ts" }, "SAME");
  assert.equal(final.verdict.stalledRounds, STALLED_ROUNDS_TO_ESCALATE);
  assert.equal(final.verdict.escalate, true);
});

test("one real result anywhere in a round clears the streak", () => {
  const g = createDoomLoopState();
  observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "A", ok: true });
  // Two stalled rounds — one short of the break.
  for (let i = 0; i < STALLED_ROUNDS_TO_ESCALATE - 1; i++) {
    round(g, "read_file", { path: "a.ts" }, "A");
  }
  // A parallel batch: a repeat AND something genuinely new. The round advanced the task.
  const repeated = observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "A", ok: true });
  const fresh = observeCall(g, { name: "read_file", args: { path: "b.ts" }, result: "B", ok: true });
  const mixed = closeRound(g, [repeated, fresh]);
  assert.equal(mixed.stalledRounds, 0);
  assert.equal(mixed.escalate, false);
  // And the counter really restarted: a single stalled round after it does not break.
  assert.equal(round(g, "read_file", { path: "a.ts" }, "A").verdict.escalate, false);
});

test("the break is reported once, so the round after it is an ordinary round", () => {
  const g = createDoomLoopState();
  round(g, "read_file", { path: "a.ts" }, "SAME");
  let broke = 0;
  for (let i = 0; i < STALLED_ROUNDS_TO_ESCALATE + 3; i++) {
    if (round(g, "read_file", { path: "a.ts" }, "SAME").verdict.escalate) broke++;
  }
  assert.equal(broke, 1);
});

test("a round with no tool calls leaves the streak untouched", () => {
  const g = createDoomLoopState();
  round(g, "read_file", { path: "a.ts" }, "SAME");
  round(g, "read_file", { path: "a.ts" }, "SAME");
  const before = g.stalledRounds;
  const verdict = closeRound(g, []);
  assert.equal(verdict.stalledRounds, before);
  assert.equal(verdict.escalate, false);
});

test("each turn starts clean: a fresh guard shares nothing with the last one", () => {
  const first = createDoomLoopState();
  for (let i = 0; i < STALLED_ROUNDS_TO_ESCALATE + 1; i++) round(first, "read_file", { path: "a.ts" }, "SAME");
  const second = createDoomLoopState();
  const note = observeCall(second, { name: "read_file", args: { path: "a.ts" }, result: "SAME", ok: true });
  assert.equal(note.repeat, 1);
  assert.equal(note.unproductive, false);
});

// ── Signals added at M3 (docs/agent-runtime-loop.md §12) ────────────────────────────────────────────────

test("cosmetically different arguments are the same call", () => {
  assert.equal(equivalentKey("read_file", { path: "./A.ts" }), equivalentKey("read_file", { path: "a.ts " }));
  assert.equal(equivalentKey("search", { query: "the  handler" }), equivalentKey("search", { query: "The Handler" }));
  // Numbers are left alone: a different line range is a genuinely different read, and normalising it would
  // flag a sequential walk through a file as a loop.
  assert.notEqual(equivalentKey("read_file", { path: "a.ts", offset: 1 }), equivalentKey("read_file", { path: "a.ts", offset: 500 }));
});

test("a reworded repeat is caught, but only when it returns the same thing", () => {
  const g = createDoomLoopState();
  const first = observeCall(g, { name: "read_file", args: { path: "./a.ts" }, result: "A", ok: true });
  assert.equal(first.unproductive, false);
  // Same file, spelled differently, same content: nothing was learned.
  const reworded = observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "A", ok: true });
  assert.equal(reworded.unproductive, true);
  assert.equal(reworded.signal, "equivalent", "byte-identity would have missed this");
});

test("rewording is NOT flagged when the output actually changed", () => {
  const g = createDoomLoopState();
  observeCall(g, { name: "run_command", args: { cmd: "npm test" }, result: "3 failed", ok: true });
  const second = observeCall(g, { name: "run_command", args: { cmd: "npm  test" }, result: "1 failed", ok: true });
  assert.equal(second.unproductive, false, "the suite output changed, so the round made progress");
});

test("byte-identity is reported in preference to the vaguer equivalence", () => {
  const g = createDoomLoopState();
  observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "A", ok: true });
  const again = observeCall(g, { name: "read_file", args: { path: "a.ts" }, result: "A", ok: true });
  assert.equal(again.signal, "identical", "the more specific diagnosis is the actionable one");
});

test("the resource a call touches is recognised across the argument names that name one", () => {
  assert.equal(resourceOf({ path: "./Src/App.ts" }), "src/app.ts");
  assert.equal(resourceOf({ query: "  handler  " }), "handler");
  assert.equal(resourceOf({ url: "https://x.test" }), "https://x.test");
  assert.equal(resourceOf({ limit: 20 }), null, "a call with no named resource has none");
  assert.equal(resourceOf(null), null);
  assert.equal(resourceOf("nope"), null);
});

test("circling one file is caught even though no two reads are alike", () => {
  const g = createDoomLoopState();
  // Different line ranges every time, so neither identity nor equivalence ever fires.
  const verdicts = [];
  for (let i = 0; i < RESOURCE_NOTE_AT; i++) {
    verdicts.push(observeCall(g, { name: "read_file", args: { path: "a.ts", offset: i * 100 }, result: `chunk${i}`, ok: true }));
  }
  assert.equal(verdicts[0].unproductive, false, "reading three parts of a big file is ordinary work");
  assert.equal(verdicts[RESOURCE_NOTE_AT - 2].unproductive, false);
  const last = verdicts[RESOURCE_NOTE_AT - 1];
  assert.equal(last.unproductive, true);
  assert.equal(last.signal, "resource");
  assert.equal(last.resourceHits, RESOURCE_NOTE_AT);
});

test("reading different files is never a resource loop", () => {
  const g = createDoomLoopState();
  for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
    const v = observeCall(g, { name: "read_file", args: { path }, result: path.toUpperCase(), ok: true });
    assert.equal(v.unproductive, false, path);
  }
});

test("the same resource under different tools is counted separately", () => {
  const g = createDoomLoopState();
  for (let i = 0; i < RESOURCE_NOTE_AT; i++) {
    observeCall(g, { name: "read_file", args: { path: "a.ts", offset: i }, result: `r${i}`, ok: true });
  }
  // file_info on the same path is a different question about it, not a repeat of the read.
  const info = observeCall(g, { name: "file_info", args: { path: "a.ts" }, result: "size 12", ok: true });
  assert.equal(info.unproductive, false);
});
