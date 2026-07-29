/**
 * Context compression (session-level): shrink the conversation "sent to the model" when necessary, while the full
 * conversation is always kept verbatim in convoRef / persistence / UI bubbles — i.e. "one conversation, two views":
 *   - Display view: fully faithful, what the user sees (DisplayMsg, never passes through here);
 *   - Wire view: the compressed version produced by this module, used only for sending to the model.
 *
 * Why a separate layer (compress.ts only compresses a single tool output, this compresses the entire history):
 *   In long conversations, what really blows out the context window is the "accumulated history" — especially repeated read_file results and long-obsolete intermediate steps.
 *
 * Two compression techniques, cheap-and-deterministic first, expensive-and-lossy later:
 *   1) Stale-read deduplication (deterministic, no model needed): once the same file is read again / modified by a write, the entire
 *      content of the earlier read is replaced with a one-line stub — because the model can already learn the file's latest state from the later read / write.
 *   2) History summarization (lossy, needs the model): only when deduplication still leaves it over threshold, hand the history before the "last N turns" to the model to compress into a single summary,
 *      replacing that large chunk of original text.
 *
 * Key: prefix-cache friendly. The compaction plan is frozen at the "start of each turn" (see CompactionState.frozenLen); within this turn's tool loop,
 * newly appended messages are always sent as-is, never rewritten retroactively, so the prefix [system, summary, …deduplicated tail] stays byte-stable throughout the turn,
 * hitting the prefix cache; stale reads produced by the previous turn are folded only at the "start of the next turn". Never rewrite history mid tool-loop.
 */
import { foldReminders, renderSnapshot } from "./reminders";
import type { ApiMsg, ContentPart } from "./types";
import { countMessagesTokens } from "@/lib/ai/tokenizer";
import { resolveToolCall } from "@/lib/ai/toolRouter";

// ── Tunable parameters ──────────────────────────────────────────────────────────────────
/** Only start compressing when context usage exceeds this fraction of the window (hysteresis: below this value, no compression at all, keeping the prefix cache most stable). */
export const COMPACT_TRIGGER_PCT = 0.75;
/** Compression target: shrink the wire view to around this fraction of the window (summarize only when deduplication isn't enough, avoiding repeated summarization every turn). */
export const COMPACT_TARGET_PCT = 0.5;
/** Number of "most recent user turns" kept when summarizing (these turns stay verbatim, not summarized). */
export const KEEP_TAIL_TURNS = 4;
/** Only read results exceeding this character count are worth stubbing (too-short ones save little and just add cache churn). */
export const MIN_STUB_CHARS = 400;
/** Lower bound for manual "compress now": manual compression is disallowed when context usage is below this fraction of the window (too little content, compression is meaningless). */
export const MANUAL_COMPACT_MIN_PCT = 0.2;

/** Error-hardening §B1: after a summary has been reused this many turns, force a fresh re-summary from the
 *  verbatim originals — even if the growth threshold hasn't tripped — so no unverified summary can live
 *  indefinitely in a slowly-growing conversation. Trades a little cache stability for a bounded error window. */
export const MAX_SUMMARY_REUSE = 20;

/**
 * Resolve the hybrid auto-compaction trigger/target (in tokens) from the model's context window and an
 * absolute working-set budget (K tokens). The effective threshold is the MORE aggressive of the two —
 * min(window-relative, absolute) — so a large window can no longer defer compaction indefinitely.
 * Returns null when budgetK <= 0, which leaves planCompaction on its original window-relative behaviour.
 * The absolute target keeps the SAME trigger→target hysteresis ratio as the window-relative path, so the
 * anti-thrash gap is preserved at any budget.
 */
export function resolveHybridBudget(
  contextWindow: number,
  budgetK: number,
): { triggerTokens: number; targetTokens: number } | null {
  if (!budgetK || budgetK <= 0) return null;
  const budget = budgetK * 1000;
  return {
    triggerTokens: Math.min(contextWindow * COMPACT_TRIGGER_PCT, budget),
    targetTokens: Math.min(contextWindow * COMPACT_TARGET_PCT, budget * (COMPACT_TARGET_PCT / COMPACT_TRIGGER_PCT)),
  };
}

/** Pure read tools: a read result is redundant once a LATER read COVERS the same line span (see readRange). */
const READ_TOOLS = new Set(["read_file"]);

/**
 * `read_file` returns a 1-based inclusive LINE SPAN, not the whole file: it takes `offset` (1-based
 * first line, default 1) and `limit` (line count, default READ_DEFAULT_MAX_LINES), returning
 * [offset, offset + limit - 1]. Dedup therefore has to compare spans, not just paths — an agent
 * walking a large file emits reads like {offset:460,limit:90} / {offset:550,limit:90} /
 * {offset:640,limit:50}, which are DISJOINT. Treating a later one as superseding an earlier one
 * (as keying on path alone does) would stub live content the model still needs.
 *
 * Note a bare `read_file {path}` is NOT a whole-file read — it is [1, READ_DEFAULT_MAX_LINES], so on
 * a longer file it does not cover later chunks either.
 *
 * Mirrors `read_file` in electron/tools/aiToolkit.mjs (different process, so the constant cannot be
 * shared) — keep this in sync with READ_DEFAULT_MAX_LINES there.
 */
