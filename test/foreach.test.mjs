/**
 * Fan-out (forEach) tests.
 *
 * Shape taken from the real use case: an upstream step produces a list of candidates, and a later
 * step is executed once per candidate — each individually checkpointed, retried and approved.
 * A single blanket approval for a whole list is not consent, so per-item gating is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setAutomationRoot } from "../electron/automation/storage.mjs";
import { openDb, closeDb } from "../electron/automation/db.mjs";
import { saveWorkflow } from "../electron/automation/definitions.mjs";
import { createExecutionManager } from "../electron/automation/executionManager.mjs";
import { validateDefinition } from "../electron/automation/schema.mjs";
import { resolveList } from "../electron/automation/dataBus.mjs";
import * as repo from "../electron/automation/repo.mjs";

const isWindows = process.platform === "win32";
const echoItem = isWindows ? "echo %INPUT_ITEM%" : 'printf "%s" "$INPUT_ITEM"';

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-foreach-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

/** list -> a node run once per entry. */
const fanOut = (id, nodeExtra = {}, listJson = '["alpha","beta","gamma"]') => ({
  id,
  name: id,
  triggers: [{ id: "t1", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  variables: [{ key: "list", type: "json", default: listJson }],
  nodes: [
    {
      id: "each",
      runtime: "shell",
      config: { command: echoItem },
      inputs: [],
      forEach: "var://list",
      maxItems: 10,
      ...nodeExtra,
    },
  ],
  edges: [],
});

/* ------------------------------------------------------------------ resolveList */

test("resolveList", async (t) => {
  await t.test("accepts a real array", () => {
    const r = resolveList("var://l", { variables: { l: [1, 2] } });
    assert.deepEqual(r.items, [1, 2]);
  });

  await t.test("accepts a JSON array in a string", () => {
    // An agent node returns its answer as `text`, so "produce a JSON list" is the natural way to
    // feed a fan-out; requiring a separate parse step would be a papercut on the main use case.
    const r = resolveList("run://a/text", { outputs: { a: { text: '["x","y"]' } } });
    assert.deepEqual(r.items, ["x", "y"]);
  });

  await t.test("rejects a non-list", () => {
    assert.equal(resolveList("var://l", { variables: { l: 5 } }).ok, false);
  });

  await t.test("accepts a fenced JSON array", () => {
    // Models wrap answers in ```json despite being told not to. Failing the run for that spends the
    // step's tokens and delivers nothing, over a formatting habit.
    const r = resolveList("run://a/text", { outputs: { a: { text: '```json\n["x","y"]\n```' } } });
    assert.deepEqual(r.items, ["x", "y"]);
  });

  await t.test("accepts an array surrounded by prose", () => {
    const text = 'Sure! Here are the targets:\n[{"competitor":"A"}]\nLet me know if you want more.';
    const r = resolveList("run://a/text", { outputs: { a: { text } } });
    assert.deepEqual(r.items, [{ competitor: "A" }]);
  });

  await t.test("does not guess an array out of an enclosing object", () => {
    // Two keys and no obvious answer; running the wrong list silently is worse than reporting it.
    const r = resolveList("run://a/text", { outputs: { a: { text: '{"targets":[1],"notes":[2]}' } } });
    assert.equal(r.ok, false);
  });

  await t.test("rejects a string that is not JSON, quoting what arrived", () => {
    const r = resolveList("var://l", { variables: { l: "not json" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSON/);
    assert.match(r.error, /not json/);
  });

  await t.test("names truncation as truncation, not as bad JSON", () => {
    const r = resolveList("var://l", { variables: { l: '["a","b…[truncated 900 bytes]' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /cut off at the inline size limit/);
  });
});

/* ---------------------------------------------------------------------- schema */

test("schema requires a cap on fan-out", () => {
  // An unbounded fan-out over a model-generated list is how a workflow accidentally makes a
  // thousand paid calls.
  const def = fanOut("wf-cap");
  def.version = 1;
  delete def.nodes[0].maxItems;
  const res = validateDefinition(def);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.includes("maxItems")), JSON.stringify(res.errors));
});

test("schema rejects maxItems without forEach", () => {
  const def = fanOut("wf-stray");
  def.version = 1;
  delete def.nodes[0].forEach;
  assert.ok(!validateDefinition(def).ok);
});

/* -------------------------------------------------------------------- execution */

test("runs the node once per item and collects the outputs", async () => {
  const root = freshRoot();
  saveWorkflow(fanOut("wf-each"));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-each" });

  assert.ok(res.ok, res.error);
  assert.equal(res.outputs.each.count, 3);
  assert.deepEqual(
    res.outputs.each.items.map((v) => v.stdout.trim()),
    ["alpha", "beta", "gamma"],
  );

  // Each item has its own attempt row, so the Timeline shows which one failed.
  const ids = repo.listAttempts(res.runId).map((a) => a.node_id);
  assert.deepEqual(ids, ["each#0", "each#1", "each#2"]);
  // ...and its own checkpoint, which is what a resume restarts from.
  assert.ok(repo.readCheckpoint(res.runId, "each#1"));

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("maxItems caps the fan-out and says so", async () => {
  const root = freshRoot();
  saveWorkflow(fanOut("wf-cap2", { maxItems: 2 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-cap2" });

  assert.ok(res.ok, res.error);
  assert.equal(res.outputs.each.count, 2);
  // Silent truncation would read as "we processed everything".
  const warned = repo
    .readEvents(res.runId)
    .some((e) => e.type === "log" && /capped at maxItems/.test(String(e.payload.message)));
  assert.ok(warned, "the dropped items must be reported");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("onItemError 'continue' skips a bad item and keeps going", async () => {
  const root = freshRoot();
  // The middle item exits non-zero; the others must still be processed.
  const def = fanOut("wf-continue", { onItemError: "continue" }, '["ok1","FAIL","ok2"]');
  def.nodes[0].config.command = isWindows
    ? 'if "%INPUT_ITEM%"=="FAIL" (exit 1) else (echo %INPUT_ITEM%)'
    : '[ "$INPUT_ITEM" = FAIL ] && exit 1; printf "%s" "$INPUT_ITEM"';
  saveWorkflow(def);

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-continue" });

  assert.ok(res.ok, res.error);
  assert.equal(res.outputs.each.count, 2, "the failing item is skipped, the rest complete");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("onItemError 'fail' (default) stops the whole run", async () => {
  const root = freshRoot();
  const def = fanOut("wf-failfast", {}, '["ok1","FAIL","ok2"]');
  def.nodes[0].config.command = isWindows
    ? 'if "%INPUT_ITEM%"=="FAIL" (exit 1) else (echo %INPUT_ITEM%)'
    : '[ "$INPUT_ITEM" = FAIL ] && exit 1; printf "%s" "$INPUT_ITEM"';
  saveWorkflow(def);

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-failfast" });

  assert.ok(!res.ok);
  assert.equal(repo.getRun(res.runId).state, "FAILED");
  // The third item must never have started.
  assert.equal(repo.listAttempts(res.runId).some((a) => a.node_id === "each#2"), false);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("each item is approved separately", async () => {
  const root = freshRoot();
  saveWorkflow(fanOut("wf-approve-each", { requiresApproval: true }, '["c1","c2"]'));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-approve-each" });

  // Suspends on the FIRST item; one blanket approval for the whole list would not be consent.
  assert.equal(res.suspended, true);
  let pending = repo.pendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].node_id, "each#0");
  // The preview shows which item is being authorised.
  assert.equal(pending[0].preview.inputs.item, "c1");

  await mgr.decideApproval({ approvalId: pending[0].id, approved: true });
  await waitFor(() => repo.pendingApprovals().some((a) => a.node_id === "each#1"), 8000);

  pending = repo.pendingApprovals();
  assert.equal(pending[0].node_id, "each#1");
  assert.equal(pending[0].preview.inputs.item, "c2");

  await mgr.decideApproval({ approvalId: pending[0].id, approved: true });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);
  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejecting one item skips only that item when onItemError is 'continue'", async () => {
  const root = freshRoot();
  saveWorkflow(fanOut("wf-reject-one", { requiresApproval: true, onItemError: "continue" }, '["c1","c2"]'));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-reject-one" });

  const first = repo.pendingApprovals()[0];
  await mgr.decideApproval({ approvalId: first.id, approved: false, note: "not a fit" });
  await waitFor(() => repo.pendingApprovals().some((a) => a.node_id === "each#1"), 8000);

  const second = repo.pendingApprovals()[0];
  await mgr.decideApproval({ approvalId: second.id, approved: true });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  // Declining one candidate is a decision about that candidate, not a failure of the run.
  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  assert.equal(repo.listAttempts(res.runId).some((a) => a.node_id === "each#0"), false);
  assert.equal(repo.listAttempts(res.runId).some((a) => a.node_id === "each#1"), true);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a resumed fan-out does not redo completed items", async () => {
  const root = freshRoot();
  const marker = path.join(root, "ran.txt");
  const def = fanOut("wf-resume-each", {}, '["a","b"]');
  def.nodes[0].config.command = `echo x >> ${JSON.stringify(marker)}`;
  saveWorkflow(def);

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-resume-each" });
  assert.ok(res.ok, res.error);
  const linesAfterRun = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.equal(linesAfterRun, 2);

  // Force a re-execution the way a crash recovery would.
  repo.setRunState(res.runId, "RUNNING");
  await mgr.executeRun(res.runId);

  const linesAfterResume = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.equal(linesAfterResume, 2, "already-completed items must not run again");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
