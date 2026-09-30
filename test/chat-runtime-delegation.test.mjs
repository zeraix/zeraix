/**
 * A chat delegation run by the Rust runtime.
 *
 * delegationRuntime.ts moves a sub-agent's conversation into the runtime while the delegation keeps everything it
 * is: its tools on its own path (attributed to its execution, logged as `sub:<label>`), its own KV key on a local
 * server, its usage line, and the outcomes the Inspector shows — a conclusion, a Stop, a halted loop. These drive
 * the REAL `createRunDelegation` through the real bridge and a real sidecar; the provider and the tools'
 * implementations are the stand-ins.
 *
 * Skipped when the sidecar cannot hold a chat turn, exactly when the app would keep delegations where they were.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import test from "node:test";

import { call, fakeWindow, provider, stubElectron, text } from "./helpers/runtimeFakes.mjs";

const ipc = stubElectron();
register("./helpers/srcResolve.mjs", import.meta.url);

process.env.ZERAIX_RUST_CHAT_LOOP = "on";
const { initRuntimeTurnBridge } = await import("../electron/agent/runtimeTurnBridge.mjs");
const { hasFeature, setSessionPolicyProvider, shutdown } = await import("../electron/tools/rustRuntime.mjs");
const { createRunDelegation } = await import("../src/app/agent/chat/delegation.ts");
const { beginExecution, cancelExecution, subscribeExecutionEvents } = await import("../src/lib/agent/executionRegistry.ts");
const { STOPPED_BY_USER_RESULT } = await import("../src/lib/ai/subagentScheduler.ts");
const { runDelegationInRuntime } = await import("../src/app/agent/chat/delegationRuntime.ts");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-delegation-"));
setSessionPolicyProvider(() => ({ workspaceRoots: [workdir] }));
const usageLog = [];
initRuntimeTurnBridge({ getWorkdir: () => workdir, getAssetDir: () => "", logUsage: (e) => usageLog.push(e) });

// The sub-agent's tool list comes from the toolkit bridge; this is its one declaration.
globalThis.window = globalThis;
globalThis.aiTools = {
  list: async () => [{ type: "function", function: { name: "search_files", parameters: { type: "object" } } }],
};

test.after(async () => {
  await shutdown();
  fs.rmSync(workdir, { recursive: true, force: true });
});

async function canHoldAChatTurn() {
  return (await hasFeature("agent.host_tools")) && (await hasFeature("agent.round_context"));
}

const CAPS = { supportsPerTurnReasoningEffort: false };

/** A delegation runner over `endpoint`, recording every tool call the delegation's own path was asked to run. */
function runner(endpoint, { toolResult = () => "found in a.ts", turnUsage } = {}) {
  const executed = [];
  const bucket = { turnId: "t1", done: [] };
  const run = createRunDelegation({
    t: (k) => k,
    toolsReady: true,
    workdir,
    endpoint,
    sandboxStatus: () => null,
    isLocalModel: false,
    sendReasoningContext: () => false,
    thinking: { enabled: false, effort: "medium" },
    capabilities: CAPS,
    requestChat: async () => {
      throw new Error("the delegation fell back to the TypeScript loop");
    },
    execToolCall: async (ctx, name, args, displayName, actor, requester, onResult) => {
      executed.push({ name, args, displayName, actor, executionId: ctx.executionId });
      onResult?.(true);
      return toolResult(name, args);
    },
    delegations: () => bucket,
    runtimeModel: {
      endpoint,
      apiKey: "k",
      modelName: "m",
      isLocalModel: false,
      activeModel: { id: "m1", model: "m", providerId: "custom", contextWindow: 32_000 },
      thinking: { enabled: false, effort: "medium" },
      capabilities: CAPS,
      thinkingUnsupported: () => new Set(),
      reasoningContextUnsupported: () => new Set(),
      turnUsage,
    },
  });
  return { run, executed, bucket };
}

const ctx = (signal = new AbortController().signal) => ({ convId: "conv1", turnId: "t1", signal, push: () => {}, status: () => {} });
const opts = (execution) => ({
  agentId: "explore",
  task: "find the handler",
  def: { id: "explore", systemPrompt: "you explore", tools: undefined },
  label: "explore",
  status: () => {},
  execution,
});

