/**
 * The line span the renderer attributes to a `read_file` call, and the dedup that rests on it.
 *
 * `read_file` has had no default line window since 2026-09-04: a bare `read_file {path}` returns the whole
 * file. The stale-read dedup in contextCompress.ts decides whether an earlier read is redundant by span
 * containment, so the span of a bare read has to be open-ended — [1, ∞) — or a later whole-file read would
 * fail to supersede the chunk reads before it, and a chunk read could wrongly supersede a whole-file one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { indexCalls, computeStaleStubs, covers, MIN_STUB_CHARS } = await import(
  "../src/app/agent/chat/contextCompress.ts"
);

const read = (id, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }],
});
// Long enough to be worth stubbing; dedup ignores results shorter than MIN_STUB_CHARS.
const result = (id) => ({ role: "tool", tool_call_id: id, content: "x".repeat(MIN_STUB_CHARS) });
const rangeOf = (args) => indexCalls([read("c", args)]).get("c").range;

test("a bare read spans the whole file, and an offset without a limit reads to the end", () => {
  assert.deepEqual(rangeOf({ path: "big.log" }), { start: 1, end: Infinity });
  assert.deepEqual(rangeOf({ path: "big.log", offset: 300 }), { start: 300, end: Infinity });
  // The tool treats 0 and NaN as absent (`Number(v) || …`), so the span does too.
  assert.deepEqual(rangeOf({ path: "big.log", offset: 0, limit: 0 }), { start: 1, end: Infinity });
  assert.deepEqual(rangeOf({ path: "big.log", offset: "3", limit: "2" }), { start: 3, end: 4 });
  assert.deepEqual(rangeOf({ path: "big.log", offset: 460, limit: 90 }), { start: 460, end: 549 });
});

test("containment works on the open-ended span", () => {
  const whole = { start: 1, end: Infinity };
  assert.equal(covers(whole, whole), true);
  assert.equal(covers(whole, { start: 5000, end: 5089 }), true);
  assert.equal(covers({ start: 1, end: 2000 }, whole), false, "a chunk never covers the whole file");
  assert.equal(covers({ start: 2, end: Infinity }, whole), false, "a read from line 2 misses line 1");
  assert.equal(covers(whole, { start: 2, end: Infinity }), true);
});

test("a later bare read supersedes every earlier chunk read of the same path", () => {
  const messages = [
    read("c1", { path: "big.log", offset: 460, limit: 90 }),
    result("c1"),
    read("c2", { path: "big.log", offset: 5000, limit: 90 }),
    result("c2"),
    read("c3", { path: "big.log" }),
    result("c3"),
  ];
  const stubs = computeStaleStubs(messages, indexCalls(messages), 0);
  assert.deepEqual([...stubs.keys()].sort(), ["c1", "c2"]);
});

test("a chunk read never supersedes an earlier bare read, and a different path is untouched", () => {
  const messages = [
    read("c1", { path: "big.log" }),
    result("c1"),
    read("c2", { path: "big.log", offset: 1, limit: 2000 }),
    result("c2"),
    read("c3", { path: "other.log" }),
    result("c3"),
  ];
  assert.equal(computeStaleStubs(messages, indexCalls(messages), 0).size, 0);
});
