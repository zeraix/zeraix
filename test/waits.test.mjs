/**
 * Wait-for-event tests.
 *
 * The scenario: a run sends something outward, then waits for the other side to respond — possibly
 * days later, with the app closed for most of it. Same shape as an approval (durable row, suspended
 * run, deadline read from the clock); the difference is that an inbound event resolves it rather
 * than a human decision.
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
import * as repo from "../electron/automation/repo.mjs";

const isWindows = process.platform === "win32";
const echoEvent = isWindows ? "echo %INPUT_EVENT%" : 'printf "%s" "$INPUT_EVENT"';

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-waits-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

const waiting = (id, waitFor, nodeExtra = {}) => ({
  id,
  name: id,
  triggers: [{ id: "t1", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  nodes: [{ id: "reply", runtime: "shell", config: { command: echoEvent }, inputs: [], waitFor, ...nodeExtra }],
  edges: [],
});

/* ---------------------------------------------------------------------- schema */

test("an unbounded wait is rejected", () => {
  // A wait with no deadline holds a run open forever: "did the employer reply?" would silently never
  // finish and nothing would ever say why.
  const def = waiting("wf-nodeadline", { key: "reply" });
  def.version = 1;
  const res = validateDefinition(def);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.includes("timeoutMs")), JSON.stringify(res.errors));
});

/* ------------------------------------------------------------------- execution */

test("a waiting node suspends the run until an event arrives", async () => {
  const root = freshRoot();
  saveWorkflow(waiting("wf-wait", { key: "reply:acme", timeoutMs: 60_000 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-wait" });

  assert.equal(res.suspended, true);
  assert.equal(repo.getRun(res.runId).state, "AWAITING_EVENT");
  // The node must NOT have run yet.
  assert.equal(repo.listAttempts(res.runId).length, 0);

  const waits = repo.pendingWaits();
  assert.equal(waits.length, 1);
  assert.equal(waits[0].match_key, "reply:acme");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("delivering the event resumes the run across a restart", async () => {
  const root = freshRoot();
  saveWorkflow(waiting("wf-deliver", { key: "reply:acme", timeoutMs: 60_000 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-deliver" });
  await mgr.shutdown();

  // Days later, a fresh process: nothing about this run survives except what is in SQLite.
  closeDb();
  openDb();
  const mgr2 = createExecutionManager();

  const delivered = await mgr2.deliverEvent("reply:acme", { from: "Acme", body: "interested" });
  assert.equal(delivered.ok, true);
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  // The payload reaches the node as an ordinary input.
  assert.match(repo.nodeOutputs(res.runId).reply.stdout, /interested/);

  await mgr2.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an event nobody is waiting for is reported, not silently dropped", async () => {
  const root = freshRoot();
  saveWorkflow(waiting("wf-nomatch", { key: "reply:acme", timeoutMs: 60_000 }));

  const mgr = createExecutionManager();
  const res = await mgr.deliverEvent("reply:someone-else", {});
  assert.equal(res.ok, false);
  assert.match(res.error, /nothing is waiting/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a deadline that elapsed while the app was closed fails the run", async () => {
  const root = freshRoot();
  saveWorkflow(waiting("wf-expire", { key: "reply:acme", timeoutMs: 1 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-expire" });
  assert.equal(repo.pendingWaits().length, 1);
  await mgr.shutdown();

  closeDb();
  openDb();
  const mgr2 = createExecutionManager();
  mgr2.recoverInterrupted(); // what runs at startup

  await waitFor(() => repo.getRun(res.runId).state === "FAILED", 8000);
  assert.equal(repo.getRun(res.runId).state, "FAILED");
  assert.equal(repo.pendingWaits().length, 0);

  await mgr2.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("per-item waits: each candidate waits on its own key", async () => {
  const root = freshRoot();
  // The real shape: one outstanding wait per company, not one for the whole batch.
  const def = waiting(
    "wf-per-item",
    { key: "reply:{{item}}", timeoutMs: 60_000, onTimeout: "continue" },
    { forEach: "var://list", maxItems: 5, onItemError: "continue" },
  );
  def.variables = [{ key: "list", type: "json", default: '["acme","globex"]' }];
  saveWorkflow(def);

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-per-item" });

  assert.equal(res.suspended, true);
  let waits = repo.pendingWaits();
  assert.equal(waits.length, 1);
  assert.equal(waits[0].match_key, "reply:acme", "the key is interpolated per item");

  await mgr.deliverEvent("reply:acme", { body: "yes" });
  await waitFor(() => repo.pendingWaits().some((w) => w.match_key === "reply:globex"), 8000);

  waits = repo.pendingWaits();
  assert.equal(waits[0].match_key, "reply:globex");
  await mgr.deliverEvent("reply:globex", { body: "no" });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a silent candidate is dropped, the rest of the batch continues", async () => {
  const root = freshRoot();
  // "No reply within N days -> drop this company" — the user's stated requirement.
  const def = waiting(
    "wf-drop",
    { key: "reply:{{item}}", timeoutMs: 1, onTimeout: "continue" },
    { forEach: "var://list", maxItems: 5, onItemError: "continue" },
  );
  def.variables = [{ key: "list", type: "json", default: '["silent","chatty"]' }];
  saveWorkflow(def);

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-drop" });
  assert.equal(res.suspended, true);

  // The first candidate never replies and its deadline lapses.
  mgr.expireOverdueWaits();
  await waitFor(() => repo.pendingWaits().some((w) => w.match_key === "reply:chatty"), 8000);

  await mgr.deliverEvent("reply:chatty", { body: "let us talk" });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  // Dropping one silent company is not a failure of the whole search.
  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  const ran = repo.listAttempts(res.runId).map((a) => a.node_id);
  assert.ok(!ran.includes("reply#0"), "the silent candidate is skipped");
  assert.ok(ran.includes("reply#1"), "the responsive candidate is processed");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a resumed run does not open a second wait", async () => {
  const root = freshRoot();
  saveWorkflow(waiting("wf-once", { key: "reply:acme", timeoutMs: 60_000 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-once" });
  await mgr.executeRun(res.runId);
  await mgr.executeRun(res.runId);

  assert.equal(repo.pendingWaits().length, 1, "re-entering the gate must reuse the existing wait");

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
