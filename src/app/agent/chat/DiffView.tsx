"use client";

import { memo } from "react";

/**
 * Unified diff rendering: renders the ```diff code block returned by write_file / edit_file
 * in a git-like style (old/new line numbers + red for deletions, green for additions + @@ hunk headers).
 */

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
    <div className="overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 text-[12px]">
      {/* Stats bar */}
      <div className="flex items-center gap-3 border-b border-neutral-700 px-3 py-1 font-mono text-[11px] text-neutral-400">
        <span className="text-emerald-400">+{added}</span>
        <span className="text-red-400">-{removed}</span>
        <span className="text-neutral-500">changes</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono leading-relaxed">
          <tbody>
            {rows.map((r, i) => {
              if (r.type === "@") {
                return (
                  <tr key={i} className="bg-neutral-800/60 text-sky-300/80">
                    <td className="select-none px-2 text-right text-neutral-600" />
                    <td className="select-none px-2 text-right text-neutral-600" />
                    <td className="px-2" />
                    <td className="whitespace-pre px-2 py-0.5">{r.text}</td>
                  </tr>
                );
              }
              // Editor-like solid-color diff: full row red/green background, with a darker shade for the line-number gutter.
              const rowBg =
                r.type === "+" ? "bg-[#12351d]" : r.type === "-" ? "bg-[#451b1b]" : "";
              const gutterBg =
                r.type === "+"
                  ? "bg-[#19492a] text-emerald-300/70"
                  : r.type === "-"
                    ? "bg-[#5a2222] text-red-300/70"
                    : "text-neutral-600";
              const sign =
                r.type === "+"
                  ? "text-emerald-400"
                  : r.type === "-"
                    ? "text-red-400"
                    : "text-neutral-600";
              const textColor =
                r.type === "+"
                  ? "text-emerald-100"
                  : r.type === "-"
                    ? "text-red-100"
                    : "text-neutral-300";
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
