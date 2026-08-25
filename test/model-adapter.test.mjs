/**
 * Model Adapter (docs/agent-runtime-loop.md §5, §5.1, §6.1, §6.3) — milestone M1.
 *
 * Two things are pinned here, and the second is the one that matters.
 *
 * The first is that capability reporting is HONEST. A capability flag exists so the Runtime can plan around
 * it, so a flag that reports an ability the provider does not have is worse than no flag at all: it makes the
 * Runtime offer the model a knob that silently does nothing (§6.2 requires that to degrade, not to pretend).
 *
 * The second is `clampEffort`, which is the whole of §6's safety rule in one function. The Runtime may
 * economise on routine turns and may never spend beyond what the user allowed, never switch thinking on when
 * the user switched it off, and never reduce effort for recovery. Every one of those is a way to silently
 * override a user's explicit setting, which §20 rule 4 forbids outright — so each gets its own case here.
 *
 * The scripted adapter is tested too, because §18's determinism claim rests on it: if its ids or its
 * exhaustion behaviour drift, every later milestone's test drifts with them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { describeCapabilities, normalizeChatResponse, createModelAdapter, clampEffort } = await import(
  "../src/lib/agent/modelAdapter.ts"
);
const { createScriptedAdapter, FIXTURES } = await import("../src/lib/agent/testModelAdapter.ts");

const model = (over = {}) => ({ model: "gpt-5", local: false, multimodal: false, ...over });

// ── Capabilities ────────────────────────────────────────────────────────────────────────────────────────

test("a provider that rejected the thinking parameter is reported as unable to reason", () => {
  assert.equal(describeCapabilities(model()).supportsReasoning, true);
  // The point of the flag: once the provider has actually said no, the Runtime must stop planning around it.
  assert.equal(describeCapabilities(model({ thinkingRejected: true })).supportsReasoning, false);
  assert.equal(describeCapabilities(model({ thinkingRejected: true })).supportsPerTurnReasoningEffort, false);
});

test("an unrecognised model can still reason, but not at a chosen effort", () => {
  // thinkingParams treats an unknown id as opt-in and sends reasoning_effort, so "can reason" is true...
  const caps = describeCapabilities(model({ model: "some-gateway-alias-v3" }));
  assert.equal(caps.supportsReasoning, true);
  // ...but nothing confirms the knob is honoured, so the per-turn override must not be offered for it.
  assert.equal(caps.supportsPerTurnReasoningEffort, false);
});

test("a local model can be told whether to think, not how hard", () => {
  const caps = describeCapabilities(model({ model: "qwen3-30b", local: true }));
  assert.equal(caps.supportsReasoning, true);
  // chat_template_kwargs.enable_thinking is a boolean. Offering an effort tool here would do nothing at all.
  assert.equal(caps.supportsPerTurnReasoningEffort, false);
});

test("structured output is reported false, because nothing in the app has ever asked for it", () => {
  for (const id of ["gpt-5", "claude-opus-4", "gemini-2.5-pro", "qwen3-30b"]) {
    assert.equal(describeCapabilities(model({ model: id })).supportsStructuredOutput, false, id);
  }
});

test("per-turn effort is recognised for the families whose spelling carries it", () => {
  for (const id of ["gpt-5", "o3", "gemini-2.5-pro", "claude-sonnet-4"]) {
    assert.equal(describeCapabilities(model({ model: id })).supportsPerTurnReasoningEffort, true, id);
  }
});

test("image support is reported, never inferred", () => {
  assert.equal(describeCapabilities(model({ multimodal: true })).supportsImages, true);
  assert.equal(describeCapabilities(model({ multimodal: false })).supportsImages, false);
});

// ── Reasoning params pass through to the real family table ──────────────────────────────────────────────

test("the adapter defers request spelling to thinking.ts rather than restating it", () => {
  const gpt = createModelAdapter(model({ model: "gpt-5" }));
  assert.deepEqual(gpt.reasoningParams({ enabled: true, effort: "high", sendContext: false }), {
    reasoning_effort: "high",
  });
  // GPT-5 reasons by default, so "off" is an argument in its own right — the table's job, and it still is.
  assert.deepEqual(gpt.reasoningParams({ enabled: false, effort: "high", sendContext: false }), {
    reasoning_effort: "none",
  });
  const local = createModelAdapter(model({ model: "qwen3-30b", local: true }));
  assert.deepEqual(local.reasoningParams({ enabled: true, effort: "low", sendContext: false }), {
    chat_template_kwargs: { enable_thinking: true },
  });
});

// ── Response normalization ──────────────────────────────────────────────────────────────────────────────

test("both reasoning field spellings are read, and absence is an empty string", () => {
  assert.equal(normalizeChatResponse({ choices: [{ message: { role: "assistant", content: "x", reasoning_content: "why" } }] }).reasoning, "why");
  assert.equal(normalizeChatResponse({ choices: [{ message: { role: "assistant", content: "x", reasoning: "why" } }] }).reasoning, "why");
  assert.equal(normalizeChatResponse({ choices: [{ message: { role: "assistant", content: "x" } }] }).reasoning, "");
});

test("a null content and a missing tool_calls normalize to values callers can use unguarded", () => {
  const n = normalizeChatResponse({ choices: [{ message: { role: "assistant", content: null } }] });
  assert.equal(n.content, "");
  assert.deepEqual(n.toolCalls, [], "an empty array is the loop's exit condition; undefined would throw");
});

test("an empty response does not throw", () => {
  const n = normalizeChatResponse({});
  assert.equal(n.content, "");
  assert.deepEqual(n.toolCalls, []);
});

// ── clampEffort: §6's rule, in full ─────────────────────────────────────────────────────────────────────

const user = (enabled, effort) => ({ enabled, effort, sendContext: false });

test("thinking off is never turned on, by any phase or any model request", () => {
  const off = user(false, "medium");
  assert.deepEqual(clampEffort(off, "high"), off);
  assert.deepEqual(clampEffort(off, "low"), off);
  assert.deepEqual(clampEffort(off, null), off);
});

test("effort is only ever reduced, never raised above what the user allowed", () => {
  assert.equal(clampEffort(user(true, "medium"), "low").effort, "low", "economising is allowed");
  assert.equal(clampEffort(user(true, "medium"), "high").effort, "medium", "the user's setting is the ceiling");
  assert.equal(clampEffort(user(true, "low"), "high").effort, "low");
});

test("no request means the user's configured effort, unchanged", () => {
  // This is the recovery / verification path from §6.3: those phases never reduce, so they pass null.
  assert.deepEqual(clampEffort(user(true, "high"), null), user(true, "high"));
});

test("clamping preserves the rest of the config", () => {
  const cfg = { enabled: true, effort: "high", sendContext: true };
  assert.equal(clampEffort(cfg, "low").sendContext, true, "sendContext is a separate setting and is not touched");
});

test("a nonsense effort is ignored rather than applied", () => {
  assert.deepEqual(clampEffort(user(true, "medium"), "extreme"), user(true, "medium"));
});

// ── The scripted adapter itself ─────────────────────────────────────────────────────────────────────────

test("the script is played in order and ends with a final turn", () => {
  const a = createScriptedAdapter(FIXTURES.singleTool);
  const first = a.respond(user(true, "medium"));
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(first.toolCalls[0].function.arguments), { path: "a.ts" });
  const second = a.respond(user(true, "medium"));
  assert.deepEqual(second.toolCalls, [], "no tool calls is how the loop is meant to end");
  assert.match(second.content, /two exports/);
});

test("tool-call ids are deterministic, so pairing assertions are stable", () => {
  const one = createScriptedAdapter(FIXTURES.parallelTools).respond(user(true, "medium"));
  const two = createScriptedAdapter(FIXTURES.parallelTools).respond(user(true, "medium"));
  assert.deepEqual(
    one.toolCalls.map((c) => c.id),
    two.toolCalls.map((c) => c.id),
  );
  assert.equal(new Set(one.toolCalls.map((c) => c.id)).size, 3, "ids within a turn are distinct");
});

test("every request is recorded with the effort it was issued at", () => {
  const a = createScriptedAdapter(FIXTURES.multiStep);
  a.respond(user(true, "high"));
  a.respond(user(true, "low"));
  assert.equal(a.requests.length, 2);
  assert.equal(a.requests[0].thinking.effort, "high");
  assert.equal(a.requests[1].thinking.effort, "low");
  assert.deepEqual(a.requests[1].params, { reasoning_effort: "low" });
  assert.equal(a.requests[0].round, 0);
});

test("a recorded request is a snapshot, not a live reference to the caller's config", () => {
  const a = createScriptedAdapter(FIXTURES.singleTool);
  const cfg = user(true, "high");
  a.respond(cfg);
  cfg.effort = "low";
  assert.equal(a.requests[0].thinking.effort, "high", "mutating the config afterwards must not rewrite history");
});

test("repeat mode keeps a misbehaving model misbehaving", () => {
  const a = createScriptedAdapter(FIXTURES.doomLoop);
  const names = [];
  for (let i = 0; i < 6; i++) names.push(a.respond(user(true, "medium")).toolCalls[0].function.name);
  assert.deepEqual(names, Array(6).fill("search_files"));
  assert.equal(a.round, 6);
});

test("throw mode fails loudly when the Runtime asks for a turn the test did not script", () => {
  const a = createScriptedAdapter({ turns: [{ content: "only one" }], onExhausted: "throw" });
  a.respond(user(true, "medium"));
  assert.throws(() => a.respond(user(true, "medium")), /script exhausted/);
});

test("a scripted provider error throws, for the error stop reason", () => {
  const a = createScriptedAdapter(FIXTURES.providerError);
  assert.throws(() => a.respond(user(true, "medium")), /503 upstream/);
  // The failed turn still counted as a request: a test asserting "we tried once" needs to see it.
  assert.equal(a.requests.length, 1);
});

test("fixture capabilities are reported verbatim, not guessed from the id", () => {
  const a = createScriptedAdapter({ turns: [], capabilities: { supportsReasoning: false } });
  assert.equal(a.capabilities().supportsReasoning, false);
  assert.equal(a.capabilities().supportsToolCalling, true, "unspecified flags keep their defaults");
});
