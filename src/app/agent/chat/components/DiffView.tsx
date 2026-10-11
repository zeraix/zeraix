"use client";

import { memo } from "react";

/**
 * Unified diff rendering: renders the ```diff code block returned by write_file / edit_file
 * in a git-like style (old/new line numbers + red for deletions, green for additions + @@ hunk headers).
 *
 * ## Why the panel has a height
 *
 * A diff is as long as the change, and a change can be a whole file. Rendered without a bound, one write
 * pushes the rest of the conversation off the screen and the user scrolls past hundreds of lines to reach
 * what the agent said next — so the diff, the thing they most want to skim, is the thing hardest to skim past.
 *
 * The container therefore has a max height and scrolls internally. The alternative the tools used to take was
 * to CUT the diff, which is worse in the way that matters: a truncated diff is indistinguishable from a
 * complete one, so a user reading it cannot tell whether they have seen the whole change.
 */

/**
 * Tallest a diff gets before it scrolls inside itself.
 *
 * About twenty rows at this font size — enough that most edits are read without scrolling at all, and short
 * enough that a large one still leaves the surrounding conversation visible.
 */
const MAX_DIFF_HEIGHT = "26rem";

interface Row {
  oldLn: number | null;
  newLn: number | null;
  type: " " | "+" | "-" | "@" | "\\";
  text: string;
}

/** Parse unified diff text (without the ``` fences) into an array of rows, deriving old/new line numbers. */
function parseDiff(diff: string): Row[] {
  const rows: Row[] = [];
  let oldLn = 0;
  let newLn = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLn = parseInt(m[1], 10);
        newLn = parseInt(m[2], 10);
      }
      rows.push({ oldLn: null, newLn: null, type: "@", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ oldLn: null, newLn: newLn++, type: "+", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ oldLn: oldLn++, newLn: null, type: "-", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ oldLn: null, newLn: null, type: "\\", text: line });
    } else {
      // Context line (starts with a space, or a truncation note, etc.)
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ oldLn: oldLn++, newLn: newLn++, type: " ", text });
    }
  }
  return rows;
}

const num = (n: number | null) => (n == null ? "" : String(n));

export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const rows = parseDiff(diff);
  const added = rows.filter((r) => r.type === "+").length;
  const removed = rows.filter((r) => r.type === "-").length;

  return (
    <div className="overflow-hidden rounded-lg border border-code-line bg-code-surface text-[12px]">
      {/* Stats bar. Outside the scrolling region below, so the +/- totals stay visible while a long diff is
          scrolled — the one line saying how big the change is should not be the first thing to leave. */}
      <div className="flex items-center gap-3 border-b border-code-line px-3 py-1 font-mono text-[11px] text-ink-muted">
        <span className="text-diff-add-ink">+{added}</span>
        <span className="text-diff-del-ink">-{removed}</span>
        <span className="text-ink-subtle">changes</span>
      </div>
      {/* Scrolls in BOTH directions: vertically because a diff is as long as the change, horizontally because
          a source line is as wide as it was written. Neither is truncated. */}
      <div className="overflow-auto overscroll-contain" style={{ maxHeight: MAX_DIFF_HEIGHT }}>
        <table className="w-full border-collapse font-mono leading-relaxed">
          <tbody>
            {rows.map((r, i) => {
              if (r.type === "@") {
                return (
                  <tr key={i} className="bg-diff-hunk text-diff-hunk-ink">
                    <td className="select-none px-2 text-right text-ink-subtle" />
                    <td className="select-none px-2 text-right text-ink-subtle" />
                    <td className="px-2" />
                    <td className="whitespace-pre px-2 py-0.5">{r.text}</td>
                  </tr>
                );
              }
              // Editor-like solid-color diff: the row carries a wash of the add/delete tint and the
              // line-number gutter carries it at full strength, so the gutter reads as a margin rule.
              // Both tints come from --diff-* in globals.css and follow the theme; the body text stays
              // --code-ink at full contrast rather than being tinted, which is what keeps a long diff readable.
              const rowBg =
                r.type === "+" ? "bg-diff-add/55" : r.type === "-" ? "bg-diff-del/55" : "";
              const gutterBg =
                r.type === "+"
                  ? "bg-diff-add text-diff-add-ink"
                  : r.type === "-"
                    ? "bg-diff-del text-diff-del-ink"
                    : "text-ink-subtle";
              const sign =
                r.type === "+"
                  ? "text-diff-add-ink"
                  : r.type === "-"
                    ? "text-diff-del-ink"
                    : "text-ink-subtle";
              const textColor = "text-code-ink";
              return (
                <tr key={i} className={rowBg}>
                  <td className={`w-10 select-none px-2 text-right ${gutterBg}`}>{num(r.oldLn)}</td>
                  <td className={`w-10 select-none px-2 text-right ${gutterBg}`}>{num(r.newLn)}</td>
                  <td className={`w-4 select-none text-center font-bold ${sign}`}>
                    {r.type === " " ? "" : r.type}
                  </td>
                  <td className={`whitespace-pre-wrap break-all px-2 py-0.5 ${textColor}`}>
                    {r.text || " "}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

/** Extract the ```diff code block from the tool result text; returns { before, diff, after }. If there's no diff, diff is null. */
export function extractDiff(result: string): { before: string; diff: string | null; after: string } {
  const m = /```diff\n([\s\S]*?)\n```/.exec(result);
  if (!m) return { before: result, diff: null, after: "" };
  return {
    before: result.slice(0, m.index).trim(),
    diff: m[1],
    after: result.slice(m.index + m[0].length).trim(),
  };
}
