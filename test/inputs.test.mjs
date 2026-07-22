/**
 * Workflow input tests.
 *
 * The bug these exist to prevent: run variables used to live only in memory, so a run that suspended
 * for approval and resumed after a restart silently fell back to the definition's defaults —
 * executing against different inputs than the ones the user actually approved.
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
const echoVar = isWindows ? "echo %INPUT_V%" : 'printf "%s" "$INPUT_V"';

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-inputs-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

const withVar = (id, variable, nodeExtra = {}) => ({
  id,
  name: id,
  triggers: [{ id: "t1", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  variables: [variable],
  nodes: [
    {
      id: "show",
      runtime: "shell",
      config: { command: echoVar },
      inputs: [{ as: "v", ref: `var://${variable.key}` }],
      ...nodeExtra,
    },
  ],
  edges: [],
});

/* ---------------------------------------------------------------------- schema */

test("a required variable cannot also have a default", () => {
  // The default would always satisfy it, so the user is never asked and "required" is a guarantee
  // that is not actually there.
  const def = withVar("wf-bad", { key: "resume", type: "file", required: true, default: "/tmp/x" });
  def.version = 1;
  const res = validateDefinition(def);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.includes("required")), JSON.stringify(res.errors));
});

test("file is a valid variable type", () => {
  const def = withVar("wf-file", { key: "resume", type: "file", required: true, label: "Your résumé" });
  def.version = 1;
  assert.ok(validateDefinition(def).ok, JSON.stringify(validateDefinition(def).errors));
});

/* ------------------------------------------------------------------- execution */

test("a run is refused when a required input is missing", async () => {
  const root = freshRoot();
  saveWorkflow(withVar("wf-req", { key: "resume", type: "file", required: true, label: "Your résumé" }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-req" });

  assert.ok(!res.ok);
  assert.match(res.error, /missing required input/);
  assert.deepEqual(res.missing, ["Your résumé"]);
  // Refused before the run exists: a half-executed run has already spent money.
  assert.equal(repo.listRuns({ workflowId: "wf-req" }).length, 0);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("supplied variables reach the node", async () => {
  const root = freshRoot();
  saveWorkflow(withVar("wf-supply", { key: "v", type: "string", required: true }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-supply", variables: { v: "hello-input" } });

  assert.ok(res.ok, res.error);
  assert.match(res.outputs.show.stdout, /hello-input/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("run variables survive a restart and an approval resume", async () => {
  const root = freshRoot();
  // Gated node: the run suspends, the app restarts, then the user approves days later.
  saveWorkflow(
    withVar("wf-persist", { key: "v", type: "string", required: true }, { requiresApproval: true }),
  );

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-persist", variables: { v: "supplied-value" } });
  assert.equal(res.suspended, true);
  const [approval] = repo.pendingApprovals();
  await mgr.shutdown();

  // Drop every in-memory handle: nothing about this run survives except what is in SQLite.
  closeDb();
  openDb();
  const mgr2 = createExecutionManager();
  await mgr2.decideApproval({ approvalId: approval.id, approved: true });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  // The load-bearing assertion: the resumed run used the supplied input, not a default or "".
  assert.match(repo.nodeOutputs(res.runId).show.stdout, /supplied-value/);

  await mgr2.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the approval preview shows the value that will actually be used", async () => {
  const root = freshRoot();
  saveWorkflow(
    withVar("wf-preview-var", { key: "v", type: "string", required: true }, { requiresApproval: true }),
  );

  const mgr = createExecutionManager();
  await mgr.run({ workflowId: "wf-preview-var", variables: { v: "approve-this" } });

  const [approval] = repo.pendingApprovals();
  assert.equal(approval.preview.inputs.v, "approve-this");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("input values are not written into the event log", async () => {
  const root = freshRoot();
  saveWorkflow(withVar("wf-privacy", { key: "v", type: "string", required: true }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-privacy", variables: { v: "C:/private/resume.pdf" } });

  // run:created records variable NAMES only. Values can be a document path or a private threshold,
  // and the Timeline shows event payloads verbatim.
  const created = repo.readEvents(res.runId).find((e) => e.type === "run:created");
  assert.deepEqual(created.payload.variableKeys, ["v"]);
  assert.ok(!JSON.stringify(created.payload).includes("private"));

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a definition default is used when no value is supplied", async () => {
  const root = freshRoot();
  saveWorkflow(withVar("wf-default", { key: "v", type: "string", default: "from-default" }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-default" });

  assert.ok(res.ok, res.error);
  assert.match(res.outputs.show.stdout, /from-default/);

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
