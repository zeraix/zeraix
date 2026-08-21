/**
 * Truncated tool output: the signals a capped result carries.
 *
 * Every capped tool result is a claim about what is missing, and the model acts on that claim. A notice that
 * says only "roughly N elided" tells the model something is gone but not what fraction it is holding — the one
 * number that decides whether the retrieved part answers the question or the rest has to be fetched. And the
 * four tools that cap (read_file, list_directory, search_files, search_in_files) only work as a set if they
 * say so the same way; a notice reworded in one of them leaves that tool's truncation unrecognisable while the
 * others still announce theirs. Nothing fails when that drifts, which is why the vocabulary is pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";

// capToolOutput lives in src/ behind a TypeScript extension node does not resolve on its own. Registered
// before the dynamic import, which is why that import is not a static one.
register("./helpers/srcResolve.mjs", import.meta.url);
const { capToolOutput, MAX_TOOL_OUTPUT_CHARS } = await import("../src/app/agent/chat/compress.ts");

const toolkitSource = fs.readFileSync(new URL("../electron/tools/aiToolkit.mjs", import.meta.url), "utf8");

/**
 * The shared vocabulary of a partial result. Matched as literals against the toolkit source rather than
 * against a live call: the toolkit needs Electron to import, and what is being pinned is the wording, which
 * is visible in the source.
 */
const MARKERS = [
  "TRUNCATED", //            the word itself, on every capped path except read_file
  "read on with offset:", // read_file's cursor — the only tool that can hand back a way to continue
  "showing lines", //        read_file's shown-of-total
  "showing the first", //    list_directory / search_files shown-of-total
  "stopped at the ", //      search_in_files, where the true total is unknowable
];

test("the tools that cap all announce it in the same vocabulary", () => {
  for (const marker of MARKERS) {
    assert.ok(
      toolkitSource.includes(marker),
      `no tool emits ${JSON.stringify(marker)} any more — a capped result it used to mark now reads as complete`,
    );
  }
});

test("output within the cap is returned untouched", () => {
  const short = "x".repeat(MAX_TOOL_OUTPUT_CHARS);
  assert.equal(capToolOutput(short), short);
});

test("a capped result states how much of the whole it is showing", () => {
  const total = MAX_TOOL_OUTPUT_CHARS * 3;
  const out = capToolOutput("H".repeat(total - 1) + "T");

  assert.ok(out.includes("TRUNCATED"), "the notice does not say it is truncated");
  assert.ok(out.includes(String(total)), "the notice does not state the total character count");
  assert.ok(out.startsWith("H"), "the head was not preserved");
  assert.ok(out.endsWith("T"), "the tail was not preserved — the end of a command's output is where its error is");
  assert.ok(out.length < total, "nothing was actually elided");
  // Re-issuing the identical call is the wasted round trip this wording exists to prevent.
  assert.ok(/narrower/i.test(out), "the notice does not say how to reach the elided part");
});

test("capping is deterministic — the same input caps to the same bytes", () => {
  const input = "abc".repeat(MAX_TOOL_OUTPUT_CHARS);
  assert.equal(capToolOutput(input), capToolOutput(input));
});

test("a non-string result is passed through rather than coerced", () => {
  assert.equal(capToolOutput(undefined), undefined);
  assert.equal(capToolOutput(null), null);
});