const READ_DEFAULT_MAX_LINES = 2000;

/** A 1-based, inclusive line span returned by one read call. */
export interface ReadRange {
  start: number;
  end: number;
}

/** Resolve a read call's arguments to the line span it actually returned. */
function readRange(args: Record<string, unknown>): ReadRange {
  const start = Math.max(1, Math.floor(Number(args.offset) || 1));
  const count = Math.max(1, Math.floor(Number(args.limit) || READ_DEFAULT_MAX_LINES));
  return { start, end: start + count - 1 };
}

/**
 * Whether `outer` fully covers `inner`, making `inner`'s content redundant.
 *
 * Deliberately only containment against a SINGLE later read: coverage by the union of several later
 * reads (read the whole file, then read every chunk of it) is not modelled. Containment is provably
 * safe and catches the case that actually recurs — a repeated bare `read_file {path}`.
 */
export const covers = (outer: ReadRange, inner: ReadRange): boolean =>
  outer.start <= inner.start && outer.end >= inner.end;
/** Tools that change a file's content / existence: after them, an earlier read result for the same path is stale. key = which parameter to take as the path. */
const MUTATORS: Record<string, "path" | "destination"> = {
  write_file: "path",
  edit_file: "path",
  append_file: "path",
  delete_file: "path",
  move_file: "destination",
  copy_file: "destination",
};

const normPath = (p: unknown): string =>
  typeof p === "string" ? p.trim().replace(/[/\\]+$/, "") : "";

/** Stale-read stub text (model-visible; occurs within the wire view, invisible to the user — the display view is still the full original). */
const stubText = (path: string): string =>
  `[…… The earlier read result for "${path}" has been omitted: a later read covered the same lines, or the file was ` +
  `modified afterward, so rely on the later read / write result; if you still need the content at that time, call read_file again ……]`;

/** Prefix marker for the summary message (model-visible). */
const SUMMARY_PREFIX =
  "[The following is a summary of the earlier part of this conversation, used to continue the context; if details are missing, re-read the relevant files / command output]\n";

// ── Plan and state ────────────────────────────────────────────────────────────────

/** A single compaction "plan": how to compress the frozen prefix [0, frozenLen). The live part (after it) is always kept as-is. */
export interface CompactionPlan {
  /** Freeze boundary: the value of messages.length at the moment of freezing; only [0, frozenLen) participates in compression. */
  frozenLen: number;
  /** Number of "non-system prefix" messages to be replaced by the summary (counted from index 1); 0 means no summarization, dedup only. */
  coversCount: number;
  /** Number of "user turns" folded into the summary (for UI display only; the count of user messages within coversCount). */
  summarizedTurns: number;
  /** Deduplicated tool-result tool_call_id → its file path (only within the frozen range, after the summary boundary). */
  stubs: Map<string, string>;
}

/** The full compaction state carrying the summary text (stored in the ref / sidecar-persisted). */
export interface CompactionState extends CompactionPlan {
  /** The history summary body corresponding to coversCount>0; null when not yet generated (in which case coversCount should fall back to 0). */
  summaryText: string | null;
  /** How many turns this exact summary has been reused (error-hardening §B1). Reset to 0 on a fresh
   *  summary; when it reaches MAX_SUMMARY_REUSE the caller forces a re-summary, bounding error dwell time. */
  reuseCount?: number;
}

// ── Associate tool_call_id → {tool name, path} ────────────────────────────────────────
interface CallInfo {
  name: string;
  path: string;
  /**
   * Read calls only: the line span the call returned (see readRange). Undefined for mutators, and
   * also for a read whose arguments failed to parse — dedup treats an unknown span as "cannot prove
   * redundant" and leaves the result alone, which is the safe direction.
   */
  range?: ReadRange;
}
/**
 * The single place this file learns what a tool call actually was — and therefore the only place that
 * has to know about tool lazy loading.
 *
 * A cold tool reaches the wire wrapped as `call_tool{name, arguments}` (see toolRouter.ts), and which
 * tools are cold is a per-mode decision that changes: `delete_file` / `move_file` / `copy_file` are
 * MUTATORS *and* routed in dev. Read through the wrapper here and every transform downstream —
 * computeStaleStubs, pathProvenance, trimEditDiffs — keeps working on real names and real paths with
 * no knowledge of the dispatcher. Resolving anywhere else would mean auditing this file again every
 * time the routed set moves, and the failure would be silent: a stale read left live because the
 * mutation that invalidated it was wearing an envelope.
 */
