/**
 * The chat page's turn, run by the Rust runtime — what a person sees and what is kept.
 *
 * runtimeRound.ts is the chat page's side of a runtime turn: it has to leave the conversation record, the turn
 * buffer, the transcript on screen and the crash checkpoint exactly as `createRoundRunner` leaves them, or a
 * conversation run one way reads differently when it is reopened the other way. These drive the REAL adapter
 * through the real bridge and a real sidecar, against the real chat store and turn buffer; only the window, the
 * provider and the tools' own implementations are stand-ins.
 *
 * Skipped when the sidecar cannot hold a chat turn — exactly when the app would not route one to it.
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
const { runChatTurnInRuntime } = await import("../src/app/agent/chat/runtimeRound.ts");
const { createTurnBuffer } = await import("../src/app/agent/chat/turnBuffer.ts");
const { useAgentChatStore } = await import("../src/store/agentChatStore.ts");
const { emptyGoal } = await import("../src/app/agent/chat/goalState.ts");
const { wrapReminder } = await import("../src/app/agent/chat/reminders.ts");
const { FINALIZE_NUDGE, repeatedCallNudge, DELEGATION_TOOLS, MUTATING_FILE_TOOLS, RISKY_PATH_PATTERN } = await import(
  "../src/app/agent/chat/constants.ts"
);

// page.tsx's WIRE_STEPS, assembled from the same modules: the page itself cannot be imported here.
const compress = await import("../src/app/agent/chat/contextCompress.ts");
const wire = await import("../src/app/agent/chat/wireHelpers.ts");
const { materializeReminders } = await import("../src/app/agent/chat/reminders.ts");
const WIRE_STEPS = {
  buildWireContext: (messages, compaction, ceiling) => compress.buildWireContext(messages, compaction, ceiling),
  sanitizeToolCallPairs: compress.sanitizeToolCallPairs,
  materializeReminders,
  stripWireMetadata: wire.stripWireMetadata,
  applyReasoningPolicy: wire.applyReasoningPolicy,
  stripAllImagesForText: wire.stripAllImagesForText,
  stripRemoteImagesForLocal: wire.stripRemoteImagesForLocal,
  hoistSystemToFront: wire.hoistSystemToFront,
};

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-round-"));
setSessionPolicyProvider(() => ({ workspaceRoots: [workdir] }));
initRuntimeTurnBridge({ getWorkdir: () => workdir, getAssetDir: () => "" });

test.after(async () => {
  await shutdown();
  fs.rmSync(workdir, { recursive: true, force: true });
});

async function canHoldAChatTurn() {
  return (await hasFeature("agent.host_tools")) && (await hasFeature("agent.round_context"));
}

/**
 * One turn's worth of what page.tsx hands the adapter, over a fresh conversation. Returns the deps and what the
 * test reads back: the tools that ran, the checkpoint's calls, the rows drawn.
 */
function turn(endpoint, { signal = new AbortController().signal, tools = {}, runTool } = {}) {
  const store = useAgentChatStore.getState();
  const convId = store.createConversation({ workdir });
  store.appendMessage(convId, { role: "user", content: "go", ts: Date.now() });
  const buf = createTurnBuffer({ initial: [{ role: "user", content: "go" }], convId, syncView: () => {} });
  const ran = [];
  const checkpoints = [];
  const display = { current: [] };
  const usage = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
  const log = { lastWire: [], lastContent: "" };
  const deps = {
    convId,
    turnId: `${convId}-t`,
    signal,
    active: () => true,
    t: (key) => key,
    buf,
    compaction: null,
    log,
    checkpoint: {
      roundStarted: () => checkpoints.push("round"),
      callsStarted: (calls) => checkpoints.push(`calls:${calls.map((c) => c.callId).join(",")}`),
      callsFinished: () => checkpoints.push("done"),
    },
    activeModel: { id: "m1", model: "m", providerId: "custom", contextWindow: 32_000 },
    modelName: "m",
    isLocalModel: false,
    sendReasoningContext: () => false,
    wireSteps: WIRE_STEPS,
    tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
    ctx: { convId, turnId: `${convId}-t`, signal, push: () => {}, status: () => {} },
    rendererTools: tools,
    execToolCall: async (_ctx, name, args, _display, _actor, _req, onOk) => {
      ran.push({ name, args });
      onOk?.(true);
      return runTool ? runTool(name, args) : `ran ${name}`;
    },
    toolRules: { mutatingTools: MUTATING_FILE_TOOLS, riskyPath: RISKY_PATH_PATTERN, delegationTools: DELEGATION_TOOLS },
    drainDelegations: () => "",
    drainJobEvents: () => "",
    displayRef: display,
    viewTokenRef: { current: { owner: convId } },
    setDisplay: (next) => (display.current = next),
    setCtxTokens: () => {},
    diagRef: { current: null },
    lastArtifactRef: { current: null },
    schedulerRef: { current: null },
    awaitingJobsRef: { current: new Map() },
    tagLastAssistantStoredIndex: () => {},
    goalFor: () => emptyGoal(),
    setGoalFor: () => {},
    endpoint,
    apiKey: "k",
    thinking: { enabled: false, effort: "medium" },
    capabilities: { supportsPerTurnReasoningEffort: false },
    thinkingUnsupported: () => new Set(),
    reasoningContextUnsupported: () => new Set(),
    turnUsage: () => usage,
  };
  return { deps, convId, buf, ran, checkpoints, display, usage, log, stored: () => store.getConversation(convId).messages };
}

/** Run a turn with this window serving the runtime. */
async function run(deps) {
  const win = fakeWindow(ipc);
  globalThis.agentRuntime = win.api;
  try {
    return await runChatTurnInRuntime(deps);
  } finally {
    delete globalThis.agentRuntime;
  }
}

