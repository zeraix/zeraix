/**
 * Headless agent turn-loop tests.
 *
 * The LLM transport is faked (a scripted sequence of responses) so the loop's real behaviour --
 * round progression, tool dispatch, fallback, refusal of interactive tools -- is exercised without
 * a network call. Tool execution goes through an injected runTool, mirroring how the real runtime
 * receives aiToolkit's implementation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentTurn, isToolAllowed, INTERACTIVE_TOOLS } from "../electron/agent/turn.mjs";
import { interpolate } from "../electron/automation/runtimes/agent.mjs";
import {
  setLlmConfigReader,
  resolveModel,
  resolveChain,
  listModels,
  isLocalEndpoint,
} from "../electron/agent/modelResolver.mjs";

/* ----------------------------------------------------------------- fake transport */

/** A fake llmChat that replays scripted responses and records the requests it received. */
function scriptedLlm(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (req) => {
    calls.push(req);
    const next = queue.shift();
    if (!next) throw new Error("scriptedLlm ran out of responses");
    return typeof next === "function" ? next(req) : next;
  };
  fn.calls = calls;
  return fn;
}

const say = (content, usage) => ({
  ok: true,
  status: 200,
  data: { choices: [{ message: { role: "assistant", content } }], ...(usage ? { usage } : {}) },
});

const callTool = (name, args = {}, id = "c1") => ({
  ok: true,
  status: 200,
  data: {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  },
});

const httpError = (status, error) => ({ ok: false, status, error });

const noTools = async () => [];
const baseDeps = {
  prompt: "do the thing",
  chain: [{ id: "m1", label: "Model One", endpoint: "https://api.example/v1/chat/completions", apiKey: "k", model: "gpt-x" }],
  listTools: noTools,
  runTool: async () => "ok",
};

/* ------------------------------------------------------------------- turn loop */

test("returns the model's final answer", async () => {
  const llmChat = scriptedLlm([say("the answer")]);
  const res = await runAgentTurn({ ...baseDeps, llmChat });

  assert.ok(res.ok, res.error);
  assert.equal(res.text, "the answer");
  assert.equal(res.rounds, 1);
  assert.equal(res.modelUsed, "Model One");
});

test("executes a tool call and feeds the result back", async () => {
  const llmChat = scriptedLlm([callTool("read_file", { path: "a.txt" }), say("file says hi")]);
  const executed = [];
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "read_file" } }],
    runTool: async (name, args) => {
      executed.push({ name, args });
      return "hi";
    },
  });

  assert.ok(res.ok, res.error);
  assert.equal(res.rounds, 2);
  assert.deepEqual(executed, [{ name: "read_file", args: { path: "a.txt" } }]);

  // The assistant turn must be echoed back before the tool result, or providers reject the request
  // for having a tool message with no matching tool_calls.
  const second = llmChat.calls[1].body.messages;
  const assistantIdx = second.findIndex((m) => m.role === "assistant");
  const toolIdx = second.findIndex((m) => m.role === "tool");
  assert.ok(assistantIdx >= 0 && toolIdx > assistantIdx);
  assert.equal(second[toolIdx].tool_call_id, "c1");
});

test("refuses interactive tools instead of hanging", async () => {
  // An unattended run has nobody to answer ask_user; blocking would burn the node's whole timeout.
  const llmChat = scriptedLlm([callTool("ask_user", { question: "which one?" }), say("proceeded alone")]);
  let ran = false;
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    runTool: async () => { ran = true; return "x"; },
  });

  assert.ok(res.ok, res.error);
  assert.equal(ran, false, "ask_user must never reach runTool");
  const toolMsg = llmChat.calls[1].body.messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /needs a human/);
});

test("interactive tools are not even offered to the model", async () => {
  const llmChat = scriptedLlm([say("done")]);
  await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "ask_user" } },
      { type: "function", function: { name: "browser" } },
    ],
  });

  const offered = (llmChat.calls[0].body.tools ?? []).map((t) => t.function.name);
  assert.deepEqual(offered, ["read_file"]);
});