export function indexCalls(messages: ApiMsg[]): Map<string, CallInfo> {
  const byId = new Map<string, CallInfo>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let raw: Record<string, unknown> | null = null;
      try {
        raw = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        /* Invalid JSON arguments: treat as having no path and no span */
      }
      const { name, args: resolvedArgs } = resolveToolCall(tc.function.name, raw ?? {});
      // A wrapper whose own arguments were unparseable yields no inner call either, so the null stays
      // null and the entry keeps the "cannot prove anything about this call" shape.
      const args = raw === null ? null : resolvedArgs;
      const isRead = READ_TOOLS.has(name);
      const pathKey = isRead ? "path" : MUTATORS[name];
      byId.set(tc.id, {
        name,
        path: pathKey && args ? normPath(args[pathKey]) : "",
        ...(isRead && args ? { range: readRange(args) } : {}),
      });
    }
  }
  return byId;
}

/**
 * Compute the set of "stale-read" stubs: a read_file result is redundant when a LATER read of the same
 * path covers its whole line span, or when the path is written afterward. Only results exceeding
 * MIN_STUB_CHARS are stubbed.
 *
 * Supersession is by span containment, not by path (see readRange / covers). Keying on path alone
 * treats an agent's sequential chunk reads of one file — {offset:460,limit:90}, {offset:550,limit:90},
 * {offset:640,limit:50} — as superseding each other and stubs live content out of the wire.
 *
 * @param startIndex Only deduplicate messages at this index and after (in the summary scenario = the start of the kept tail, to avoid reprocessing overlap with the summarized segment).
 */
export function computeStaleStubs(
  messages: ApiMsg[],
  calls: Map<string, CallInfo>,
  startIndex: number,
): Map<string, string> {
  const stubs = new Map<string, string>();
  // Per path: every read and the span it returned, plus the index of the last mutation.
  const readsByPath = new Map<string, { idx: number; range: ReadRange }[]>();
  const lastWrite = new Map<string, number>();
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const info = calls.get(tc.id);
        if (!info?.path) continue;
        if (READ_TOOLS.has(info.name) && info.range) {
          const list = readsByPath.get(info.path);
          if (list) list.push({ idx: i, range: info.range });
          else readsByPath.set(info.path, [{ idx: i, range: info.range }]);
        }
        if (MUTATORS[info.name]) lastWrite.set(info.path, i);
      }
    }
  }
  // Then judge each read result: its own call sits earlier, but supersession is decided by the later
  // reads / writes of the same path, so comparing against this result's index is sound.
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const info = calls.get(m.tool_call_id);
    if (!info || !READ_TOOLS.has(info.name) || !info.path) continue;
    // No known span (unparseable arguments): cannot prove redundancy, so keep the result.
    const range = info.range;
    if (!range) continue;
    if (typeof m.content !== "string" || m.content.length < MIN_STUB_CHARS) continue;
    const supersededByWrite = (lastWrite.get(info.path) ?? -1) > i;
    const supersededByRead = (readsByPath.get(info.path) ?? []).some(
      (r) => r.idx > i && covers(r.range, range),
    );
    if (supersededByRead || supersededByWrite) stubs.set(m.tool_call_id, info.path);
  }
  return stubs;
}

/** Find the index within body (the non-system part) of the earliest of the "most recent keepTurns user messages"; return 0 if there aren't enough. */
function tailStartInBody(body: ApiMsg[], keepTurns: number): number {
  const userIdx: number[] = [];
  for (let i = 0; i < body.length; i++) if (body[i].role === "user") userIdx.push(i);
  if (userIdx.length <= keepTurns) return 0;
  return userIdx[userIdx.length - keepTurns];
}

/** Estimate the tokens of a set of messages (borrowing the tiktoken fallback estimator; only for threshold checks, not a precise bill). */
function estTokens(messages: ApiMsg[]): number {
  return countMessagesTokens(messages);
}

/**
 * Plan a compaction: called at the "start of each turn". Returning null means no compression is needed (usage hasn't crossed the threshold) — in which case the compaction state should be cleared,
 * so the wire view == the full conversation, keeping the prefix cache most stable. When a plan is returned:
 *   - if coversCount>0, the caller must first generate the summary text via summarizeMessages, then finalize the CompactionState;
 *   - if coversCount==0, dedup only, no model call needed.
 */
