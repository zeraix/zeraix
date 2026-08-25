/**
 * Folding the transcript into rows.
 *
 * This is the one piece of real logic in the message area, and every rule in it exists because the naive
 * version was wrong on screen: a trace shown one bubble at a time buries the answer, a generated image
 * swallowed into the collapsed card cannot be found at all, and a window that renumbers its rows silently
 * retargets edit / regenerate / rating at whatever sits in that slot instead.
 *
 * Pinned here rather than checked by eye because this app cannot be opened under WSL — the folding is the
 * half of the render that can be verified without a browser, so it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { groupTranscript, lastAssistantIndex } = await import("../src/app/agent/chat/transcriptRows.ts");

const user = (content = "hi") => ({ kind: "user", content });
const assistant = (content = "there") => ({ kind: "assistant", content });
const reasoning = () => ({ kind: "reasoning", content: "thinking" });
const phase = () => ({ kind: "phase", content: "step" });
const tool = (extra = {}) => ({ kind: "tool", name: "read_file", args: {}, ok: true, result: "x", ...extra });
const image = () => tool({ name: "image_generation", image: "data:image/png;base64,AAAA" });

test("a run of trace entries collapses into one group", () => {
  const rows = groupTranscript([user(), reasoning(), tool(), phase(), tool(), assistant()], 0);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["item", "group", "item"],
  );
  assert.equal(rows[1].items.length, 4);
  assert.equal(rows[1].start, 1);
});

test("a generated image is a deliverable, so it never disappears into the card", () => {
  const rows = groupTranscript([reasoning(), image(), tool()], 0);
  // The image splits the run: trace, then the image on its own, then trace again.
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["group", "item", "group"],
  );
  assert.equal(rows[1].index, 1);
});

test("indices stay absolute when only a window is mounted", () => {
  const display = [user(), assistant(), user(), reasoning(), assistant()];
  const rows = groupTranscript(display, 3);
  // Nothing before the window is produced, and what is produced still points at its real slot.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "group");
  assert.equal(rows[0].start, 3);
  assert.equal(rows[1].index, 4);
});

test("only a group that reaches the end of the transcript is trailing", () => {
  const rows = groupTranscript([reasoning(), assistant(), tool()], 0);
  assert.equal(rows[0].trailing, false, "a group with a reply after it is finished");
  assert.equal(rows[2].trailing, true, "the last group is the one still in progress");
});

test("an out-of-range or negative window start is handled rather than trusted", () => {
  const display = [user(), assistant()];
  assert.deepEqual(groupTranscript(display, 99), []);
  assert.equal(groupTranscript(display, -5).length, 2, "a negative start clamps to the beginning");
});

test("an empty transcript folds to nothing", () => {
  assert.deepEqual(groupTranscript([], 0), []);
});

test("the last AI reply is the only regenerable one", () => {
  assert.equal(lastAssistantIndex([user(), assistant(), user(), assistant(), tool()]), 3);
  assert.equal(lastAssistantIndex([user(), tool()]), -1, "no reply yet");
  assert.equal(lastAssistantIndex([]), -1);
});
