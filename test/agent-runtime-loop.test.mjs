/**
 * The automation turn, run inside the Rust runtime.
 *
 * Covers the seam rather than the loop: `agent-runtime`'s own tests already prove the cycle works, and what
 * these check is the part only the host can be wrong about — that an agent node's rules still hold when the
 * node is no longer the thing driving the rounds. The tool policy, the refusal of interactive tools, the
 * NodeEvent timeline and the round budget are the automation's, and each had to be re-expressed through a
 * protocol seam to survive the move.
 *
 * Skipped when the sidecar cannot serve the turn — not built, too old, or turned off. That is the same
 * condition under which the app falls back to the loop in turn.mjs, so skipping here is honest: there is
 * nothing of this path to test on a machine where it would not run either.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgentTurn } from "../electron/agent/turn.mjs";
import { hasFeature, setSessionPolicyProvider, shutdown } from "../electron/tools/rustRuntime.mjs";

/**
 * What a real OpenAI-compatible provider would refuse in this request body, or null.
 *
 * The fakes used to accept anything, and a runtime that replayed every tool call as `{ id, name, arguments }`
 * passed every test here while no real provider would take its second request.
 */
function wireProblem(body) {
  for (const m of body?.messages ?? []) {
    for (const tc of m.tool_calls ?? []) {
      if (tc?.type !== "function" || typeof tc?.function?.name !== "string" || typeof tc.function.arguments !== "string") {
        return `messages[].tool_calls[] must be { id, type: "function", function: { name, arguments } }; got ${JSON.stringify(tc)}`;
      }
    }
  }
  return null;
}

/**
 * An OpenAI-compatible endpoint that replies with a scripted sequence, one response per request.
 *
 * `billed: true` serves it over IPv6 loopback instead of `127.0.0.1`. That is not a transport detail — turn.mjs
 * reads the endpoint to decide whether a model is LOCAL, and a local model is deliberately exempt from the
 * round ceiling and reports 0 tokens to the Policy Guard (see LOCAL_MAX_ROUNDS). A test for a round budget
 * served from 127.0.0.1 would be testing the exemption, not the budget.
 */