export function planCompaction(
  messages: ApiMsg[],
  opts: {
    contextWindow: number;
    currentTokens: number;
    force?: boolean;
    /** The previous compaction state: used for the "freeze boundary" — reusing its summary boundary until the tail exceeds the threshold again (see below). */
    prev?: CompactionState | null;
    /**
     * Optional absolute overrides (in tokens). When present they REPLACE the window-relative
     * trigger / target, giving the caller a hybrid budget (Phase 3: min(window*pct, budget)) or a
     * simulation knob (Phase 2 replay). Undefined preserves the original window-relative behaviour
     * exactly, so existing callers are unaffected.
     */
    triggerTokens?: number;
    targetTokens?: number;
  },
): { plan: CompactionPlan; summarizeMessages: ApiMsg[] } | null {
  const trigger = opts.triggerTokens ?? opts.contextWindow * COMPACT_TRIGGER_PCT;
  // force: manual "compress now", ignoring the threshold and compressing as hard as possible (dedup + summarize the history before the last KEEP_TAIL_TURNS).
  if (!opts.force && opts.currentTokens <= trigger) return null;

  const frozenLen = messages.length;
  const calls = indexCalls(messages);
  const hasSystem = messages[0]?.role === "system";
  const bodyStart = hasSystem ? 1 : 0;

  // First do dedup only, and see if that's already enough to drop below the target line.
  const dedupOnly = computeStaleStubs(messages, calls, bodyStart);
  const target = opts.targetTokens ?? opts.contextWindow * COMPACT_TARGET_PCT;
  const afterDedup = estTokens(applyStubs(messages, dedupOnly));
  if (!opts.force && afterDedup <= target) {
    return {
      plan: { frozenLen, coversCount: 0, summarizedTurns: 0, stubs: dedupOnly },
      summarizeMessages: [],
    };
  }

  const body = messages.slice(bodyStart);

  // ── Freeze boundary (the key to prefix caching, see docs/prompt-cache-optimization.md §4.1) ──────────
  // When a summary already exists, don't recompute the boundary every turn by "keeping the most recent N turns" (that way the boundary slides with new turns → coversCount
  // changes every turn → re-summarize every turn → the [system, summary, tail] prefix changes every turn → post-compression prefix-cache hit rate collapses to ~0).
  // Instead: reuse the previous boundary coversCount, and keep it unchanged as long as the "summary + trailing original text after it" wire still doesn't exceed trigger
  // (stable coversCount → the caller reuses the old summary body → the prefix is byte-stable → appended new turns hit the prefix cache).
  // Only move the boundary forward and re-summarize when the tail grows to exceed trigger again (a rare discrete event, only then is there a single cold write).
  // Manual force compression should compress as hard as possible, skipping the freeze and recomputing the boundary directly.
  if (
    !opts.force &&
    opts.prev?.summaryText &&
    opts.prev.coversCount > 0 &&
    opts.prev.coversCount <= body.length
  ) {
    const keep = opts.prev.coversCount;
    const keptTail = body.slice(keep);
    const tailStubs = computeStaleStubs(messages, calls, bodyStart + keep);
    const wireWithPrev = [
      ...(hasSystem ? [messages[0]] : []),
      // Snapshot included here too: this branch decides whether the frozen boundary can be reused by measuring the resulting
      // wire, and leaving it out would under-count by the snapshot's size on every turn, advancing the boundary later than it
      // should.
      ...foldSummary(
        opts.prev.summaryText,
        applyStubs(keptTail, tailStubs),
        renderSnapshot(foldReminders(body.slice(0, keep))),
      ),
    ];
    if (estTokens(wireWithPrev) <= trigger) {
      return {
        plan: {
          frozenLen,
          coversCount: keep,
          summarizedTurns: opts.prev.summarizedTurns,
          stubs: tailStubs,
        },
        summarizeMessages: [], // reuse the old summary, no need to call the summarization model again
      };
    }
    // tail already exceeds threshold → fall through to move the boundary forward below and re-summarize.
  }

  // dedup insufficient → add summarization: keep the original text of the most recent KEEP_TAIL_TURNS user turns, summarize the rest into one segment.
  const tailStart = tailStartInBody(body, KEEP_TAIL_TURNS);
  if (tailStart <= 0) {
    // the tail is already everything (history is short yet still over the limit: usually a single-turn giant output) — dedup did its best, don't summarize.
    return {
      plan: { frozenLen, coversCount: 0, summarizedTurns: 0, stubs: dedupOnly },
      summarizeMessages: [],
    };
  }
  // the summary covers body[0, tailStart); dedup only applies to the kept tail (the summarized segment has entirely vanished, no need to dedup again).
  const stubs = computeStaleStubs(messages, calls, bodyStart + tailStart);
  const summarizeMessages = body.slice(0, tailStart);
  const summarizedTurns = summarizeMessages.filter((m) => m.role === "user").length;
  return {
    plan: { frozenLen, coversCount: tailStart, summarizedTurns, stubs },
    summarizeMessages,
  };
}

// ── Apply: produce the wire view from the full conversation + state ────────────────────────────────────────

/**
 * Replace the content of the tool results listed in stubs with stub text (other messages as-is). Pure function, doesn't mutate the
 * arguments. A change event riding this turn is untouched: it lives in `reminderText`, not in `content`.
 */
// ── Completed-round release (wire-only) ───────────────────────────────────────────

