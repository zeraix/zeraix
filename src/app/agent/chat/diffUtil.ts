/**
 * Renderer-side unified diff generation (matches the implementation in the main process's aiToolkit.mjs).
 * Used by the "sensitive operation confirmation" panel: before edit_file / write_file actually runs,
 * read the old content and compute a change preview with line numbers, so the user can see "what changes where" before deciding.
 *
 * Returns the unified diff body (including @@ line-number headers and +/- lines, without the ``` fences); returns null if there are no changes.
 */

type Op = [" " | "+" | "-", string];

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

export function makeUnifiedDiff(before: string, after: string, context = 3): string | null {
  if (before === after) return null;
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  if (a.length + b.length > 6000) {
    return `@@ ${a.length} → ${b.length} lines (file too large, diff omitted) @@`;
  }

  const ops = diffLines(a, b);
  let oldLn = 1;
  let newLn = 1;
  const rows = ops.map(([t, line]) => {
    const row = { t, line, oldLn: t === "+" ? null : oldLn, newLn: t === "-" ? null : newLn };
    if (t !== "+") oldLn++;
    if (t !== "-") newLn++;
    return row;
  });

  const changed: number[] = [];
  rows.forEach((r, idx) => {
    if (r.t !== " ") changed.push(idx);
  });
  if (!changed.length) return null;

  const hunks: [number, number][] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(rows.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - context <= end + 1) {
      end = Math.min(rows.length - 1, changed[k] + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, changed[k] - context);
      end = Math.min(rows.length - 1, changed[k] + context);
    }
  }
  hunks.push([start, end]);

  const out: string[] = [];
  const MAX = 200;
  let total = 0;
  for (const [s, e] of hunks) {
    let oFirst: number | null = null;
    let nFirst: number | null = null;
    let oCount = 0;
    let nCount = 0;
    for (let k = s; k <= e; k++) {
      const r = rows[k];
      if (r.t !== "+") {
        if (oFirst == null) oFirst = r.oldLn;
        oCount++;
      }
      if (r.t !== "-") {
        if (nFirst == null) nFirst = r.newLn;
        nCount++;
      }
    }
    out.push(`@@ -${oFirst ?? 0},${oCount} +${nFirst ?? 0},${nCount} @@`);
    for (let k = s; k <= e; k++) {
      const r = rows[k];
      out.push((r.t === "+" ? "+" : r.t === "-" ? "-" : " ") + r.line);
      if (++total >= MAX) {
        out.push("... (diff truncated)");
        return out.join("\n");
      }
    }
  }
  return out.join("\n");
}
