/**
 * Reading the arguments a model actually emits, rather than the ones the schema asked for.
 *
 * The failure these pin is one bug wearing several hats. `JSON.parse(...) catch → {}` meant every malformed or merely
 * unconventional payload reached the tool as NO arguments, and the tool then reported a missing required parameter — so the
 * model was told its shape was wrong for a call whose shape was right, and the honest correction (the same call again) was the
 * one thing the message argued against. It bit `spawn_subagents` hardest: its batch of long task strings is the biggest payload
 * on the wire, so it is the first to be truncated by a token ceiling, and "tasks must be a non-empty array" pushed models off
 * the concurrent path onto serial `run_subagent` calls — correct, and several times slower.
 *
 * Two rules are pinned here. A payload whose MEANING is recoverable (fenced, doubly encoded, a synonym key, an array sent as a
 * string) runs. A payload whose CONTENT was lost (truncated mid-value) does not run, and says so in a way the model can act on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { parseToolArguments } = await import("../src/lib/ai/toolArgs.ts");
const { normalizeSpawnTasks, SUBAGENTS } = await import("../src/lib/ai/subagents.ts");
const { resolveToolCall, DISPATCHER_NAME } = await import("../src/lib/ai/toolRouter.ts");

const ok = (result) => {
  assert.equal(result.ok, true, `expected readable arguments, got: ${result.error}`);
  return result.args;
};

// ── parseToolArguments ────────────────────────────────────────────────────────

test("ordinary arguments parse, and an absent payload is a no-argument call", () => {
  assert.deepEqual(ok(parseToolArguments('{"a":1}')), { a: 1 });
  assert.deepEqual(ok(parseToolArguments("")), {});
  assert.deepEqual(ok(parseToolArguments(undefined)), {});
  // Some providers spell "no arguments" as a literal null rather than an empty object.
  assert.deepEqual(ok(parseToolArguments("null")), {});
});

test("a fenced or doubly encoded payload is read rather than discarded", () => {
  assert.deepEqual(ok(parseToolArguments('```json\n{"a":1}\n```')), { a: 1 });
  assert.deepEqual(ok(parseToolArguments(JSON.stringify('{"a":1}'))), { a: 1 });
});

test("an object with a remark after it is read, and a brace inside a string does not end it early", () => {
  assert.deepEqual(ok(parseToolArguments('{"a":1} — narrow set, as asked')), { a: 1 });
  assert.deepEqual(ok(parseToolArguments('{"task":"fix the `}` handling"} done')), {
    task: "fix the `}` handling",
  });
});

test("a truncated payload does not run, and the message says why and what to do", () => {
  // What a response cut off at its token ceiling leaves behind: valid up to the point it stopped.
  const cut = '{"tasks":[{"agent":"reviewer","task":"Review every C++ source and header under src/ for arch';
  const res = parseToolArguments(cut);
  assert.equal(res.ok, false);
  // The three things the model needs: that nothing ran, that the cause was the payload not the schema, and which keys arrived.
  assert.match(res.error, /NOTHING RAN/);
  assert.match(res.error, /token limit/);
  assert.match(res.error, /tasks/);
  // It must NOT read as a complaint about the arguments the model chose, which is what sent it correcting a correct shape.
  assert.doesNotMatch(res.error, /must be a non-empty array/);
});

test("a truncated payload is never silently completed into a runnable call", () => {
  // The repair exists to describe the failure, not to run half a brief: a sub-agent handed a task string cut in two would
  // work for minutes and answer a question nobody asked.
  const res = parseToolArguments('{"tasks":[{"agent":"coder","task":"Rewrite the parser so tha');
  assert.equal(res.ok, false);
});

test("a bare array is refused with the wrapper it needs, not a parse error", () => {
  const res = parseToolArguments('[{"agent":"explore","task":"find the build entry point"}]');
  assert.equal(res.ok, false);
  assert.match(res.error, /"tasks"/);
});

// ── resolveToolCall: the call_tool envelope ───────────────────────────────────

test("a dispatched call whose arguments were flattened keeps them", () => {
  // call_tool{name, …the inner tool's own parameters}: the wrapper carries no information, so models drop it — and dropping
  // the siblings with it produced the wrapped tool's own "missing parameter" against arguments that were fully present.
  const { name, args } = resolveToolCall(DISPATCHER_NAME, {
    name: "spawn_subagents",
    tasks: [{ agent: "reviewer", task: "review src/" }],
  });
  assert.equal(name, "spawn_subagents");
  assert.equal(args.tasks.length, 1);
});

test("a dispatched call with a JSON-string envelope still wins over the flattened reading", () => {
  const { name, args } = resolveToolCall(DISPATCHER_NAME, {
    name: "read_file",
    arguments: '{"path":"src/main.ts"}',
    path: "ignored.ts",
  });
  assert.equal(name, "read_file");
  assert.equal(args.path, "src/main.ts");
});

// ── normalizeSpawnTasks ───────────────────────────────────────────────────────

const tasksOf = (raw) => {
  const res = normalizeSpawnTasks(raw);
  assert.ok(!("error" in res), `expected runnable entries, got: ${res.error}`);
  return res.entries;
};

test("the declared shape is unchanged by the normalisation around it", () => {
  const entries = tasksOf({
    tasks: [
      { agent: "reviewer", task: "review architecture" },
      { agent: "reviewer", task: "review security" },
    ],
  });
  assert.deepEqual(entries, [
    { agent: "reviewer", task: "review architecture" },
    { agent: "reviewer", task: "review security" },
  ]);
});

test("the array arriving as a JSON string is read, not refused", () => {
  // A whole class of provider serialises any non-scalar argument, so this is the model's payload arriving intact.
  const entries = tasksOf({ tasks: '[{"agent":"explore","task":"map the render pipeline"}]' });
  assert.deepEqual(entries, [{ agent: "explore", task: "map the render pipeline" }]);
});

test("one delegation sent without its wrapper still starts", () => {
  assert.deepEqual(tasksOf({ tasks: { agent: "plan", task: "design the migration" } }), [
    { agent: "plan", task: "design the migration" },
  ]);
  assert.deepEqual(tasksOf({ agent: "plan", task: "design the migration" }), [
    { agent: "plan", task: "design the migration" },
  ]);
});

test("the synonyms the tool's own description uses in prose are accepted", () => {
  assert.deepEqual(tasksOf({ subagents: [{ role: "coder", prompt: "add the flag" }] }), [
    { agent: "coder", task: "add the flag" },
  ]);
});

test("whitespace-only task text is not a task", () => {
  const res = normalizeSpawnTasks({ tasks: [{ agent: "coder", task: "   " }] });
  assert.ok("error" in res);
});

test("a call with nothing runnable in it is told what arrived, not just what was expected", () => {
  const res = normalizeSpawnTasks({ tasks: "review everything" });
  assert.ok("error" in res);
  // Naming the payload is the whole point: the model can see the schema, it cannot see how its call was received.
  assert.match(res.error, /tasks=string/);
  assert.match(res.error, /run_subagent/);
});

test("an empty call names every field it needed", () => {
  const res = normalizeSpawnTasks({});
  assert.ok("error" in res);
  assert.match(res.error, /no arguments at all/);
});

test("the roster a refusal can quote is the one that actually exists", () => {
  // The refusal for an unknown agent lists SUBAGENTS ids; a routed tool's schema is not on the wire, so this is the only
  // place the model can learn them from.
  assert.ok(SUBAGENTS.length > 0);
  for (const def of SUBAGENTS) assert.equal(typeof def.id, "string");
});

test("a label in `name` does not shadow the role the entry actually names", () => {
  // `name` is as often a title for the delegation as it is the role, so a real roster id wins wherever it appears.
  const [entry] = tasksOf({
    tasks: [{ name: "architecture review", agent: "reviewer", task: "review src/" }],
  });
  assert.equal(entry.agent, "reviewer");
});

test("an unrecognised role is still reported as the model wrote it", () => {
  // The refusal quotes this back, so swallowing it would leave the model with nothing to correct.
  const [entry] = tasksOf({ tasks: [{ role: "code-reviewer", task: "review src/" }] });
  assert.equal(entry.agent, "code-reviewer");
});

// ── The catalog signature IS the schema, for a routed tool ────────────────────

test("every parameter the delegation catalog names is one its tool actually reads", async () => {
  /*
   * The delegation family is routed (toolRouter.ts), so none of these schemas are on the wire: the one-line signature in
   * development.mode.md is the ONLY description of them the model ever sees. That made two silent mismatches possible and
   * both were live — the catalog advertised `join_subagents(… timeout_ms?)` against a declaration reading `timeout_seconds`
   * (the bound was accepted and ignored), and `spawn_sub_agent(task, tools)` against a handler requiring `requestedTools`
   * (every catalog-following call was refused on its first attempt). A stale signature here is not documentation drift; it
   * is a tool the model cannot call correctly.
   */
  const { subAgentTool, spawnSubagentsTool, joinSubagentsTool } = await import(
    "../src/lib/ai/subagents.ts"
  );
  const { spawnSubAgentTool } = await import("../src/lib/ai/orchestration/orchestrator-tool.ts");
  const catalog = (await import("../src/app/agent/chat/system/development.mode.md")).default;

  const declared = Object.fromEntries(
    [subAgentTool(), spawnSubagentsTool(), joinSubagentsTool(), spawnSubAgentTool()].map((t) => [
      t.function.name,
      Object.keys(t.function.parameters.properties),
    ]),
  );

  for (const [name, params] of Object.entries(declared)) {
    const line = new RegExp(`\`${name}\\(([^)]*)\\)\``).exec(catalog);
    assert.ok(line, `${name} has no signature in the tool catalog, which is where a routed tool is documented`);
    const named = line[1]
      .split(",")
      .map((p) => p.trim().replace(/\?$/, ""))
      .filter(Boolean);
    assert.ok(named.length > 0, `${name} is listed with no parameters at all`);
    for (const param of named) {
      assert.ok(params.includes(param), `the catalog offers ${name}(${param}), which its schema does not declare`);
    }
  }
});

