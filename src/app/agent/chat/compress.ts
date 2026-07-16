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
 * Determinism: trimming uses only plain string slicing + a fixed template + raw numbers (no localization / time / randomness),
 * guaranteeing that the same input produces exactly the same result on any device — because the compressed text participates in the integrity hash.
 */

/** Only compress when the output exceeds this character count (output within roughly 2–3K tokens is kept as-is). */
export const MAX_TOOL_OUTPUT_CHARS = 8000;
/** Number of head characters kept when compressing (preserves the opening structure / key information). */
const HEAD_CHARS = 5000;
/** Number of tail characters kept when compressing (preserves the ending, such as a command's final result / error). */
const TAIL_CHARS = 2000;

/** If the tool output is too long, compress it into head + tail and note the elided amount; otherwise return as-is. */
export function capToolOutput(content: string): string {
  if (typeof content !== "string" || content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
  const head = content.slice(0, HEAD_CHARS);
  const tail = content.slice(content.length - TAIL_CHARS);
  const elided = content.length - HEAD_CHARS - TAIL_CHARS;
  return (
    `${head}\n\n` +
    `[…… Elided roughly ${elided} characters in the middle. ` +
    `If you need the elided content, call the tool again with narrower parameters — e.g. a more specific ` +
    `search_in_files query, or a command that prints less ……]\n\n` +
    `${tail}`
  );
}