/**
 * How many trailing rounds keep their tool results verbatim. A "round" is delimited by user messages.
 *
 * 2 rather than 1 deliberately: a follow-up often refers back to what the previous round just did
 * ("now do the same for the other file"), so the round before the live one stays intact.
 */
export const KEEP_ROUNDS = 2;

/** Short descriptor of a tool call, kept in place of its released result so the trace survives. */
function describeCall(rawName: string, argsJson: string): string {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    /* unparseable arguments: fall back to the bare tool name */
  }
  // Through the dispatcher, so the descriptor reads "read_file src/x.ts lines 460-549" rather than a
  // uniform "call_tool" for every released result — the descriptor exists precisely so the model can
  // tell what ran and re-run it, and a wrapper name defeats that.
  const { name, args } = resolveToolCall(rawName, raw);
  const p =
    typeof args.path === "string"
      ? args.path
      : typeof args.destination === "string"
        ? args.destination
        : "";
  if (READ_TOOLS.has(name) && p) {
    const r = readRange(args);
    return `${name} ${p} lines ${r.start}-${r.end}`;
  }
  if (p) return `${name} ${p}`;
  const firstStr = Object.values(args).find((v) => typeof v === "string" && v) as string | undefined;
  return firstStr ? `${name} ${firstStr.slice(0, 60)}` : name;
}

const releaseText = (desc: string): string =>
  `[…… Result released: this call belongs to a task that has since completed, so its output is no longer carried in ` +
  `context. It was: ${desc}. Run it again if you need the content ……]`;

/**
 * Tool results belonging to rounds that already finished.
 *
 * Measured: the working set a round inherits is 45-77% of what that round costs, because tool output
 * is append-only and every token in it is re-delivered on each of the round's ~20-30 model calls. Once
 * a round is over, its raw tool output has done its job — the agent's own assistant messages, which are
 * never touched here, still carry what it concluded, and the descriptor left behind says what ran so the
 * model can re-run it rather than assuming it never looked.
 *
 * Driven by round boundaries rather than todo completions on purpose: todos are updated late and in
 * batches (first completion landed at call 17 of 29 in one profiled round), so they recover ~8% where
 * round boundaries reach ~26%, and forcing more frequent todo updates costs more in round trips than the
 * eviction saves.
 *
 * Pure and deterministic: within a round the set cannot change (no new user message), so the wire prefix
 * stays byte-stable and the cache holds. It shifts exactly once per round, at the boundary.
 */
/**
 * Index of the first message belonging to the live region: the last `keepRounds` user turns and
 * everything after them. 0 when the conversation is still short enough that nothing has completed.
 *
 * Rounds are delimited by user messages, and no user message is appended mid-round, so this value is
 * constant for the duration of a round — which is what keeps every release below prefix-stable.
 */
function liveRegionStart(messages: ApiMsg[], keepRounds: number): number {
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") userIdx.push(i);
  if (userIdx.length <= keepRounds) return 0;
  return userIdx[userIdx.length - keepRounds];
}

export function computeReleasedResults(
  messages: ApiMsg[],
  keepRounds: number = KEEP_ROUNDS,
): Map<string, string> {
  const released = new Map<string, string>();
  const liveFrom = liveRegionStart(messages, keepRounds);
  if (liveFrom <= 0) return released;

  const desc = new Map<string, string>();
  for (let i = 0; i < liveFrom; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) desc.set(tc.id, describeCall(tc.function.name, tc.function.arguments));
    }
  }
  for (let i = 0; i < liveFrom; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    // Already short: a descriptor would not be smaller, and rewriting it would churn the prefix for nothing.
    if (m.content.length < MIN_STUB_CHARS) continue;
    const d = desc.get(m.tool_call_id);
    if (d) released.set(m.tool_call_id, d);
  }
  return released;
}

/**
 * Bulky edit-tool argument fields, by tool. These carry the text the agent wrote; once the call has
 * landed, that text is on disk and `read_file` can recover it, so the wire does not need to keep
 * carrying it. `path` and every structural field are always preserved — `indexCalls`, `pathProvenance`
 * and the dedup logic all key on `path`, and the tool-call shape has to stay schema-valid.
 */
const RELEASABLE_ARGS: Record<string, readonly string[]> = {
  edit_file: ["old_string", "new_string"],
  write_file: ["content"],
  append_file: ["content"],
};

/**
 * Elide the bulky fields of one completed edit call's arguments. Returns null when there is nothing
 * to do (not an edit tool, unparseable arguments, or every field already small) so the caller can keep
 * the original object and its referential equality.
 */