test("a denied tool is reported to the model rather than executed", async () => {
  const llmChat = scriptedLlm([callTool("run_command", { cmd: "rm -rf /" }), say("ok then")]);
  let ran = false;
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "run_command" } }],
    runTool: async () => { ran = true; return "x"; },
    toolPolicy: { deny: ["run_command"] },
  });

  assert.ok(res.ok);
  assert.equal(ran, false);
  assert.match(llmChat.calls[1].body.messages.find((m) => m.role === "tool").content, /not permitted/);
});

test("a tool that throws becomes a message the model can recover from", async () => {
  // Aborting the whole run on a tool error would waste everything done so far.
  const llmChat = scriptedLlm([callTool("read_file", { path: "missing" }), say("recovered")]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "read_file" } }],
    runTool: async () => { throw new Error("ENOENT"); },
  });

  assert.ok(res.ok);
  assert.match(llmChat.calls[1].body.messages.find((m) => m.role === "tool").content, /ENOENT/);
});

test("malformed tool arguments are reported, not thrown", async () => {
  const llmChat = scriptedLlm([
    { ok: true, status: 200, data: { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{not json" } }] } }] } },
    say("ok"),
  ]);
  const res = await runAgentTurn({ ...baseDeps, llmChat, listTools: async () => [{ type: "function", function: { name: "read_file" } }] });
  assert.ok(res.ok);
  assert.match(llmChat.calls[1].body.messages.find((m) => m.role === "tool").content, /not valid JSON/);
});

test("falls back to the next model when the first fails", async () => {
  const llmChat = scriptedLlm([httpError(500, "upstream boom"), say("second model answered")]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    chain: [
      { id: "m1", label: "Primary", endpoint: "https://a/v1/chat/completions", apiKey: "k", model: "a" },
      { id: "m2", label: "Backup", endpoint: "https://b/v1/chat/completions", apiKey: "k", model: "b" },
    ],
  });

  assert.ok(res.ok, res.error);
  assert.equal(res.text, "second model answered");
  assert.equal(res.modelUsed, "Backup");
  assert.equal(llmChat.calls[1].endpoint, "https://b/v1/chat/completions");
});

test("reports failure when every model in the chain fails", async () => {
  const llmChat = scriptedLlm([httpError(500, "a down"), httpError(503, "b down")]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    chain: [
      { id: "m1", label: "Primary", endpoint: "https://a", apiKey: "k", model: "a" },
      { id: "m2", label: "Backup", endpoint: "https://b", apiKey: "k", model: "b" },
    ],
  });
  assert.ok(!res.ok);
  assert.match(res.error, /503|b down/);
});

test("stops at the round ceiling instead of looping forever", async () => {
  // A model stuck calling the same tool must fail loudly, not burn the budget silently.
  const llmChat = scriptedLlm(Array.from({ length: 10 }, () => callTool("read_file", {})));
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "read_file" } }],
    maxRounds: 3,
  });

  assert.ok(!res.ok);
  assert.match(res.error, /within 3 rounds/);
  assert.equal(llmChat.calls.length, 3, "must not retry the ceiling on a fallback model");
});

test("reports what each tool was called with and what came back", async () => {
  // The timeline is read to answer one question — what did it search for, and what did it get. A
  // bare "tool: web_search" line cannot answer either.
  const events = [];
  const llmChat = scriptedLlm([callTool("web_search", { query: "competitor pricing", count: 6 }), say("done")]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "web_search" } }],
    runTool: async () => "result one\nresult two",
    onEvent: (e) => events.push(e),
  });

  assert.ok(res.ok);
  const started = events.find((e) => e.type === "tool:started");
  assert.equal(started.name, "web_search");
  assert.equal(started.args.query, "competitor pricing");

  const finished = events.find((e) => e.type === "tool:finished");
  assert.equal(finished.ok, true);
  assert.equal(finished.preview, "result one\nresult two");
  assert.equal(finished.chars, "result one\nresult two".length);
  assert.equal(typeof finished.ms, "number");
});

