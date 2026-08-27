/**
 * How a tool call reads on one line of the thinking-process stream.
 *
 * The line has to be right about size and about place, and both have a way of being quietly wrong:
 *
 *  - aiToolkit caps a diff body at 200 rows and appends "... (diff truncated)". Counting the `+` lines of that diff
 *    reports 200 for a 900-line rewrite — a number that looks authoritative and is not. The cap is invisible in the
 *    output unless something goes looking for it, which is what `partial` is for.
 *  - the `@@` hunk headers of a unified diff are neither additions nor removals, and neither is a context line, so a
 *    counter that keys on the first character has to be checked against a real diff rather than a hand-made one.
 *  - a path arrives however the model typed it, including with Windows separators, and the folder/file split is what
 *    the row renders.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  countDiffLines,
  groupCalls,
  toolNameOf,
  splitPath,
  tallyExplore,
  targetOf,
} from "../src/app/agent/chat/processTrace.ts";
import { phaseSummaryText, thinkingProcessText } from "../src/app/agent/chat/wireHelpers.ts";

/** The shape aiToolkit's makeUnifiedDiff emits: @@ headers, then ' ' / '+' / '-' prefixed lines. */
const DIFF = ["@@ -1,3 +1,4 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export {};"].join(
  "\n"
);

test("counts additions and removals, ignoring hunk headers and context", () => {
  assert.deepEqual(countDiffLines(DIFF), { add: 2, del: 1, partial: false });
});

test("a hunk header is not counted as a removal", () => {
  // "@@ -1,3 +1,4 @@" starts with '@', but a careless regex over the body could still pick up its "-1,3" / "+1,4".
  const { add, del } = countDiffLines("@@ -10,2 +10,2 @@\n+x\n-y");
  assert.equal(add, 1);
  assert.equal(del, 1);
});

test("a truncated diff reports what it saw and admits it is a floor", () => {
  const capped = `${DIFF}\n... (diff truncated)`;
  const counts = countDiffLines(capped);
  assert.equal(counts.partial, true, "the cap must be surfaced, not swallowed");
  assert.equal(counts.add, 2);
});

test("no diff, and a diff that changed nothing, both yield no badge", () => {
  assert.equal(countDiffLines(null), null);
  // The "file too large, diff omitted" note is a lone @@ header with no +/- lines: a confident "+0" would be a lie.
  assert.equal(countDiffLines("@@ 900 → 931 lines (file too large, diff omitted) @@"), null);
});

test("splits a path into the folder it sits in and the file's own name", () => {
  assert.deepEqual(splitPath("voxel-minecraft/js/config.js"), {
    dir: "voxel-minecraft/js/",
    name: "config.js",
  });
  // A bare filename has no folder to show.
  assert.deepEqual(splitPath("index.html"), { dir: "", name: "index.html" });
});

test("a Windows path splits on its own separator", () => {
  assert.deepEqual(splitPath("src\\app\\page.tsx"), { dir: "src\\app\\", name: "page.tsx" });
});

test("names the most concrete argument a tool carries", () => {
  assert.equal(targetOf("write_file", { path: "a.ts", content: "…" }), "a.ts");
  // A move is better read by where the file ended up than by where it came from.
  assert.equal(targetOf("move_file", { source: "old.ts", destination: "new.ts" }), "new.ts");
  assert.equal(targetOf("run_command", { command: "npm run build" }), "npm run build");
  assert.equal(targetOf("web_search", { query: "useVirtualizer" }), "useVirtualizer");
  assert.equal(targetOf("mcp_tools", undefined), "");
  assert.equal(targetOf("plugin_tools", {}), "");
});

test("the renderer-side tools name something, rather than nothing", () => {
  // Every one of these used to fall through the chain and render a bare verb with no object.
  assert.equal(targetOf("save_memory", { title: "npm, not pnpm" }), "npm, not pnpm");
  assert.equal(targetOf("remember_project", { note: "renderer never touches fs" }), "renderer never touches fs");
  assert.equal(targetOf("set_task_state", { notes: "waiting on review" }), "waiting on review");
  assert.equal(targetOf("image_generation", { prompt: "a voxel landscape" }), "a voxel landscape");
  assert.equal(targetOf("load_skill", { id: "brandkit" }), "brandkit");
  assert.equal(targetOf("browser", { action: "click", selector: "#go" }), "click");
});

test("an MCP tool is named by its server, not by its launcher", () => {
  // The bug this pins: `command` sits ahead of `id` in the general chain, so every MCP row would read "npx".
  // constants.ts carries the same carve-out for the status line, for the same reason.
  assert.equal(targetOf("mcp_connect", { id: "github", command: "npx", args: ["-y", "server"] }), "github");
  assert.equal(targetOf("mcp_discover", { query: "blender" }), "blender");
});

