/**
 * The context-compression marker — one shape, built in one place.
 *
 * When the wire view drops something (a write's own text, a stale read, a released result, a diff the model
 * already has), what it leaves behind is a MARKER: a note to the model saying what was removed and how to get
 * it back. Six of these were spelled out by hand across `compress.ts`, `contextCompress.ts` and
 * `resultBlobs.mjs`, all in the same ad-hoc `[…… … ……]` bracket form.
 *
 * ## Why XML, and not those brackets
 *
 * Because the bracket form reads as CONTENT, and a model that sees its own writes rendered that way imitates
 * it. That is not hypothetical:
 *
 *  - 2026-09-04: a `write_file` whose entire content was the marker, which then sat on disk as the file.
 *  - 2026-09-09: with the marker's line count in the prose — "26 lines elided" — a model read the count as a
 *    quota ("26 lines still exceeds the limit, budget about 20 lines"), split the write into halves, and sent
 *    the marker again, once with no `path` at all.
 *
 * A tag is structurally distinct from prose in a way brackets are not: it is unambiguously a container the
 * harness put there, its metadata sits in ATTRIBUTES where a number reads as a property rather than as an
 * instruction, and models are heavily trained to treat this shape as scaffolding rather than as text to copy.
 * That is the whole argument for the change.
 *
 * The guard behind it is unchanged and is still what actually prevents the failure: `is_context_placeholder`
 * in runtime/crates/agent-tools/src/edittext.rs refuses a write whose content is one of these. It recognises
 * BOTH shapes — this one and the legacy brackets — because conversations already on disk are full of the old
 * form and a model can quote one back at any time.
 */

/** The tag every marker uses. Matched by the file tools' guard; changing it means changing that guard too. */
export const MARKER_TAG = "context-compressed";

/** What was compressed. One vocabulary, so a reader can tell the cases apart without parsing the prose. */
export type MarkerKind =
  /** The text the model itself sent as `content` / `new_string` on a call that has already run. */
  | "tool-argument"
  /** A read whose result a later read or write superseded. */
  | "stale-read"
  /** A result belonging to a task that has since finished. */
  | "released-result"
  /** A diff whose added lines are text the model passed in the same round. */
  | "diff"
  /** Lines removed from the middle of a diff that was too long to carry whole. */
  | "diff-lines"
  /** The middle of a result too large to carry whole. */
  | "truncated"
  /** A large result held on disk instead of in the conversation. */
  | "stored-result"
  /** A large result whose file is gone. */
  | "missing-result";

/** Attribute values are model-visible and can carry a path, so the five XML entities are escaped. */
function attr(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `kind="…" path="…"`, skipping anything absent — an attribute with no value says nothing. */
function attrs(kind: MarkerKind, rest: Record<string, string | number | undefined>): string {
  const pairs = [`kind="${kind}"`];
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === "" || v === null) continue;
    pairs.push(`${k}="${attr(v)}"`);
  }
  return pairs.join(" ");
}

/**
 * Build a marker.
 *
 * `body` is the sentence the model reads: what went, and what to do about it. Kept as prose rather than more
 * attributes because it is the part that has to be persuasive — the attributes say what this is, the body says
 * what to do next, and every one of these should end by naming the call that recovers the content.
 */
export function marker(
  kind: MarkerKind,
  body: string,
  rest: Record<string, string | number | undefined> = {},
): string {
  return `<${MARKER_TAG} ${attrs(kind, rest)}>\n${body.trim()}\n</${MARKER_TAG}>`;
}

/** A marker with nothing to say beyond its attributes — used where it has to sit on ONE line, inside a diff. */
export function selfClosingMarker(
  kind: MarkerKind,
  rest: Record<string, string | number | undefined> = {},
): string {
  return `<${MARKER_TAG} ${attrs(kind, rest)} />`;
}

/**
 * Is this whole text one of our markers?
 *
 * The renderer's copy of the guard in `edittext.rs` / `placeholder.mjs`, for callers on this side. Matched on
 * SHAPE rather than on wording, so the prose inside stays free to change, and it accepts the legacy bracket
 * form because conversations written before this change are full of them.
 */
export function isContextMarker(text: unknown): boolean {
  const t = String(text ?? "").trim();
  if (t.startsWith(`<${MARKER_TAG}`) && (t.endsWith(`</${MARKER_TAG}>`) || t.endsWith("/>"))) return true;
  return t.startsWith("[…… ") && t.endsWith(" ……]");
}
