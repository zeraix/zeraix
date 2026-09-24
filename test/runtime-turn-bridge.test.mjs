/**
 * A chat turn in the Rust runtime, across all four hops.
 *
 * renderer client (src/lib/agent/runtimeTurn.ts) → main bridge (electron/agent/runtimeTurnBridge.mjs) →
 * runtime bridge (electron/tools/rustRuntime.mjs) → the sidecar → a scripted provider, and back.
 *
 * Every one of those is the real module. The only stand-in is Electron's `ipcMain`, and a fake window that
 * relays between the two halves. It relays SYNCHRONOUSLY, which is stricter than Electron: a request that is
 * sent before its reply is registered — the race subagentBridge.mjs records as having cost four fixes — fails
 * here every time instead of once in a while.
 *
 * Skipped when the sidecar cannot hold a turn, which is exactly when the app would not route one to it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { call, declare, fakeWindow as fakeWindowOver, provider, stubElectron, text } from "./helpers/runtimeFakes.mjs";

// ── Electron, and nothing else, is stubbed ─────────────────────────────────────────────────────
const { handlers, listeners } = stubElectron();
const fakeWindow = () => fakeWindowOver({ handlers, listeners });

process.env.ZERAIX_RUST_CHAT_LOOP = "on";
const { chatLoopEnabled, initRuntimeTurnBridge, routeFromChromium } = await import("../electron/agent/runtimeTurnBridge.mjs");
const { hasFeature, setSessionPolicyProvider, shutdown } = await import("../electron/tools/rustRuntime.mjs");
const { runTurnInRuntime, userVisibleMessages } = await import("../src/lib/agent/runtimeTurn.ts");

// The workspace a run happens in, and a DIFFERENT one declared at the handshake — the app's ordinary state
// once a project has been opened after launch.
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-chat-"));
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-boot-"));
fs.writeFileSync(path.join(workdir, "note.txt"), "NOTE-CONTENTS");
setSessionPolicyProvider(() => ({ workspaceRoots: [bootDir] }));
// Every usage-log entry the bridge writes. Tests find their own by `convId`.
const usageLog = [];
initRuntimeTurnBridge({ getWorkdir: () => workdir, getAssetDir: () => "", logUsage: (e) => usageLog.push(e) });

test.after(async () => {
  await shutdown();
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.rmSync(bootDir, { recursive: true, force: true });
});

async function canHoldAChatTurn() {
  return (await hasFeature("agent.host_tools")) && (await hasFeature("agent.round_gate"));
}

const params = (endpoint, extra = {}) => ({
  provider: { endpoint, apiKey: "k", model: "m", stream: false },
  messages: [{ role: "user", content: "go" }],
  tools: [declare("web_search"), declare("read_file")],
  ...extra,
});

test("a chat turn crosses all four hops: the runtime runs its own tools, the window runs the rest", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([
    call("c1", "web_search", { query: "zeraix" }),
    call("c2", "read_file", { path: "note.txt" }),
    text("done"),
  ]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const served = [];
  const toolEvents = [];
  try {
    const r = await runTurnInRuntime(params(p.endpoint), {
      runTool: async (name, args) => {
        served.push({ name, args });
        return { ok: true, content: "three results" };
      },
      onTool: (e) => toolEvents.push(e),
    });

    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(r.content, "done");
    // The window ran what only it can run...
    assert.deepEqual(served, [{ name: "web_search", args: { query: "zeraix" } }]);
    // ...and read_file never came back here: the runtime executed it itself, in the run's workspace, even
    // though the handshake declared a different one.
    const readEnd = toolEvents.find((e) => e.name === "read_file" && e.phase === "end");
    assert.ok(readEnd, `no end event for read_file: ${JSON.stringify(toolEvents)}`);
    assert.equal(readEnd.ok, true, JSON.stringify(readEnd));
    assert.match(readEnd.content, /NOTE-CONTENTS/, "a chat UI must be able to show what the tool returned");
    assert.equal(readEnd.args?.path, "note.txt");
    const readStart = toolEvents.find((e) => e.name === "read_file" && e.phase === "start");
    assert.match(readStart.arguments, /note\.txt/, "a chat UI must be able to show what the tool was asked");
    assert.deepEqual(r.injected, []);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("the workspace is the main process's, whatever the renderer sends", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "read_file", { path: "note.txt" }), text("done")]);
  const win = fakeWindow();
  try {
    // A renderer that tries to point the run somewhere else. Called on the bridge directly, since the
    // client has no way to send a workdir at all.
    const r = await handlers.get("agent-run:start")(win.event, {
      runId: "hostile-1",
      params: { ...params(p.endpoint), workdir: "/", assetDir: "/" },
    });
    const tool = r.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /NOTE-CONTENTS/, "the run read from the main process's workspace, not '/'");
  } finally {
    await p.close();
  }
});

test("only the window that owns a run may answer for it", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("done")]);
  const owner = fakeWindow();
  const intruder = fakeWindow();
  const requests = [];
  owner.api.onRequest((r) => requests.push(r));
  try {
    const running = owner.api.start("owned-1", params(p.endpoint), false);
    while (!requests.length) await new Promise((r) => setTimeout(r, 10));

    // Another window tries to feed the model a tool result. It must be ignored, not merely outvoted.
    intruder.api.reply(requests[0].requestId, { result: { ok: true, content: "INJECTED-BY-INTRUDER" } });
    owner.api.reply(requests[0].requestId, { result: { ok: true, content: "from the owner" } });

    const r = await running;
    const transcript = JSON.stringify(r.messages);
    assert.ok(!transcript.includes("INJECTED-BY-INTRUDER"), "a foreign window's reply reached the model");
    assert.ok(transcript.includes("from the owner"));
  } finally {
    await p.close();
  }
});

test("Stop reaches the runtime", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  // A provider slow enough that the turn is certainly still in flight when Stop arrives.
  const p = await provider([text("too late")], { delayMs: 5_000 });
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const stop = new AbortController();
  try {
    const started = Date.now();
    setTimeout(() => stop.abort(), 300);
    const r = await runTurnInRuntime(params(p.endpoint), { runTool: async () => ({ ok: true, content: "" }) }, stop.signal);
    assert.equal(r.stop_reason, "cancelled", JSON.stringify(r));
    assert.ok(Date.now() - started < 4_000, "Stop must not wait out the provider");
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("a window that closes mid-turn ends its turn instead of leaving it to run", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("never read")]);
  const win = fakeWindow();
  const requests = [];
  win.api.onRequest((r) => requests.push(r));
  try {
    const running = win.api.start("closing-1", params(p.endpoint), false);
    while (!requests.length) await new Promise((r) => setTimeout(r, 10));
    // The window goes away with a tool request outstanding. Nobody will ever answer it.
    const closedAt = Date.now();
    win.wc.destroy();
    const r = await running;
    assert.equal(r.stop_reason, "cancelled", "a closed window's turn must stop, not run on");
    // Bounded, because the reason alone is not enough: this test PASSED while the bug was live, with the
    // right reason, after 180 seconds — the runtime waited out its host timeout on a question the closed
    // window could never answer, while the bridge waited on the runtime to fail that question.
    assert.ok(Date.now() - closedAt < 5_000, `closing the window took ${Date.now() - closedAt}ms to stop the turn`);
  } finally {
    await p.close();
  }
});

test("messages the host injects are kept for the model and kept out of the user's view", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("the answer")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  try {
    const r = await runTurnInRuntime(params(p.endpoint), {
      runTool: async () => ({ ok: true, content: "result" }),
      round: async ({ round }) =>
        round === 1 ? { withdrawTools: true, inject: [{ role: "user", content: "HOST-NOTE: answer now" }] } : {},
    });
    assert.equal(r.stop_reason, "completed");
    assert.equal(r.injected.length, 1);
    assert.equal(r.messages[r.injected[0]].content, "HOST-NOTE: answer now");
    // The model saw it...
    assert.ok(JSON.stringify(p.seen[1].messages).includes("HOST-NOTE"));
    // ...the user will not.
    const visible = JSON.stringify(userVisibleMessages(r));
    assert.ok(!visible.includes("HOST-NOTE"), "an injected message must not be shown as something the user said");
    assert.ok(visible.includes("the answer"));
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("with the flag off, nothing is routed and the caller keeps its own loop", async () => {
  const win = fakeWindow();
  const prior = process.env.ZERAIX_RUST_CHAT_LOOP;
  process.env.ZERAIX_RUST_CHAT_LOOP = "off";
  try {
    const r = await win.api.start("off-1", params("http://127.0.0.1:9/v1/chat/completions"), false);
    assert.equal(r, null, "off means 'not served here', which the renderer answers with runAgentLoop");
  } finally {
    process.env.ZERAIX_RUST_CHAT_LOOP = prior;
  }
});

test("chat runs in the runtime by default, and ZERAIX_RUST_CHAT_LOOP=off turns it off", () => {
  const prior = process.env.ZERAIX_RUST_CHAT_LOOP;
  try {
    for (const [value, expected] of [
      [undefined, true], ["", true], ["on", true], ["1", true],
      ["off", false], ["OFF", false], ["0", false], ["false", false], ["no", false],
    ]) {
      if (value === undefined) delete process.env.ZERAIX_RUST_CHAT_LOOP;
      else process.env.ZERAIX_RUST_CHAT_LOOP = value;
      assert.equal(chatLoopEnabled(), expected, `ZERAIX_RUST_CHAT_LOOP=${value}`);
    }
  } finally {
    process.env.ZERAIX_RUST_CHAT_LOOP = prior;
  }
});

test("with no preload surface the client declines before anything starts", async () => {
  delete globalThis.agentRuntime;
  const r = await runTurnInRuntime(params("http://127.0.0.1:9/v1/chat/completions"), {
    runTool: async () => ({ ok: true, content: "" }),
  });
  assert.equal(r, null);
});

// ── Transport parity: what the renderer's own loop provides, provided here too ──────────────────

/** A streamed reply, as SSE. `cut` ends the connection mid-stream, the way a dropped connection does. */
const stream = (chunks, { cut = false } = {}) => (res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  if (cut) {
    // Give the runtime the partial text before the connection dies, or there is nothing to reset.
    setTimeout(() => res.destroy(), 150);
    return;
  }
  res.end("data: [DONE]\n\n");
};
const refuse = (status, message) => (res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
};

