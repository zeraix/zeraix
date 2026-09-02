/**
 * Sub-agent execution observability: the state machine, the event reducer, redaction and retention.
 *
 * These are the properties the Inspector's honesty rests on, and every one of them is a property of plain
 * data — so they are pinned here, against the reducer, rather than against a rendered panel. What is
 * deliberately NOT tested here is the delegation wiring itself (that a `run_subagent` call creates a record):
 * that is covered by driving the registry the way the call sites do, below, because the call sites are React
 * factories that need a whole page's worth of dependencies to construct.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);

// Dynamic, like every other src-importing suite here: a static import is hoisted above `register`, and the
// reducer's sibling import is extensionless.
const {
  applyExecutionEvent,
  canTransition,
  clearConversation,
  emptyExecutionsState,
  isTerminal,
  MAX_EVENTS_PER_EXECUTION,
  groupByTurn,
  pruneExecutions,
  rootExecutions,
  summarise,
} = await import("../src/lib/agent/subagentExecution.ts");
const { beginExecution, cancelExecutions, resetExecutionListenersForTest, subscribeExecutionEvents } =
  await import("../src/lib/agent/executionRegistry.ts");
const { redactArgs, redactOutput, REDACTED } = await import("../src/lib/agent/executionRedaction.ts");
const { executionTranscript, executionIsRunning } = await import(
  "../src/app/agent/chat/executionTranscript.ts"
);

/** Collect everything the registry publishes, and fold it the way the store does. */
function harness() {
  resetExecutionListenersForTest();
  const events = [];
  let state = emptyExecutionsState();
  subscribeExecutionEvents((e) => {
    events.push(e);
    state = applyExecutionEvent(state, e);
  });
  return {
    events,
    get state() {
      return state;
    },
    types: () => events.map((e) => e.type),
    one: (id) => state.byId[id],
  };
}

const init = (over = {}) => ({
  agent: "explore",
  task: "Inspect the authentication architecture",
  origin: "spawn_subagents",
  conversationId: "c1",
  turnId: "t1",
  ...over,
});

// ── Lifecycle (TODO §29 Runtime tests) ──────────────────────────────────────────────────────────

test("a delegation reports the whole lifecycle: queued → running → tool → result → completed", () => {
  const h = harness();
  const ex = beginExecution(init());
  assert.equal(h.one(ex.id).status, "queued", "a spawned delegation is visible before it gets a slot");
  ex.start();
  assert.equal(h.one(ex.id).status, "running");
  const call = ex.toolCall("search_files", { pattern: "spawn_subagents" });
  assert.equal(h.one(ex.id).phase, "tool");
  assert.equal(h.one(ex.id).toolCallCount, 1);
  ex.toolResult(call, "search_files", true, "14 matches");
  assert.equal(h.one(ex.id).phase, "thinking", "the action falls back once nothing is running");
  ex.complete("it retries twice");

  const rec = h.one(ex.id);
  assert.equal(rec.status, "completed");
  assert.equal(rec.result, "it retries twice");
  assert.equal(rec.toolCalls[0].ok, true);
  assert.equal(rec.toolCalls[0].output, "14 matches");
  assert.deepEqual(h.types(), [
    "spawned",
    "started",
    "tool_call",
    "tool_result",
    "completed",
  ]);
});

test("a failure is recorded as a failure, with its message and code", () => {
  const h = harness();
  const ex = beginExecution(init({ agent: "coder" }));
  ex.start();
  ex.fail("run_command exited with code 1", "error");
  const rec = h.one(ex.id);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error.message, "run_command exited with code 1");
  assert.equal(rec.error.code, "error");
});

test("cancellation is its own outcome, not a failure", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  ex.cancel();
  assert.equal(h.one(ex.id).status, "cancelled");
});

test("a delegation cancelled while still queued never shows as running", () => {
  // The case nothing else reports: the scheduler settles a queued job without ever calling its body.
  const h = harness();
  const ex = beginExecution(init());
  cancelExecutions([ex.id]);
  assert.equal(h.one(ex.id).status, "cancelled");
  assert.equal(h.one(ex.id).startedAt, undefined);
});

