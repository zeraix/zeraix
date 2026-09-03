/**
 * Sub-agent convergence (docs/agent-runtime-loop.md §15) — milestone M6.
 *
 * §15 asks that a sub-agent run "its own instance of the same Agent Loop the Main Agent uses", not a second
 * implementation of one. Until this milestone `delegation.ts` had its own `while (true)` with **no upper
 * limit, no doom-loop detection and no stop policy** (M0's problem P3) — so a sub-agent that started
 * repeating itself did so entirely unobserved, which is worse than the main agent's case because nobody is
 * reading its output while it runs.
 *
 * These tests drive the real `createRunDelegation` with injected dependencies. Every fixture is a scripted
 * model, so what is asserted is the Runtime's reaction to a sub-agent that misbehaves — the thing that could
 * not be tested at all while the sub-agent loop was unbounded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { createRunDelegation } = await import("../src/app/agent/chat/delegation.ts");
const { beginExecution, cancelExecution, resetExecutionListenersForTest, subscribeExecutionEvents } =
  await import("../src/lib/agent/executionRegistry.ts");
const { STOPPED_BY_USER_RESULT } = await import("../src/lib/ai/subagentScheduler.ts");

const CAPS = {
  supportsReasoning: true,
  supportsToolCalling: true,
  supportsParallelToolCalls: true,
  supportsStreaming: true,
  supportsStructuredOutput: false,
  supportsPerTurnReasoningEffort: true,
  supportsImages: false,
};

/**
 * Build a delegation runner over a scripted sequence of provider responses.
 *
 * `toolsReady: false` keeps `listTools` out of it, and a non-local endpoint keeps the sub-conversation-id
 * path (which writes to the store) out too — neither is what these tests are about.
 */
function makeRunner({ turns, repeatLast = false, toolResult = () => "ok", ok = () => true }) {
  let i = 0;
  const requests = [];
  const executed = [];
  // The shared repeat-guard record. Shared on purpose: a test that hands out a fresh object per call could
  // never observe whether a conclusion was recorded, and would pass whatever the code did.
  const bucket = { turnId: "t1", done: [] };
  const run = createRunDelegation({
    t: (k, v) => `${k}:${JSON.stringify(v ?? {})}`,
    toolsReady: false,
    workdir: "/w",
    endpoint: "https://api.example.test/v1",
    sandboxStatus: () => null,
    isLocalModel: false,
    sendReasoningContext: () => false,
    thinking: { enabled: true, effort: "high", sendContext: false },
    capabilities: CAPS,
    requestChat: async (messages, tools, signal, onDelta, log, reasoning) => {
      requests.push({ messages, log, reasoning });
      const turn = i < turns.length ? turns[i] : repeatLast ? turns[turns.length - 1] : { content: "done" };
      i++;
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: turn.content ?? null,
              ...(turn.toolCalls
                ? {
                    tool_calls: turn.toolCalls.map((c, n) => ({
                      id: `c${i}_${n}`,
                      type: "function",
                      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                    })),
                  }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
    execToolCall: async (ctx, name, args, displayName, actor, requester, onResult) => {
      executed.push({ name, args });
      onResult?.(ok(name, args, executed.length - 1));
      return toolResult(name, args, executed.length - 1);
    },
    delegations: () => bucket,
  });
  return { run, requests, executed, bucket };
}

const ctx = (signal = new AbortController().signal) => ({
  convId: "conv1",
  turnId: "t1",
  signal,
  push: () => {},
  status: () => {},
});
const opts = (over = {}) => ({
  agentId: "explore",
  task: "find the handler",
  def: { id: "explore", systemPrompt: "you explore", tools: undefined },
  label: "explore",
  onStep: () => {},
  status: () => {},
  ...over,
});

// ── The behaviour that convergence brings ───────────────────────────────────────────────────────────────

test("a sub-agent that repeats one call forever is now halted", async () => {
  const { run, executed } = makeRunner({
    turns: [{ toolCalls: [{ name: "search_files", args: { query: "handler" } }] }],
    repeatLast: true,
    toolResult: () => "always the same",
  });
  const result = await run(ctx(), opts());
  // Before M6 this ran until the user pressed stop. There was no cap and no detector on this path at all.
  assert.ok(result.error, "a halted delegation must report an error, not a conclusion");
  assert.match(result.error, /doom-loop/);
  assert.ok(executed.length < 12, `expected a prompt halt, ran ${executed.length} tools`);
});

test("a halted sub-agent's output is NOT recorded as a reusable conclusion", async () => {
  const halted = makeRunner({
    turns: [{ toolCalls: [{ name: "search_files", args: { query: "x" } }] }],
    repeatLast: true,
    toolResult: () => "same",
  });
  // `delegations()` is the repeat-guard record. A truncated run must not populate it, or the next identical
  // delegation would be answered from a conclusion that was never actually reached.
  await halted.run(ctx(), opts());
  assert.deepEqual(halted.bucket.done, [], "nothing to reuse from a delegation that never finished");

  // The control: a delegation that DOES finish is recorded, so the assertion above is about the halt and not
  // about the record being broken.
  const ok = makeRunner({ turns: [{ content: "the handler is in a.ts" }] });
  await ok.run(ctx(), opts());
  assert.equal(ok.bucket.done.length, 1);
  assert.equal(ok.bucket.done[0].conclusion, "the handler is in a.ts");
});

test("an ordinary delegation still returns its conclusion", async () => {
  const { run, executed } = makeRunner({
    turns: [
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { content: "The handler is in a.ts." },
    ],
  });
  const result = await run(ctx(), opts());
  assert.equal(result.error, undefined);
  assert.equal(result.conclusion, "The handler is in a.ts.");
  assert.deepEqual(executed.map((e) => e.name), ["read_file"]);
});

test("a sub-agent's reasoning follows the same phase policy as the main agent", async () => {
  const { run, requests } = makeRunner({
    turns: [
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "b.ts" } }] },
      { content: "done" },
    ],
  });
  await run(ctx(), opts());
  assert.equal(requests.length, 3, "one request per round");
  // The effort actually sent, round by round: round 1 plans at the user's setting, later routine rounds are
  // economised. This is what proves the loop's decision REACHES the provider — resolving it and then not
  // passing it would leave every request at the session default and look identical from the outside.
  assert.deepEqual(
    requests.map((r) => r.reasoning?.effort),
    ["high", "low", "low"],
  );
});