function fakeProvider(script, { billed = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body || "{}"));
      const problem = wireProblem(seen[seen.length - 1]);
      if (problem) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: problem } }));
        return;
      }
      const next = script.shift() ?? { choices: [{ message: { content: "out of script" } }] };
      // `{ status, body }` scripts a refusal; anything else is a 200 carrying that response.
      if (next.status) {
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next.body ?? {}));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 }, ...next }));
    });
  });
  const host = billed ? "::1" : "127.0.0.1";
  return new Promise((resolve) => {
    server.listen(0, host, () =>
      resolve({
        endpoint: `http://${billed ? "[::1]" : "127.0.0.1"}:${server.address().port}/v1/chat/completions`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

const text = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
const callTool = (id, name, args) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});

const declare = (name) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

/** The transport the loop in turn.mjs would use. Calling it means the turn did NOT run in the runtime. */
const llmChatMustNotBeCalled = () => {
  throw new Error("the turn fell back to the JavaScript loop");
};

let workdir = "";
// Declared at the handshake the way the app declares its boot workspace, and deliberately NOT the run's
// workspace: a runtime with no declared policy is fail-closed and would deny every tool it executes itself,
// and a runtime whose boot root equals the run's would hide the ceiling regression the app had.
const bootRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-auto-boot-"));
setSessionPolicyProvider(() => ({ workspaceRoots: [bootRoot] }));
test.before(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-auto-"));
});
test.after(async () => {
  await shutdown();
  fs.rmSync(workdir, { recursive: true, force: true });
});

/** Whether this machine has a sidecar that can hold a whole turn. */
async function runtimeCanHoldATurn() {
  return (await hasFeature("agent.host_tools")) && (await hasFeature("agent.round_gate"));
}

test("an agent node's turn runs inside the runtime, with its tools served by the host", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  const provider = await fakeProvider([callTool("c1", "web_search", { query: "zeraix" }), text("found three")], {
    billed: true,
  });
  const events = [];
  const calls = [];
  const modelCalls = [];
  try {
    const r = await runAgentTurn({
      prompt: "look it up",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("web_search")],
      runTool: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, content: "three results" };
      },
      getWorkdir: () => workdir,
      onModelCall: (c) => modelCalls.push(c),
      onEvent: (e) => events.push(e),
    });

    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    assert.equal(r.text, "found three");
    // The host ran the tool the runtime does not implement, with the model's own arguments.
    assert.deepEqual(calls, [{ name: "web_search", args: { query: "zeraix" } }]);
    // The timeline still pairs up, which is what the run's log is built from.
    const toolEvents = events.filter((e) => e.type?.startsWith("tool:"));
    assert.deepEqual(
      toolEvents.map((e) => e.type),
      ["tool:started", "tool:finished"],
    );
    assert.equal(toolEvents[1].ok, true);
    // Usage reaches the Policy Guard, which is how a budget is enforced at all.
    assert.ok(events.some((e) => e.type === "usage" && e.tokens > 0), "no usage was reported");
    // Two rounds at 10 + 5 each. Exact rather than ">0": the last round of a turn is never seen by a round
    // gate — there is no round after it to ask about — so counting it has to come from the result instead,
    // and ">0" would pass while silently losing the final (often largest) model call of every turn.
    assert.equal(r.usage.promptTokens, 20);
    assert.equal(r.usage.completionTokens, 10);
    assert.equal(r.usage.totalTokens, 30);

    // The temperature this loop has always sent. The runtime's provider omits temperature unless told, so
    // without it every automation step would quietly move to whatever the provider defaults to.
    assert.equal(provider.seen[0].temperature, 0.2);

    // The usage log. Model calls made inside the runtime never pass through the proxy that logs the rest, so
    // without this an automation's tool calls keep appearing in the log while its model calls vanish.
    assert.equal(modelCalls.length, 2, `expected one entry per round: ${JSON.stringify(modelCalls)}`);
    assert.equal(modelCalls[0].model, "m");
    assert.equal(modelCalls[0].promptTokens, 10);
    assert.equal(modelCalls[0].completionTokens, 5);
  } finally {
    await provider.close();
  }
});

test("a tool the RUNTIME executes still appears on the node's timeline", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // Every other test here uses a host-served tool, which reports itself through runOneTool. A tool the
  // runtime runs on its own never reaches the host — and running an automation in the app showed a node
  // that listed a directory with no tool on its timeline at all, and nothing in the usage log.
  fs.writeFileSync(path.join(workdir, "visible.txt"), "x");
  const provider = await fakeProvider([callTool("c1", "list_directory", { path: "." }), text("listed")]);
  const events = [];
  try {
    const r = await runAgentTurn({
      prompt: "list it",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("list_directory")],
      runTool: async () => {
        throw new Error("list_directory is the runtime's own tool and must not be handed to the host");
      },
      getWorkdir: () => workdir,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);

    const tools = events.filter((e) => e.type?.startsWith("tool:"));
    assert.deepEqual(
      tools.map((e) => `${e.type}:${e.name}`),
      ["tool:started:list_directory", "tool:finished:list_directory"],
      "reported exactly once — by the runtime's events, not also by the host",
    );
    const finished = tools[1];
    assert.equal(finished.ok, true, `the listing failed: ${finished.error ?? ""}`);
    assert.match(finished.preview, /visible\.txt/, "the timeline must show what the tool returned");
    assert.deepEqual(tools[0].args, { path: "." });
  } finally {
    await provider.close();
  }
});