function releaseCallArguments(rawName: string, argsJson: string): string | null {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return null; // unparseable: leave it exactly as it was rather than rewrite it into something else
  }
  // This is the one transform that REWRITES arguments rather than reading them, so resolving through
  // indexCalls is not enough — the elided text has to be written back INSIDE the dispatcher's envelope,
  // or the rewritten call would no longer satisfy call_tool's own {name, arguments} schema. When the
  // call was not wrapped, `wrapped` is false and this behaves exactly as before.
  const { name, args } = resolveToolCall(rawName, outer);
  const wrapped = name !== rawName;
  const fields = RELEASABLE_ARGS[name];
  if (!fields) return null;
  const path = typeof args.path === "string" ? args.path : "";
  let changed = false;
  for (const f of fields) {
    const v = args[f];
    if (typeof v !== "string" || v.length < MIN_STUB_CHARS) continue;
    const lines = v.split("\n").length;
    args[f] =
      f === "old_string"
        ? `[…… ${lines} lines elided: the text this call replaced ……]`
        : `[…… ${lines} lines elided: this text was written to ${path || "the file"}; read_file it if you need it ……]`;
    changed = true;
  }
  if (!changed) return null;
  return JSON.stringify(wrapped ? { ...outer, name, arguments: args } : args);
}

/**
 * Release the payloads the agent itself wrote, for edit calls in rounds that have completed.
 *
 * Measured after the tool-result fixes landed: a round's own history grew +32,005 against tool output's
 * +5,677 — 85% of in-round growth is the agent's own emissions, nearly all of it `new_string` /
 * `content` sitting in `tool_calls[].function.arguments` and re-sent on every later call.
 *
 * Scoped to completed rounds for the same reason as computeReleasedResults, and doubly so here: within
 * the live region the model may still be reasoning about what it just wrote, and the consent-preview
 * path in page.tsx reads these arguments to compute a diff before the call executes. Only the derived
 * wire is affected — display, persistence, and execution all read the untouched source.
 */
export function releaseCallPayloads(
  messages: ApiMsg[],
  keepRounds: number = KEEP_ROUNDS,
): ApiMsg[] {
  const liveFrom = liveRegionStart(messages, keepRounds);
  if (liveFrom <= 0) return messages;
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= liveFrom || m.role !== "assistant" || !m.tool_calls) return m;
    let touched = false;
    const calls = m.tool_calls.map((tc) => {
      const next = releaseCallArguments(tc.function.name, tc.function.arguments);
      if (next === null) return tc;
      touched = true;
      return { ...tc, function: { ...tc.function, arguments: next } };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, tool_calls: calls };
  });
  return changed ? out : messages;
}

/** Replace released tool results with their descriptor. Returns the input array when nothing changed. */
export function applyReleases(messages: ApiMsg[], released: Map<string, string>): ApiMsg[] {
  if (released.size === 0) return messages;
  return messages.map((m) =>
    m.role === "tool" && released.has(m.tool_call_id)
      ? { ...m, content: releaseText(released.get(m.tool_call_id)!) }
      : m,
  );
}

// ── Edit-diff trimming (wire-only) ────────────────────────────────────────────────

/** Tools whose result carries a unified diff appended by makeUnifiedDiff (electron/tools/aiToolkit.mjs). */
const DIFF_TOOLS = new Set(["edit_file", "write_file", "append_file"]);

/**
 * Replace an edit tool's echoed diff with the line ranges it touched.
 *
 * The `+` lines of that diff ARE the `new_string` the assistant just sent, so the same code sits in
 * the wire twice — once in the assistant's tool_call arguments, once in the echoed result. Measured
 * on a real 6-task round: 14 edit_file results carried ~12K tokens of diff duplicating the model's
 * own output, and because tool results are append-only every later round in that conversation
 * re-sent all of it (docs/context-budget-profiling.md).
 *
 * The model keeps what it needs to act on — which file, which lines — and can read_file those ranges
 * for the current text. This is a pure per-message projection, so the wire prefix stays byte-stable
 * and prompt caching is unaffected (unlike a retroactive rewrite — see the dedup discussion in
 * docs/prompt-cache-optimization.md).
 */
function summarizeEditDiff(content: string): string {
  // The fenced block makeUnifiedDiff appends at the very end of the result.
  const block = /\n```diff\n([\s\S]*?)\n```\s*$/.exec(content);
  if (!block) return content;
  const ranges: string[] = [];
  // Hunk header: "@@ -old,oldCount +new,newCount @@" — the new-side range is what a re-read would use.
  for (const h of block[1].matchAll(/^@@ -\d+,\d+ \+(\d+),(\d+) @@$/gm)) {
    const start = Number(h[1]);
    const count = Number(h[2]);
    ranges.push(count > 1 ? `${start}-${start + count - 1}` : `${start}`);
  }
  // No parseable hunks — e.g. makeUnifiedDiff's "file too large, diff omitted" placeholder, which is
  // already compact. Leave it alone rather than replacing one summary with another.
  if (!ranges.length) return content;
  return (
    `${content.slice(0, block.index)}\n` +
    `[…… The diff has been omitted from context: its added lines are the same text you passed as new_string just above. ` +
    `Changed lines in the file as it now stands: ${ranges.join(", ")}. Call read_file on those ranges if you need to see ` +
    `the current text ……]`
  );
}

