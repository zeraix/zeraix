/**
 * The context-trimming marker is never file content (electron/tools/placeholder.mjs; the Rust twin guards
 * write_file and edit_file). Pinned here against the exact text contextCompress.ts writes, so the two cannot
 * drift apart silently: if the elision wording changes shape, this test says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { isContextPlaceholder, PLACEHOLDER_REFUSED, placeholderRefusal } from "../electron/tools/placeholder.mjs";

register("./helpers/srcResolve.mjs", import.meta.url);
const { releaseCallPayloads } = await import("../src/app/agent/chat/contextCompress.ts");
const { marker, selfClosingMarker, isContextMarker, MARKER_TAG } = await import(
  "../src/app/agent/chat/contextMarker.ts"
);
const { unloadedBlobNote, missingBlobNote } = await import("../electron/store/resultBlobs.mjs");

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
  // Case-insensitive: the content marker leads with "Not a limit and not a value to reuse", the
  // old_string one with "Not a value to reuse" — both have to say it, neither has to say it the same way.
  assert.match(written.content, /not a value to reuse/i);
  assert.match(edited.old_string, /not a value to reuse/i);
});

test("both marker shapes are recognised: the tag now, the brackets still on disk", () => {
  // The bracket form has to stay recognised. Every conversation saved before the change is full of them, and
  // a model can quote one back at any time — refusing only the new shape would reopen the 2026-09-04 bug for
  // exactly the users with the most history.
  assert.equal(isContextPlaceholder('<context-compressed kind="tool-argument" lines="26">gone</context-compressed>'), true);
  assert.equal(isContextPlaceholder('  <context-compressed kind="stale-read">x</context-compressed>\n'), true);
  assert.equal(isContextPlaceholder('<context-compressed kind="diff-lines" lines="9" />'), true);
  assert.equal(isContextPlaceholder("[…… 19 lines elided: written to out.csv ……]"), true);
});

test("ordinary text, including text that merely mentions the marker, is not a placeholder", () => {
  assert.equal(isContextPlaceholder("序号,测试项,类别\n1,web_search,基础工具"), false);
  assert.equal(isContextPlaceholder("// see the […… elided ……] note in the docs"), false);
  assert.equal(isContextPlaceholder("[…… a marker, then real content ……]\nconst x = 1;"), false);
  assert.equal(isContextPlaceholder('<context-compressed kind="diff">x</context-compressed>\nconst x = 1;'), false);
  assert.equal(isContextPlaceholder("// see the <context-compressed> note in the docs"), false);
  // An unrelated XML document must stay writable.
  assert.equal(isContextPlaceholder('<svg viewBox="0 0 1 1"><rect /></svg>'), false);
  assert.equal(isContextPlaceholder(""), false);
  assert.equal(isContextPlaceholder(null), false);
});

test("the refusal names the marker and tells the model what to send instead", () => {
  const refusal = placeholderRefusal("content", "src/core/camera.ts");
  assert.match(refusal, /not file content/);
  assert.match(refusal, /complete text/);
  // The path is in the message because the model has to read_file SOMETHING, and one that reached this
  // state had already lost track of which file it meant (2026-09-09: its next call carried no path at all).
  assert.match(refusal, /src\/core\/camera\.ts/);
  // Names the argument, since edit_file has two and only new_string is checked.
  assert.match(placeholderRefusal("new_string", "a.ts"), /^new_string: /);
});

/**
 * The regression this guards, in the words the model used for it: "26 行还是超限，预算约 20 行。拆成两段"
 * — "26 lines still exceeds the limit, budget about 20 lines. Split into two parts."
 *
 * It had been handed a marker whose PROSE opened with `26 lines elided`, read the count as a quota, and spent
 * three calls trying to get under it. The count is back now, because it is genuinely useful — but only as an
 * ATTRIBUTE, where it is a property of what was removed rather than a number in a sentence telling the model
 * how much it may send. That distinction is the whole fix, so it is what gets pinned.
 */
