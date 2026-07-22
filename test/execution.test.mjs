/**
 * Execution Manager end-to-end tests -- Phase 1's exit criterion:
 * a manual-trigger workflow runs and is fully reconstructable from SQLite.
 *
 * These run real child processes through the real Shell runtime against a real database. Nothing is
 * mocked except the storage root, because the parts most likely to be wrong (process teardown,
 * checkpoint ordering, crash resume) are exactly the parts a mock would paper over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { setAutomationRoot } from "../electron/automation/storage.mjs";
import { openDb, closeDb } from "../electron/automation/db.mjs";
import { saveWorkflow } from "../electron/automation/definitions.mjs";
import { createExecutionManager } from "../electron/automation/executionManager.mjs";
import { createDispatcher } from "../electron/automation/dispatcher.mjs";
import { setLlmConfigReader } from "../electron/agent/modelResolver.mjs";
import { createEventQueue } from "../electron/automation/runtimes/eventQueue.mjs";
import * as repo from "../electron/automation/repo.mjs";

const isWindows = process.platform === "win32";
/** Portable "print this" command, so these tests are not Unix-only. */
const echo = (text) => (isWindows ? `echo ${text}` : `printf '%s' ${JSON.stringify(text)}`);

/**
 * Portable "block for N seconds".
 *
 * NOT `timeout /t N` on Windows: it refuses to run when stdin is redirected -- which is exactly what
 * spawn() does -- and exits non-zero within milliseconds. A node that fails instantly instead of
 * hanging silently invalidates every test here that needs a long-running child. `ping` has no such
 * restriction (N+1 pings ≈ N seconds, since the first is immediate).
 */
const sleepCmd = (seconds) =>
  isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-exec-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

/** A single-shell-node workflow. */
const oneNode = (id, command) => ({
  id,
  name: id,
  triggers: [{ id: "t1", type: "manual", config: {} }],
  limits: { concurrency: "single" },
  nodes: [{ id: "only", runtime: "shell", config: { command }, inputs: [] }],
  edges: [],
});

test("a runtime that emits after the consumer has gone is released, not parked", async () => {
  // The real sequence this comes from: a budget ceiling aborts a node while the agent loop is still
  // inside a tool call, so the queue closes and the tool's finish event arrives afterwards. Parking
  // the producer there deadlocks the run and the whole test process with it — close() promises it
  // cannot, and that promise has to hold for events pushed after the close as well as before.
  const queue = createEventQueue();
  queue.close();
  await Promise.race([
    queue.push({ type: "log", level: "info", message: "late" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("push after close never resolved")), 1000)),
  ]);
});