test("a system prompt reaches the model", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // The commonest shape an agent node has, and the one that would fail wholesale if the runtime's Message
  // did not accept the role — every node with a system prompt, all at once.
  const provider = await fakeProvider([text("understood")]);
  try {
    const r = await runAgentTurn({
      prompt: "do the thing",
      system: "You are a careful assistant.",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [],
      runTool: async () => ({ ok: true, content: "" }),
      getWorkdir: () => workdir,
      onEvent: () => {},
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    assert.deepEqual(
      provider.seen[0].messages.map((m) => m.role),
      ["system", "user"],
    );
    assert.equal(provider.seen[0].messages[0].content, "You are a careful assistant.");
  } finally {
    await provider.close();
  }
});

test("a tool that needs a human is refused, not run", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  const provider = await fakeProvider([callTool("c1", "ask_user", { question: "which one?" }), text("carried on")]);
  const events = [];
  let ran = false;
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      // Offered deliberately: buildToolList filters it out, and this proves the refusal holds even when a
      // model asks for it anyway — which is the case that matters, since the model can name any tool.
      listTools: async () => [declare("ask_user")],
      runTool: async () => {
        ran = true;
        return { ok: true, content: "should never happen" };
      },
      getWorkdir: () => workdir,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.ok, true);
    assert.equal(ran, false, "an unattended run must never reach a tool that needs a person");

    // Refused, and TOLD it was refused. `ask_user` is the one tool the runtime routes to a method of its own
    // rather than through the tool bridge, so it was the one that slipped past the run's policy and answered
    // the model with an empty list — which reads as a real answer and invites it to ask again.
    const result = provider.seen[1].messages.find((m) => m.role === "tool");
    assert.ok(result, `no tool result was sent back: ${JSON.stringify(provider.seen[1].messages)}`);
    assert.match(result.content, /needs a human/);
    // And it is on the timeline, where a blocked tool has to be visible or the node's behaviour is unexplained.
    const blocked = events.find((e) => e.type === "tool:finished" && e.name === "ask_user");
    assert.ok(blocked?.blocked, `the refusal must be reported: ${JSON.stringify(events)}`);
  } finally {
    await provider.close();
  }
});

test("the tool policy is applied to a call the runtime hands back", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  const provider = await fakeProvider([callTool("c1", "web_search", { query: "x" }), text("did without it")]);
  let ran = false;
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("web_search")],
      runTool: async () => {
        ran = true;
        return { ok: true, content: "nope" };
      },
      toolPolicy: { deny: ["web_search"] },
      getWorkdir: () => workdir,
      onEvent: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(ran, false, "a denied tool must not execute");
  } finally {
    await provider.close();
  }
});

test("a declared context window keeps a long node inside it", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // The capability existed in the runtime and nothing in the app switched it on. This is the test that the
  // window now travels: model entry → resolveChain → runAgentTurn → agent.run → ContextManager.
  const huge = "RESULT-BODY ".repeat(2000);
  const provider = await fakeProvider([
    callTool("c1", "web_search", { query: "a" }),
    text("answered from what fitted"),
  ]);
  try {
    const r = await runAgentTurn({
      prompt: "look it up",
      chain: [
        { label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m", contextWindow: 1000 },
      ],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("web_search")],
      runTool: async () => ({ ok: true, content: huge }),
      getWorkdir: () => workdir,
      onEvent: () => {},
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);

    // The second request is the one that carries the tool result. It must not carry all of it.
    assert.equal(provider.seen.length, 2);
    const sent = JSON.stringify(provider.seen[1].messages);
    assert.ok(
      sent.length < huge.length,
      `the tool output was sent whole despite a 1000-token window: ${sent.length} vs ${huge.length}`,
    );
    assert.ok(
      sent.includes("to make room"),
      `compaction should have left its marker, so the model knows output is missing: ${sent.slice(0, 300)}`,
    );
  } finally {
    await provider.close();
  }
});

test("no declared window means nothing is compacted", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // A model entry without a recorded window must behave exactly as before: the runtime is told nothing and
  // sends the conversation whole. A guessed window would shrink conversations that fitted perfectly well.
  const body = "RESULT-BODY ".repeat(2000);
  const provider = await fakeProvider([
    callTool("c1", "web_search", { query: "a" }),
    text("answered in full"),
  ]);
  try {
    const r = await runAgentTurn({
      prompt: "look it up",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("web_search")],
      runTool: async () => ({ ok: true, content: body }),
      getWorkdir: () => workdir,
      onEvent: () => {},
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    const sent = JSON.stringify(provider.seen[1].messages);
    assert.ok(sent.includes(body), "with no window declared the tool output must be sent whole");
  } finally {
    await provider.close();
  }
});