test("the line count lives in an attribute and never in the prose the model reads", () => {
  const convo = [
    { role: "user", content: "write it" },
    call("c1", "write_file", { path: "out.csv", content: body }),
    result("c1", "Created"),
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and again" },
    { role: "assistant", content: "ok" },
  ];
  const m = JSON.parse(releaseCallPayloads(convo, 2)[1].tool_calls[0].function.arguments).content;
  assert.ok(isContextPlaceholder(m), m);

  const openTag = m.slice(0, m.indexOf(">") + 1);
  const prose = m.slice(m.indexOf(">") + 1, m.lastIndexOf("</"));
  assert.match(openTag, /lines="\d+"/, "the count is still available to a reader that wants it");
  // The fixture path carries no digits, so any digit here would be the count leaking back into the sentence.
  assert.doesNotMatch(prose, /\d/, `a number in the prose reads as a quota: ${prose}`);
  // It still has to say which file the text belongs to, or read_file has no target.
  assert.match(m, /out\.csv/);
  // And the prose has to deny the limit outright: "send the complete text" alone is heard as "send less".
  assert.match(prose, /not a size limit/);
});

test("the refusal itself carries no number to satisfy", () => {
  assert.doesNotMatch(PLACEHOLDER_REFUSED, /\d/, PLACEHOLDER_REFUSED);
});

test("the refusal denies the size limit rather than only asking for the full text", () => {
  for (const text of [PLACEHOLDER_REFUSED, placeholderRefusal("content", "a.ts")]) {
    assert.match(text, /not truncated/);
    assert.match(text, /no line or size limit/);
    // The specific wrong move it made: two smaller writes.
    assert.match(text, /splitting the write into smaller parts will not help/);
  }
});

// ── The format is written in three places and must stay one format ──────────────────────────────────────
//
// `contextMarker.ts` builds the renderer's markers, `resultBlobs.mjs` builds the store's (it is Electron-side
// and cannot import TypeScript), and the guard that refuses them as file content exists twice more —
// `placeholder.mjs` here and `is_context_placeholder` in edittext.rs. Nothing but a test can hold four copies
// of one rule together, so this is that test: every marker any producer writes must be refused as content.

test("every marker any producer writes is recognised by the guard", () => {
  const produced = [
    marker("tool-argument", "gone", { path: "a.ts", lines: 26 }),
    marker("stale-read", "superseded", { path: "a.ts" }),
    marker("released-result", "the task finished"),
    marker("diff", "same text as new_string", { ranges: "1-4" }),
    marker("truncated", "the middle was removed", { total: 10, elided: 5 }),
    selfClosingMarker("diff-lines", { lines: 40 }),
    unloadedBlobNote("b".repeat(64), 4194305),
    missingBlobNote(262144),
  ];
  for (const m of produced) {
    assert.ok(isContextPlaceholder(m), `the JS guard does not refuse: ${m}`);
    assert.ok(isContextMarker(m), `the renderer's own copy does not recognise: ${m}`);
    assert.ok(m.startsWith(`<${MARKER_TAG}`), m);
  }
});

test("the two guards agree on what is NOT a marker", () => {
  const notMarkers = [
    "序号,测试项,类别\n1,web_search,基础工具",
    "const x = 1;",
    `<${MARKER_TAG} kind="diff">x</${MARKER_TAG}>\nconst x = 1;`,
    '<svg viewBox="0 0 1 1"><rect /></svg>',
    "",
  ];
  for (const t of notMarkers) {
    assert.equal(isContextPlaceholder(t), false, t);
    assert.equal(isContextMarker(t), false, t);
  }
});

test("a path with XML metacharacters cannot break out of the attribute", () => {
  // Attribute values are model-visible and carry a path, which a user can name almost anything.
  const m = marker("tool-argument", "gone", { path: 'a"><script>&.ts', lines: 1 });
  assert.ok(!m.slice(0, m.indexOf(">")).includes('"><script>'), `attribute not escaped: ${m}`);
  assert.match(m, /&quot;&gt;&lt;script&gt;&amp;/);
  assert.ok(isContextPlaceholder(m), "and it is still recognised as a marker");
});
