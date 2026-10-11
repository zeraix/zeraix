/**
 * The reading of a tool call that the thinking-process stream turns into one line: which path it touched, how big the
 * change was, and how a run of lookups tallies up.
 *
 * Kept apart from ProcessStream.tsx, and deliberately free of imports: this is the part with edge cases worth pinning
 * down (a truncated diff, a Windows path, a tool that names its target under a different key), and a plain module can
 * be exercised directly by the tests rather than through a rendered component.
 */

/** Which tally an explored tool lands in, for the "2 read, 1 listed" summary. */
const EXPLORE_TALLY: Record<string, "read" | "list" | "search"> = {
  read_file: "read",
  list_directory: "list",
  file_info: "list",
  search_files: "search",
  search_in_files: "search",
};

export type ExploreTally = { read: number; list: number; search: number };

/**
 * The parts of a tool call a row needs. Deliberately narrower than the display message: a sub-agent's steps are stored
 * as this shape and nothing more, and a row renders them the same way it renders the main agent's calls.
 */
export type TraceCall = {
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
  /** Still executing: there is no result yet, and the row shows what it is doing instead of what it did. */
  running?: boolean;
  /**
   * Wall clock the call took, when the caller knows it.
   *
   * Optional because most callers do not: a sub-agent's persisted steps carry no timing, so a reloaded
   * transcript would show a number it invented. The Sub-agent Inspector does know, because the runtime
   * timestamps both halves of every call — so the same row shows a duration there and none in the
   * transcript, which is the honest difference rather than an inconsistency.
   */
  ms?: number;
};

/**
 * Fold a run of calls into what the stream draws: consecutive read-only lookups become one group, everything else
 * stands alone. Reading around a codebase is one activity; listing every grep separately buries the writes between
 * them. The explore test is passed in rather than decided here, so the icon/label table stays the single source of
 * truth for which tools are lookups.
 */
export function groupCalls(
  calls: TraceCall[],
  isExplore: (name: string) => boolean
): Array<{ explore: TraceCall[] } | { call: TraceCall }> {
  const out: Array<{ explore: TraceCall[] } | { call: TraceCall }> = [];
  for (const c of calls) {
    if (!isExplore(c.name)) {
      out.push({ call: c });
      continue;
    }
    const last = out[out.length - 1];
    if (last && "explore" in last) last.explore.push(c);
    else out.push({ explore: [c] });
  }
  return out;
}

/** Group a run of read-only lookups by what they actually did. An unlisted tool counts as a read. */
export function tallyExplore(names: string[]): ExploreTally {
  const tally: ExploreTally = { read: 0, list: 0, search: 0 };
  for (const n of names) tally[EXPLORE_TALLY[n] ?? "read"]++;
  return tally;
}

/**
 * The tool a display name refers to.
 *
 * Two different things put an arrow in a name, and they put the tool on opposite sides of it. A delegation is pushed
 * as `run_subagent → explore`, tool first. A call a sub-agent made is pushed as `explore→read_file`, prefixed with the
 * agent that made it (execToolCall's displayName). Reading the wrong half is not cosmetic: every tool a sub-agent ran
 * would miss the verb table and fall back to "Called", and none of its file reads would merge into an "Explored" run.
 * Deciding by whether the left half is itself a tool settles both, and settles `reviewer→run_subagent` too.
 */
export function toolNameOf(display: string, isTool: (name: string) => boolean): string {
  const parts = display.split("→").map((p) => p.trim());
  if (parts.length === 1) return display.trim();
  return isTool(parts[0]) ? parts[0] : parts[parts.length - 1];
}

/**
 * The argument a tool's line should name.
 *
 * Ordered by specificity, not by preference: a path is the most concrete thing a call can name, and `destination`
 * beats `source` because a move/copy is better read by where the file ended up. Everything after that is the fallback
 * chain for tools that have no path at all — a command, a query, a URL, and then the various nouns the renderer-side
 * tools carry instead (a memory's title, a project note, a generation prompt).
 *
 * MCP tools are keyed on the server id first, because `command` would otherwise win and name every one of them after
 * its launcher — "Connected npx" rather than the server the user actually chose. The same carve-out exists in
 * `toolStatusText` (constants.ts) for the same reason; this is the second place that lesson has had to be learnt.
 */
export function targetOf(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  const v = name.startsWith("mcp_")
    ? o.id ?? o.query
    : o.path ??
      o.destination ??
      o.source ??
      o.command ??
      o.query ??
      o.url ??
      o.pattern ??
      o.title ??
      o.module ??
      o.note ??
      o.notes ??
      o.prompt ??
      o.id ??
      o.name ??
      o.action;
  return v == null ? "" : String(v);
}

/**
 * Split "src/app/page.tsx" into the folder it sits in — trailing slash kept, so it reads as a folder — and the file's
 * own name. Windows separators count too: a path typed by the model can arrive either way.
 */
export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/**
 * How many lines a change added and removed, counted off the unified diff body the tool appended to its result.
 *
 * The diff is not always the whole story. aiToolkit caps a diff body at DIFF_MAX_LINES rows and appends
 * "... (diff truncated)", and on a very large file it skips the line-by-line diff altogether. Counting the `+` lines of
 * a truncated diff would report 200 changed lines for a 900-line rewrite, so a capped diff comes back flagged
 * `partial` and the badge says "at least" instead of stating a number it cannot know. A diff that was omitted entirely
 * has no +/- lines at all and yields null — better no badge than a confident zero.
 */
export function countDiffLines(
  diff: string | null
): { add: number; del: number; partial: boolean } | null {
  if (!diff) return null;
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return add || del ? { add, del, partial: diff.includes("(diff truncated)") } : null;
}
