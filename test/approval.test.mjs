/**
 * Approval gate tests.
 *
 * The property that matters: an approval is a SUSPEND, not an await. The app may be closed for days
 * between a run asking and the user deciding, so every test here goes through storage — several
 * deliberately drop the database handle and reopen it to prove the decision survives a restart.
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
const echo = (text) => (isWindows ? `echo ${text}` : `printf '%s' ${JSON.stringify(text)}`);

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-approval-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

/** send-after-review: the shape of the user's job-application case. */
const gatedWorkflow = (id, extra = {}) => ({
  id,
  name: "Gated",
  triggers: [{ id: "t1", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  nodes: [
    { id: "prepare", runtime: "shell", config: { command: echo("draft message") }, inputs: [] },
    {
      id: "send",
      runtime: "shell",
      config: { command: echo("SENT") },
      inputs: [{ as: "draft", ref: "run://prepare/stdout" }],
      requiresApproval: true,
      ...extra,
    },
  ],
  edges: [{ from: "prepare", to: "send" }],
});

test("a gated node suspends the run instead of executing", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-gate"));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-gate" });

  assert.equal(res.suspended, true);
  assert.equal(repo.getRun(res.runId).state, "AWAITING_APPROVAL");

  // The gated node must NOT have run.
  assert.deepEqual(repo.listAttempts(res.runId).map((a) => a.node_id), ["prepare"]);

  const pending = repo.pendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].node_id, "send");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the approval preview shows the concrete action being authorised", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-preview"));

  const mgr = createExecutionManager();
  await mgr.run({ workflowId: "wf-preview" });

  const [approval] = repo.pendingApprovals();
  // Authorising "node send" would be meaningless; the user has to see what actually goes out.
  assert.match(String(approval.preview.config.command), /SENT/);
  assert.match(String(approval.preview.inputs.draft), /draft message/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("secrets in node config are redacted from the preview", async () => {
  const root = freshRoot();
  const def = gatedWorkflow("wf-redact");
  def.nodes[1].config = { command: echo("x"), apiKey: "sk-super-secret", token: "t0ken" };
  saveWorkflow(def);

  const mgr = createExecutionManager();
  await mgr.run({ workflowId: "wf-redact" });

  const [approval] = repo.pendingApprovals();
  const shown = JSON.stringify(approval.preview);
  assert.ok(!shown.includes("sk-super-secret"), "an API key must never reach the approval preview");
  assert.ok(!shown.includes("t0ken"));
  assert.match(shown, /\[redacted\]/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("approving resumes the run across an app restart", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-resume-approve"));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-resume-approve" });
  const [approval] = repo.pendingApprovals();
  await mgr.shutdown();

  // Simulate quitting and relaunching the app before the user decides.
  closeDb();
  openDb();
  const mgr2 = createExecutionManager();

  await mgr2.decideApproval({ approvalId: approval.id, approved: true });
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  // The gated node ran exactly once, and only after approval.
  const sends = repo.listAttempts(res.runId).filter((a) => a.node_id === "send");
  assert.equal(sends.length, 1);
  assert.match(repo.nodeOutputs(res.runId).send.stdout, /SENT/);
  // The earlier node is not re-executed on resume.
  assert.equal(repo.listAttempts(res.runId).filter((a) => a.node_id === "prepare").length, 1);

  await mgr2.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejecting stops the run and never executes the node", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-reject"));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-reject" });
  const [approval] = repo.pendingApprovals();

  await mgr.decideApproval({ approvalId: approval.id, approved: false, note: "wrong company" });
  await waitFor(() => repo.getRun(res.runId).state === "CANCELLED", 8000);

  assert.equal(repo.getRun(res.runId).state, "CANCELLED");
  assert.match(repo.getRun(res.runId).error, /wrong company/);
  assert.equal(repo.listAttempts(res.runId).filter((a) => a.node_id === "send").length, 0);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a decision cannot be made twice", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-double"));

  const mgr = createExecutionManager();
  await mgr.run({ workflowId: "wf-double" });
  const [approval] = repo.pendingApprovals();

  assert.equal((await mgr.decideApproval({ approvalId: approval.id, approved: true })).ok, true);
  const second = await mgr.decideApproval({ approvalId: approval.id, approved: false });
  assert.equal(second.ok, false, "a second decision must be refused, not silently applied");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a deadline that elapsed while the app was closed is honoured at next start", async () => {
  const root = freshRoot();
  // 1ms deadline: by the time we sweep, it is long past — the same situation as a 48h deadline
  // that expires overnight with the app shut down.
  saveWorkflow(gatedWorkflow("wf-expire", { approvalTimeoutMs: 1 }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-expire" });
  assert.equal(repo.pendingApprovals().length, 1);
  await mgr.shutdown();

  closeDb();
  openDb();
  const mgr2 = createExecutionManager();
  // recoverInterrupted() is what runs at startup; it must sweep deadlines too.
  mgr2.recoverInterrupted();

  assert.equal(repo.pendingApprovals().length, 0);
  assert.equal(repo.getApproval(res.runId, "send").state, "EXPIRED");
  assert.equal(repo.getRun(res.runId).state, "CANCELLED");
  assert.match(repo.getRun(res.runId).error, /timed out/);

  await mgr2.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("onApprovalTimeout 'approve' lets the run proceed when the deadline passes", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-auto", { approvalTimeoutMs: 1, onApprovalTimeout: "approve" }));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-auto" });
  mgr.expireOverdueApprovals();
  await waitFor(() => repo.getRun(res.runId).state === "SUCCEEDED", 8000);

  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");
  assert.equal(repo.getApproval(res.runId, "send").decided_by, "timeout");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a resumed run does not re-request approval or re-notify", async () => {
  const root = freshRoot();
  saveWorkflow(gatedWorkflow("wf-once"));

  let notifications = 0;
  const mgr = createExecutionManager({ notifyApproval: () => notifications++ });
  const res = await mgr.run({ workflowId: "wf-once" });

  // Re-entering executeRun (as a crash recovery or a stray resume would) must find the existing
  // request rather than creating a second one and nagging the user again.
  await mgr.executeRun(res.runId);
  await mgr.executeRun(res.runId);

  assert.equal(repo.pendingApprovals().length, 1);
  assert.equal(notifications, 1, "the user must be notified once, not once per resume attempt");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("schema rejects auto-approve without an explicit deadline", () => {
  // Auto-approving an outward-facing action on an unspecified timer defeats the gate entirely.
  const def = gatedWorkflow("wf-bad");
  def.version = 1;
  def.nodes[1].onApprovalTimeout = "approve";
  const res = validateDefinition(def);
  assert.ok(!res.ok);
  assert.ok(res.errors.some((e) => e.includes("approvalTimeoutMs")), JSON.stringify(res.errors));
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