// ── join_subagents arguments ─────────────────────────────────────────────────

test("a timeout is honoured under either documented spelling", async () => {
  const { readJoinArgs, JOIN_DEFAULT_TIMEOUT_MS, JOIN_MAX_TIMEOUT_MS } = await import(
    "../src/lib/ai/subagents.ts"
  );
  assert.equal(readJoinArgs({ timeout_seconds: 90 }).timeoutMs, 90_000);
  // The spelling the catalog advertised for as long as it was wrong: accepted rather than silently defaulted.
  assert.equal(readJoinArgs({ timeout_ms: 90_000 }).timeoutMs, 90_000);
  assert.equal(readJoinArgs({}).timeoutMs, JOIN_DEFAULT_TIMEOUT_MS);
  // The ceiling still binds: one wedged delegation must not be able to eat the turn.
  assert.equal(readJoinArgs({ timeout_seconds: 99_999 }).timeoutMs, JOIN_MAX_TIMEOUT_MS);
});

test("named ids are waited for, and only an absent list means everything", async () => {
  const { readJoinArgs } = await import("../src/lib/ai/subagents.ts");
  assert.deepEqual(readJoinArgs({ ids: ["d1", "d2"] }).ids, ["d1", "d2"]);
  // Both near-misses used to read as "no ids", which does not fail — it blocks on every delegation instead of the two named.
  assert.deepEqual(readJoinArgs({ ids: '["d1","d2"]' }).ids, ["d1", "d2"]);
  assert.deepEqual(readJoinArgs({ ids: "d1" }).ids, ["d1"]);
  assert.equal(readJoinArgs({}).ids, null);
  assert.equal(readJoinArgs({ ids: [] }).ids, null);
});