test("a delegation is named by its tool, a sub-agent's call by its tool", () => {
  const isTool = (n) => ["run_subagent", "spawn_sub_agent", "read_file", "write_file"].includes(n);
  // "run_subagent → explore" — the delegation itself, tool on the left of the arrow.
  assert.equal(toolNameOf("run_subagent → explore", isTool), "run_subagent");
  assert.equal(toolNameOf("spawn_sub_agent → reviewer", isTool), "spawn_sub_agent");
  // "explore→read_file" — a call the sub-agent made, prefixed with the agent. Tool on the RIGHT.
  // Reading the wrong half here costs every sub-agent call its verb and its merge into an "Explored" run.
  assert.equal(toolNameOf("explore→read_file", isTool), "read_file");
  // An agent whose name collides with a tool's still resolves by which half is the tool being reported.
  assert.equal(toolNameOf("reviewer→run_subagent", isTool), "run_subagent");
  assert.equal(toolNameOf("read_file", isTool), "read_file");
});

test("groups a run of lookups by what each one did", () => {
  assert.deepEqual(
    tallyExplore(["read_file", "read_file", "list_directory", "search_in_files"]),
    { read: 2, list: 1, search: 1 }
  );
  // An unlisted tool still has to land somewhere, or it vanishes from a summary that claims to cover the run.
  assert.deepEqual(tallyExplore(["some_new_tool"]), { read: 1, list: 0, search: 0 });
});

/**
 * The thinking-process text is the round's body kept WHOLE.
 *
 * A model that reasons inline writes its thinking into `content` between <think> and </think>. The bubble that streams
 * mid-round trims that off to stay readable, and trimming it in the stream too was what made a round that thought for
 * eleven seconds display a single trailing sentence. The stream is where it comes back.
 */
const INLINE = "<think>\u7528\u6237\u60f3\u8ba9\u6211\u505a\u4e00\u4e2a\u4f53\u7d20\u6e38\u620f\u3002\n\u5148\u770b\u770b\u9879\u76ee\u91cc\u6709\u4ec0\u4e48\u3002</think>\n\n\u8ba9\u6211\u5148\u4e86\u89e3\u4e00\u4e0b\u8fd9\u4e2a\u9879\u76ee\u3002";

test("the thinking-process text keeps everything the model wrote", () => {
  const kept = thinkingProcessText(INLINE);
  assert.match(kept, /\u4f53\u7d20\u6e38\u620f/, "the reasoning itself must survive");
  assert.match(kept, /\u8ba9\u6211\u5148\u4e86\u89e3/, "and so must the sentence after it");
  assert.doesNotMatch(kept, /<\/?think>/, "Markdown renders with html:false, so a literal tag would show as text");
});

test("the streaming bubble still trims, and that is deliberate", () => {
  // The two readings of one body: mid-round the chain of thought is noise in the conversation, in the stream it is
  // the point. If this ever starts matching, the trimming has leaked back into the place it was removed from.
  assert.doesNotMatch(phaseSummaryText(INLINE), /\u4f53\u7d20\u6e38\u620f/);
});

test("a body with no think block is passed through unchanged", () => {
  assert.equal(thinkingProcessText("\u5148\u5217\u51fa\u4efb\u52a1\u8ba1\u5212\u3002"), "\u5148\u5217\u51fa\u4efb\u52a1\u8ba1\u5212\u3002");
});

test("an unclosed think block still yields its text", () => {
  // Truncated mid-thought (a cancelled or cut-off round): the opening marker must not survive into the UI either.
  assert.equal(thinkingProcessText("<think>\u8fd8\u5728\u60f3\u2026"), "\u8fd8\u5728\u60f3\u2026");
});

/**
 * A run of calls folds the same way wherever it appears — the main agent's trace and a sub-agent's nested steps go
 * through this one function, which is the point: a delegation that reads like a summary hides what it actually did.
 */
const isExplore = (n) => n === "read_file" || n === "search_in_files" || n === "list_directory";
const call = (name) => ({ name, args: {}, ok: true, result: "" });

test("consecutive lookups merge, and a write breaks the run", () => {
  const groups = groupCalls(
    [call("read_file"), call("read_file"), call("write_file"), call("list_directory")],
    isExplore
  );
  assert.equal(groups.length, 3);
  assert.equal(groups[0].explore.length, 2, "the two reads are one group");
  assert.equal(groups[1].call.name, "write_file", "the write stands alone between them");
  assert.equal(groups[2].explore.length, 1, "and the run after it starts fresh");
});

test("a lone write is never swallowed into a lookup group", () => {
  // The failure this guards: a merge that reached across non-explore calls would bury every file change of a
  // read-heavy round inside an "Explored" line.
  const groups = groupCalls([call("edit_file"), call("edit_file")], isExplore);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => "call" in g));
});

test("an empty run produces nothing to draw", () => {
  assert.deepEqual(groupCalls([], isExplore), []);
});