test("every model call of a chat turn reaches the usage log, attributed to its conversation", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  // On the renderer's loop each request is logged by the renderer or by the proxy. A turn in the runtime passes
  // through neither, so without the bridge's entries chat's model calls would vanish from the log.
  const p = await provider([
    call("c1", "web_search", { query: "q" }),
    { ...text("done"), usage: { prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 32 } } },
  ]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const rounds = [];
  try {
    const r = await runTurnInRuntime(
      {
        ...params(`${p.endpoint}?key=QUERY-SECRET`),
        provider: { endpoint: `${p.endpoint}?key=QUERY-SECRET`, apiKey: "sk-HEADER-SECRET", model: "m", stream: false },
        meta: { convId: "conv-usage", turnId: "turn-usage", provider: "custom" },
      },
      {
        // Slow on purpose: a model call's latency must not include the tools its round ran.
        runTool: async () => {
          await new Promise((r) => setTimeout(r, 400));
          return { ok: true, content: "result" };
        },
        onRound: (e) => rounds.push(e),
      },
    );
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(r.cached_tokens, 32);
    assert.equal(r.estimated, false);

    const entries = usageLog.filter((e) => e.convId === "conv-usage");
    assert.equal(entries.length, 2, `one entry per model call: ${JSON.stringify(entries)}`);
    for (const e of entries) {
      assert.equal(e.kind, "model");
      assert.equal(e.source, "chat");
      assert.equal(e.actor, "main");
      assert.equal(e.turnId, "turn-usage");
      assert.equal(e.provider, "custom");
      assert.equal(e.model, "m");
      assert.equal(e.ok, true);
      assert.equal(e.stream, false);
    }
    assert.deepEqual(
      entries.map((e) => [e.promptTokens, e.completionTokens, e.totalTokens, e.cachedTokens]),
      [
        [10, 5, 15, 0],
        [40, 2, 42, 32],
      ],
    );
    // The host and nothing else: a gateway key in the query string must never reach the log file.
    assert.equal(entries[0].endpoint, new URL(p.endpoint).host);
    assert.ok(!JSON.stringify(entries).includes("SECRET"), "a credential reached the usage log");
    // The model call, not the round: the first round spent 400 ms in a tool, which is not the provider's.
    const first = rounds.find((e) => e.phase === "end" && e.round === 0);
    assert.ok(first.ms >= 400, `the round itself took ${first.ms}ms`);
    assert.ok(entries[0].ms < 400, `logged ${entries[0].ms}ms for a call that took less — the tool was billed to it`);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("a chat request that fails for good is logged as a failed call", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([refuse(401, "bad key")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  try {
    const r = await runTurnInRuntime(
      { ...params(p.endpoint), meta: { convId: "conv-fail" } },
      { runTool: async () => ({ ok: true, content: "" }) },
    );
    assert.equal(r.stop_reason, "error", JSON.stringify(r));
    const entries = usageLog.filter((e) => e.convId === "conv-fail");
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].ok, false);
    assert.match(entries[0].error, /401|bad key/);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("a retried request reaches the window, and the half-streamed reply starts over", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  // The connection drops mid-reply; the retry streams the whole answer again. A window that only ever appends
  // would show "STALE-PARTIAL Hello world".
  const p = await provider([stream(["STALE-PARTIAL "], { cut: true }), stream(["Hello", " world"])]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const retries = [];
  let shown = "";
  let resets = 0;
  try {
    const r = await runTurnInRuntime(
      { ...params(p.endpoint), provider: { endpoint: p.endpoint, apiKey: "k", model: "m", stream: true } },
      {
        runTool: async () => ({ ok: true, content: "" }),
        onRetry: (e) => retries.push(e),
        // What a chat window does with the deltas: append, and start over on a reset.
        onDelta: (d) => {
          if (d.reset) {
            resets += 1;
            shown = "";
          }
          shown += d.content;
        },
      },
    );
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(r.content, "Hello world");
    assert.equal(retries.length, 1, `the window must hear about the retry: ${JSON.stringify(retries)}`);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].attempts, 3);
    assert.ok(["network", "server", "rate-limit"].includes(retries[0].kind), retries[0].kind);
    assert.equal(resets, 1);
    assert.equal(shown, "Hello world", "the stale partial must be gone");
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("provider headers reach the provider, and refusals go out as known and come back as learned", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  // `X-Conversation-Id` is how a local llama-server finds a conversation's KV cache; without it every turn
  // re-reads the whole prompt. A header that HTTP cannot carry is dropped, never allowed to fail the turn.
  const p = await provider([text("ok")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  try {
    const r = await runTurnInRuntime(
      {
        ...params(p.endpoint),
        provider: {
          endpoint: p.endpoint,
          apiKey: "k",
          model: "m",
          stream: false,
          thinkingParams: { chat_template_kwargs: { enable_thinking: true } },
          headers: { "X-Conversation-Id": "conv-kv", "Not A Header": "x", "X-Split": "a\r\nInjected: yes" },
          known: { thinking_unsupported: true },
        },
      },
      { runTool: async () => ({ ok: true, content: "" }) },
    );
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(p.headers[0]["x-conversation-id"], "conv-kv");
    assert.equal(p.headers[0].injected, undefined, "a header value smuggled a second header");
    // Known up front: the refused parameter is never sent, and it is still reported for the caller to keep.
    assert.ok(!("chat_template_kwargs" in p.seen[0]), "a known refusal was sent anyway");
    assert.equal(r.learned.thinking_unsupported, true);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("a chat turn takes the route the window's own network stack would", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  // The fake provider stands in for the system proxy: a proxy is sent the request in absolute form, which is
  // how the assertion tells "went through the proxy" from "went straight to the provider".
  const proxy = await provider([text("via the system proxy")]);
  const win = fakeWindow();
  const asked = [];
  win.wc.session = {
    resolveProxy: async (url) => {
      asked.push(url);
      return `PROXY ${new URL(proxy.endpoint).host}; DIRECT`;
    },
  };
  globalThis.agentRuntime = win.api;
  const endpoint = "http://provider.invalid/v1/chat/completions";
  try {
    const r = await runTurnInRuntime(
      // A renderer that names its own route is overruled, exactly as it is for the workspace.
      { ...params(endpoint), provider: { endpoint, apiKey: "k", model: "m", stream: false, proxy: "direct" } },
      { runTool: async () => ({ ok: true, content: "" }) },
    );
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(r.content, "via the system proxy");
    assert.deepEqual(asked, [endpoint], "the route must come from the window's own session");
    assert.equal(proxy.urls[0], endpoint);
  } finally {
    delete globalThis.agentRuntime;
    await proxy.close();
  }
});

test("Chromium's proxy answers translate to routes the runtime can take", () => {
  assert.equal(routeFromChromium("DIRECT"), "direct");
  assert.equal(routeFromChromium("PROXY 127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(routeFromChromium("PROXY proxy.corp:8080; DIRECT"), "http://proxy.corp:8080", "the first choice wins");
  assert.equal(routeFromChromium("HTTPS secure.corp:443"), "https://secure.corp:443");
  // SOCKS as Chromium resolves it: host names through a SOCKS5 proxy, locally for SOCKS4.
  assert.equal(routeFromChromium("SOCKS5 127.0.0.1:1080"), "socks5h://127.0.0.1:1080");
  assert.equal(routeFromChromium("SOCKS 127.0.0.1:1080"), "socks4://127.0.0.1:1080");
  assert.equal(routeFromChromium("SOCKS4 127.0.0.1:1080; DIRECT"), "socks4://127.0.0.1:1080");
  assert.equal(routeFromChromium("QUIC 127.0.0.1:443"), null, "anything unrecognised is left to the environment");
  assert.equal(routeFromChromium(""), null);
  assert.equal(routeFromChromium(undefined), null);
  assert.equal(routeFromChromium("PROXY"), null);
});

// ── Round context: what the chat page needs to keep its own habits once the loop is not its own ──────

test("the window hears what the last round ran, and its nudge rides the latest tool result", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text("done")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const asked = [];
  try {
    const r = await runTurnInRuntime(params(p.endpoint), {
      runTool: async () => ({ ok: true, content: "three results" }),
      round: async (info) => {
        asked.push(info);
        return info.round === 1 ? { nudge: "<system-reminder>\nREVIEW IT\n</system-reminder>" } : {};
      },
    });
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    const before1 = asked.find((i) => i.round === 1 && !i.final);
    assert.deepEqual(before1.last.calls, [{ id: "c1", name: "web_search", args: { query: "q" }, ok: true }]);
    assert.equal(before1.last.contentEmpty, true);
    assert.ok(asked.some((i) => i.final), "asked once more after the final answer");
    // Joined the way materializeReminders joins a reminder, so the next turn replays these exact bytes.
    const tool = p.seen[1].messages.find((m) => m.role === "tool");
    assert.equal(tool.content, "three results\n\n<system-reminder>\nREVIEW IT\n</system-reminder>");
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("a silent final answer goes back for another round when the window says so", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "web_search", { query: "q" }), text(""), text("the answer")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  let resumed = false;
  try {
    const r = await runTurnInRuntime(params(p.endpoint), {
      runTool: async () => ({ ok: true, content: "found it" }),
      round: async (info) => {
        if (info.final && info.last?.contentEmpty && !resumed) {
          resumed = true;
          return { resume: true, nudge: "ANSWER FROM WHAT YOU HAVE" };
        }
        return {};
      },
    });
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(r.content, "the answer");
    assert.equal(p.seen.length, 3);
    // The empty assistant turn stays out of the request: several providers refuse one.
    assert.ok(!p.seen[2].messages.some((m) => m.role === "assistant" && !m.tool_calls && !m.content));
    assert.match(p.seen[2].messages.find((m) => m.role === "tool").content, /ANSWER FROM WHAT YOU HAVE$/);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("the reply reaches the window before its tool results, in the shape the chat stores", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const p = await provider([call("c1", "read_file", { path: "note.txt" }), text("done")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  const log = [];
  let response;
  try {
    await runTurnInRuntime(params(p.endpoint), {
      runTool: async () => ({ ok: true, content: "" }),
      onRound: (e) => {
        log.push(`round:${e.phase}`);
        if (e.phase === "response" && !response) response = e;
      },
      onTool: (e) => log.push(`tool:${e.phase}`),
    });
    assert.ok(log.indexOf("round:response") < log.indexOf("tool:end"), log.join(" "));
    assert.deepEqual(response.tool_calls, [
      { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) } },
    ]);
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("tools the window names as parallel-safe run side by side", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const both = {
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: ["a", "b"].map((q, i) => ({ id: `c${i}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: q }) } })),
      },
    }],
  };
  const p = await provider([both, text("done")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  let running = 0;
  let most = 0;
  try {
    const r = await runTurnInRuntime({ ...params(p.endpoint), parallelTools: ["web_search"] }, {
      runTool: async () => {
        most = Math.max(most, ++running);
        await new Promise((done) => setTimeout(done, 300));
        running -= 1;
        return { ok: true, content: "ok" };
      },
    });
    assert.equal(r.stop_reason, "completed", JSON.stringify(r));
    assert.equal(most, 2, "both searches were in flight at once");
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});

test("thinking is replayed within the turn when the window asks", async (t) => {
  if (!(await canHoldAChatTurn())) return t.skip("no runtime that can hold a turn");
  const thinking = call("c1", "web_search", { query: "q" });
  thinking.choices[0].message.reasoning_content = "WEIGHING IT";
  const p = await provider([thinking, text("done")]);
  const win = fakeWindow();
  globalThis.agentRuntime = win.api;
  try {
    await runTurnInRuntime({ ...params(p.endpoint), replayReasoning: true }, {
      runTool: async () => ({ ok: true, content: "ok" }),
    });
    const assistant = p.seen[1].messages.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "WEIGHING IT");
  } finally {
    delete globalThis.agentRuntime;
    await p.close();
  }
});
