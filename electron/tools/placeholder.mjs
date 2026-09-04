/**
 * The renderer's context-trimming placeholder, recognised so a file tool never writes it as content.
 *
 * Mirrors `is_context_placeholder` / `PLACEHOLDER_REFUSED` in runtime/crates/agent-tools/src/edittext.rs, which
 * guard write_file and edit_file; this is for append_file, the one file tool still implemented here. The marker
 * (`[…… N lines elided: … ……]`, contextCompress.ts) stands in for a completed call's bulky arguments in the model's
 * context, and a model that sees its own writes rendered that way can imitate the shape on its next write.
 */
export function isContextPlaceholder(text) {
  const t = String(text ?? "").trim();
  return t.startsWith("[…… ") && t.endsWith(" ……]");
}

export const PLACEHOLDER_REFUSED =
  'the text you sent is the context-trimming marker "[…… N lines elided … ……]", not file content. ' +
  "That marker stands in for text of your own earlier calls that was trimmed from your context; it is never valid content. " +
  "Send the complete text you want in the file (read_file the current file first if you need what is there).";
