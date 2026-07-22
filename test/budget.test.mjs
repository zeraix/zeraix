/**
 * Budget ceiling tests.
 *
 * The property that matters: a ceiling must bind *during* a node, not only between nodes. A single
 * agent node can spend an entire budget in one step, so a guard that only checks at dispatch would
 * notice after the money is gone.
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
import { createDispatcher } from "../electron/automation/dispatcher.mjs";
import { createPolicyGuard, BudgetExceededError } from "../electron/automation/policyGuard.mjs";
import { setLlmConfigReader } from "../electron/agent/modelResolver.mjs";
import * as repo from "../electron/automation/repo.mjs";

function freshRoot() {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-budget-"));
  setAutomationRoot(dir);
  openDb();
  return dir;
}

/* --------------------------------------------------------------- guard in isolation */

test("policy guard", async (t) => {
  await t.test("allows while under every ceiling", () => {
    const g = createPolicyGuard({ limits: { maxTokens: 100 } });
    assert.equal(g.beforeNode({}).allow, true);
    g.noteUsage({ tokens: 50 });
    assert.equal(g.beforeNode({}).allow, true);
  });

  await t.test("throws mid-node once the token ceiling is crossed", () => {
    const g = createPolicyGuard({ limits: { maxTokens: 100 } });
    g.noteUsage({ tokens: 60 });
    assert.throws(() => g.noteUsage({ tokens: 60 }), BudgetExceededError);
  });

  await t.test("refuses to start another node once over budget", () => {
    const g = createPolicyGuard({ limits: { maxTokens: 10 } });
    try { g.noteUsage({ tokens: 99 }); } catch { /* expected */ }
    const verdict = g.beforeNode({});
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /token ceiling/);
  });

  await t.test("enforces a wall-clock limit", () => {
    let clock = 1000;
    const g = createPolicyGuard({ limits: { maxDurationMs: 500 }, startedAt: 1000, now: () => clock });
    assert.equal(g.beforeNode({}).allow, true);
    clock = 1600;
    assert.match(g.beforeNode({}).reason, /time limit/);
  });

  await t.test("derives cost from a configured price", () => {
    // $10 per 1M tokens, 200k tokens => $2, over a $1 ceiling.
    const g = createPolicyGuard({ limits: { maxCostUsd: 1 }, priceFor: () => 10 });
    assert.throws(() => g.noteUsage({ tokens: 200_000, model: "m" }), BudgetExceededError);
  });

  await t.test("says plainly when a cost ceiling cannot be enforced", () => {
    // Providers do not return a price, so with none configured `maxCostUsd` would silently never
    // bind. An inert ceiling that looks active is worse than no ceiling.
    const g = createPolicyGuard({ limits: { maxCostUsd: 1 }, priceFor: () => null });
    g.noteUsage({ tokens: 5000, model: "unpriced" });
    const warnings = g.drainWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot be enforced/);
    // ...and it warns once, not on every usage report.
    g.noteUsage({ tokens: 5000, model: "unpriced" });
    assert.equal(g.drainWarnings().length, 0);
  });

  await t.test("seeds from prior spend so a resumed run cannot double its budget", () => {
    const g = createPolicyGuard({ limits: { maxTokens: 100 }, seed: { tokens: 90 } });
    assert.throws(() => g.noteUsage({ tokens: 20 }), BudgetExceededError);
  });

  await t.test("rejects a toolPolicy on a shell node", () => {
    // A shell node can invoke anything, so a deny-list it could trivially bypass reads as protection
    // that is not actually there.
    const g = createPolicyGuard({ limits: {} });
    const verdict = g.beforeNode({ runtime: "shell", config: { toolPolicy: { deny: ["run_command"] } } });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /shell node/);
  });
});

/* ------------------------------------------------------- enforced through a real run */