test("blocking is the default and only an explicit false turns it off", async () => {
  const { readJoinArgs } = await import("../src/lib/ai/subagents.ts");
  assert.equal(readJoinArgs({}).block, true);
  assert.equal(readJoinArgs({ block: false }).block, false);
  // Local models routinely emit booleans as strings; a join that blocks when the model asked not to costs it the turn.
  assert.equal(readJoinArgs({ block: "false" }).block, false);
  assert.equal(readJoinArgs({ block: true }).block, true);
});

test("spawn_sub_agent reads the tool list under either name, and still refuses a missing one", async () => {
  const { createSpawnSubAgentHandler } = await import(
    "../src/lib/ai/orchestration/orchestrator-tool.ts"
  );
  // A broker that records the ask and grants nothing: this is about argument reading, not about policy.
  let seen = null;
  const spawn = createSpawnSubAgentHandler({
    broker: {
      requestGrant: async (req) => {
        seen = req.requestedTools;
        throw new Error("no grant in this test");
      },
    },
    client: {},
    tools: {},
    requesterId: "test",
  });

  for (const args of [
    { task: "read a file", requestedTools: ["read_file"] },
    { task: "read a file", tools: ["read_file"] },
    { task: "read a file", tools: '["read_file"]' },
  ]) {
    seen = null;
    const r = await spawn(args);
    assert.notEqual(r.status, "invalid_input", `rejected ${JSON.stringify(args)}`);
    assert.deepEqual(seen, ["read_file"]);
  }

  // Naming no tools at all stays invalid: the request is what the broker answers, so there is nothing to answer.
  assert.equal((await spawn({ task: "read a file" })).status, "invalid_input");
});
