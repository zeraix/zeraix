/**
 * The renderer's context-trimming placeholder, in JavaScript — now a TEST MIRROR, not a guard.
 *
 * The guard is `is_context_placeholder` / `PLACEHOLDER_REFUSED` / `placeholder_refusal` in
 * runtime/crates/agent-tools/src/edittext.rs, which every file tool goes through. This module used to be the
 * copy `append_file` needed, back when it was the one file tool still implemented in this process; it is not
 * any more.
 *
 * It is kept because it is the only way to test the contract END TO END on this side: the marker is WRITTEN by
 * contextCompress.ts (TypeScript) and REFUSED by edittext.rs (Rust), and nothing but test/placeholder.test.mjs
 * can see both halves. Delete it only together with that test — and only once something else pins that the
 * string one language writes is the string the other language rejects.
 *
 * If the two ever disagree, the Rust copy is right.
 */
export function isContextPlaceholder(text) {
  const t = String(text ?? "").trim();
  // Current: one whole `<context-compressed …>` element, open-and-close or self-closing.
  if (t.startsWith("<context-compressed") && (t.endsWith("</context-compressed>") || t.endsWith("/>"))) return true;
  // Legacy bracket form, still on disk in conversations saved before the change.
  return t.startsWith("[…… ") && t.endsWith(" ……]");
}

export const PLACEHOLDER_REFUSED =
  "the text you sent is a <context-compressed> marker, not file content. " +
  "It stands in for text of your own earlier calls that was dropped from your context to save space; it is never " +
  "valid content, and its `lines` attribute describes what was removed rather than any budget you have to fit " +
  "inside. Nothing here limits how much you can write: the file was not truncated, there is no line or size limit, " +
  "and splitting the write into smaller parts will not help.";

/**
 * The refusal above, plus where to read the text back from. Mirrors `placeholder_refusal` in edittext.rs.
 *
 * The last two clauses of the constant exist because a refusal that only says "send the complete text" is heard as
 * "send LESS text" by a model that thinks it is over a quota: on 2026-09-09 one read the marker's old line count as
 * a budget ("26 lines still exceeds the limit, budget is about 20 lines"), split the write in two, and sent the
 * marker again — once with no `path` at all, which is why the path is named here.
 */
export function placeholderRefusal(field, path) {
  return (
    `${field}: ${PLACEHOLDER_REFUSED} Call read_file on ${path} to get its current text, then send the ` +
    "complete text in a single call."
  );
}