test("a second terminal event is ignored — the first one wins", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  ex.complete("done");
  const settledAt = h.one(ex.id).completedAt;
  ex.fail("the turn was interrupted");
  ex.cancel();
  const rec = h.one(ex.id);
  assert.equal(rec.status, "completed", "cancelAll racing a natural finish must not rewrite the outcome");
  assert.equal(rec.error, undefined);
  assert.equal(rec.completedAt, settledAt);
});

test("the state machine refuses transitions that cannot happen", () => {
  assert.equal(canTransition("queued", "running"), true);
  assert.equal(canTransition("running", "waiting"), true);
  assert.equal(canTransition("waiting", "running"), true);
  assert.equal(canTransition("completed", "running"), false);
  assert.equal(canTransition("failed", "completed"), false);
  assert.equal(canTransition("cancelled", "running"), false);
  assert.equal(canTransition("running", "running"), false);
  for (const s of ["completed", "failed", "cancelled"]) assert.equal(isTerminal(s), true);
});

test("an event for an execution that was never spawned changes nothing", () => {
  const before = emptyExecutionsState();
  const after = applyExecutionEvent(before, {
    type: "completed",
    executionId: "ex_nope",
    timestamp: 1,
  });
  assert.equal(after, before, "identity is the signal a store uses to skip the render");
});

test("a duplicate spawn does not create a second record", () => {
  let state = emptyExecutionsState();
  const spawn = { type: "spawned", executionId: "ex_1", timestamp: 1, agent: "explore", task: "t", origin: "run_subagent" };
  state = applyExecutionEvent(state, spawn);
  const after = applyExecutionEvent(state, spawn);
  assert.equal(after, state);
  assert.equal(state.order.length, 1);
});

// ── Parallelism and attribution (TODO §29, §31) ─────────────────────────────────────────────────

test("parallel delegations keep their own state and their own tool calls", () => {
  const h = harness();
  const agents = ["explore", "plan", "coder"];
  const handles = agents.map((a) => beginExecution(init({ agent: a })));
  for (const ex of handles) ex.start();

  // Interleaved on purpose: the failure this guards is one delegation's result landing on another.
  const calls = handles.map((ex, i) => ex.toolCall("read_file", { path: `f${i}.ts` }));
  handles.forEach((ex, i) => ex.toolResult(calls[i], "read_file", true, `body ${i}`));
  handles[0].complete("A");
  handles[2].fail("boom");

  assert.equal(h.one(handles[0].id).status, "completed");
  assert.equal(h.one(handles[1].id).status, "running");
  assert.equal(h.one(handles[2].id).status, "failed");
  handles.forEach((ex, i) => {
    const rec = h.one(ex.id);
    assert.equal(rec.toolCalls.length, 1);
    assert.equal(rec.toolCalls[0].args.path, `f${i}.ts`);
    assert.equal(rec.toolCalls[0].output, `body ${i}`);
  });
});

test("concurrent calls to the same tool pair up with their own results", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  const a = ex.toolCall("read_file", { path: "a.ts" });
  const b = ex.toolCall("read_file", { path: "b.ts" });
  assert.notEqual(a, b, "two calls started in the same tick need different ids");
  assert.equal(h.one(ex.id).activeToolCallIds.length, 2);
  // Out of order, which is how concurrent calls actually settle.
  ex.toolResult(b, "read_file", true, "B");
  assert.equal(h.one(ex.id).phase, "tool", "one call still in flight keeps the action on the tool");
  ex.toolResult(a, "read_file", false, "A failed");
  const rec = h.one(ex.id);
  assert.equal(rec.toolCalls.find((c) => c.toolCallId === a).output, "A failed");
  assert.equal(rec.toolCalls.find((c) => c.toolCallId === a).ok, false);
  assert.equal(rec.toolCalls.find((c) => c.toolCallId === b).output, "B");
  assert.equal(rec.phase, "thinking");
});