test("keeps secret-looking tool arguments out of the event log", async () => {
  // These values were chosen by the model, so nothing upstream vetted them, and the log is durable.
  const events = [];
  const llmChat = scriptedLlm([callTool("fetch_url", { url: "https://x.test", api_key: "sk-live-123" }), say("done")]);
  await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "fetch_url" } }],
    onEvent: (e) => events.push(e),
  });

  const started = events.find((e) => e.type === "tool:started");
  assert.equal(started.args.api_key, "[redacted]");
  assert.equal(started.args.url, "https://x.test", "non-secret arguments must survive intact");
});

test("a blocked tool is visible in the timeline, not just to the model", async () => {
  // A policy that silently removes the one tool a step needed shows up only as a strange final
  // answer, with nothing on screen naming the cause.
  const events = [];
  const llmChat = scriptedLlm([callTool("write_file", { path: "out.md" }), say("done")]);
  await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "write_file" } }],
    toolPolicy: { deny: ["write_file"] },
    onEvent: (e) => events.push(e),
  });

  const finished = events.find((e) => e.type === "tool:finished");
  assert.equal(finished.ok, false);
  assert.equal(finished.blocked, true);
  assert.match(finished.error, /tool policy/);
});

test("spends the last round asking for an answer instead of more tool calls", async () => {
  // A research step that used its whole budget has usually gathered what it needed and simply never
  // stopped. Failing there throws away every tool call the node already paid for.
  const llmChat = scriptedLlm([
    callTool("read_file", {}),
    callTool("read_file", {}),
    say('["a","b"]'),
  ]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "read_file" } }],
    maxRounds: 3,
  });

  assert.ok(res.ok);
  assert.deepEqual(JSON.parse(res.text), ["a", "b"]);
  // The final request must offer no tools at all — leaving them on the table is what the model keeps
  // reaching for, and "please stop" alone does not reliably stop it.
  const last = llmChat.calls.at(-1).body;
  assert.equal(last.tools, undefined);
  assert.match(last.messages.at(-1).content, /entire tool budget/);
});

test("an empty final message is a failure, not an empty success", async () => {
  // Otherwise a downstream node reading this node's `text` would silently receive "".
  const llmChat = scriptedLlm([say("   ")]);
  const res = await runAgentTurn({ ...baseDeps, llmChat });
  assert.ok(!res.ok);
  assert.match(res.error, /empty final message/);
});

test("stops promptly when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const llmChat = scriptedLlm([say("should not be reached")]);
  const res = await runAgentTurn({ ...baseDeps, llmChat, signal: controller.signal });
  assert.ok(!res.ok);
  assert.equal(res.error, "cancelled");
  assert.equal(llmChat.calls.length, 0);
});

test("accumulates token usage across rounds", async () => {
  const llmChat = scriptedLlm([
    { ...callTool("read_file", {}), data: { ...callTool("read_file", {}).data, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } },
    say("done", { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }),
  ]);
  const res = await runAgentTurn({
    ...baseDeps,
    llmChat,
    listTools: async () => [{ type: "function", function: { name: "read_file" } }],
  });
  assert.ok(res.ok, res.error);
  assert.equal(res.usage.totalTokens, 39);
});

/* --------------------------------------------------------------- tool policy */

test("isToolAllowed: deny wins over allow", () => {
  assert.equal(isToolAllowed("x", undefined), true);
  assert.equal(isToolAllowed("x", { allow: ["x"] }), true);
  assert.equal(isToolAllowed("y", { allow: ["x"] }), false);
  assert.equal(isToolAllowed("x", { deny: ["x"] }), false);
  assert.equal(isToolAllowed("x", { allow: ["x"], deny: ["x"] }), false);
});

test("INTERACTIVE_TOOLS covers the human-in-the-loop tools", () => {
  for (const t of ["ask_user", "browser", "image_generation"]) {
    assert.ok(INTERACTIVE_TOOLS.includes(t), `${t} must be blocked headless`);
  }
});

