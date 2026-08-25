/**
 * The Agent Loop, end to end (docs/agent-runtime-loop.md §18 Tests 1–6) — milestone M5c.
 *
 * These are the scenarios the spec asks for, and they are runnable at all only because §5.1's Test Model
 * Adapter exists: against a live model every one of them would assert on non-deterministic behaviour. Here
 * the model's output is a fixture, so what is being tested is the Runtime's reaction to it — which is the
 * thing that was never testable while the loop lived inside a React component.
 *
 * The host callback (`runRound`) stands in for everything the loop deliberately does not own: the provider
 * request, tool execution, rendering, persistence. It is a few lines, and that is the point — if driving the
 * loop needed a large harness, the seam would be in the wrong place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { runAgentLoop } = await import("../src/lib/agent/agentLoop.ts");
const { createTestBoundary } = await import("../src/lib/agent/runtimeBoundary.ts");
const { createScriptedAdapter, FIXTURES } = await import("../src/lib/agent/testModelAdapter.ts");
const { DEFAULT_STOP_POLICY } = await import("../src/lib/agent/stopPolicy.ts");

const thinking = (enabled = true, effort = "high") => ({ enabled, effort, sendContext: false });

/**
 * Drive the loop with a scripted model, executing every tool call with `toolOutcome`.
 *
 * `toolOutcome(name, args, callIndex)` returns `{content, ok}` — which is where a scenario decides that a
 * particular tool fails, or that a repeated call keeps returning the same thing.
 */
function drive(fixture, { toolOutcome = () => ({ content: "ok", ok: true }), ...opts } = {}) {
  const adapter = createScriptedAdapter(fixture);
  const boundary = createTestBoundary({ signal: opts.signal });
  const executed = [];
  let clock = 0;

  const runRound = async ({ reasoning }) => {
    let turn;
    try {
      turn = adapter.respond(reasoning.config);
    } catch (e) {
      return { content: "", reasoning: "", toolResults: [], toolCallCount: 0, providerError: e.message };
    }
    const toolResults = turn.toolCalls.map((c, i) => {
      const args = JSON.parse(c.function.arguments);
      const outcome = toolOutcome(c.function.name, args, executed.length + i);
      executed.push({ name: c.function.name, args });
      return { toolCallId: c.id, name: c.function.name, args, content: outcome.content, ok: outcome.ok, ms: 1 };
    });
    return {
      content: turn.content,
      reasoning: turn.reasoning,
      toolResults,
      toolCallCount: turn.toolCalls.length,
      ...(opts.roundExtras ? opts.roundExtras(turn, executed) : {}),
    };
  };

  return runAgentLoop({
    boundary,
    sessionId: "conv1",
    turnId: "t1",
    modelId: "test-model",
    runRound,
    thinking: opts.thinking ?? thinking(),
    capabilities: adapter.capabilities(),
    stopPolicy: opts.stopPolicy ?? DEFAULT_STOP_POLICY,
    evaluateGoal: opts.evaluateGoal,
    onDoomSignal: opts.onDoomSignal,
    now: () => ++clock,
  }).then((res) => ({ ...res, boundary, adapter, executed }));
}

// ── §18 Test 1 — Single Tool ────────────────────────────────────────────────────────────────────────────

test("Test 1: user → model → tool → final, and the loop terminates", async () => {
  const { stop, state, turns, executed } = await drive(FIXTURES.singleTool);
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, "completed");
  assert.equal(state.phase, "completed");
  assert.equal(turns.length, 2, "one tool round, one final round");
  assert.deepEqual(executed.map((e) => e.name), ["read_file"]);
  assert.equal(state.toolCalls, 1);
});

test("Test 1b: the run is reported through the boundary, not returned only", async () => {
  const { boundary } = await drive(FIXTURES.singleTool);
  assert.equal(boundary.eventsOfType("turn-start").length, 2);
  assert.equal(boundary.eventsOfType("turn-end").length, 2);
  assert.equal(boundary.eventsOfType("tool-end").length, 1);
  const stopped = boundary.eventsOfType("stopped");
  assert.equal(stopped.length, 1, "a run reports exactly one ending");
  assert.equal(stopped[0].reason, "completed");
});

// ── §18 Test 2 — Multi-Step ─────────────────────────────────────────────────────────────────────────────

test("Test 2: state and context stay correct across a planning → tools → final run", async () => {
  const { state, turns, executed } = await drive(FIXTURES.multiStep);
  assert.deepEqual(executed.map((e) => e.name), ["read_file", "edit_file", "run_command"]);
  assert.equal(state.toolCalls, 3);
  assert.equal(state.round, 4);
  assert.equal(turns.length, 4);
  // Rounds are numbered within the user turn, and the ids are derived from that.
  assert.deepEqual(turns.map((t) => t.providerTurnId), ["t1#0", "t1#1", "t1#2", "t1#3"]);
});