test("ten concurrent sub-agents: no cross-contamination, no duplicates, every id present", () => {
  const h = harness();
  const handles = Array.from({ length: 10 }, (_, i) =>
    beginExecution(init({ agent: `worker${i}`, task: `task ${i}` })),
  );
  const ids = new Set(handles.map((x) => x.id));
  assert.equal(ids.size, 10, "execution ids are unique");
  for (const ex of handles) ex.start();
  for (let round = 0; round < 5; round++) {
    for (const ex of handles) {
      const c = ex.toolCall("search_in_files", { query: `${ex.id}-${round}` });
      ex.toolResult(c, "search_in_files", true, `${ex.id}-${round}`);
    }
  }
  handles.forEach((ex, i) => (i % 3 === 0 ? ex.fail("nope") : ex.complete(`done ${i}`)));

  assert.equal(h.state.order.length, 10);
  handles.forEach((ex, i) => {
    const rec = h.one(ex.id);
    assert.equal(rec.toolCallCount, 5);
    assert.ok(rec.toolCalls.every((c) => c.args.query.startsWith(ex.id)), "a call belongs to one execution");
    assert.equal(rec.status, i % 3 === 0 ? "failed" : "completed");
  });
  const counts = summarise(h.state, "c1");
  assert.deepEqual(counts, { running: 0, queued: 0, failed: 4, total: 10 });
});

// ── Hierarchy (TODO §20, §21) ───────────────────────────────────────────────────────────────────

test("a nested delegation is listed under its parent and never at the top level", () => {
  const h = harness();
  const parent = beginExecution(init({ agent: "explore" }));
  parent.start();
  const child = beginExecution(init({ agent: "search", parentExecutionId: parent.id }));
  child.start();

  assert.deepEqual(h.one(parent.id).childIds, [child.id]);
  assert.equal(h.one(child.id).parentExecutionId, parent.id);
  assert.deepEqual(rootExecutions(h.state).map((e) => e.id), [parent.id]);

  // A parent stays running while a child finishes: nothing about a child settles its parent.
  child.complete("found it");
  assert.equal(h.one(parent.id).status, "running");
});

// ── Retention (TODO §13) ────────────────────────────────────────────────────────────────────────

test("old settled executions are evicted; running ones never are", () => {
  const h = harness();
  const settled = Array.from({ length: 8 }, () => {
    const ex = beginExecution(init());
    ex.start();
    ex.complete("x");
    return ex.id;
  });
  const live = beginExecution(init());
  live.start();

  const pruned = pruneExecutions(h.state, 3);
  assert.equal(pruned.order.filter((id) => pruned.byId[id].status === "completed").length, 3);
  assert.ok(pruned.byId[live.id], "a running delegation is retained whatever the cap");
  assert.ok(!pruned.byId[settled[0]], "the oldest settled ones go first");
  assert.ok(pruned.byId[settled[7]]);
});

test("a settled parent with a live child is not evicted out from under it", () => {
  const h = harness();
  const parent = beginExecution(init());
  parent.start();
  const child = beginExecution(init({ parentExecutionId: parent.id }));
  child.start();
  parent.complete("handed off");
  for (let i = 0; i < 5; i++) {
    const ex = beginExecution(init());
    ex.start();
    ex.complete("x");
  }
  const pruned = pruneExecutions(h.state, 1);
  assert.ok(pruned.byId[parent.id], "evicting it would orphan its running child at the top level");
  assert.ok(pruned.byId[child.id]);
});

test("the timeline is capped, and says how much it dropped", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  for (let i = 0; i < MAX_EVENTS_PER_EXECUTION + 20; i++) ex.action(i % 2 ? "thinking" : "waiting");
  const rec = h.one(ex.id);
  assert.equal(rec.events.length, MAX_EVENTS_PER_EXECUTION);
  assert.ok(rec.droppedEvents > 0);
});

test("clearing a conversation forgets only that conversation's executions", () => {
  const h = harness();
  const mine = beginExecution(init({ conversationId: "c1" }));
  const other = beginExecution(init({ conversationId: "c2" }));
  const after = clearConversation(h.state, "c1");
  assert.ok(!after.byId[mine.id]);
  assert.ok(after.byId[other.id]);
});

// ── Payload safety (TODO §10, §28) ──────────────────────────────────────────────────────────────

test("secret-named arguments are withheld whatever they contain", () => {
  const out = redactArgs({
    path: "src/auth/session.ts",
    apiKey: "not-actually-a-known-shape",
    headers: { Authorization: "Bearer abcdefghijklmnop", accept: "json" },
    env: { HOME: "/home/u" },
  });
  assert.equal(out.path, "src/auth/session.ts");
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.headers.Authorization, REDACTED);
  assert.equal(out.headers.accept, "json");
  assert.equal(out.env, REDACTED, "environment variables are not exposed by default");
});

