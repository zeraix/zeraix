/**
 * Reasoning policy (docs/agent-runtime-loop.md §6, §18 Test 3, §18 Test 8) — milestone M4.
 *
 * This is the module that decides how much the user pays to think on each turn, so almost every test here is
 * about a way it could quietly overcharge or quietly under-deliver:
 *
 *  - reducing effort on a RECOVERY turn would economise at exactly the moment correctness matters most.
 *    §6.3 forbids it, and it is the single most consequential rule in the section (§18 Test 3 names it).
 *  - turning thinking on when the user turned it off would override an explicit setting, which §20 rule 4
 *    forbids outright — and it would show up as a bill, not as a bug report.
 *  - sending a reduced effort to a provider with no per-request knob would be either ignored or rejected;
 *    §6.2 requires that absence to degrade silently.
 *  - letting the model raise effort above the user's ceiling would make the "thinking effort" setting
 *    advisory, which is not what a user setting is.
 *
 * Test 8 is run end to end against the scripted adapter from M1: a model turn that calls
 * `set_reasoning_effort` must actually change the NEXT provider turn's configuration, and the recorded
 * requests are what proves it rather than an assertion on the policy's return value alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const {
  resolveReasoning,
  reasoningToolDeclaration,
  parseReasoningRequest,
  describeReasoningResult,
  EXECUTING_DEFAULT_EFFORT,
  REASONING_TOOL_NAME,
} = await import("../src/lib/agent/reasoningPolicy.ts");
const { describeCapabilities } = await import("../src/lib/agent/modelAdapter.ts");
const { createScriptedAdapter } = await import("../src/lib/agent/testModelAdapter.ts");

const caps = (over = {}) => ({
  supportsReasoning: true,
  supportsToolCalling: true,
  supportsParallelToolCalls: true,
  supportsStreaming: true,
  supportsStructuredOutput: false,
  supportsPerTurnReasoningEffort: true,
  supportsImages: false,
  ...over,
});
const user = (enabled, effort) => ({ enabled, effort, sendContext: false });
const resolve = (over = {}) =>
  resolveReasoning({ user: user(true, "high"), phase: "executing", capabilities: caps(), ...over });

// ── §6.3's table, phase by phase ────────────────────────────────────────────────────────────────────────

test("a routine tool follow-up is the only phase the Runtime may economise on", () => {
  const d = resolve({ phase: "executing" });
  assert.equal(d.config.effort, EXECUTING_DEFAULT_EFFORT);
  assert.equal(d.source, "phase-default");
});

test("recovery keeps the user's full effort — the rule that matters most", () => {
  const d = resolve({ phase: "recovering" });
  assert.equal(d.config.effort, "high", "a failed tool is exactly when reasoning must not be cut");
  assert.equal(d.source, "user");
});

test("planning, verification and completion all keep the user's effort", () => {
  for (const phase of ["planning", "verifying", "completed"]) {
    const d = resolve({ phase });
    assert.equal(d.config.effort, "high", phase);
    assert.equal(d.source, "user", phase);
  }
});

test("reasoning is never simply disabled", () => {
  for (const phase of ["planning", "executing", "recovering", "verifying", "completed"]) {
    assert.equal(resolve({ phase }).config.enabled, true, phase);
  }
});

// ── The user's setting is absolute ──────────────────────────────────────────────────────────────────────

test("thinking off is never turned on by a phase", () => {
  for (const phase of ["planning", "executing", "recovering", "verifying"]) {
    const d = resolveReasoning({ user: user(false, "medium"), phase, capabilities: caps() });
    assert.equal(d.config.enabled, false, phase);
    assert.equal(d.source, "user");
  }
});

test("thinking off is never turned on by the model either", () => {
  const d = resolveReasoning({
    user: user(false, "medium"),
    phase: "executing",
    capabilities: caps(),
    modelRequest: "high",
  });
  assert.equal(d.config.enabled, false);
});

test("a user who already chose low is not 'reduced' to something higher", () => {
  const d = resolveReasoning({ user: user(true, "low"), phase: "executing", capabilities: caps() });
  assert.equal(d.config.effort, "low");
});

test("the phase default never raises effort", () => {
  // EXECUTING_DEFAULT_EFFORT is low; a user on low must stay low, not be nudged up to it.
  const d = resolveReasoning({ user: user(true, "low"), phase: "planning", capabilities: caps() });
  assert.equal(d.config.effort, "low");
});

test("unrelated settings survive the decision", () => {
  const cfg = { enabled: true, effort: "high", sendContext: true };
  assert.equal(resolveReasoning({ user: cfg, phase: "executing", capabilities: caps() }).config.sendContext, true);
});

// ── §6.2: the model's override ──────────────────────────────────────────────────────────────────────────

test("the model's request outranks the Runtime's phase default", () => {
  const d = resolve({ phase: "executing", modelRequest: "high" });
  assert.equal(d.config.effort, "high", "the model can undo a reduction it does not want");
  assert.equal(d.source, "model-override");
});

test("the model may lower its own effort", () => {
  const d = resolve({ phase: "recovering", modelRequest: "low" });
  assert.equal(d.config.effort, "low");
  assert.equal(d.source, "model-override");
});

test("the model may not spend beyond the user's ceiling", () => {
  const d = resolveReasoning({
    user: user(true, "low"),
    phase: "planning",
    capabilities: caps(),
    modelRequest: "high",
  });
  assert.equal(d.config.effort, "low", "the user's setting is a budget, not a suggestion");
});

// ── §6.2: silent degradation where the knob does not exist ──────────────────────────────────────────────

test("a provider with no per-request knob simply gets the user's setting", () => {
  const d = resolveReasoning({
    user: user(true, "high"),
    phase: "executing",
    capabilities: caps({ supportsPerTurnReasoningEffort: false }),
  });
  assert.equal(d.config.effort, "high", "no reduction is attempted where it could not be honoured");
  assert.equal(d.source, "user");
});

test("a model request to a provider without the knob is accepted and does nothing", () => {
  const d = resolveReasoning({
    user: user(true, "high"),
    phase: "executing",
    capabilities: caps({ supportsPerTurnReasoningEffort: false }),
    modelRequest: "low",
  });
  assert.equal(d.config.effort, "high");
  assert.equal(d.source, "user", "degrades silently — no error, no partial application");
});

test("the tool is offered only where it would work", () => {
  assert.ok(reasoningToolDeclaration(caps()));
  assert.equal(reasoningToolDeclaration(caps({ supportsPerTurnReasoningEffort: false })), null);
  assert.equal(reasoningToolDeclaration(caps({ supportsReasoning: false })), null);
  // A local model can be told whether to think, not how hard — so it must never see this tool.
  const local = describeCapabilities({ model: "qwen3-30b", local: true, multimodal: false });
  assert.equal(reasoningToolDeclaration(local), null);
});

test("the declaration names the tool the loop dispatches on", () => {
  const decl = reasoningToolDeclaration(caps());
  assert.equal(decl.function.name, REASONING_TOOL_NAME);
  assert.deepEqual(decl.function.parameters.properties.effort.enum, ["low", "medium", "high"]);
});

// ── Parsing and reporting ───────────────────────────────────────────────────────────────────────────────

test("a malformed request falls back to policy rather than defaulting or throwing", () => {
  assert.equal(parseReasoningRequest({ effort: "high" }), "high");
  assert.equal(parseReasoningRequest({ effort: "extreme" }), null);
  assert.equal(parseReasoningRequest({ effort: 3 }), null);
  assert.equal(parseReasoningRequest({}), null);
  assert.equal(parseReasoningRequest(null), null);
  assert.equal(parseReasoningRequest("high"), null);
});

test("the model is told what will actually happen, not what it asked for", () => {
  const clamped = resolveReasoning({
    user: user(true, "low"),
    phase: "planning",
    capabilities: caps(),
    modelRequest: "high",
  });
  const msg = describeReasoningResult("high", clamped);
  assert.match(msg, /Requested high, applied low/, "a model told 'set to high' would plan around a budget it lacks");
  assert.match(msg, /ceiling/);
});

test("an applied request reports plainly, including that it lapses", () => {
  const applied = resolve({ phase: "executing", modelRequest: "high" });
  const msg = describeReasoningResult("high", applied);
  assert.match(msg, /high effort/);
  assert.match(msg, /one turn/);
});

test("thinking off is explained rather than silently ignored", () => {
  const off = resolveReasoning({
    user: user(false, "medium"),
    phase: "executing",
    capabilities: caps(),
    modelRequest: "high",
  });
  assert.match(describeReasoningResult("high", off), /thinking turned off/);
});

// ── §18 Test 8, end to end against the scripted adapter ─────────────────────────────────────────────────

test("Test 8: a set_reasoning_effort call changes the NEXT provider turn's configuration", () => {
  // Turn 1 asks for low; turn 2 is the one that must be affected; turn 3 is the final answer.
  const adapter = createScriptedAdapter({
    turns: [
      { toolCalls: [{ name: REASONING_TOOL_NAME, args: { effort: "low" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { content: "Read it." },
    ],
  });
  const userCfg = user(true, "high");
  let pending = null;

  // Round 1 — planning, no override in force yet.
  const r1 = resolveReasoning({ user: userCfg, phase: "planning", capabilities: adapter.capabilities() });
  const t1 = adapter.respond(r1.config);
  assert.equal(t1.toolCalls[0].function.name, REASONING_TOOL_NAME);
  pending = parseReasoningRequest(JSON.parse(t1.toolCalls[0].function.arguments));
  assert.equal(pending, "low");

  // Round 2 — the override applies here, and nowhere else.
  const r2 = resolveReasoning({
    user: userCfg,
    phase: "planning",
    capabilities: adapter.capabilities(),
    modelRequest: pending,
  });
  adapter.respond(r2.config);
  pending = null;

  // Round 3 — the override has lapsed; planning returns to the user's effort.
  const r3 = resolveReasoning({ user: userCfg, phase: "planning", capabilities: adapter.capabilities() });
  adapter.respond(r3.config);

  assert.deepEqual(
    adapter.requests.map((r) => r.thinking.effort),
    ["high", "low", "high"],
    "the request the provider actually received is what proves the override took effect",
  );
  assert.deepEqual(adapter.requests[1].params, { reasoning_effort: "low" });
});

test("Test 8b: a user-level 'thinking off' is never overridden by the phase default", () => {
  const adapter = createScriptedAdapter({
    turns: [{ toolCalls: [{ name: "read_file", args: {} }] }, { content: "done" }],
  });
  const off = user(false, "high");
  for (const phase of ["planning", "executing"]) {
    const d = resolveReasoning({ user: off, phase, capabilities: adapter.capabilities() });
    adapter.respond(d.config);
  }
  for (const req of adapter.requests) {
    assert.equal(req.thinking.enabled, false);
    assert.deepEqual(req.params, { reasoning_effort: "none" });
  }
});

test("Test 3's reasoning half: a recovery round is not silently reduced", () => {
  const adapter = createScriptedAdapter({
    turns: [
      { toolCalls: [{ name: "edit_file", args: { path: "missing.ts" } }] },
      { toolCalls: [{ name: "list_directory", args: { path: "." } }] },
      { content: "fixed" },
    ],
  });
  const userCfg = user(true, "high");
  // Round 1: executing — economised.
  adapter.respond(resolveReasoning({ user: userCfg, phase: "executing", capabilities: adapter.capabilities() }).config);
  // The edit failed, so round 2 is recovering — full effort, per §6.3.
  adapter.respond(resolveReasoning({ user: userCfg, phase: "recovering", capabilities: adapter.capabilities() }).config);
  assert.deepEqual(
    adapter.requests.map((r) => r.thinking.effort),
    ["low", "high"],
  );
});
