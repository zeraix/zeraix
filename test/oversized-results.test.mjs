/**
 * The wire-side rule for a tool result too large for the model (contextCompress.withholdOversizedResults).
 *
 * `read_file` returns whole files with no cap, so a result can be bigger than any context window. Such a
 * result stays in the transcript and on disk; on the wire the model gets a note that says what it was and
 * how to read it in pieces. The planner sees the same view, so one giant read does not trip compaction on
 * every later turn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const {
  buildWireContext,
  indexCalls,
  measureResult,
  oversizedResultStub,
  planCompaction,
  resultCeilingTokens,
  withholdOversizedResults,
} = await import("../src/app/agent/chat/contextCompress.ts");
const { countMessagesTokens } = await import("../src/lib/ai/tokenizer.ts");

const call = (id, name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id, content) => ({ role: "tool", tool_call_id: id, content });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of the log with some words in it`).join("\n") + "\n";
const bigLog = lines(60_000); // ~2.6 MB, ~700K tokens

const convo = [
  { role: "system", content: "sys" },
  { role: "user", content: "look at the log" },
  call("c1", "read_file", { path: "big.log" }),
  result("c1", bigLog),
  call("c2", "read_file", { path: "small.txt" }),
  result("c2", "just a few words"),
];

test("the ceiling is the compaction target: half the window, or the budget-scaled target when one is set", () => {
  assert.equal(resultCeilingTokens(128_000, 0), 64_000);
  assert.equal(resultCeilingTokens(1_000_000, 120), Math.floor(120_000 * (0.5 / 0.75)));
  assert.equal(resultCeilingTokens(0, 0), 0);
});

test("a result over the ceiling is replaced by a note naming the call, its size, and how to page", () => {
  const out = withholdOversizedResults(convo, indexCalls(convo), 10_000);
  assert.notEqual(out, convo);
  const note = out[3].content;
  assert.match(note, /^\[tool result withheld: read_file big\.log returned 60,000 lines, /);
  assert.match(note, /offset\/limit/);
  assert.match(note, /the file has 60,000 lines/);
  assert.match(note, /10,000 tokens/);
  assert.ok(note.length < 1024, "the note is a few hundred characters");
  // Everything else is the same object, not a copy.
  for (const i of [0, 1, 2, 4, 5]) assert.equal(out[i], convo[i]);
});

test("nothing qualifies: the same array comes back, and a ceiling of 0 withholds nothing", () => {
  assert.equal(withholdOversizedResults(convo, indexCalls(convo), 0), convo);
  const small = convo.filter((m) => m.tool_call_id !== "c1" && !m.tool_calls?.some((c) => c.id === "c1"));
  assert.equal(withholdOversizedResults(small, indexCalls(small), 10_000), small);
});

test("the note for a tool other than read_file asks for less instead of offering offset/limit", () => {
  const shape = measureResult("a\nb\nc");
  assert.deepEqual({ chars: shape.chars, lines: shape.lines }, { chars: 5, lines: 3 });
  const note = oversizedResultStub({ name: "run_command" }, { chars: 5, lines: 3, tokens: 99 }, 10);
  assert.match(note, /^\[tool result withheld: run_command returned 3 lines, 5 characters, about 99 tokens/);
  assert.match(note, /Ask for less/);
  assert.doesNotMatch(note, /offset/);
});

test("the wire builder and the planner apply the same ceiling, so a giant read does not force compaction", () => {
  const ceiling = resultCeilingTokens(128_000, 0);
  const wire = buildWireContext(convo, null, ceiling);
  assert.match(wire[3].content, /^\[tool result withheld/);
  assert.ok(countMessagesTokens(wire) < 2_000, "the request is small once the result is withheld");

  // The caller measured the raw buffer: far over the trigger. The planner measures the withheld view instead.
  const raw = countMessagesTokens(convo);
  assert.ok(raw > 128_000 * 0.75, `raw conversation is ${raw} tokens`);
  assert.equal(planCompaction(convo, { contextWindow: 128_000, currentTokens: raw }), null);
  // Without a ceiling the planner would have to act on it — pinned so the test above cannot pass vacuously.
  assert.notEqual(planCompaction(convo, { contextWindow: 128_000, currentTokens: raw, targetTokens: 1e12, triggerTokens: 1 }), null);
});

test("the rule is cheap on a large result", () => {
  const huge = lines(200_000); // ~9 MB
  const msgs = [call("c9", "read_file", { path: "huge.log" }), result("c9", huge)];
  withholdOversizedResults(msgs, indexCalls(msgs), 1_000); // warm the tokenizer
  const t0 = performance.now();
  withholdOversizedResults(msgs, indexCalls(msgs), 1_000);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `took ${ms.toFixed(0)} ms`);
});