test("secret-shaped values are scrubbed out of free text, keeping the line readable", () => {
  const out = redactOutput('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\ncalled with sk-ant-abcdefghijklmnopq');
  assert.ok(!out.includes("wJalrXUtnFEMI"));
  assert.ok(out.includes("AWS_SECRET_ACCESS_KEY"), "the name survives so the line still says what was hidden");
  assert.ok(!out.includes("sk-ant-abcdefghijklmnopq"));
  assert.ok(out.includes(REDACTED));
});

test("a huge tool result is clipped rather than stored whole", () => {
  const out = redactOutput("x".repeat(50_000));
  assert.ok(out.length < 5_000);
  assert.ok(out.includes("more characters"));
});

test("a tool result is stored once, on the call — never duplicated onto the timeline", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  const c = ex.toolCall("read_file", { path: "a.ts", content: "y".repeat(5000) });
  ex.toolResult(c, "read_file", true, "z".repeat(50_000));
  const rec = h.one(ex.id);
  const timeline = rec.events.find((e) => e.type === "tool_result");
  assert.equal(timeline.output, undefined, "the timeline carries ordering, not payloads");
  assert.equal(rec.events.find((e) => e.type === "tool_call").input, undefined);
  assert.ok(rec.toolCalls[0].output.length < 5_000, "and the one stored copy is clipped");
  assert.ok(rec.toolCalls[0].args.content.length < 1_000);
});

test("events handed to a subscriber cannot be mutated by another subscriber", () => {
  resetExecutionListenersForTest();
  const seen = [];
  subscribeExecutionEvents((e) => {
    try {
      e.executionId = "hijacked";
    } catch {
      /* frozen in strict mode: exactly the point */
    }
  });
  subscribeExecutionEvents((e) => seen.push(e.executionId));
  const ex = beginExecution(init());
  assert.equal(seen[0], ex.id);
});

test("a listener that throws does not stop the others, and does not reach the runtime", () => {
  resetExecutionListenersForTest();
  const seen = [];
  subscribeExecutionEvents(() => {
    throw new Error("bad listener");
  });
  subscribeExecutionEvents((e) => seen.push(e.type));
  // The throw is reported, not swallowed; muted here so the expected warning is not mistaken for a failure.
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => beginExecution(init()).start());
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, ["spawned", "started"]);
});

// ── The store (TODO §12) ────────────────────────────────────────────────────────────────────────

test("the store folds a burst of events under a single notification", async () => {
  resetExecutionListenersForTest();
  const { useSubAgentExecutionStore } = await import("../src/store/subagentExecutionStore.ts");
  let notifications = 0;
  const stop = useSubAgentExecutionStore.subscribe(() => notifications++);

  const handles = Array.from({ length: 5 }, () => beginExecution(init()));
  for (const ex of handles) ex.start();
  assert.equal(notifications, 0, "nothing is applied synchronously — the batch is still open");

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notifications, 1, "ten events, one render");
  const state = useSubAgentExecutionStore.getState().executions;
  for (const ex of handles) assert.equal(state.byId[ex.id].status, "running");
  stop();
});

test("the store separates the main agent's wait from the sub-agents' own state", async () => {
  // No listener reset here: the store subscribes once, at import, and clearing the bus would silently
  // detach it — the module is already cached, so a second import would not re-subscribe.
  const { useSubAgentExecutionStore } = await import("../src/store/subagentExecutionStore.ts");
  const store = useSubAgentExecutionStore.getState();
  const ex = beginExecution(init({ turnId: "t-wait" }));
  ex.start();
  await Promise.resolve();
  await Promise.resolve();

  store.beginJoinWait({ conversationId: "c1", turnId: "t-wait", executionIds: [ex.id], since: 1 });
  assert.ok(useSubAgentExecutionStore.getState().waits["t-wait"]);
  assert.equal(
    useSubAgentExecutionStore.getState().executions.byId[ex.id].status,
    "running",
    "the main agent waiting must not mark its sub-agent as waiting",
  );
  assert.deepEqual(useSubAgentExecutionStore.getState().outstandingForTurn("t-wait"), [ex.id]);

  store.endJoinWait("t-wait");
  assert.equal(useSubAgentExecutionStore.getState().waits["t-wait"], undefined);
});