/* ------------------------------------------------------------ prompt templating */

test("interpolate substitutes inputs and leaves unknown placeholders alone", () => {
  assert.equal(interpolate("Summarize: {{inputs.text}}", { text: "abc" }), "Summarize: abc");
  assert.equal(interpolate("{{ inputs.text }}", { text: "abc" }), "abc");
  // A typo must stay visible rather than becoming "undefined".
  assert.equal(interpolate("{{inputs.typo}}", { text: "abc" }), "{{inputs.typo}}");
  assert.equal(interpolate("{{inputs.n}}", { n: 42 }), "42");
});

/* -------------------------------------------------------------- model resolver */

test("model resolver reads app.config's [llm] section", async (t) => {
  const models = [
    { id: "official::gpt", providerId: "official", model: "gpt", label: "Official GPT", endpoint: "https://api.zeraix/v1/chat/completions", custom: false },
    { id: "custom::abc", providerId: "custom", model: "llama", label: "My Local", endpoint: "http://127.0.0.1:8080/v1/chat/completions", custom: true },
    { id: "acme::big", providerId: "acme", model: "big", label: "Acme Big", endpoint: "https://acme/v1/chat/completions", custom: false },
    { id: "broken::x", providerId: "acme", model: "x", label: "No Endpoint", custom: false },
  ];
  setLlmConfigReader(() => ({
    model_list: JSON.stringify(models),
    selected_model: "official::gpt",
    key_acme: "acme-key",
  }));

  await t.test("lists models", () => assert.equal(listModels().length, 4));

  await t.test("resolves by id, model string and label", () => {
    assert.equal(resolveModel("official::gpt").config.model, "gpt");
    assert.equal(resolveModel("big").config.id, "acme::big");
    assert.equal(resolveModel("acme big").config.id, "acme::big");
  });

  await t.test("uses the selected model when none is named", () => {
    assert.equal(resolveModel(undefined).config.id, "official::gpt");
  });

  await t.test("attaches the provider's API key", () => {
    assert.equal(resolveModel("acme::big").config.apiKey, "acme-key");
  });

  await t.test("a local endpoint needs no key", () => {
    assert.ok(isLocalEndpoint("http://127.0.0.1:8080/v1/chat/completions"));
    assert.ok(resolveModel("custom::abc").ok);
  });

  await t.test("a remote model with no key is refused with a clear reason", () => {
    setLlmConfigReader(() => ({ model_list: JSON.stringify([models[2]]) }));
    const res = resolveModel("acme::big");
    assert.ok(!res.ok);
    assert.match(res.error, /no API key/);
    setLlmConfigReader(() => ({ model_list: JSON.stringify(models), selected_model: "official::gpt", key_acme: "acme-key" }));
  });

  await t.test("a model with no recorded endpoint says what to do", () => {
    const res = resolveModel("broken::x");
    assert.ok(!res.ok);
    assert.match(res.error, /no endpoint recorded/);
  });

  await t.test("an unknown model is refused", () => {
    assert.match(resolveModel("nope").error, /not configured/);
  });

  await t.test("resolveChain keeps working models and reports the skipped ones", () => {
    const res = resolveChain({ model: "official::gpt", fallbackModels: ["nope", "acme::big"] });
    assert.ok(res.ok);
    assert.deepEqual(res.chain.map((c) => c.id), ["official::gpt", "acme::big"]);
    assert.equal(res.skipped.length, 1);
  });

  await t.test("resolveChain fails when nothing resolves", () => {
    const res = resolveChain({ model: "nope", fallbackModels: ["also-nope"] });
    assert.ok(!res.ok);
  });

  await t.test("malformed model_list degrades to empty rather than throwing", () => {
    setLlmConfigReader(() => ({ model_list: "{not json" }));
    assert.deepEqual(listModels(), []);
  });

  setLlmConfigReader(null);
});
