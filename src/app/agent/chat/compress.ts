/**
 * Context compression: compress overly long tool results into "head + elision notice + tail", then feed them back to the model / persist them.
 *
 * Why: tool output (read_file / run_command / search_in_files, etc.) enters the conversation in full and is
 * re-sent on every subsequent turn, making it a primary source of context bloat. Here we only cap the copy that is
 * "sent to the model + persisted to disk"; the full text still remains in the UI bubble for the user to view (UI-only).
 * If the model needs the elided middle section, it can call the tool again with more precise
 * parameters (such as read_file with offset/limit).
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
    `[…… Elided roughly ${elided} characters in the middle (see the UI bubble for the full output). ` +
    `If you need the elided content, call the tool again with more precise parameters, e.g. read_file with offset/limit to read a specific section ……]\n\n` +
    `${tail}`
  );
}
