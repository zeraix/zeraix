/**
 * Context compression: compress overly long tool results into "head + elision notice + tail", then feed them back to the model / persist them.
 *
 * Why: tool output (run_command / search_in_files / fetch_url, etc.) enters the conversation in full and is
 * re-sent on every subsequent turn, making it a primary source of context bloat. Here we only cap the copy that is
 * "sent to the model + persisted to disk"; the full text still remains in the UI bubble for the user to view (UI-only).
 * If the model needs the elided middle section, it can call the tool again with narrower parameters.
 *
 * Not applied to read_file (see UNCAPPED_TOOLS in constants.ts): that tool takes an offset/limit line range, so its
 * output is already scoped to what was asked for. Eliding the middle of a source file the model is reading is
 * actively harmful — it cannot distinguish elided code from code that isn't there, so it reasons about a file with
 * a hole in it and reports conclusions that don't match the real source.
 *
 * The notice states the shown and total character counts rather than only the elided amount. A model that is told
 * "roughly N characters elided" knows something is missing but not how much of the whole it is holding, which is the
 * one number that decides whether the retrieved part answers the question or the rest has to be fetched. It also says
 * plainly that repeating the identical call returns the identical truncation — the failure mode that costs a round
 * trip and changes nothing.
 *
 * Determinism: trimming uses only plain string slicing + a fixed template + raw numbers (no localization / time / randomness),
 * guaranteeing that the same input produces exactly the same result on any device — because the compressed text participates in the integrity hash.
 * Editing the template is safe for existing conversations: capping happens once, at write time, and the capped string is what
 * is persisted and hashed — old messages keep the text (and hash) they were stored with.
 */

/** Only compress when the output exceeds this character count (output within roughly 2–3K tokens is kept as-is). */
export const MAX_TOOL_OUTPUT_CHARS = 8000;
/** Number of head characters kept when compressing (preserves the opening structure / key information). */
const HEAD_CHARS = 5000;
/** Number of tail characters kept when compressing (preserves the ending, such as a command's final result / error). */
const TAIL_CHARS = 2000;

/**
 * A fenced unified diff, as write_file / edit_file return it.
 *
 * Matched so the cap below can avoid cutting through one. A diff sliced at a character offset is not a shorter
 * diff — it is a broken one: the renderer parses the fragments as rows, the hunk headers stop matching the
 * lines under them, and both the user and the model are shown something that looks complete and is not. This
 * is the same objection `UNCAPPED_TOOLS` records for read_file, where a hole in the middle of the code is
 * indistinguishable from code that was never there.
 */
const DIFF_BLOCK = /```diff\n([\s\S]*?)\n```/;

/**
 * Elision marker for a shortened diff.
 *
 * Prefixed with `\` on purpose: the renderer maps that to the "no newline at end of file" row type, which
 * carries no line numbers — so the marker cannot shift the numbering of the rows after it. A plain context
 * line would have advanced both counters and quietly mislabelled every following line.
 */
const diffElision = (lines: number) => `\\ […… ${lines} diff lines elided ……]`;

/**
 * Shorten a diff by whole lines, keeping it a valid diff.
 *
 * Head and tail rather than head alone: the start of a change says what it is and the end is where a
 * half-finished edit shows up.
 */
function capDiffBody(body: string, budget: number): string {
  if (body.length <= budget) return body;
  const lines = body.split("\n");
  const kept: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let head = 0;
  let back = lines.length - 1;
  // Alternate ends so a change with all its weight at one end is not represented only by the other.
  while (head <= back) {
    const next = head <= back ? lines[head] : "";
    if (used + next.length + 1 > budget) break;
    kept.push(next);
    used += next.length + 1;
    head++;
    if (head > back) break;
    const prev = lines[back];
    if (used + prev.length + 1 > budget) break;
    tail.unshift(prev);
    used += prev.length + 1;
    back--;
  }
  const elided = lines.length - kept.length - tail.length;
  if (elided <= 0) return body;
  return [...kept, diffElision(elided), ...tail].join("\n");
}

/** If the tool output is too long, compress it into head + tail and note the elided amount; otherwise return as-is. */
export function capToolOutput(content: string): string {
  if (typeof content !== "string" || content.length <= MAX_TOOL_OUTPUT_CHARS) return content;

  // A diff is shortened by whole lines rather than sliced, so what survives is still a diff. The prose around
  // it (a "Wrote N bytes to …" line) is short and is kept whole.
  const block = DIFF_BLOCK.exec(content);
  if (block) {
    const before = content.slice(0, block.index);
    const after = content.slice(block.index + block[0].length);
    // What is left for the diff once the surrounding text and the fences have had their share.
    const budget = MAX_TOOL_OUTPUT_CHARS - before.length - after.length - 16;
    if (budget > 0) {
      return `${before}\`\`\`diff\n${capDiffBody(block[1], budget)}\n\`\`\`${after}`;
    }
    // The prose alone is over budget, which means this is not really a diff result. Fall through.
  }

  const head = content.slice(0, HEAD_CHARS);
  const tail = content.slice(content.length - TAIL_CHARS);
  const elided = content.length - HEAD_CHARS - TAIL_CHARS;
  return (
    `${head}\n\n` +
    `[…… TRUNCATED — this result is incomplete. Showing ${HEAD_CHARS} characters from the start and ` +
    `${TAIL_CHARS} from the end of ${content.length} total; ${elided} characters elided from the middle. ` +
    `Repeating this call unchanged returns the same truncation. To reach the elided part, call the tool again ` +
    `with NARROWER parameters — a more specific search_in_files query, a name pattern to scope it, or a command ` +
    `that prints less. If what you already have answers the question, use it and say the output was truncated ……]\n\n` +
    `${tail}`
  );
}