test("Test 2b: the first round plans and a later ordinary round does not", async () => {
  // The phase is observable through the effort each round was issued at, which is the point of deciding
  // reasoning BEFORE the request: planning keeps the user's effort, a routine follow-up is economised.
  const { adapter } = await drive(FIXTURES.multiStep);
  assert.deepEqual(
    adapter.requests.map((r) => r.thinking.effort),
    ["high", "low", "low", "low"],
  );
});

// ── §18 Test 3 — Tool Failure and Recovery ──────────────────────────────────────────────────────────────

test("Test 3: a failure moves to recovering, and the recovery round is NOT economised", async () => {
  const { adapter, state } = await drive(FIXTURES.toolFailure, {
    toolOutcome: (name, args) =>
      name === "edit_file" && args.path === "missing.ts"
        ? { content: "no such file", ok: false }
        : { content: "ok", ok: true },
  });
  // Round 1 planning (high) → the edit fails → round 2 is recovering, which §6.3 says keeps full effort.
  assert.equal(adapter.requests[0].thinking.effort, "high");
  assert.equal(adapter.requests[1].thinking.effort, "high", "recovery must never be silently reduced");
  // Recovery succeeded, so the streak is cleared by the end.
  assert.equal(state.consecutiveFailures, 0);
});

test("Test 3b: the run still completes after recovering", async () => {
  const { stop } = await drive(FIXTURES.toolFailure, {
    toolOutcome: (name, args) =>
      name === "edit_file" && args.path === "missing.ts" ? { content: "no such file", ok: false } : { content: "ok", ok: true },
  });
  assert.equal(stop.reason, "completed");
});

// ── §18 Test 4 — Doom Loop ──────────────────────────────────────────────────────────────────────────────

test("Test 4: an identical call repeated forever is warned about, then stopped", async () => {
  const signals = [];
  const { stop, state } = await drive(FIXTURES.doomLoop, {
    // Same call, same output, every time — the definition of learning nothing.
    toolOutcome: () => ({ content: "always the same", ok: true }),
    onDoomSignal: (signal) => signals.push(signal),
  });
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, "doom-loop", "a run that stops here must never read as completed");
  assert.match(stop.detail, /no new information/);
  // Proportional response: reminders were delivered before the stop, not instead of it.
  assert.ok(signals.length >= 2, `expected repeated warnings before escalation, got ${signals.length}`);
  assert.equal(signals[0], "identical");
  // And it stopped promptly rather than running to some large cap.
  assert.ok(state.round <= 6, `expected escalation within a few rounds, took ${state.round}`);
});

test("Test 4b: a healthy run using one tool repeatedly with different results is never stopped", async () => {
  let n = 0;
  const { stop } = await drive(
    {
      turns: [
        { toolCalls: [{ name: "run_command", args: { cmd: "npm test" } }] },
        { toolCalls: [{ name: "run_command", args: { cmd: "npm test" } }] },
        { toolCalls: [{ name: "run_command", args: { cmd: "npm test" } }] },
        { content: "green" },
      ],
    },
    { toolOutcome: () => ({ content: `run ${n++} output`, ok: true }) },
  );
  assert.equal(stop.reason, "completed", "the same command with changing output is progress, not a loop");
});

// ── §18 Test 5 — Parallel Tools ─────────────────────────────────────────────────────────────────────────

test("Test 5: three independent calls in one turn are all executed and all recorded", async () => {
  const { state, turns, executed } = await drive(FIXTURES.parallelTools);
  assert.equal(executed.length, 3);
  assert.equal(state.toolCalls, 3);
  const firstTurn = turns[0];
  assert.equal(firstTurn.toolResults.length, 3, "all three results belong to the one turn that asked for them");
  // Distinct ids, so results pair with calls rather than with positions.
  assert.equal(new Set(firstTurn.toolResults.map((r) => r.toolCallId)).size, 3);
});

// ── §18 Test 6 — Long-running task ──────────────────────────────────────────────────────────────────────

test("Test 6: compaction mid-run makes the next round plan again, and the run continues correctly", async () => {
  const { adapter, stop } = await drive(FIXTURES.multiStep, {
    // Compaction happens before round 3.
    roundExtras: (_turn, executed) => ({ compacted: executed.length === 2 }),
  });
  assert.equal(stop.reason, "completed", "the agent continues correctly post-compaction");
  // Round 1 plans; round 2 is routine; round 3 follows the compaction and plans again.
  assert.deepEqual(
    adapter.requests.map((r) => r.thinking.effort),
    ["high", "low", "high", "low"],
  );
});

// ── Stop reasons that are not completion ────────────────────────────────────────────────────────────────

test("a provider error ends the run with reason error", async () => {
  const { stop } = await drive(FIXTURES.providerError);
  assert.equal(stop.reason, "error");
  assert.match(stop.detail, /503/);
});