/** Run with a window serving the runtime. */
async function delegate(fn) {
  const win = fakeWindow(ipc);
  globalThis.agentRuntime = win.api;
  try {
    return await fn();
  } finally {
    delete globalThis.agentRuntime;
  }
}

test("a delegation runs in the runtime and its tools take the delegation's own path", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const p = await provider([call("c1", "search_files", { query: "handler" }), text("the handler is in a.ts")]);
  const { run, executed, bucket } = runner(p.endpoint);
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });
  try {
    const result = await delegate(() => run(ctx(), opts(execution)));
    assert.deepEqual(result, { conclusion: "the handler is in a.ts", error: undefined });
    // The sidecar sent both requests, and the sub-agent's conversation was its own: [system, task].
    assert.equal(p.seen.length, 2);
    assert.deepEqual(p.seen[0].messages.map((m) => m.role), ["system", "user"]);
    assert.equal(p.seen[0].messages[1].content, "find the handler");
    assert.equal(p.seen[0].stream, false, "nothing renders a delegation's tokens");
    // Its tool ran on its own path: attributed to its execution, named and logged as the delegation.
    assert.deepEqual(executed, [
      { name: "search_files", args: { query: "handler" }, displayName: "explore→search_files", actor: "sub:explore", executionId: execution.id },
    ]);
    // Its model calls are in the usage log under the delegation, not the main agent.
    assert.equal(usageLog.filter((e) => e.convId === "conv1" && e.actor === "sub:explore").length, 2);
    // A conclusion is recorded for the repeat-delegation guard.
    assert.equal(bucket.done.at(-1)?.conclusion, "the handler is in a.ts");
  } finally {
    await p.close();
  }
});

test("a delegation on a local model gets its own KV key, never the conversation's", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  // 127.0.0.1 is local: a delegation there names its own conversation, or it would evict the parent's KV.
  const p = await provider([text("done")]);
  const { run } = runner(p.endpoint);
  try {
    await delegate(() => run(ctx(), opts()));
    assert.match(String(p.headers[0]["x-conversation-id"]), /^conv1#explore-[0-9a-f]{8}$/);
  } finally {
    await p.close();
  }
});

test("the Inspector's Stop ends a delegation the runtime is running, as a stop and not a failure", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const p = await provider([text("too late")], { delayMs: 5_000 });
  const { run } = runner(p.endpoint);
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });
  try {
    const started = Date.now();
    setTimeout(() => cancelExecution(execution.id), 300);
    const result = await delegate(() => run(ctx(), opts(execution)));
    assert.deepEqual(result, { conclusion: STOPPED_BY_USER_RESULT, error: "cancelled" });
    assert.ok(Date.now() - started < 4_000, "Stop must not wait out the provider");
  } finally {
    await p.close();
  }
});

test("a delegation that stops making progress is halted and says so", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const same = () => call("c", "search_files", { query: "handler" });
  const p = await provider(Array.from({ length: 12 }, same));
  const { run } = runner(p.endpoint, { toolResult: () => "always the same" });
  try {
    const result = await delegate(() => run(ctx(), opts()));
    assert.match(result.error ?? "", /^doom-loop/);
    assert.match(result.conclusion, /stopped making progress/);
  } finally {
    await p.close();
  }
});

test("a delegation whose provider refuses fails, with the rounds it spent reported", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const refuse = (res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  };
  const p = await provider([refuse]);
  const { run } = runner(p.endpoint);
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });
  const failed = [];
  execution.fail = ((orig) => (...a) => (failed.push(a), orig(...a)))(execution.fail.bind(execution));
  try {
    await assert.rejects(delegate(() => run(ctx(), opts(execution))), /HTTP 401 — .*bad key/);
    assert.equal(failed.length, 1, "the execution is failed, not left looking as if it were still running");
  } finally {
    await p.close();
  }
});

test("what a delegation spends is added to the turn's usage, as every sub-agent request is on the other path", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  // Two requests, 10 + 5 tokens each (the fake provider's usage). Left out, the turn's usage row, the session
  // total and a goal's cost all under-reported whatever the sub-agents spent.
  const p = await provider([call("c1", "search_files", { query: "x" }), text("done")]);
  const turn = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
  const { run } = runner(p.endpoint, { turnUsage: () => turn });
  try {
    await delegate(() => run(ctx(), opts(undefined)));
    assert.deepEqual({ prompt: turn.prompt, completion: turn.completion, total: turn.total }, { prompt: 20, completion: 10, total: 30 });
  } finally {
    await p.close();
  }
});