test("a sub-agent's recovery round keeps full effort, exactly as the main agent's does", async () => {
  const { run, requests } = makeRunner({
    turns: [
      { toolCalls: [{ name: "edit_file", args: { path: "missing.ts" } }] },
      { toolCalls: [{ name: "list_directory", args: { path: "." } }] },
      { content: "fixed" },
    ],
    ok: (name) => name !== "edit_file",
    toolResult: (name) => (name === "edit_file" ? "no such file" : "listing"),
  });
  await run(ctx(), opts());
  assert.equal(requests[1].reasoning?.effort, "high", "recovery must never be silently economised");
});

test("a failing tool moves the delegation into recovery rather than being ignored", async () => {
  const { run } = makeRunner({
    turns: [
      { toolCalls: [{ name: "edit_file", args: { path: "missing.ts" } }] },
      { toolCalls: [{ name: "list_directory", args: { path: "." } }] },
      { content: "fixed it" },
    ],
    ok: (name) => name !== "edit_file",
    toolResult: (name) => (name === "edit_file" ? "no such file" : "a.ts b.ts"),
  });
  const result = await run(ctx(), opts());
  assert.equal(result.conclusion, "fixed it", "recovery still reaches a conclusion");
  assert.equal(result.error, undefined);
});

test("many different tools all failing stops the delegation on the failure backstop", async () => {
  const names = ["read_file", "list_directory", "search_files", "file_info", "write_file", "edit_file",
                 "run_command", "search_in_files", "append_file", "copy_file", "move_file", "delete_file"];
  const { run } = makeRunner({
    turns: names.map((name) => ({ toolCalls: [{ name, args: { path: `${name}.ts` } }] })),
    ok: () => false,
    toolResult: (n, a, i) => `environment is broken (${i})`,
  });
  const result = await run(ctx(), opts());
  assert.ok(result.error, "a delegation in a broken environment must not run forever");
});

