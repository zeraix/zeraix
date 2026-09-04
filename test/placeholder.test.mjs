/**
 * The context-trimming marker is never file content (electron/tools/placeholder.mjs; the Rust twin guards
 * write_file and edit_file). Pinned here against the exact text contextCompress.ts writes, so the two cannot
 * drift apart silently: if the elision wording changes shape, this test says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { isContextPlaceholder, PLACEHOLDER_REFUSED } from "../electron/tools/placeholder.mjs";

register("./helpers/srcResolve.mjs", import.meta.url);
const { releaseCallPayloads } = await import("../src/app/agent/chat/contextCompress.ts");

const call = (id, name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id, content) => ({ role: "tool", tool_call_id: id, content });
const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a file long enough to be released`).join("\n");

test("what contextCompress writes in place of a released argument is exactly what the tools refuse", () => {
  // Three completed rounds so the first write is outside the live region and gets released.
  const convo = [
    { role: "user", content: "write it" },
    call("c1", "write_file", { path: "out.csv", content: body }),
    result("c1", "Created"),
    call("c2", "edit_file", { path: "out.csv", old_string: body, new_string: "x" }),
    result("c2", "Replaced"),
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and again" },
    { role: "assistant", content: "ok" },
  ];
  const wire = releaseCallPayloads(convo, 2);
  const written = JSON.parse(wire[1].tool_calls[0].function.arguments);
  const edited = JSON.parse(wire[3].tool_calls[0].function.arguments);
  assert.notEqual(written.content, body, "the write's content was released");
  assert.ok(isContextPlaceholder(written.content), written.content);
  assert.ok(isContextPlaceholder(edited.old_string), edited.old_string);
  assert.match(written.content, /Not a value to reuse/);
});

test("ordinary text, including text that merely mentions the marker, is not a placeholder", () => {
  assert.equal(isContextPlaceholder("序号,测试项,类别\n1,web_search,基础工具"), false);
  assert.equal(isContextPlaceholder("// see the […… elided ……] note in the docs"), false);
  assert.equal(isContextPlaceholder("[…… a marker, then real content ……]\nconst x = 1;"), false);
  assert.equal(isContextPlaceholder(""), false);
  assert.equal(isContextPlaceholder(null), false);
});

test("the refusal names the marker and tells the model what to send instead", () => {
  assert.match(PLACEHOLDER_REFUSED, /not file content/);
  assert.match(PLACEHOLDER_REFUSED, /complete text/);
});
