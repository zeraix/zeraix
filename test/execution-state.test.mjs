/**
 * Execution State and Stop Policy (docs/agent-runtime-loop.md §4.2, §6.1, §11) — milestone M3.
 *
 * These two modules decide two things the user feels directly: how hard the model thinks on a given round,
 * and when a run ends. Both are the kind of logic that looks obviously right and is quietly wrong in one
 * case, so what is pinned here is mostly the *precedence* between rules rather than the rules themselves.
 *
 * The one that matters most: a state that is both "just failed" and "just compacted" must resolve to
 * `recovering`. §6.3 requires recovery to keep the user's full reasoning effort, so if `planning` won that
 * tie the Runtime would be economising at exactly the moment correctness matters most — and it would do it
 * silently, on the round after every compaction that happens to follow a failure.
 *
 * For the Stop Policy the equivalent is: the defaults must reproduce today's behaviour exactly. §11 is
 * explicit that a turn cap is a genuinely new limit and must be off by default so the refactor does not
 * silently change what the product does. A test that lets `maxTurns` default to a number would hide that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const {
  initExecutionState,
  beginRound,
  recordToolResult,
  endRoundWithoutTools,
  markCompacted,
  markPlanChanged,
  markClaimsComplete,
  markCompleted,
  derivePhase,
  mayReduceEffort,
} = await import("../src/lib/agent/executionState.ts");
const { decideStop, DEFAULT_STOP_POLICY, isSuccessfulStop } = await import("../src/lib/agent/stopPolicy.ts");

const ok = (name = "read_file") => ({ toolCallId: "c1", name, args: {}, content: "x", ok: true, ms: 1 });
const fail = (name = "edit_file") => ({ toolCallId: "c1", name, args: {}, content: "no match", ok: false, ms: 1 });

// ── Execution State ─────────────────────────────────────────────────────────────────────────────────────

test("a turn starts in planning, with nothing counted", () => {
  const s = initExecutionState();
  assert.equal(s.phase, "planning");
  assert.equal(s.round, 0);
  assert.equal(s.toolCalls, 0);
  assert.equal(s.consecutiveFailures, 0);
});

test("the first round is planning; a later ordinary round is executing", () => {
  let s = beginRound(initExecutionState());
  assert.equal(s.phase, "planning");
  s = recordToolResult(s, ok());
  s = beginRound(s);
  assert.equal(s.phase, "executing");
});

test("a failed tool moves the run to recovering, and a success moves it back", () => {
  let s = beginRound(beginRound(initExecutionState()));
  s = recordToolResult(s, fail());
  assert.equal(s.phase, "recovering");
  assert.equal(s.consecutiveFailures, 1);
  s = recordToolResult(s, ok());
  assert.equal(s.phase, "executing");
  assert.equal(s.consecutiveFailures, 0, "any success ends the run of failures");
});

test("consecutive failures accumulate across different tools", () => {
  let s = beginRound(initExecutionState());
  s = recordToolResult(s, fail("edit_file"));
  s = recordToolResult(s, fail("write_file"));
  assert.equal(s.consecutiveFailures, 2, "the run is of failures, not of one tool failing");
});

test("recovering outranks planning — the tie that would silently economise on a recovery round", () => {
  let s = beginRound(beginRound(initExecutionState()));
  s = recordToolResult(s, fail());
  s = markCompacted(s);
  // Both "just failed" and "just compacted" are true. §6.3 says recovery keeps full effort.
  assert.equal(derivePhase({ ...s, round: s.compactedAtRound + 1 }), "recovering");
});

test("planning applies to the round after an event, not to every round since", () => {
  let s = beginRound(beginRound(initExecutionState()));
  s = recordToolResult(s, ok());
  s = markCompacted(s);
  const after = beginRound(s);
  assert.equal(after.phase, "planning", "the round following compaction re-plans");
  const later = beginRound(recordToolResult(after, ok()));
  assert.equal(later.phase, "executing", "and only that round");
});

test("a plan change makes the next round a planning round", () => {
  let s = beginRound(beginRound(initExecutionState()));
  s = recordToolResult(s, ok());
  s = markPlanChanged(s);
  assert.equal(beginRound(s).phase, "planning");
});

test("the model claiming completion moves to verifying, never to completed", () => {
  let s = beginRound(beginRound(initExecutionState()));
  s = recordToolResult(s, ok());
  s = markClaimsComplete(s);
  assert.equal(s.phase, "verifying", "believing you are done is not being done");
  assert.notEqual(s.phase, "completed");
});

test("a model that keeps working has evidently not finished", () => {
  let s = markClaimsComplete(beginRound(initExecutionState()));
  assert.equal(s.phase, "verifying");
  s = recordToolResult(s, ok());
  assert.equal(s.claimsComplete, false);
  assert.notEqual(s.phase, "verifying");
});

test("completed is terminal and only the Stop Policy reaches it", () => {
  let s = markCompleted(beginRound(initExecutionState()));
  assert.equal(s.phase, "completed");
  // Nothing re-derives away from it, including a subsequent failure.
  assert.equal(derivePhase({ ...s, lastToolSucceeded: false }), "completed");
  assert.equal(beginRound(s).phase, "completed");
});

test("a round that called no tools ends the consecutive run", () => {
  let s = recordToolResult(beginRound(initExecutionState()), ok());
  assert.equal(s.consecutiveToolCalls, 1);
  assert.equal(endRoundWithoutTools(s).consecutiveToolCalls, 0);
});

test("only executing may be economised on", () => {
  assert.equal(mayReduceEffort("executing"), true);
  for (const phase of ["planning", "recovering", "verifying", "completed"]) {
    assert.equal(mayReduceEffort(phase), false, phase);
  }
});

// ── Stop Policy ─────────────────────────────────────────────────────────────────────────────────────────

const running = (over = {}) => ({
  state: { ...initExecutionState(), round: 5, toolCalls: 12 },
  cancelled: false,
  doomLoopEscalated: false,
  finalResponse: false,
  ...over,
});

test("the defaults reproduce today's behaviour: nothing is capped", () => {
  assert.equal(DEFAULT_STOP_POLICY.maxTurns, null, "a turn cap is a product decision, not a refactor");
  assert.equal(DEFAULT_STOP_POLICY.maxToolCalls, null);
  assert.equal(DEFAULT_STOP_POLICY.contextLimitFraction, null);
});

test("a healthy long run is never stopped by default", () => {
  const decision = decideStop(running({ state: { ...initExecutionState(), round: 500, toolCalls: 4000 } }));
  assert.equal(decision.stop, false);
});

test("cancellation outranks everything, so a stopped run is never reported as something else", () => {
  const d = decideStop(running({ cancelled: true, doomLoopEscalated: true, finalResponse: true, providerError: "boom" }));
  assert.equal(d.reason, "cancelled");
});

test("a provider error outranks a doom loop and a final response", () => {
  const d = decideStop(running({ providerError: "503", doomLoopEscalated: true, finalResponse: true }));
  assert.equal(d.reason, "error");
  assert.equal(d.detail, "503");
});

test("a looping model that finally emits text is still reported as looping", () => {
  const d = decideStop(running({ doomLoopEscalated: true, finalResponse: true }));
  assert.equal(d.reason, "doom-loop");
  assert.match(d.detail, /consecutive rounds/);
});

test("a final response with no goal in force completes the run", () => {
  const d = decideStop(running({ finalResponse: true }));
  assert.equal(d.stop, true);
  assert.equal(d.reason, "completed");
});

test("an unmet goal overrides the model's own ending", () => {
  const d = decideStop(running({ finalResponse: true, goalMet: false }));
  assert.equal(d.stop, false, "the model does not get to declare itself finished while a goal is unmet");
});

test("a met goal completes it", () => {
  assert.equal(decideStop(running({ finalResponse: true, goalMet: true })).reason, "completed");
});

test("limits are checked last, so a finishing run is never blamed on one", () => {
  const d = decideStop(running({ finalResponse: true, state: { ...initExecutionState(), round: 99 } }), {
    ...DEFAULT_STOP_POLICY,
    maxTurns: 10,
  });
  assert.equal(d.reason, "completed");
});

test("max turns fires when configured, and reports what it counted", () => {
  const d = decideStop(running({ state: { ...initExecutionState(), round: 10 } }), { ...DEFAULT_STOP_POLICY, maxTurns: 10 });
  assert.equal(d.reason, "max-turns");
  assert.equal(d.detail, "10 of 10");
});

test("max tool calls fires when configured", () => {
  const d = decideStop(running({ state: { ...initExecutionState(), toolCalls: 50 } }), {
    ...DEFAULT_STOP_POLICY,
    maxToolCalls: 50,
  });
  assert.equal(d.reason, "max-tool-calls");
});

test("runaway failure stops the run even with every other limit off", () => {
  const d = decideStop(running({ state: { ...initExecutionState(), consecutiveFailures: 10 } }));
  assert.equal(d.stop, true);
  assert.equal(d.reason, "error");
  assert.match(d.detail, /consecutive tool failures/);
});

test("failures below the backstop do not stop a run that may still recover", () => {
  assert.equal(decideStop(running({ state: { ...initExecutionState(), consecutiveFailures: 9 } })).stop, false);
});

test("the context limit is off by default and fires only when configured", () => {
  const near = running({ contextTokens: 190_000, contextWindow: 200_000 });
  assert.equal(decideStop(near).stop, false, "compaction handles growth; this is not a default limit");
  const d = decideStop(near, { ...DEFAULT_STOP_POLICY, contextLimitFraction: 0.9 });
  assert.equal(d.reason, "context-limit");
});

test("a context limit with nothing to measure against does not fire", () => {
  const cfg = { ...DEFAULT_STOP_POLICY, contextLimitFraction: 0.9 };
  assert.equal(decideStop(running({ contextTokens: 190_000 }), cfg).stop, false, "no window known");
  assert.equal(decideStop(running({ contextWindow: 0, contextTokens: 5 }), cfg).stop, false, "no division by zero");
});

test("only completion counts as success — a limit or a loop must never read as a finished task", () => {
  assert.equal(isSuccessfulStop("completed"), true);
  for (const reason of ["max-turns", "max-tool-calls", "doom-loop", "cancelled", "error", "context-limit", undefined]) {
    assert.equal(isSuccessfulStop(reason), false, String(reason));
  }
});