/**
 * Apply summarizeEditDiff to every edit-tool result. Pure and deterministic; returns the original
 * array when nothing changed so callers keep referential equality.
 */
export function trimEditDiffs(messages: ApiMsg[], calls: Map<string, CallInfo>): ApiMsg[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const info = calls.get(m.tool_call_id);
    if (!info || !DIFF_TOOLS.has(info.name)) return m;
    const next = summarizeEditDiff(m.content);
    if (next === m.content) return m;
    changed = true;
    return { ...m, content: next };
  });
  return changed ? out : messages;
}

export function applyStubs(messages: ApiMsg[], stubs: Map<string, string>): ApiMsg[] {
  if (stubs.size === 0) return messages;
  return messages.map((m) =>
    m.role === "tool" && stubs.has(m.tool_call_id)
      ? { ...m, content: stubText(stubs.get(m.tool_call_id)!) }
      : m,
  );
}

/**
 * Merge the summary body into the first kept message after it: if it's a user message, splice into its body (avoiding an extra
 * message / consecutive same-role), otherwise prepend a user message.
 *
 * `snapshot` is the standing state as of the cut, folded from the change events that fall BEFORE it (see reminders.ts). Everything
 * before the cut is replaced by prose the summariser wrote, and the summariser may or may not mention that the working directory
 * changed — so the constraints ride along in computed form instead, where non-determinism cannot lose them. It describes the state
 * AT the cut, not the current state: a reminder that survives in the kept region then replays it forward correctly.
 *
 * The kept turn is spread rather than rebuilt, so its own `reminder` payload is not dropped.
 */
function foldSummary(summaryText: string, kept: ApiMsg[], snapshot?: string): ApiMsg[] {
  const banner = SUMMARY_PREFIX + summaryText + (snapshot ? `\n\n${snapshot}` : "");
  const first = kept[0];
  if (first && first.role === "user") {
    if (typeof first.content === "string") {
      return [{ ...first, content: `${banner}\n\n${first.content}` }, ...kept.slice(1)];
    }
    // Multimodal: prepend the summary as the first text part.
    const parts = first.content as ContentPart[];
    return [
      { ...first, content: [{ type: "text", text: banner }, ...parts] },
      ...kept.slice(1),
    ];
  }
  return [{ role: "user", content: banner }, ...kept];
}

/**
 * Produce the "sent to the model" wire view from the full conversation messages + compaction state.
 * state null / undefined → return as-is (== the full conversation). Only compress [0, frozenLen); append the rest as-is.
 */
export function buildWireContext(
  messages: ApiMsg[],
  state: CompactionState | null | undefined,
): ApiMsg[] {
  // Both applied compaction or not. trimEditDiffs drops an echo that duplicates the assistant's own
  // tool-call arguments; applyReleases drops raw tool output whose round is over. Order matters only
  // in that releases win — a released result is already reduced to its descriptor.
  const trimmed = trimEditDiffs(messages, indexCalls(messages));
  const withResults = applyReleases(trimmed, computeReleasedResults(trimmed));
  const base = releaseCallPayloads(withResults);
  if (!state) return base;
  const frozenLen = Math.min(state.frozenLen, base.length);
  const frozen = base.slice(0, frozenLen);
  const live = base.slice(frozenLen);

  const hasSystem = frozen[0]?.role === "system";
  const system = hasSystem ? [frozen[0]] : [];
  const body = hasSystem ? frozen.slice(1) : frozen;

  let prefixBody: ApiMsg[];
  if (state.summaryText && state.coversCount > 0) {
    const kept = applyStubs(body.slice(state.coversCount), state.stubs);
    // Folded over the pre-compaction messages, never over the wire: foldSummary rebuilds kept[0], and the wire has already had the
    // `reminder` payloads stripped by the time anything downstream sees it.
    prefixBody = foldSummary(state.summaryText, kept, renderSnapshot(foldReminders(body.slice(0, state.coversCount))));
  } else {
    prefixBody = applyStubs(body, state.stubs);
  }
  return [...system, ...prefixBody, ...live];
}

/**
 * Ensure the "sent to the model" message sequence is self-consistent on tool calls: after each assistant.tool_calls, pair each of its
 * tool_call_ids with a tool result message (fill in a stub if missing), and drop orphan tool messages with no owner.
 *
 * Why needed: the assistant's tool-call message is persisted "at dispatch time", while its results are persisted one by one only after the tools execute.
 * If this turn is interrupted by the user / the backend (such as llama-server) crashes midway, it's possible that only the assistant.tool_calls was stored without its
 * results; when the session is reopened and this history is replayed as-is, the vendor returns 400 with "tool_calls were not each answered". This function fills the gaps
 * before sending, keeping the wire view always valid (it's an identity transform for already-consistent history, not perturbing the prefix cache).
 *
 * Also drops any assistant message with neither content nor tool_calls: a reasoning model can return a turn whose only
 * output was reasoning_content (which is stripped from the wire) and no tool call, leaving an empty assistant message
 * that the provider rejects with 400 "content or tool_calls must be set". Dropping it here fixes both the live buffer
 * and already-persisted conversations that carry one.
 */