// Budget ceilings only bind cloud models — local models are deliberately uncounted (see turn.mjs),
// so these use a remote endpoint (with a key) by default. Pass a 127.0.0.1 endpoint to exercise the
// local-exemption path.
function agentDispatcher(responses, { endpoint = "https://api.example/v1/chat/completions" } = {}) {
  const local = /127\.0\.0\.1|localhost/.test(endpoint);
  setLlmConfigReader(() => ({
    model_list: JSON.stringify([
      { id: "t::m", providerId: "custom", model: "m", label: "Test Model", endpoint, custom: true },
    ]),
    selected_model: "t::m",
    // A remote model needs a key to resolve; a local one does not.
    ...(local ? {} : { "key_t::m": "test-key" }),
  }));
  const queue = [...responses];
  const calls = { count: 0 };
  const d = createDispatcher({
    agent: {
      llmChat: async () => {
        calls.count++;
        return queue.shift() ?? { ok: false, status: 500, error: "out of responses" };
      },
      listTools: async () => [{ type: "function", function: { name: "read_file" } }],
      runTool: async () => "ok",
    },
  });
  d.llmCalls = calls;
  return d;
}

const toolCall = (usage) => ({
  ok: true,
  status: 200,
  data: {
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] } }],
    usage,
  },
});

test("a token ceiling stops a runaway agent node mid-run", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-budget",
    name: "budget",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    // The node would otherwise loop up to maxRounds, spending on every round.
    limits: { concurrency: "single", maxTokens: 250 },
    nodes: [{ id: "think", runtime: "agent", config: { prompt: "go", maxRounds: 20 }, inputs: [] }],
    edges: [],
  });

  // Each round reports 100 tokens; the ceiling is 250, so it must stop on the third.
  const dispatcher = agentDispatcher(Array.from({ length: 20 }, () => toolCall({ total_tokens: 100 })));
  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-budget" });

  assert.ok(!res.ok);
  assert.match(res.error, /token ceiling/);
  assert.equal(repo.getRun(res.runId).state, "FAILED");
  // The load-bearing assertion: it stopped part-way, not after burning all 20 rounds.
  assert.ok(dispatcher.llmCalls.count <= 4, `expected an early stop, got ${dispatcher.llmCalls.count} calls`);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a budget stop is not retried", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-budget-retry",
    name: "budget-retry",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single", maxTokens: 50 },
    nodes: [
      {
        id: "think",
        runtime: "agent",
        config: { prompt: "go", maxRounds: 5 },
        inputs: [],
        retry: { attempts: 3, backoff: "fixed", delayMs: 1 },
      },
    ],
    edges: [],
  });

  const dispatcher = agentDispatcher(Array.from({ length: 20 }, () => toolCall({ total_tokens: 100 })));
  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-budget-retry" });

  assert.ok(!res.ok);
  // Retrying after a ceiling is hit would spend *more* money to rediscover the same verdict.
  assert.equal(repo.listAttempts(res.runId).length, 1);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("usage accrues to the run record for the Timeline to show", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-usage",
    name: "usage",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    limits: { concurrency: "single" },
    nodes: [{ id: "think", runtime: "agent", config: { prompt: "go" }, inputs: [] }],
    edges: [],
  });

  const dispatcher = agentDispatcher([
    { ok: true, status: 200, data: { choices: [{ message: { role: "assistant", content: "done" } }], usage: { total_tokens: 42 } } },
  ]);
  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-usage" });

  assert.ok(res.ok, res.error);
  assert.equal(repo.getRun(res.runId).tokens_total, 42);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a local model is exempt from the token ceiling", async () => {
  const root = freshRoot();
  saveWorkflow({
    id: "wf-local",
    name: "local",
    triggers: [{ id: "t1", type: "manual", config: {} }],
    // A ceiling a *cloud* model would blow through: three rounds of 100 tokens > 250.
    limits: { concurrency: "single", maxTokens: 250 },
    nodes: [{ id: "think", runtime: "agent", config: { prompt: "go", maxRounds: 20 }, inputs: [] }],
    edges: [],
  });

  // The same rounds, but on a LOCAL model (127.0.0.1): local usage is uncounted, so the ceiling never
  // trips and the node runs to its natural end. tokens_total stays 0.
  const dispatcher = agentDispatcher(
    [
      toolCall({ total_tokens: 100 }),
      toolCall({ total_tokens: 100 }),
      toolCall({ total_tokens: 100 }),
      { ok: true, status: 200, data: { choices: [{ message: { role: "assistant", content: "done" } }], usage: { total_tokens: 100 } } },
    ],
    { endpoint: "http://127.0.0.1:9/v1/chat/completions" },
  );
  const mgr = createExecutionManager({ dispatcher });
  const res = await mgr.run({ workflowId: "wf-local" });

  assert.ok(res.ok, res.error);
  assert.equal(repo.getRun(res.runId).tokens_total, 0);

  await mgr.shutdown();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
