/**
 * Provider Turn and the Runtime/UI boundary (docs/agent-runtime-loop.md §7, §13) — milestone M2.
 *
 * These two modules are the seam the whole refactor rests on, and neither can be verified by running the app:
 * a turn record is only interesting once something reads it, and the boundary only matters once the loop is
 * on the other side of it. So what is pinned here is the set of properties later milestones will silently
 * depend on.
 *
 * The turn tests are mostly about IDENTITY and IMMUTABILITY. Identity, because `providerTurnId` is derived
 * rather than random specifically so a replayed or resumed turn is recognisable as the same turn — if it ever
 * becomes random, every §19 record and every test that names an id goes unstable, and it would go unstable
 * quietly. Immutability, because the loop will hold a turn across awaits while tools run; if `withToolResult`
 * mutated in place, a turn captured before execution would change underneath its holder.
 *
 * The boundary tests are about the two BLOCKING paths, consent and ask_user, since those are the reason the
 * loop cannot leave the component today. `hasUnansweredCalls` gets its own attention because an unanswered
 * tool call is not a cosmetic gap: the provider rejects the entire conversation on the next request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { openTurn, withResponse, withToolResult, closeTurn, wantsTools, hasUnansweredCalls, turnTokens, turnDuration } =
  await import("../src/lib/agent/turn.ts");
const { createTestBoundary } = await import("../src/lib/agent/runtimeBoundary.ts");

const init = (over = {}) => ({
  turnId: "t1",
  sessionId: "conv1",
  round: 0,
  modelId: "gpt-5",
  startedAt: 1000,
  ...over,
});
const call = (id, name = "read_file") => ({ id, type: "function", function: { name, arguments: "{}" } });
const result = (toolCallId, over = {}) => ({
  toolCallId,
  name: "read_file",
  args: {},
  content: "ok",
  ok: true,
  ms: 5,
  ...over,
});

// ── Provider Turn ───────────────────────────────────────────────────────────────────────────────────────

test("a provider turn's id is derived, so the same round is always the same turn", () => {
  assert.equal(openTurn(init()).providerTurnId, "t1#0");
  assert.equal(openTurn(init({ round: 7 })).providerTurnId, "t1#7");
  // The property that matters: building it twice gives the same id, so a replay is recognisable as a replay.
  assert.equal(openTurn(init()).providerTurnId, openTurn(init()).providerTurnId);
});

test("rounds within one user turn are distinct; the same round in different user turns is not confused", () => {
  assert.notEqual(openTurn(init({ round: 0 })).providerTurnId, openTurn(init({ round: 1 })).providerTurnId);
  assert.notEqual(openTurn(init({ turnId: "t1" })).providerTurnId, openTurn(init({ turnId: "t2" })).providerTurnId);
});

test("a turn defaults to the main agent, and a sub-agent says so", () => {
  assert.equal(openTurn(init()).agentId, "main");
  assert.equal(openTurn(init({ agentId: "explore" })).agentId, "explore");
});

test("recording a response does not mutate the turn it was given", () => {
  const open = openTurn(init());
  const answered = withResponse(open, { content: "hi", reasoning: "why", toolCalls: [call("c1")] });
  assert.equal(open.content, "", "the original must be untouched — the loop holds it across awaits");
  assert.deepEqual(open.toolCalls, []);
  assert.equal(answered.content, "hi");
  assert.equal(answered.reasoning, "why");
  assert.equal(answered.toolCalls.length, 1);
});

test("recording a tool result does not mutate the turn it was given", () => {
  const t = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [call("c1")] });
  const withOne = withToolResult(t, result("c1"));
  assert.equal(t.toolResults.length, 0);
  assert.equal(withOne.toolResults.length, 1);
});

test("wantsTools is the loop's continuation condition", () => {
  const noTools = withResponse(openTurn(init()), { content: "done", reasoning: "", toolCalls: [] });
  const withTools = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [call("c1")] });
  assert.equal(wantsTools(noTools), false, "no tool calls is the final answer");
  assert.equal(wantsTools(withTools), true);
});

test("an unanswered tool call is detectable, because the provider rejects the conversation without one", () => {
  const t = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [call("c1"), call("c2")] });
  assert.equal(hasUnansweredCalls(t), true);
  const half = withToolResult(t, result("c1"));
  assert.equal(hasUnansweredCalls(half), true, "a cancelled round leaves some calls unanswered");
  const full = withToolResult(half, result("c2"));
  assert.equal(hasUnansweredCalls(full), false);
});

test("results are matched by id, not by position", () => {
  const t = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [call("c1"), call("c2")] });
  // Out of order on purpose: parallel tools settle in whatever order they finish.
  const done = withToolResult(withToolResult(t, result("c2")), result("c1"));
  assert.equal(hasUnansweredCalls(done), false);
});

test("a result for a call that was never made does not count as answering one that was", () => {
  const t = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [call("c1")] });
  assert.equal(hasUnansweredCalls(withToolResult(t, result("stray"))), true);
});

test("duration is zero while the turn is open, and real once closed", () => {
  const open = openTurn(init());
  assert.equal(turnDuration(open), 0, "an open turn has no duration yet, not a negative one");
  assert.equal(turnDuration(closeTurn(open, 1250)), 250);
});

test("token accounting sums both directions", () => {
  const t = withResponse(openTurn(init()), {
    content: "x",
    reasoning: "",
    toolCalls: [],
    promptTokens: 1200,
    completionTokens: 300,
  });
  assert.equal(turnTokens(t), 1500);
  // Absent usage must not turn into NaN — every §19 figure is derived from this.
  assert.equal(turnTokens(openTurn(init())), 0);
});

test("omitted usage leaves the previous count rather than zeroing it", () => {
  const t = withResponse(openTurn(init()), { content: "", reasoning: "", toolCalls: [], promptTokens: 10 });
  const again = withResponse(t, { content: "x", reasoning: "", toolCalls: [] });
  assert.equal(again.promptTokens, 10);
});

// ── Runtime boundary ────────────────────────────────────────────────────────────────────────────────────

test("events are recorded in order and can be filtered by kind", async () => {
  const b = createTestBoundary();
  b.onEvent({ type: "status", text: "thinking" });
  b.onEvent({ type: "delta", content: "he", reasoning: "" });
  b.onEvent({ type: "status", text: "running read_file" });
  assert.equal(b.events.length, 3);
  assert.deepEqual(
    b.eventsOfType("status").map((e) => e.text),
    ["thinking", "running read_file"],
  );
  assert.equal(b.eventsOfType("delta").length, 1);
  assert.equal(b.eventsOfType("stopped").length, 0);
});

test("consent defaults to approval, and every request is visible to the test", async () => {
  const b = createTestBoundary();
  assert.equal(await b.requestConsent({ name: "write_file", args: { path: "a.ts" } }), "yes");
  assert.equal(b.consentRequests.length, 1);
  assert.equal(b.consentRequests[0].name, "write_file");
});

test("a refusal is an answer, not an error — the loop is meant to continue on it", async () => {
  const b = createTestBoundary({ onConsent: () => "no" });
  const decision = await b.requestConsent({ name: "delete_file", args: {} });
  assert.equal(decision, "no");
});

test("consent can be decided per tool, which is what a mixed scenario needs", async () => {
  const b = createTestBoundary({ onConsent: (req) => (req.name === "delete_file" ? "no" : "always") });
  assert.equal(await b.requestConsent({ name: "write_file", args: {} }), "always");
  assert.equal(await b.requestConsent({ name: "delete_file", args: {} }), "no");
  assert.deepEqual(
    b.consentRequests.map((r) => r.name),
    ["write_file", "delete_file"],
  );
});

test("a sub-agent requester is carried through, because it must bypass 'don't ask again'", async () => {
  const b = createTestBoundary();
  await b.requestConsent({
    name: "run_command",
    args: { cmd: "rm -rf build" },
    requester: { agentId: "coder", task: "clean the build" },
  });
  assert.equal(b.consentRequests[0].requester?.agentId, "coder");
});

test("ask_user picks the first option by default and never flags discussion", async () => {
  const b = createTestBoundary();
  const text = await b.askUser([
    { question: "Which?", options: ["A", "B"], multiSelect: false },
    { question: "And?", options: ["C"], multiSelect: false },
  ]);
  // The boundary answers with the TEXT the tool result carries, not structured answers — see the contract.
  assert.equal(text, "- Which? → A\n- And? → C");
  assert.equal(b.questions.length, 1, "one card, two questions");
  assert.equal(b.questions[0].length, 2);
});

test("a question with no options yields an empty answer rather than undefined", async () => {
  const b = createTestBoundary();
  const text = await b.askUser([{ question: "Free text?", options: [], multiSelect: false }]);
  assert.equal(text, "- Free text? → ");
});

test("answers can be scripted, including a request to discuss", async () => {
  const b = createTestBoundary({ onAsk: () => [{ value: "B", discuss: true }] });
  const text = await b.askUser([{ question: "Which?", options: ["A", "B"], multiSelect: false }]);
  assert.equal(text, "- Which? → discuss", "a discuss flag must be visible to the model, not flattened to a value");
});

test("persisted messages are observable, and indices are per session", () => {
  const b = createTestBoundary();
  assert.equal(b.storage.appendMessage("conv1", { role: "user", content: "hi" }), 0);
  assert.equal(b.storage.appendMessage("conv1", { role: "assistant", content: "hey" }), 1);
  // A second conversation starts its own numbering — a shared counter would hand sub-agent traces a wrong index.
  assert.equal(b.storage.appendMessage("conv2", { role: "user", content: "other" }), 0);
  assert.equal(b.storage.appendMessage("conv1", { role: "user", content: "again" }), 2);
  assert.equal(b.persisted.length, 4);
  assert.deepEqual(
    b.persisted.filter((p) => p.sessionId === "conv1").map((p) => p.msg.role),
    ["user", "assistant", "user"],
  );
});

test("a boundary with no signal supplied is simply never aborted", () => {
  assert.equal(createTestBoundary().signal.aborted, false);
});

test("a supplied signal is the one the Runtime sees, so cancellation stays the caller's", () => {
  const ctrl = new AbortController();
  const b = createTestBoundary({ signal: ctrl.signal });
  assert.equal(b.signal.aborted, false);
  ctrl.abort();
  assert.equal(b.signal.aborted, true);
});