// ── The run view reads a delegation as a conversation (Inspector drill-down) ─────────────────────

test("an execution becomes the same message shapes the chat page renders", () => {
  const h = harness();
  const ex = beginExecution(init({ agent: "explore", task: "Map the retry logic" }));
  ex.start();
  const c = ex.toolCall("read_file", { path: "a.ts" });
  ex.toolResult(c, "read_file", true, "contents", 1800);
  ex.complete("it retries twice");

  const rows = executionTranscript(h.one(ex.id));
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user", "tool", "assistant"],
    "task → thinking process → reply, which is what a turn looks like",
  );
  assert.equal(rows[0].content, "Map the retry logic");
  assert.equal(rows[1].name, "read_file");
  assert.equal(rows[1].ok, true);
  assert.equal(rows[1].running, false, "a settled call is not drawn with a spinner");
  assert.equal(rows[1].ms, 1800, "the duration the runtime measured reaches the row");
  assert.equal(rows[2].content, "it retries twice");
});

test("a call still in flight is marked running rather than reported as a success", () => {
  const h = harness();
  const ex = beginExecution(init());
  ex.start();
  ex.toolCall("search_files", { pattern: "x" });

  const rows = executionTranscript(h.one(ex.id));
  assert.equal(rows[1].running, true);
  assert.equal(rows.length, 2, "no reply yet — the page shows the turn in progress");
  assert.equal(executionIsRunning(h.one(ex.id)), true);
});

test("a failed run ends in its error, so the page does not read as still going", () => {
  const h = harness();
  const ex = beginExecution(init({ agent: "coder" }));
  ex.start();
  ex.fail("run_command exited with code 1", "error");

  const rows = executionTranscript(h.one(ex.id));
  const last = rows[rows.length - 1];
  assert.equal(last.kind, "assistant");
  assert.match(last.content, /run_command exited with code 1/);
  assert.equal(executionIsRunning(h.one(ex.id)), false);
});

// ── Which turn started it (Inspector grouping) ───────────────────────────────────────────────────

test("delegations are grouped by their turn, newest turn first, spawn order within", () => {
  const h = harness();
  const first = ["a1", "a2"].map((agent) =>
    beginExecution(init({ agent, turnId: "t1", turnLabel: "find the auth code" })),
  );
  const second = beginExecution(init({ agent: "b1", turnId: "t2", turnLabel: "now write the fix" }));

  const groups = groupByTurn(h.state, "c1");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].turnId, "t2", "the newest turn is where the running work is");
  assert.equal(groups[0].label, "now write the fix");
  assert.deepEqual(groups[0].executions.map((e) => e.id), [second.id]);
  assert.equal(groups[1].label, "find the auth code");
  assert.deepEqual(groups[1].executions.map((e) => e.id), first.map((e) => e.id));
});

test("a nested delegation is grouped by its parent, not listed beside it", () => {
  const h = harness();
  const parent = beginExecution(init({ turnId: "t1", turnLabel: "explore" }));
  beginExecution(init({ turnId: "t1", turnLabel: "explore", parentExecutionId: parent.id }));

  const groups = groupByTurn(h.state, "c1");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].executions.map((e) => e.id), [parent.id], "children render under their row");
  assert.equal(groups[0].executions[0].childIds.length, 1);
});

test("a delegation from another conversation is not grouped into this one", () => {
  const h = harness();
  beginExecution(init({ conversationId: "c1", turnId: "t1" }));
  beginExecution(init({ conversationId: "c2", turnId: "t9" }));
  assert.equal(groupByTurn(h.state, "c1").length, 1);
  assert.equal(groupByTurn(h.state).length, 2, "unfiltered shows both");
});

test("a delegation with no turn id still appears, as its own group", () => {
  // The field is optional on the event; hiding the row would be the worst way to handle a missing label.
  const h = harness();
  const ex = beginExecution({ agent: "x", task: "t", origin: "run_subagent", conversationId: "c1" });
  const groups = groupByTurn(h.state, "c1");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, undefined);
  assert.deepEqual(groups[0].executions.map((e) => e.id), [ex.id]);
});