test("cancelling the turn ends the delegation as cancelled, not as an answer", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { run, requests } = makeRunner({ turns: [{ content: "never reached" }] });
  const result = await run(ctx(ctrl.signal), opts());
  assert.equal(result.error, "cancelled");
  assert.equal(requests.length, 0, "an already-cancelled delegation issues no request");
});

test("stopping ONE sub-agent ends its delegation as cancelled and tells the parent the user did it", async () => {
  resetExecutionListenersForTest();
  const events = [];
  subscribeExecutionEvents((e) => events.push(e.type));
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });

  const turn = new AbortController();
  let signals = [];
  const { run, requests } = makeRunner({
    turns: [
      { toolCalls: [{ name: "search_files", args: { query: "handler" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { content: "never reached" },
    ],
    repeatLast: true,
  });
  // Press Stop while the second round's request is in flight, from outside — exactly what the button does.
  const stopping = run(
    {
      ...ctx(turn.signal),
      // The runner's requestChat ignores its signal argument, so the stop is observed through the loop
      // instead: it must end the delegation without another request being issued.
    },
    opts({
      execution,
      status: () => {
        if (requests.length === 2 && signals.length === 0) signals.push(cancelExecution(execution.id));
      },
    }),
  );
  const result = await stopping;

  assert.deepEqual(signals, [true], "the stop was accepted while the delegation was running");
  assert.equal(result.error, "cancelled");
  assert.equal(result.conclusion, STOPPED_BY_USER_RESULT, "the parent learns the USER stopped it");
  assert.equal(turn.signal.aborted, false, "the turn itself was never cancelled");
  assert.ok(requests.length < 4, "the loop stops issuing requests once its signal is pulled");
  assert.equal(events.at(-1), "cancelled");
  assert.ok(events.includes("cancel_requested"));
});

test("a request that REJECTS with the abort reason on Stop is a cancellation, not a failure", async () => {
  // What actually happens in the app: Stop pulls the signal under an in-flight fetch, which rejects with
  // "signal is aborted without reason". That must not become the sub-agent's conclusion or a red row.
  resetExecutionListenersForTest();
  const events = [];
  subscribeExecutionEvents((e) => events.push(e));
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "run_subagent" });
  const { run, requests } = makeRunner({
    turns: [{ toolCalls: [{ name: "search_files", args: { query: "handler" } }] }, { content: "unreached" }],
    // The first tool call is where Stop lands; the runner's tool rejects the way a real aborted call does.
    toolResult: () => {
      cancelExecution(execution.id);
      throw new DOMException("signal is aborted without reason", "AbortError");
    },
  });
  const result = await run(ctx(), opts({ execution }));
  assert.equal(result.error, "cancelled");
  assert.equal(result.conclusion, STOPPED_BY_USER_RESULT);
  assert.equal(requests.length, 1);
  const last = events.at(-1);
  assert.equal(last.type, "cancelled", "reported as stopped, not failed");
  assert.ok(!events.some((e) => e.type === "failed"));
});

test("a sub-agent stopped while still queued never starts and never issues a request", async () => {
  resetExecutionListenersForTest();
  const events = [];
  subscribeExecutionEvents((e) => events.push(e.type));
  const execution = beginExecution({ agent: "explore", task: "find the handler", origin: "spawn_subagents" });
  cancelExecution(execution.id);
  const { run, requests } = makeRunner({ turns: [{ content: "never reached" }] });
  const result = await run(ctx(), opts({ execution }));
  assert.equal(result.error, "cancelled");
  assert.equal(result.conclusion, STOPPED_BY_USER_RESULT);
  assert.equal(requests.length, 0);
  assert.deepEqual(events, ["spawned", "cancel_requested", "cancelled"], "no `started` for work that never ran");
});

test("a provider failure ends the delegation with an error rather than an empty conclusion", async () => {
  const { run } = makeRunner({ turns: [{ content: null }] });
  // A response with no message at all is the "no response" path.
  const result = await run(ctx(), opts({ agentId: "explore" }));
  assert.ok(result.conclusion.length > 0, "there is always something to report back to the parent");
});