test("runs a single-node workflow end to end", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-hello", echo("hello-world")));

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-hello" });

  assert.ok(res.ok, res.error);
  assert.match(res.outputs.only.stdout, /hello-world/);

  const run = repo.getRun(res.runId);
  assert.equal(run.state, "SUCCEEDED");
  assert.equal(run.definition_version, 1, "the run must pin the version it executed");
  assert.ok(run.started_at && run.ended_at);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the run is fully reconstructable from SQLite", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-recon", echo("abc")));

  const mgr = createExecutionManager();
  const { runId } = await mgr.run({ workflowId: "wf-recon" });
  await mgr.shutdown();

  // Drop every in-memory handle and reopen: this is the acceptance test from design doc §2 --
  // the viewer must rebuild from storage alone, holding no state of its own.
  closeDb();
  openDb();

  const events = repo.readEvents(runId);
  const types = events.map((e) => e.type);
  for (const want of ["run:created", "run:started", "node:started", "output", "node:succeeded", "run:succeeded"]) {
    assert.ok(types.includes(want), `missing ${want} in ${JSON.stringify(types)}`);
  }
  assert.deepEqual([...events].sort((a, b) => a.seq - b.seq).map((e) => e.seq), events.map((e) => e.seq));

  const attempts = repo.listAttempts(runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "SUCCEEDED");

  // The checkpoint must exist even for a node with no inputs -- it is what a resume restarts from.
  assert.ok(repo.readCheckpoint(runId, "only"));
  assert.match(repo.nodeOutputs(runId).only.stdout, /abc/);

  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("passes output from one node to the next by reference", async () => {
  const root = freshRoot();
  // The second node reads the first node's stdout through an explicit input binding -- there is no
  // ambient blackboard it could have read instead (design doc §7.1).
  saveWorkflow({
    id: "wf-chain",
    name: "chain",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      { id: "a", runtime: "shell", config: { command: echo("from-a") }, inputs: [] },
      {
        id: "b",
        // Inputs arrive as $INPUT_<NAME>, never spliced into the command string -- an upstream
        // output containing a quote or semicolon would otherwise be shell injection.
        runtime: "shell",
        config: { command: isWindows ? "echo %INPUT_PREV%" : 'printf "%s" "$INPUT_PREV"' },
        inputs: [{ as: "prev", ref: "run://a/stdout" }],
      },
    ],
    edges: [{ from: "a", to: "b" }],
  });

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-chain" });
  assert.ok(res.ok, res.error);

  // The value must actually reach the command, not merely be resolved and checkpointed.
  assert.match(res.outputs.b.stdout, /from-a/, "node b must receive node a's output");

  // b's checkpoint proves the resolved input was durable before b ran.
  const ckpt = repo.readCheckpoint(res.runId, "b");
  assert.match(ckpt.inputs.prev, /from-a/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a failing node fails the run and stops the chain", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-fail",
    name: "fail",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      { id: "boom", runtime: "shell", config: { command: "exit 3" }, inputs: [] },
      { id: "never", runtime: "shell", config: { command: echo("nope") }, inputs: [] },
    ],
    edges: [{ from: "boom", to: "never" }],
  });

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-fail" });

  assert.ok(!res.ok);
  assert.equal(repo.getRun(res.runId).state, "FAILED");
  const ran = repo.listAttempts(res.runId).map((a) => a.node_id);
  assert.deepEqual(ran, ["boom"], "the downstream node must not run");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("retries a failing node the configured number of times", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-retry",
    name: "retry",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      {
        id: "flaky",
        runtime: "shell",
        config: { command: "exit 1" },
        inputs: [],
        retry: { attempts: 3, backoff: "fixed", delayMs: 1 },
      },
    ],
    edges: [],
  });

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-retry" });

  assert.ok(!res.ok);
  const attempts = repo.listAttempts(res.runId);
  assert.equal(attempts.length, 3, "every attempt is recorded separately");
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3]);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("cancellation stops the run and kills the child process", async () => {
  const root = freshRoot();
  // A command that would outlive the test if teardown were merely cooperative.
  saveWorkflow(oneNode("wf-cancel", sleepCmd(30)));

  const mgr = createExecutionManager();
  const created = mgr.createRun({ workflowId: "wf-cancel" });
  const pending = mgr.executeRun(created.runId);

  // Wait until the child has actually spawned before cancelling.
  await waitFor(() => repo.listRecordedProcesses().length > 0, 5000);
  const pid = repo.listRecordedProcesses()[0].pid;

  assert.equal(mgr.cancelRun(created.runId), true);
  const res = await pending;

  assert.ok(!res.ok);
  assert.equal(repo.getRun(created.runId).state, "CANCELLED");
  await waitFor(() => !isAlive(pid), 5000);
  assert.equal(isAlive(pid), false, "the child process must actually be dead, not just abandoned");
  assert.equal(repo.listRecordedProcesses().length, 0, "the pid record must be cleared");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("cancellation kills grandchildren, not just the shell", { skip: isWindows ? "POSIX process groups" : false }, async () => {
  const root = freshRoot();
  // A COMPOUND command: the shell does not exec-replace itself, so `sleep` is a real grandchild.
  // Killing only the shell pid would reparent it to init and leak it -- which is what happened
  // before the runtime switched to detached process groups.
  saveWorkflow(oneNode("wf-tree", "sleep 30 && echo done"));

  const mgr = createExecutionManager();
  const created = mgr.createRun({ workflowId: "wf-tree" });
  const pending = mgr.executeRun(created.runId);

  await waitFor(() => repo.listRecordedProcesses().length > 0, 5000);
  const shellPid = repo.listRecordedProcesses()[0].pid;
  // Find the sleep that belongs to this shell.
  await waitFor(() => descendantSleeps(shellPid).length > 0, 5000);
  const sleepPid = descendantSleeps(shellPid)[0];

  const cancelledAt = Date.now();
  mgr.cancelRun(created.runId);

  // Assert BEFORE awaiting the run. Awaiting first would mask the bug: an orphaned grandchild holds
  // the stdout pipe open, so 'close' does not fire until it exits on its own 30s later -- by which
  // point "is it dead?" is trivially true and the test proves nothing.
  await waitFor(() => !isAlive(sleepPid), 8000);
  assert.equal(isAlive(sleepPid), false, "the grandchild process must be killed, not orphaned");

  const res = await pending;
  assert.ok(!res.ok);
  // Teardown must be prompt, not "eventually, once the child finishes anyway".
  assert.ok(Date.now() - cancelledAt < 15000, "cancellation must not wait out the child's natural life");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a node timeout is recorded as TIMED_OUT, not FAILED", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-timeout",
    name: "timeout",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      {
        id: "slow",
        runtime: "shell",
        config: { command: sleepCmd(30) },
        inputs: [],
        timeoutMs: 300,
      },
    ],
    edges: [],
  });

  const mgr = createExecutionManager();
  const res = await mgr.run({ workflowId: "wf-timeout" });

  assert.ok(!res.ok);
  assert.equal(repo.getRun(res.runId).state, "TIMED_OUT");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("concurrency 'single' refuses a second overlapping run", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-solo", sleepCmd(5)));

  const mgr = createExecutionManager();
  const first = mgr.createRun({ workflowId: "wf-solo" });
  const pending = mgr.executeRun(first.runId);

  const second = mgr.createRun({ workflowId: "wf-solo" });
  assert.ok(!second.ok);
  assert.match(second.error, /already active/);

  mgr.cancelRun(first.runId);
  await pending;
  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the Policy Guard blocks a node before it executes", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-policy", echo("should-not-run")));

  // The guard is at the dispatcher, so it applies to every runtime -- not just the agent (§3.1).
  let asked = null;
  const dispatcher = createDispatcher({
    policy: (ctx) => {
      asked = ctx.nodeId;
      return { allow: false, reason: "shell nodes are disabled in this test" };
    },
  });

  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-policy" });

  assert.ok(!res.ok);
  assert.match(res.error, /policy denied/);
  assert.equal(asked, "only", "the guard must be consulted for the node");
  assert.equal(repo.getRun(res.runId).state, "FAILED");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a policy denial is not retried", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-policy-retry",
    name: "policy-retry",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      {
        id: "only",
        runtime: "shell",
        config: { command: echo("x") },
        inputs: [],
        retry: { attempts: 3, backoff: "fixed", delayMs: 1 },
      },
    ],
    edges: [],
  });

  const dispatcher = createDispatcher({ policy: () => ({ allow: false, reason: "denied" }) });
  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-policy-retry" });

  assert.ok(!res.ok);
  // Retrying a denial cannot change the verdict; it would just burn attempts.
  assert.equal(repo.listAttempts(res.runId).length, 1);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("resume skips nodes that already succeeded", async () => {
  const root = freshRoot();
  const marker = path.join(root, "side-effect.txt");
  saveWorkflow({
    id: "wf-resume",
    name: "resume",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      // Appends a line every time it runs, so a re-execution would be visible.
      { id: "a", runtime: "shell", config: { command: `echo x >> ${JSON.stringify(marker)}` }, inputs: [] },
      { id: "b", runtime: "shell", config: { command: "exit 1" }, inputs: [] },
    ],
    edges: [{ from: "a", to: "b" }],
  });

  const mgr = createExecutionManager();
  const first = await mgr.run({ workflowId: "wf-resume" });
  assert.ok(!first.ok, "b fails, so the run fails");
  const linesAfterFirst = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.equal(linesAfterFirst, 1);

  // Simulate a crash-and-resume: put the run back to RUNNING and execute it again.
  repo.setRunState(first.runId, "RUNNING");
  await mgr.executeRun(first.runId);

  const linesAfterResume = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.equal(linesAfterResume, 1, "node 'a' already succeeded and must not run twice");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("recovery marks stranded runs INTERRUPTED and clears orphan pids", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-recover", echo("x")));

  // A run left mid-flight by a kill, plus a pid record pointing at a process that is long gone.
  const runId = repo.createRun({ workflowId: "wf-recover", definitionVersion: 1, triggerType: "manual" });
  repo.setRunState(runId, "RUNNING");
  repo.recordProcess({ runId, nodeId: "only", pid: 999999, kind: "shell" });

  const mgr = createExecutionManager();
  const rec = mgr.recoverInterrupted();

  assert.deepEqual(rec.interrupted, [runId]);
  assert.equal(repo.getRun(runId).state, "INTERRUPTED");
  assert.equal(repo.listRecordedProcesses().length, 0);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/* ----------------------------------------------- Phase 2 exit criterion: agent node */

/** Dispatcher wired with a fake LLM, so an agent node runs without network access. */
function agentDispatcher(responses) {
  setLlmConfigReader(() => ({
    model_list: JSON.stringify([
      { id: "t::m", providerId: "custom", model: "m", label: "Test Model", endpoint: "http://127.0.0.1:9/v1/chat/completions", custom: true },
    ]),
    selected_model: "t::m",
  }));
  const queue = [...responses];
  // Counting real LLM invocations is the only unmaskable signal that a node re-ran: attempt-row
  // counts cannot grow past UNIQUE(run_id, node_id, attempt), so they hide re-execution.
  const calls = { count: 0 };
  const dispatcher = createDispatcher({
    agent: {
      llmChat: async () => {
        calls.count++;
        return queue.shift() ?? { ok: false, status: 500, error: "out of responses" };
      },
      listTools: async () => [],
      runTool: async () => "",
    },
  });
  dispatcher.llmCalls = calls;
  return dispatcher;
}

const finalAnswer = (content) => ({ ok: true, status: 200, data: { choices: [{ message: { role: "assistant", content } }] } });

test("runs a shell -> agent -> shell chain", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-mixed",
    name: "mixed",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      { id: "gather", runtime: "shell", config: { command: echo("raw-data") }, inputs: [] },
      {
        id: "think",
        runtime: "agent",
        // The upstream output reaches the prompt by substitution, not concatenation.
        config: { prompt: "Summarize this: {{inputs.data}}" },
        inputs: [{ as: "data", ref: "run://gather/stdout" }],
      },
      {
        id: "report",
        runtime: "shell",
        config: { command: isWindows ? "echo %INPUT_SUMMARY%" : 'printf "%s" "$INPUT_SUMMARY"' },
        inputs: [{ as: "summary", ref: "run://think/text" }],
      },
    ],
    edges: [{ from: "gather", to: "think" }, { from: "think", to: "report" }],
  });

  const mgr = createExecutionManager({ dispatcher: agentDispatcher([finalAnswer("a tidy summary")]) });
  const res = await mgr.run({ workflowId: "wf-mixed" });

  assert.ok(res.ok, res.error);
  assert.equal(res.outputs.think.text, "a tidy summary");
  // The agent's answer must actually reach the final shell node.
  assert.match(res.outputs.report.stdout, /a tidy summary/);
  assert.equal(repo.getRun(res.runId).state, "SUCCEEDED");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an interrupted mixed chain resumes without re-running the agent node", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-mixed-resume",
    name: "mixed-resume",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [
      { id: "gather", runtime: "shell", config: { command: echo("raw") }, inputs: [] },
      { id: "think", runtime: "agent", config: { prompt: "Summarize {{inputs.d}}" }, inputs: [{ as: "d", ref: "run://gather/stdout" }] },
      { id: "fail", runtime: "shell", config: { command: "exit 1" }, inputs: [] },
    ],
    edges: [{ from: "gather", to: "think" }, { from: "think", to: "fail" }],
  });

  // Exactly ONE scripted response: a second LLM call would exhaust the queue and fail the run,
  // which is precisely what proves the agent node is not re-executed on resume.
  const dispatcher = agentDispatcher([finalAnswer("expensive answer")]);
  const mgr = createExecutionManager({ dispatcher });

  const first = await mgr.run({ workflowId: "wf-mixed-resume" });
  assert.ok(!first.ok, "the last node fails, so the run fails");

  // Simulate crash recovery: put the run back to RUNNING and re-execute.
  repo.setRunState(first.runId, "RUNNING");
  const resumed = await mgr.executeRun(first.runId);

  assert.ok(!resumed.ok, "the failing node still fails");
  // The load-bearing assertion: exactly one LLM call across both executions. Counting attempt rows
  // instead would prove nothing, since UNIQUE(run_id, node_id, attempt) caps them at one anyway.
  assert.equal(dispatcher.llmCalls.count, 1, "the agent node must not be paid for twice");
  // Its output is replayed from the event log rather than regenerated.
  assert.equal(repo.nodeOutputs(first.runId).think.text, "expensive answer");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a node killed mid-execution re-runs cleanly on resume", async () => {
  const root = freshRoot();
  saveWorkflow(oneNode("wf-killed", echo("done")));

  // Exactly the app-kill scenario: an attempt row left in RUNNING because the process died before
  // it could be closed out. The node was never SUCCEEDED, so a resume must re-run it -- and the
  // attempt number must continue from 2, not collide with the orphaned attempt 1.
  const runId = repo.createRun({ workflowId: "wf-killed", definitionVersion: 1, triggerType: "manual" });
  repo.setRunState(runId, "RUNNING");
  repo.startAttempt({ runId, nodeId: "only", attempt: 1 });

  const mgr = createExecutionManager();
  const res = await mgr.executeRun(runId);

  assert.ok(res.ok, res.error);
  const attempts = repo.listAttempts(runId).filter((a) => a.node_id === "only");
  assert.equal(attempts.length, 2, "the orphaned attempt is kept and a new one recorded");
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
  assert.equal(repo.getRun(runId).state, "SUCCEEDED");

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unconfigured model fails the node with a clear reason", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-nomodel",
    name: "nomodel",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [{ id: "think", runtime: "agent", config: { prompt: "hi", model: "does-not-exist" }, inputs: [] }],
    edges: [],
  });

  const mgr = createExecutionManager({ dispatcher: agentDispatcher([]) });
  const res = await mgr.run({ workflowId: "wf-nomodel" });

  assert.ok(!res.ok);
  assert.match(res.error, /not configured/);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- helpers */

/** pids of `sleep` processes whose parent is `ppid` (POSIX only; used to prove tree teardown). */
function descendantSleeps(ppid) {
  try {
    const out = execSync("ps -eo pid,ppid,comm", { encoding: "utf8" });
    return out
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => Number(p[1]) === ppid && p[2] === "sleep")
      .map((p) => Number(p[0]));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
