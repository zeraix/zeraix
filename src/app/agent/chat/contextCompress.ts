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
import type { ApiMsg, ContentPart } from "./types";
import { countMessagesTokens } from "@/lib/ai/tokenizer";

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

/** Pure read tools: when the same path is read again, the earlier result is entirely redundant. */
const READ_TOOLS = new Set(["read_file"]);
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
  `[…… The earlier read result for "${path}" has been omitted: the file was read again or modified afterward, ` +
  `so rely on the later read / write result; if you still need the content at that time, call read_file again ……]`;

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
}

// ── Associate tool_call_id → {tool name, path} ────────────────────────────────────────
interface CallInfo {
  name: string;
  path: string;
}
function indexCalls(messages: ApiMsg[]): Map<string, CallInfo> {
  const byId = new Map<string, CallInfo>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* Invalid JSON arguments: treat as having no path */
      }
      const pathKey = READ_TOOLS.has(tc.function.name)
        ? "path"
        : MUTATORS[tc.function.name];
      byId.set(tc.id, {
        name: tc.function.name,
        path: pathKey ? normPath(args[pathKey]) : "",
      });
    }
  }
  return byId;
}

/**
 * Compute the set of "stale-read" stubs: for each read_file result, if there is a later (higher-index) read of the same path
 * or any write afterward, that result is redundant/stale → stub it. Keep the last one. Only include results exceeding MIN_STUB_CHARS.
 * @param startIndex Only deduplicate messages at this index and after (in the summary scenario = the start of the kept tail, to avoid reprocessing overlap with the summarized segment).
 */
function computeStaleStubs(
  messages: ApiMsg[],
  calls: Map<string, CallInfo>,
  startIndex: number,
): Map<string, string> {
  const stubs = new Map<string, string>();
  // First record for each path the "index of the last read" and the "index of the last write".
  const lastRead = new Map<string, number>();
  const lastTouch = new Map<string, number>(); // both read and write count as a "touch", used to judge whether a read was superseded by a later one
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const info = calls.get(tc.id);
        if (!info?.path) continue;
        if (READ_TOOLS.has(info.name)) lastRead.set(info.path, i);
        if (MUTATORS[info.name]) lastTouch.set(info.path, i);
      }
    }
  }
  // Then judge each read result: if its corresponding assistant call appears before a later read / write → stale.
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const info = calls.get(m.tool_call_id);
    if (!info || !READ_TOOLS.has(info.name) || !info.path) continue;
    if (typeof m.content !== "string" || m.content.length < MIN_STUB_CHARS) continue;
    // this read message is at position i in the array; its "call" is earlier, but the supersession relation can be judged using later reads/writes of the same path.
    const supersededByRead = (lastRead.get(info.path) ?? -1) > i;
    const supersededByWrite = (lastTouch.get(info.path) ?? -1) > i;
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
  },
): { plan: CompactionPlan; summarizeMessages: ApiMsg[] } | null {
  const trigger = opts.contextWindow * COMPACT_TRIGGER_PCT;
  // force: manual "compress now", ignoring the threshold and compressing as hard as possible (dedup + summarize the history before the last KEEP_TAIL_TURNS).
  if (!opts.force && opts.currentTokens <= trigger) return null;

  const frozenLen = messages.length;
  const calls = indexCalls(messages);
  const hasSystem = messages[0]?.role === "system";
  const bodyStart = hasSystem ? 1 : 0;

  // First do dedup only, and see if that's already enough to drop below the target line.
  const dedupOnly = computeStaleStubs(messages, calls, bodyStart);
  const target = opts.contextWindow * COMPACT_TARGET_PCT;
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
      ...foldSummary(opts.prev.summaryText, applyStubs(keptTail, tailStubs)),
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

/** Replace the content of the tool results listed in stubs with stub text (other messages as-is). Pure function, doesn't mutate the arguments. */
function applyStubs(messages: ApiMsg[], stubs: Map<string, string>): ApiMsg[] {
  if (stubs.size === 0) return messages;
  return messages.map((m) =>
    m.role === "tool" && stubs.has(m.tool_call_id)
      ? { ...m, content: stubText(stubs.get(m.tool_call_id)!) }
      : m,
  );
}

/** Merge the summary body into the first kept message after it: if it's a user message, splice into its body (avoiding an extra message / consecutive same-role), otherwise prepend a user message. */
function foldSummary(summaryText: string, kept: ApiMsg[]): ApiMsg[] {
  const banner = SUMMARY_PREFIX + summaryText;
  const first = kept[0];
  if (first && first.role === "user") {
    if (typeof first.content === "string") {
      return [{ role: "user", content: `${banner}\n\n${first.content}` }, ...kept.slice(1)];
    }
    // Multimodal: prepend the summary as the first text part.
    const parts = first.content as ContentPart[];
    return [
      { role: "user", content: [{ type: "text", text: banner }, ...parts] },
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
  if (!state) return messages;
  const frozenLen = Math.min(state.frozenLen, messages.length);
  const frozen = messages.slice(0, frozenLen);
  const live = messages.slice(frozenLen);

  const hasSystem = frozen[0]?.role === "system";
  const system = hasSystem ? [frozen[0]] : [];
  const body = hasSystem ? frozen.slice(1) : frozen;

  let prefixBody: ApiMsg[];
  if (state.summaryText && state.coversCount > 0) {
    const kept = applyStubs(body.slice(state.coversCount), state.stubs);
    prefixBody = foldSummary(state.summaryText, kept);
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
 */
export function sanitizeToolCallPairs(messages: ApiMsg[]): ApiMsg[] {
  const out: ApiMsg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
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
