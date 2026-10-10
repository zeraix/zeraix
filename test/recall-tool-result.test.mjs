/**
 * Getting a removed tool result back (recall.ts), and the notes that point to it.
 *
 * Every layer that drops a result from the model's context used to say "run it again" — wrong for a command
 * with side effects, and a round trip and possibly a different answer for the rest. The store keeps every
 * result in full; `recall_tool_result` returns one by id, and each note names the id and the call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { ELISION_HINT, RECALL_TOOL, recallCall, recallToolResult } = await import("../src/app/agent/chat/recall.ts");
const { buildWireContext, oversizedResultStub } = await import("../src/app/agent/chat/contextCompress.ts");

const call = (id, name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const stored = (id, name, content) => ({ role: "tool", tool_call_id: id, name, content });

const LOG = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");

test("a recalled result comes back exactly as it was returned", () => {
  const out = recallToolResult([stored("c1", "run_command", LOG)], { id: "c1" });
  assert.ok(out.endsWith(`\n${LOG}`), out);
  assert.match(out, /^\[recalled: the run_command result c1, exactly as it was returned\]/);
});

test("offset and limit page through it by line, as read_file pages a file", () => {
  const out = recallToolResult([stored("c1", "run_command", LOG)], { id: "c1", offset: 2, limit: 2 });
  assert.match(out, /lines 2-3 of 5/);
  assert.ok(out.endsWith("\nline 2\nline 3"), out);
  // An offset alone reads to the end; one past the end says how long the result is.
  assert.ok(recallToolResult([stored("c1", "run_command", LOG)], { id: "c1", offset: 4 }).endsWith("\nline 4\nline 5"));
  assert.match(recallToolResult([stored("c1", "run_command", LOG)], { id: "c1", offset: 9 }), /has 5 lines/);
});

test("a filesystem snapshot says the files may have changed since; a command's output does not", () => {
  assert.match(recallToolResult([stored("r1", "read_file", "fn main() {}")], { id: "r1" }), /may have changed since/);
  assert.doesNotMatch(recallToolResult([stored("c1", "run_command", LOG)], { id: "c1" }), /may have changed/);
});

test("an unknown or missing id is answered, not thrown", () => {
  assert.match(recallToolResult([stored("c1", "run_command", LOG)], { id: "nope" }), /No tool result with id "nope"/);
  assert.match(recallToolResult([], {}), /Pass "id"/);
  // Only a tool result is ever returned — never another message that happens to carry the id.
  assert.match(recallToolResult([{ role: "assistant", tool_call_id: "c1", content: "x" }], { id: "c1" }), /No tool result/);
});

test("the runtime's template names the tool and leaves the id for the runtime to fill in", () => {
  assert.ok(ELISION_HINT.includes(recallCall("{id}")), ELISION_HINT);
  assert.ok(recallCall("call_9").includes(`"name": "${RECALL_TOOL}"`));
  assert.ok(recallCall("call_9").includes(`"id": "call_9"`));
});

test("a completed round's released result names the call that recalls it", () => {
  const big = "y".repeat(2_000);
  const convo = [
    { role: "user", content: "first task" },
    call("old1", "run_command", { command: "npm test" }),
    { role: "tool", tool_call_id: "old1", content: big },
    { role: "assistant", content: "tests pass" },
    { role: "user", content: "second task" },
    { role: "assistant", content: "done" },
    { role: "user", content: "third task" },
  ];
  const wire = buildWireContext(convo, null);
  const released = wire.find((m) => m.role === "tool" && m.tool_call_id === "old1");
  assert.ok(released.content.includes(recallCall("old1")), released.content);
});

test("an oversized command result says how to page through the kept copy; read_file keeps its own advice", () => {
  const shape = { chars: 900_000, lines: 20_000, tokens: 250_000 };
  const command = oversizedResultStub({ name: "run_command", id: "c7" }, shape, 50_000);
  assert.ok(command.includes(recallCall("c7")), command);
  const read = oversizedResultStub({ name: "read_file", path: "big.log", id: "r7" }, shape, 50_000);
  assert.match(read, /read_file offset\/limit/);
  assert.ok(!read.includes(RECALL_TOOL), "read_file's own paging reads the CURRENT file — the better advice");
});

test("a repeated id returns the latest result and says the id is shared", () => {
  const out = recallToolResult([stored("call_0", "run_command", "first"), stored("call_0", "run_command", "second")], { id: "call_0" });
  assert.ok(out.endsWith("\nsecond"), out);
  assert.match(out, /2 results share this id, this is the latest/);
});

test("a result kept on disk only is not passed off as the result itself", async () => {
  const { unloadedBlobNote } = await import("../electron/store/resultBlobs.mjs");
  const note = unloadedBlobNote("a".repeat(64), 9_000_000);
  const out = recallToolResult([stored("big", "read_file", note)], { id: "big" });
  assert.match(out, /too large to keep loaded/);
  assert.ok(!out.includes("exactly as it was returned"), out);
});