function isEmptyAssistantContent(content: ApiMsg["content"]): boolean {
  if (content == null) return true;
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

export function sanitizeToolCallPairs(messages: ApiMsg[]): ApiMsg[] {
  const out: ApiMsg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && (!m.tool_calls || m.tool_calls.length === 0) && isEmptyAssistantContent(m.content)) {
      // Empty assistant turn (no body, no tool calls) — invalid to send; skip it.
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      out.push(m);
      // Gather the immediately following run of tool results (indexed by tool_call_id), then reorder / fill them in call order.
      const answered = new Map<string, ApiMsg>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        const tm = messages[j];
        if (tm.role === "tool") answered.set(tm.tool_call_id, tm);
        j++;
      }
      for (const tc of m.tool_calls) {
        const hit = answered.get(tc.id);
        out.push(
          hit ?? {
            role: "tool",
            tool_call_id: tc.id,
            content: "(No result: this tool call did not complete, possibly due to an interruption or backend error; retry if still needed)",
          },
        );
      }
      i = j - 1; // skip the consumed tool run (including discarded orphan items)
    } else if (m.role === "tool") {
      // orphan tool message with no preceding assistant.tool_calls: drop it (the vendor rejects it due to the missing corresponding call).
      continue;
    } else {
      out.push(m);
    }
  }
  return out;
}

// ── Serialization (for persistence; Map ↔ key-value pair array) ─────────────────────────────────────────
/** The JSON-serializable form of CompactionState (stubs converted from a Map to a key-value pair array). */
export type SerializedCompaction = Omit<CompactionState, "stubs"> & { stubs: [string, string][] };

export function serializeCompaction(state: CompactionState): SerializedCompaction {
  return {
    frozenLen: state.frozenLen,
    coversCount: state.coversCount,
    summarizedTurns: state.summarizedTurns,
    summaryText: state.summaryText,
    reuseCount: state.reuseCount ?? 0,
    stubs: [...state.stubs],
  };
}

/** Restore CompactionState from the persisted form (take only known fields, ignore extra keys; stubs restored to a Map). */
export function deserializeCompaction(s: SerializedCompaction): CompactionState {
  return {
    frozenLen: s.frozenLen,
    coversCount: s.coversCount,
    summarizedTurns: s.summarizedTurns,
    summaryText: s.summaryText,
    reuseCount: s.reuseCount ?? 0,
    stubs: new Map(s.stubs ?? []),
  };
}

/** For the UI to show "how much was folded": number of summarized user turns + number of deduplicated reads. Both 0 means not compressed. */
export function compactionSavings(state: CompactionState | null | undefined): {
  summarizedTurns: number;
  dedupedReads: number;
} {
  if (!state) return { summarizedTurns: 0, dedupedReads: 0 };
  return {
    summarizedTurns: state.summaryText ? state.summarizedTurns : 0,
    dedupedReads: state.stubs.size,
  };
}

/**
 * Provenance of a path's current known state, for the confirmation gate (error-hardening §A1). Determines,
 * from the compaction state alone (no model call), whether the model's knowledge of this file comes from
 * content still present verbatim in the wire, or only from the lossy summary:
 *   - "verified"    — the latest read/write of the path is in the kept-verbatim or live-tail region.
 *   - "digest-only" — the latest read/write was folded into the summary; the model is acting on compressed,
 *                     unverified history. A high-risk mutation on this warrants a "re-read first" warning.
 *   - "unknown"     — the path was never read/written in this conversation (a different risk; not flagged here).
 */
export function pathProvenance(
  messages: ApiMsg[],
  state: CompactionState | null | undefined,
  rawPath: string,
): "verified" | "digest-only" | "unknown" {
  const path = normPath(rawPath);
  if (!path) return "unknown";
  const calls = indexCalls(messages);
  const hasSystem = messages[0]?.role === "system";
  const bodyStart = hasSystem ? 1 : 0;
  // Messages [bodyStart, foldedEnd) are folded into the summary (gone from the wire); anything at/after it
  // survives verbatim (kept-frozen or live tail). No summary → nothing folded.
  const foldedEnd = state?.summaryText && state.coversCount > 0 ? bodyStart + state.coversCount : bodyStart;
  let latestTouch = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const info = calls.get(tc.id);
      if (info?.path === path && (READ_TOOLS.has(info.name) || MUTATORS[info.name]) && i > latestTouch) {
        latestTouch = i;
      }
    }
  }
  if (latestTouch < 0) return "unknown";
  return latestTouch < foldedEnd ? "digest-only" : "verified";
}