test("a call that never reached the window is the one the Inspector shows as failed, even beside a twin", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  // One batch, two calls to one tool: the first cut off mid-arguments, so the runtime refuses it without asking the
  // window; the second fine. Attributed by NAME, the refused call was credited with the good one's arrival and the
  // Inspector showed a phantom failure carrying the good call's result, while the real parse error never appeared.
  const batch = {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "cut", type: "function", function: { name: "search_files", arguments: '{"query": "hand' } },
            { id: "fine", type: "function", function: { name: "search_files", arguments: JSON.stringify({ query: "handler" }) } },
          ],
        },
      },
    ],
  };
  const p = await provider([batch, text("done")]);
  const { run, executed } = runner(p.endpoint);
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });
  const reported = [];
  const off = subscribeExecutionEvents((e) => {
    if (e.executionId === execution.id && e.type === "tool_result") reported.push(e);
  });
  try {
    await delegate(() => run(ctx(), opts(execution)));
    assert.deepEqual(executed.map((e) => e.args), [{ query: "handler" }], "only the readable call reached the window");
    // execToolCall reports the calls it ran (the stand-in here reports none); the delegation reports the one it never saw.
    assert.equal(reported.length, 1, JSON.stringify(reported));
    assert.equal(reported[0].ok, false);
    assert.doesNotMatch(String(reported[0].output), /found in a\.ts/, "the refused call must not carry the good call's result");
  } finally {
    off();
    await p.close();
  }
});

test("a sidecar too old to send call ids still has its calls attributed, not reported twice", async () => {
  // Over a stand-in preload: the runtime asks for one call WITHOUT a call id, as one built before host.tool carried
  // them does, then reports it ended. Matched by id alone, every such call read as one that never reached the
  // window, and the Inspector showed a failure beside each real result.
  let onEvent;
  let onRequest;
  const replies = [];
  globalThis.agentRuntime = {
    start: async (runId) => {
      onRequest({ requestId: "q1", runId, kind: "tool", name: "search_files", args: { query: "x" } });
      while (!replies.length) await new Promise((r) => setTimeout(r, 1));
      onEvent({ runId, kind: "tool", payload: { phase: "start", id: "c1", name: "search_files" } });
      onEvent({ runId, kind: "tool", payload: { phase: "end", id: "c1", name: "search_files", ok: true, content: "found" } });
      return { stop_reason: "completed", messages: [], injected: [], learned: {} };
    },
    cancel() {},
    reply: (requestId, body) => replies.push({ requestId, ...body }),
    onEvent: (cb) => ((onEvent = cb), () => {}),
    onRequest: (cb) => ((onRequest = cb), () => {}),
  };
  const execution = beginExecution({ agent: "explore", task: "t", origin: "run_subagent" });
  const reported = [];
  const off = subscribeExecutionEvents((e) => {
    if (e.executionId === execution.id && e.type === "tool_result") reported.push(e);
  });
  try {
    const out = await runDelegationInRuntime({
      model: {
        endpoint: "http://unused.invalid",
        apiKey: "k",
        modelName: "m",
        isLocalModel: false,
        activeModel: null,
        thinking: { enabled: false, effort: "medium" },
        capabilities: CAPS,
        thinkingUnsupported: () => new Set(),
        reasoningContextUnsupported: () => new Set(),
      },
      sendReasoningContext: () => false,
      t: (k) => k,
      ctx: ctx(),
      signal: new AbortController().signal,
      messages: [],
      tools: [],
      actor: "sub:explore",
      displayName: (tool) => `explore→${tool}`,
      subConvId: undefined,
      execToolCall: async () => "found",
      execution,
      onRoundStart: () => {},
      progress: { rounds: 0, steps: 0, lastContent: "", usage: { prompt: 0, completion: 0, total: 0 } },
    });
    assert.equal(out?.stop.reason, "completed");
    assert.deepEqual(reported, [], "a call that reached the window is execToolCall's to report, not a phantom failure");
  } finally {
    off();
    delete globalThis.agentRuntime;
  }
});
