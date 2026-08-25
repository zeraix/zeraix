/**
 * Tool runtime — what a turn owes as its tools run (docs/agent-runtime-loop.md §8, §9) — milestone M5b.
 *
 * Two of these rules are safety checks and one is a deadlock guard, so the tests are mostly about the ways
 * each could fail quietly:
 *
 *  - the review obligation must SURVIVE until a reviewer actually runs. Losing it means a change under
 *    `auth/` ships unreviewed and nothing anywhere says so;
 *  - it must also be CLEARABLE by either delegation route, or a model that did review is nagged anyway and
 *    learns to ignore the reminder;
 *  - every reminder must fire at most once per turn. The original code says why in as many words — "if the
 *    model still insists, let it through, to avoid a deadlock" — because a guard that re-fires turns "try to
 *    conclude, get told to review, decline" into a loop with no exit;
 *  - `unansweredCalls` must be exact. An `assistant.tool_calls` entry with no matching result makes the
 *    provider reject the whole conversation on the next request, so a conversation left that way cannot be
 *    reopened at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const {
  noObligations,
  recordTool,
  dueReminders,
  unansweredCalls,
  pathArguments,
  dispatchesReviewer,
  canRunConcurrently,
} = await import("../src/lib/agent/toolRuntime.ts");

const RULES = {
  mutatingTools: new Set(["write_file", "edit_file", "delete_file"]),
  riskyPath: /(auth|payment|secret|\.env)/i,
  delegationTools: new Set(["run_subagent", "spawn_subagents"]),
};
const call = (name, args = {}) => ({ name, args });

// ── Obligations ─────────────────────────────────────────────────────────────────────────────────────────

test("a fresh turn owes nothing", () => {
  const o = noObligations();
  assert.equal(o.riskyChangePending, false);
  assert.equal(o.learnedWithoutRecording, false);
  assert.deepEqual(dueReminders(o).due, []);
});

test("editing a risky path owes a review; editing an ordinary one does not", () => {
  const risky = recordTool(noObligations(), call("edit_file", { path: "src/auth/login.ts" }), RULES);
  assert.equal(risky.riskyChangePending, true);
  const ordinary = recordTool(noObligations(), call("edit_file", { path: "src/ui/button.tsx" }), RULES);
  assert.equal(ordinary.riskyChangePending, false);
});

test("any source edit owes a memory note, risky or not", () => {
  const o = recordTool(noObligations(), call("write_file", { path: "src/ui/button.tsx" }), RULES);
  assert.equal(o.learnedWithoutRecording, true);
});

test("a read never owes anything", () => {
  const o = recordTool(noObligations(), call("read_file", { path: "src/auth/login.ts" }), RULES);
  assert.deepEqual(o, noObligations(), "reading a secret is not changing one");
});

test("the review obligation survives later unrelated tools", () => {
  let o = recordTool(noObligations(), call("edit_file", { path: ".env" }), RULES);
  o = recordTool(o, call("read_file", { path: "a.ts" }), RULES);
  o = recordTool(o, call("run_command", { cmd: "ls" }), RULES);
  assert.equal(o.riskyChangePending, true, "an unreviewed risky change must not be forgotten");
});

test("a reviewer clears it, by either delegation route", () => {
  const edited = recordTool(noObligations(), call("edit_file", { path: "src/payment/charge.ts" }), RULES);
  assert.equal(recordTool(edited, call("run_subagent", { agent: "reviewer" }), RULES).riskyChangePending, false);
  const spawned = recordTool(
    edited,
    call("spawn_subagents", { tasks: [{ agent: "explore" }, { agent: "reviewer" }] }),
    RULES,
  );
  assert.equal(spawned.riskyChangePending, false, "a review alongside other delegations is still a review");
});

test("a non-reviewer delegation does not clear it", () => {
  const edited = recordTool(noObligations(), call("edit_file", { path: "src/auth/x.ts" }), RULES);
  assert.equal(recordTool(edited, call("run_subagent", { agent: "coder" }), RULES).riskyChangePending, true);
  assert.equal(
    recordTool(edited, call("spawn_subagents", { tasks: [{ agent: "explore" }] }), RULES).riskyChangePending,
    true,
  );
});

test("editing and reviewing in one round counts as reviewed", () => {
  let o = recordTool(noObligations(), call("edit_file", { path: "src/auth/x.ts" }), RULES);
  o = recordTool(o, call("run_subagent", { agent: "reviewer" }), RULES);
  assert.equal(o.riskyChangePending, false);
});

test("a risky edit AFTER a review re-arms the obligation", () => {
  let o = recordTool(noObligations(), call("run_subagent", { agent: "reviewer" }), RULES);
  o = recordTool(o, call("edit_file", { path: "src/auth/x.ts" }), RULES);
  assert.equal(o.riskyChangePending, true, "the review happened before the change it would have covered");
});

test("recording to project memory satisfies the memory guard once, for the whole turn", () => {
  let o = recordTool(noObligations(), call("edit_file", { path: "a.ts" }), RULES);
  o = recordTool(o, call("remember_project", { note: "x" }), RULES);
  assert.equal(o.learnedWithoutRecording, false);
  assert.deepEqual(dueReminders(o).due, [], "one note covers the turn, not one note per file");
});

test("path-like arguments are found under the many names tools give them", () => {
  assert.deepEqual(pathArguments({ path: "a" }), ["a"]);
  assert.deepEqual(pathArguments({ destination: "b" }), ["b"]);
  assert.deepEqual(pathArguments({ source: "c", target: "d" }).sort(), ["c", "d"]);
  assert.deepEqual(pathArguments({ limit: 5, count: 2 }), [], "a number is never a path");
  assert.deepEqual(pathArguments({}), []);
});

test("reviewer detection reads only the delegation tools", () => {
  assert.equal(dispatchesReviewer("run_subagent", { agent: "reviewer" }), true);
  assert.equal(dispatchesReviewer("read_file", { agent: "reviewer" }), false);
  assert.equal(dispatchesReviewer("spawn_subagents", {}), false, "no tasks is not a review");
  assert.equal(dispatchesReviewer("spawn_subagents", { tasks: "nonsense" }), false);
});

// ── The once-per-turn latches ───────────────────────────────────────────────────────────────────────────

test("each reminder is delivered at most once per turn", () => {
  let o = recordTool(noObligations(), call("edit_file", { path: "src/auth/x.ts" }), RULES);
  const first = dueReminders(o);
  assert.deepEqual(first.due.sort(), ["memory", "review"]);
  o = first.next;
  // The model read both and did neither. Re-delivering is what turns a guard into a deadlock.
  assert.deepEqual(dueReminders(o).due, []);
});

test("both reminders can be due at once, and neither suppresses the other", () => {
  const o = recordTool(noObligations(), call("edit_file", { path: ".env" }), RULES);
  const { due } = dueReminders(o);
  assert.equal(due.length, 2);
});

test("a memory note after the reminder does not re-arm anything", () => {
  let o = recordTool(noObligations(), call("edit_file", { path: "a.ts" }), RULES);
  o = dueReminders(o).next;
  o = recordTool(o, call("remember_project", { note: "x" }), RULES);
  o = recordTool(o, call("edit_file", { path: "b.ts" }), RULES);
  assert.deepEqual(dueReminders(o).due, [], "the model was already asked once this turn");
});

// ── Unanswered calls ────────────────────────────────────────────────────────────────────────────────────

const tc = (id) => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } });

test("a call with no result is identified exactly", () => {
  const calls = [tc("a"), tc("b"), tc("c")];
  assert.deepEqual(
    unansweredCalls(calls, [{ toolCallId: "a" }, { toolCallId: "c" }]).map((c) => c.id),
    ["b"],
  );
});

test("results arriving out of order still count as answers", () => {
  const calls = [tc("a"), tc("b")];
  assert.deepEqual(unansweredCalls(calls, [{ toolCallId: "b" }, { toolCallId: "a" }]), []);
});

test("a result for a call that was never made answers nothing", () => {
  assert.deepEqual(unansweredCalls([tc("a")], [{ toolCallId: "zzz" }]).map((c) => c.id), ["a"]);
});

test("a cancelled round with no results at all reports every call", () => {
  assert.equal(unansweredCalls([tc("a"), tc("b")], []).length, 2);
});

// ── Parallelism (§8) ────────────────────────────────────────────────────────────────────────────────────

const SAFE = new Set(["read_file", "search_files", "list_directory"]);

test("independent read-only calls may run concurrently", () => {
  assert.equal(canRunConcurrently(["read_file", "search_files"], SAFE), true);
});

test("a single call is never 'concurrent'", () => {
  assert.equal(canRunConcurrently(["read_file"], SAFE), false);
  assert.equal(canRunConcurrently([], SAFE), false);
});

test("one mutating call in the group makes the whole group sequential", () => {
  assert.equal(canRunConcurrently(["read_file", "edit_file"], SAFE), false);
  assert.equal(canRunConcurrently(["edit_file", "write_file"], SAFE), false);
});