test("the round budget withdraws the tools and asks for a final answer", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  const provider = await fakeProvider(
    [callTool("c1", "web_search", { query: "a" }), text("answering with what I have")],
    { billed: true },
  );
  const events = [];
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [declare("web_search")],
      runTool: async () => ({ ok: true, content: "one result" }),
      maxRounds: 2,
      getWorkdir: () => workdir,
      onEvent: (e) => events.push(e),
    });

    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    assert.equal(r.text, "answering with what I have");
    // The second request is the answer round: no tools offered, and the instruction appended.
    assert.equal(provider.seen.length, 2);
    assert.ok(!provider.seen[1].tools?.length, "the final round must be offered no tools");
    const last = provider.seen[1].messages.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content, /entire tool budget/);
    assert.ok(
      events.some((e) => e.type === "log" && /round budget spent/.test(e.message ?? "")),
      "the budget stop must be visible on the timeline",
    );
  } finally {
    await provider.close();
  }
});

test("a provider that fails and recovers is retried, and the timeline says so", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // The loop in turn.mjs never retried: one 503 failed the node. The runtime retries it — which is only an
  // improvement if the run's log shows the wait, rather than a node that went quiet for a few seconds.
  const provider = await fakeProvider([
    { status: 503, body: { error: { message: "overloaded" } } },
    {
      ...text("recovered"),
      usage: { prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 32 } },
    },
  ]);
  const events = [];
  const modelCalls = [];
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [],
      runTool: async () => ({ ok: true, content: "" }),
      getWorkdir: () => workdir,
      onModelCall: (c) => modelCalls.push(c),
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    assert.equal(r.text, "recovered");
    assert.equal(provider.seen.length, 2, "one refused request, one retry");
    const warn = events.find((e) => e.type === "log" && /retrying/.test(e.message));
    assert.ok(warn, `the retry never reached the timeline: ${JSON.stringify(events)}`);
    assert.equal(warn.level, "warn");
    assert.match(warn.message, /attempt 2\/3/);
    // The usage log: ONE call, the one that answered — with the provider's cache hits, and not estimated.
    assert.equal(modelCalls.length, 1, JSON.stringify(modelCalls));
    assert.equal(modelCalls[0].cachedTokens, 32);
    assert.equal(modelCalls[0].estimated, false);
    assert.equal(modelCalls[0].ok, true);
  } finally {
    await provider.close();
  }
});

test("a request that fails for good is logged as a failed model call", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // A refusal ends the run before any round finishes, so no round event ever carries it. The proxy logs the
  // JavaScript loop's failures; without an entry here a node whose key was revoked left no model call behind.
  const provider = await fakeProvider([{ status: 401, body: { error: { message: "bad key" } } }]);
  const modelCalls = [];
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [],
      runTool: async () => ({ ok: true, content: "" }),
      getWorkdir: () => workdir,
      onModelCall: (c) => modelCalls.push(c),
      onEvent: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(provider.seen.length, 1, "a refused key is not retried");
    assert.equal(modelCalls.length, 1, JSON.stringify(modelCalls));
    assert.equal(modelCalls[0].ok, false);
    assert.match(modelCalls[0].error, /401|bad key/);
  } finally {
    await provider.close();
  }
});

test("a provider that reports no usage is counted, and the log says it was estimated", async (t) => {
  if (!(await runtimeCanHoldATurn())) return t.skip("no runtime that can hold a turn");
  // Many local servers and some gateways send no `usage`. Logged as zero, their calls looked free; counted
  // without a mark, the count would read as a bill.
  const provider = await fakeProvider([{ ...text("counted"), usage: undefined }]);
  const modelCalls = [];
  try {
    const r = await runAgentTurn({
      prompt: "go",
      chain: [{ label: "test", endpoint: provider.endpoint, apiKey: "k", model: "m" }],
      llmChat: llmChatMustNotBeCalled,
      listTools: async () => [],
      runTool: async () => ({ ok: true, content: "" }),
      getWorkdir: () => workdir,
      onModelCall: (c) => modelCalls.push(c),
      onEvent: () => {},
    });
    assert.equal(r.ok, true, `turn failed: ${r.error ?? ""}`);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].estimated, true);
    assert.ok(modelCalls[0].promptTokens > 0, "an estimate of zero is not an estimate");
    assert.ok(modelCalls[0].completionTokens > 0);
  } finally {
    await provider.close();
  }
});
