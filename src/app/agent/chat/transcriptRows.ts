/**
 * Folding the transcript into rows.
 *
 * Split out of ChatTranscript.tsx purely so it can be tested: the test runner strips types but does not
 * compile JSX, so anything importable from a plain `node --test` has to live in a file with no JSX in it.
 * The rule this encodes is described in that component's header.
 */
import type { DisplayMsg } from "./types";
// Type-only, and it must stay that way: MessageItem is a .tsx, and a value import would drag JSX into a
// module the tests import directly.
import type { ProcessItem } from "./MessageItem";

/** A trace entry, which collapses into the "thinking process" card. See the exception in the header. */
const inProcess = (m: DisplayMsg): boolean =>
  (m.kind === "tool" && !m.image) || m.kind === "reasoning" || m.kind === "phase";

/** One rendered row: either a run of trace entries, or a single message shown on its own. */
export type TranscriptRow =
  | { kind: "group"; start: number; items: ProcessItem[]; /** Ends at the tail of the transcript. */ trailing: boolean }
  | { kind: "item"; index: number };

/**
 * Fold the mounted window into rows.
 *
 * Pure, and separated from the JSX so the folding can be reasoned about (and tested) without a renderer.
 * `from` is where the mounted window starts; rows before it are simply not produced, which is what keeps a
 * long conversation cheap to display.
 */
export function groupTranscript(display: DisplayMsg[], from: number): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let i = Math.max(0, from);
  while (i < display.length) {
    if (inProcess(display[i])) {
      const start = i;
      const items: ProcessItem[] = [];
      while (i < display.length && inProcess(display[i])) {
        items.push(display[i] as ProcessItem);
        i++;
      }
      rows.push({ kind: "group", start, items, trailing: i === display.length });
    } else {
      rows.push({ kind: "item", index: i });
      i++;
    }
  }
  return rows;
}

/** The index of the last AI reply, which is the only one that may be regenerated. */
export function lastAssistantIndex(display: DisplayMsg[]): number {
  for (let j = display.length - 1; j >= 0; j--) if (display[j].kind === "assistant") return j;
  return -1;
}