test("a turn is stored, buffered and drawn as the chat's own loop would leave it", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("the answer")]);
  const x = turn(p.endpoint);
  try {
    const out = await run(x.deps);
    assert.equal(out.stop.reason, "completed");

    // The record: the user, the reply with its call, the result, the answer — in that order.
    const stored = x.stored();
    assert.deepEqual(stored.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.deepEqual(stored[1].tool_calls, [
      { id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "q" }) } },
    ]);
    assert.equal(stored[2].tool_call_id, "c1");
    assert.equal(stored[2].name, "web_search");
    assert.equal(stored[2].content, "ran web_search");
    assert.equal(stored[3].content, "the answer");
    // The buffer the post-turn work reads mirrors it.
    assert.deepEqual(x.buf.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    // The tool took the chat's own path.
    assert.deepEqual(x.ran, [{ name: "web_search", args: { query: "q" } }]);
    // The crash checkpoint moved as the other loop moves it.
    assert.deepEqual(x.checkpoints, ["round", "calls:c1", "done", "round"]);
    // The answer is on screen, and the turn's usage was counted.
    assert.ok(x.display.current.some((row) => row.kind === "assistant" && row.content === "the answer"));
    assert.equal(x.usage.prompt, 20);
    assert.equal(x.log.lastContent, "the answer");
  } finally {
    await p.close();
  }
});

test("a turn that works and then says nothing is nudged once, and the nudge is stored where it was sent", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text(""), text("from what I found")]);
  const x = turn(p.endpoint);
  try {
    const out = await run(x.deps);
    assert.equal(out.stop.reason, "completed");
    assert.equal(p.seen.length, 3);
    const sent = p.seen[2].messages.find((m) => m.role === "tool").content;
    assert.equal(sent, `ran web_search\n\n${wrapReminder(FINALIZE_NUDGE)}`);
    // Stored beside the result, not in it — the record materializeReminders will rebuild those same bytes from.
    const tool = x.stored().find((m) => m.role === "tool");
    assert.equal(tool.content, "ran web_search");
    assert.equal(tool.reminderText, wrapReminder(FINALIZE_NUDGE));
    assert.equal(x.log.lastContent, "from what I found");
  } finally {
    await p.close();
  }
});

test("the loop detector's warning reaches the model in the chat's own words", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const same = () => call("c", "web_search", { query: "same" });
  const p = await provider([same(), same(), text("done")]);
  const x = turn(p.endpoint, { runTool: () => "the same result" });
  try {
    await run(x.deps);
    const sent = p.seen[2].messages.filter((m) => m.role === "tool").at(-1).content;
    assert.ok(sent.endsWith(wrapReminder(repeatedCallNudge("web_search", 2))), sent);
  } finally {
    await p.close();
  }
});

test("a failed request is reported the way the chat reports one, with the rounds before it kept", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const refuse = (res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  };
  const p = await provider([call("c1", "web_search", { query: "q" }), refuse]);
  const x = turn(p.endpoint);
  try {
    await assert.rejects(run(x.deps), /^Error: HTTP 401 — .*bad key/);
    assert.deepEqual(x.stored().map((m) => m.role), ["user", "assistant", "tool"], "the round that completed is kept");
  } finally {
    await p.close();
  }
});

test("a local model gets its conversation id and the local error wording", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const brokenTemplate = (res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "chat template error: raise_exception" } }));
  };
  const p = await provider([brokenTemplate, brokenTemplate, brokenTemplate]);
  const x = turn(p.endpoint);
  x.deps.apiKey = "";
  try {
    // 127.0.0.1 is local, so this is the local path — the llama-server case.
    await assert.rejects(run(x.deps), /chat\.localTemplateError/);
    assert.equal(p.headers[0]["x-conversation-id"], x.convId);
    assert.equal(p.headers[0].authorization, "Bearer local", "what the proxy sends a local server with no key");
  } finally {
    await p.close();
  }
});

test("a turn stopped between calls answers every call it made", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const two = {
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: ["c1", "c2"].map((id) => ({ id, type: "function", function: { name: "write_file", arguments: "{}" } })),
      },
    }],
  };
  const p = await provider([two, text("never")]);
  const stop = new AbortController();
  const x = turn(p.endpoint, {
    signal: stop.signal,
    runTool: async () => {
      stop.abort();
      await new Promise((done) => setTimeout(done, 50));
      return "wrote it";
    },
  });
  try {
    const out = await run(x.deps);
    assert.equal(out.stop.reason, "cancelled");
    const results = x.stored().filter((m) => m.role === "tool");
    assert.deepEqual(results.map((m) => m.tool_call_id), ["c1", "c2"], "the call that never ran is answered too");
    assert.equal(results[1].content, "chat.canceled");
    assert.equal(x.ran.length, 1, "the second write never ran");
  } finally {
    await p.close();
  }
});

test("a routine round goes out at low effort, as the chat's own loop sends it", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a chat turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("done")]);
  const x = turn(p.endpoint);
  // An o-series model: its family spells effort as `reasoning_effort`, and it can vary it per request.
  Object.assign(x.deps, {
    modelName: "o3",
    thinking: { enabled: true, effort: "high" },
    capabilities: { supportsPerTurnReasoningEffort: true },
  });
  try {
    await run(x.deps);
    // Planning at the user's setting; the round after a clean tool call economised, as runAgentLoop does it.
    assert.deepEqual(p.seen.map((b) => b.reasoning_effort), ["high", "low"]);
  } finally {
    await p.close();
  }
});