test("cancellation ends the run and is never reported as anything else", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { stop, turns } = await drive(FIXTURES.singleTool, { signal: ctrl.signal });
  assert.equal(stop.reason, "cancelled");
  assert.equal(turns.length, 0, "an already-cancelled run issues no request at all");
});

test("a configured turn cap fires, and reports what it counted", async () => {
  const { stop } = await drive(FIXTURES.doomLoop, {
    toolOutcome: () => ({ content: `unique ${Math.min(1, 1)}`, ok: true }),
    stopPolicy: { ...DEFAULT_STOP_POLICY, maxTurns: 3 },
  });
  assert.equal(stop.reason, "max-turns");
  assert.equal(stop.detail, "3 of 3");
});

test("an unmet goal keeps the loop running past the model's own ending", async () => {
  let asked = 0;
  const { stop, state } = await drive(
    { turns: [{ content: "I think I'm done" }, { toolCalls: [{ name: "read_file", args: {} }] }, { content: "now done" }] },
    {
      evaluateGoal: async () => {
        asked++;
        return asked === 1 ? false : true;
      },
    },
  );
  assert.equal(asked, 2, "the evaluator is consulted only on a final response, not every round");
  assert.equal(stop.reason, "completed");
  assert.ok(state.round >= 3, "the run continued after the first 'final' answer");
});

test("one tool failing over and over escalates as a doom loop, before the failure backstop", async () => {
  const { stop, state } = await drive(
    { turns: [{ toolCalls: [{ name: "edit_file", args: {} }] }], onExhausted: "repeat" },
    // Distinct failure text each time, so the identical-call signal never fires — what catches this is the
    // consecutive-failure signal inside the detector, which reaches its threshold well before the policy's
    // backstop of ten. Documented as a test because the precedence is not obvious and is worth being stable:
    // the faster diagnosis wins, and it is the more specific one.
    { toolOutcome: (n, a, i) => ({ content: `failure ${i}`, ok: false }) },
  );
  assert.equal(stop.reason, "doom-loop");
  assert.ok(state.consecutiveFailures < 10, "the detector got there first, which is the intended precedence");
});

test("the failure backstop catches an environment where many DIFFERENT tools each fail", async () => {
  // No tool repeats, so no doom-loop signal can fire: this is the case the policy's backstop exists for —
  // a dead sandbox or a missing binary, where every call fails for a reason no rewording can fix.
  const tools = ["read_file", "list_directory", "search_files", "file_info", "write_file", "edit_file",
                 "run_command", "search_in_files", "append_file", "copy_file", "move_file", "delete_file"];
  const { stop } = await drive(
    { turns: tools.map((name) => ({ toolCalls: [{ name, args: { path: `${name}.ts` } }] })) },
    { toolOutcome: (name, args, i) => ({ content: `sandbox is down (${i})`, ok: false }) },
  );
  assert.equal(stop.reason, "error");
  assert.match(stop.detail, /consecutive tool failures/);
});

// ── The host's own wrap-up guards (§14: page.tsx's four nudges) ─────────────────────────────────────────

test("a nudged round is not treated as the model's final answer", async () => {
  let nudged = false;
  const { stop, state } = await drive(
    // The model ends with empty content after doing real work — page.tsx's FINALIZE_NUDGE case.
    { turns: [{ toolCalls: [{ name: "read_file", args: {} }] }, { content: "" }, { content: "Here is the answer." }] },
    {
      roundExtras: (turn) => {
        if (turn.toolCalls.length === 0 && !turn.content && !nudged) {
          nudged = true;
          return { forceContinue: true };
        }
        return {};
      },
    },
  );
  assert.equal(nudged, true, "the guard fired");
  assert.equal(stop.reason, "completed");
  assert.equal(state.round, 3, "the empty round was followed by another, not treated as the ending");
});

test("forceContinue cannot be used to bypass the stop policy", async () => {
  // A host that nudges forever must still be stopped: the loop takes the request at face value but every
  // other condition is still evaluated. Here the turn cap catches it.
  const { stop } = await drive(
    { turns: [{ content: "" }], onExhausted: "repeat" },
    { roundExtras: () => ({ forceContinue: true }), stopPolicy: { ...DEFAULT_STOP_POLICY, maxTurns: 4 } },
  );
  assert.equal(stop.reason, "max-turns");
});

test("a nudged round still ends the consecutive-tool run", async () => {
  // The round called no tools, so `consecutiveToolCalls` resets whether or not the host wants another pass.
  const { state } = await drive(
    { turns: [{ toolCalls: [{ name: "read_file", args: {} }] }, { content: "" }, { content: "done" }] },
    { roundExtras: (turn) => (turn.toolCalls.length === 0 && !turn.content ? { forceContinue: true } : {}) },
  );
  assert.equal(state.consecutiveToolCalls, 0);
});
