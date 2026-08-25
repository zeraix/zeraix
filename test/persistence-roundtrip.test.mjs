/**
 * Persistence round-trip (docs/agent-runtime-loop.md §16, §18 Test 7) — milestone M6.
 *
 * Test 7 asks that a conversation saved mid-task — with an active goal, task memory and pending todos —
 * reload and resume with its state intact. M0 found it could not pass: todos were never persisted at all.
 * They lived in a ref and were archived as a *display bubble* when a turn ended, so reopening a conversation
 * mid-task showed the transcript of a checklist and no checklist. The model's plan survived in Goal State
 * while the user's view of it did not.
 *
 * §16's real requirement is the one these tests spend most of their effort on: **a conversation saved before
 * the change must open correctly after it.** A field that did not exist yesterday has to read as the
 * behaviour those records already had, not throw and not silently reset the conversation's progress. So every
 * reader here is fed a record from an older build, a partial record, and a corrupt one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { normalizeTodos } = await import("../src/lib/ai/conversation.ts");
const { normalizeTaskMemory } = await import("../src/app/agent/chat/taskMemory.ts");
const { restoreGoal, emptyGoal, isGoalActive, toStoredGoal, startGoal } = await import(
  "../src/app/agent/chat/goalState.ts"
);

// ── Backward compatibility: records written before this field existed ───────────────────────────────────

test("a conversation written before todos were persisted opens as an empty list", () => {
  // The shape an older record has: the key is simply absent.
  const legacy = { id: "c1", title: "old", messages: [] };
  assert.deepEqual(normalizeTodos(legacy.todos), [], "absent must mean empty, never throw");
});

test("a corrupt or hostile todos field degrades to empty rather than throwing", () => {
  for (const bad of [null, undefined, "not an array", 42, {}, true]) {
    assert.deepEqual(normalizeTodos(bad), [], String(bad));
  }
});

test("partial items are repaired, not dropped or trusted", () => {
  const restored = normalizeTodos([
    { title: "keep me" },
    { title: "  spaced  ", status: "in_progress" },
    { title: "done", status: "completed" },
    { title: "weird", status: "banana" },
    { title: "", status: "pending" },
    null,
    "nonsense",
  ]);
  assert.deepEqual(restored, [
    { title: "keep me", status: "pending" },
    { title: "spaced", status: "in_progress" },
    { title: "done", status: "completed" },
    // An unknown status becomes pending: losing the item silently would be worse than showing it undone.
    { title: "weird", status: "pending" },
  ]);
});

// ── §18 Test 7: the round trip ──────────────────────────────────────────────────────────────────────────

test("Test 7: a conversation saved mid-task reloads with goal, task memory and todos intact", () => {
  // What the app holds mid-task.
  const todos = [
    { title: "read the config", status: "completed" },
    { title: "patch the handler", status: "in_progress" },
    { title: "run the suite", status: "pending" },
  ];
  const taskMemory = { notes: "Fixing the retry path in the uploader.", source: "model" };
  const goal = startGoal("the upload retries on a 503", { now: 1000, source: "user" });

  // What reaches disk.
  const record = {
    id: "c1",
    projectId: "p1",
    messages: [{ role: "user", content: "fix the uploader" }],
    todos,
    taskMemory,
    goal: toStoredGoal(goal),
  };
  const onDisk = JSON.parse(JSON.stringify(record));

  // What comes back.
  const restoredTodos = normalizeTodos(onDisk.todos);
  const restoredMemory = normalizeTaskMemory(onDisk.taskMemory);
  const restoredGoal = restoreGoal(onDisk.goal);

  assert.deepEqual(restoredTodos, todos, "the checklist survives verbatim, including per-item status");
  assert.equal(restoredMemory.notes, taskMemory.notes);
  assert.equal(restoredMemory.source, "model", "a model-authored brief must not be downgraded on reload");
  assert.equal(restoredGoal.condition, "the upload retries on a 503");
  assert.ok(isGoalActive(restoredGoal), "an active goal comes back active, or the task silently finishes");
});

test("Test 7b: a reloaded goal comes back active but idle, so nothing resumes spending unasked", () => {
  let goal = startGoal("ship it", { now: 1000, source: "user" });
  // Simulate a run that had already cost something.
  goal = { ...goal, run: { ...goal.run, turnCount: 18, tokenSpend: 240_000 } };
  const restored = restoreGoal(JSON.parse(JSON.stringify(toStoredGoal(goal))));
  assert.ok(isGoalActive(restored));
  assert.equal(restored.run.turnCount, 0, "counters describe an activation that is no longer happening");
  assert.equal(restored.run.tokenSpend, 0);
});

test("an empty checklist is not written back as an empty array", () => {
  // The store writes `undefined` rather than `[]` when the list empties, so a conversation that never had
  // todos and one whose todos were completed and cleared round-trip identically.
  assert.deepEqual(normalizeTodos(undefined), []);
  assert.deepEqual(normalizeTodos([]), []);
});

test("the checklist survives a JSON round trip with no reference sharing", () => {
  const todos = [{ title: "a", status: "pending" }];
  const restored = normalizeTodos(JSON.parse(JSON.stringify(todos)));
  restored[0].title = "mutated";
  assert.equal(todos[0].title, "a", "the restored list is a fresh object, not a view onto the record");
});
