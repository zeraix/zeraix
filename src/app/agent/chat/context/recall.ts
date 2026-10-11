/**
 * Getting a removed tool result back — the answer to "run the call again if you still need it".
 *
 * Every layer that drops a tool result from the model's context (the runtime mid-turn, completed-round release, the
 * oversized-result rule) used to leave a note saying to run the call again. That is the wrong advice as often as not:
 * re-running `run_command` repeats its side effects, a search or a fetch costs a round trip and may come back
 * different, and either way the model no longer has what it actually saw. The conversation store keeps every result
 * in full, so the notes now name the result's id and the call that returns it.
 *
 * Reached through `call_tool` and never declared. The declared tool block and the system prompt are the cached
 * prefix; a new declaration would retire the KV seed and tax every request for a tool the model only needs after it
 * has seen one of these notes — which is exactly where the notes teach it. Model-facing, so not localised.
 */

/** The tool's name. One place, because the notes, the runtime's template and the handler table must agree. */
export const RECALL_TOOL = "recall_tool_result";

/** The call a note shows, for one result id. */
export function recallCall(id: string): string {
  return `call_tool {"name": "${RECALL_TOOL}", "arguments": {"id": "${id}"}}`;
}

/**
 * What the runtime puts in a result it removes mid-turn, `{id}` standing for that result's id.
 *
 * Sent by the host because the host owns both the dispatcher and this tool. A run without it — a delegation, whose
 * results are never stored where this tool looks — keeps the runtime's own "re-run" wording.
 */
export const ELISION_HINT =
  `recall it with ${recallCall("{id}")} (add "offset"/"limit" to page through a long one), ` +
  `or run the call again for its current state`;

import { MARKER_TAG } from "./contextMarker";

/** Tools whose result is a snapshot of the filesystem, which may have changed since it was taken. */
const SNAPSHOT_TOOLS = new Set(["read_file", "list_directory", "file_info", "search_files", "search_in_files"]);

/** A stored message, as much of it as recall reads. */
export interface RecallableMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The stored result for `args.id`, whole or by line range — `offset` (1-based first line) and `limit` (line count),
 * as `read_file` takes them, so paging a recalled result works the way paging a file does. No cap, for the same
 * reason `read_file` has none: the wire's own rules decide what fits, not the tool.
 */
export function recallToolResult(messages: readonly RecallableMessage[], args: Record<string, unknown>): string {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return `Pass "id": the result id shown in the note that replaced it.`;
  const matches = messages.filter((m) => m.role === "tool" && m.tool_call_id === id);
  // The latest: some providers number calls per response and reuse ids, and the note being answered is far more
  // often about recent work than about the first call that happened to share the id. Said so when it is ambiguous.
  const found = matches[matches.length - 1];
  if (!found || typeof found.content !== "string") {
    return `No tool result with id "${id}" in this conversation. Use the id exactly as the note shows it.`;
  }
  const name = found.name || "tool";
  // A result too large to keep loaded is held as a note naming its blob on disk (resultBlobs.mjs). Returning that
  // note under "exactly as it was returned" would be false.
  if (isUnloadedNote(found.content)) {
    return `The ${name} result ${id} is from an earlier session and too large to keep loaded, so it cannot be recalled here. Run the call again if you need it.`;
  }
  const shared = matches.length > 1 ? `; ${matches.length} results share this id, this is the latest` : "";

  const stale = SNAPSHOT_TOOLS.has(name) ? " — files may have changed since; read them again for their current state" : "";
  const offset = positiveInt(args.offset);
  const limit = positiveInt(args.limit);
  if (offset === undefined && limit === undefined) {
    return `[recalled: the ${name} result ${id}, exactly as it was returned${stale}${shared}]\n${found.content}`;
  }

  const lines = found.content.split("\n");
  const from = offset ?? 1;
  if (from > lines.length) return `offset ${from} is past the end: the ${name} result ${id} has ${lines.length} lines.`;
  const to = limit === undefined ? lines.length : Math.min(lines.length, from + limit - 1);
  return (
    `[recalled: the ${name} result ${id}, lines ${from}-${to} of ${lines.length}, exactly as it was returned${stale}${shared}]\n` +
    lines.slice(from - 1, to).join("\n")
  );
}

/** The stand-in for a blob too large to load: `unloadedBlobNote` in resultBlobs.mjs, current and legacy spellings. */
function isUnloadedNote(text: string): boolean {
  if (text.length > 512) return false;
  const head = text.trimStart();
  return head.startsWith(`<${MARKER_TAG} kind="stored-result"`) || head.startsWith("[…… a ");
}
