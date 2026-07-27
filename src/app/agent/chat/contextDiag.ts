/**
 * Context diagnostics (Phase 1 + 2 of the context-management optimisation — measurement only, no
 * behaviour change).
 *
 * Two jobs, both read-only:
 *   1. describeContext() — break the *actual wire* into buckets (system prompt / tool schemas /
 *      conversation history / tool outputs / sub-agent outputs) so we can see WHERE a heavy task's
 *      tokens live before touching any threshold. Crucially it also sizes the tool-schema array,
 *      which the app's own context estimate (countMessagesTokens) never sees — schemas live in the
 *      request's `tools` field, not in `messages`, so today they are an invisible per-round tax.
 *   2. simulateBudgets() — replay a *persisted conversation* through the (pure) compaction planner at
 *      candidate absolute budgets, offline, to answer "how small does the working set stay, and how
 *      often would we summarise" WITHOUT changing production behaviour or waiting to collect new data.
 *
 * Nothing here is on the hot path unless the usage-log flag is on; simulateBudgets is dev-only.
 */
import type { ApiMsg, ContentPart } from "./types";
import { countTokens, countMessageTokens, countMessagesTokens, setTokenCache } from "@/lib/ai/tokenizer";
import {
  indexCalls,
  planCompaction,
  buildWireContext,
  computeStaleStubs,
  applyStubs,
  COMPACT_TRIGGER_PCT,
  COMPACT_TARGET_PCT,
  type CompactionState,
} from "./contextCompress";

/**
 * C1 (error-hardening §9): distinctive facts that appear in a compaction SUMMARY but NOT in its SOURCE
 * text — i.e. likely fabricated by the summariser. Deterministic, no model call. ADVISORY / observability
 * ONLY: we flag *only* the present-in-summary / absent-in-source direction, because a summary legitimately
 * OMITS and transforms facts (so "source fact missing from summary" is not an error). Even this direction
 * has false positives — the summary may shorten a path ("auth.ts" for "src/lib/auth.ts") or aggregate a
 * number — which is why the result is logged for measurement, never used to reject/retry or edit the
 * summary. Scoped to high-signal facts: slashed file paths with an extension, and 3+ digit numbers.
 */
const PATH_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
const NUM_RE = /\b\d{3,}\b/g;
export function findUnverifiedFacts(summary: string, sourceText: string): string[] {
  if (!summary) return [];
  const out = new Set<string>();
  for (const re of [PATH_RE, NUM_RE]) {
    for (const m of summary.matchAll(re)) {
      const tok = m[0];
      if (tok.length >= 3 && !sourceText.includes(tok)) out.add(tok);
    }
  }
  return [...out];
}

/** The tool name a sub-agent delegation is issued under (its tool results are attributed separately). */
const SUBAGENT_TOOL = "run_subagent";
/** Read tool whose repeated calls on the same path are the "redundant re-read" signal (attention proxy). */
const READ_TOOL = "read_file";

/** Count a single message's tokens, including the text parts of a multimodal (array) content. */
function msgTokens(m: ApiMsg): number {
  if (Array.isArray(m.content)) {
    // countMessageTokens treats array content as 0; count its text parts so multimodal user turns
    // aren't under-reported. Image parts are URLs (or stripped), so their token weight is nominal.
    let n = 0;
    for (const p of m.content as ContentPart[]) if (p.type === "text") n += countTokens(p.text);
    return n;
  }
  return countMessageTokens(m);
}

export interface ContextBreakdown {
  /** System prompt(s): the static prefix plus any transient system nudges present in the wire. */
  system: number;
  /** Tool JSON schemas (the `tools` request field) — NOT counted by countMessagesTokens; the app's blind spot. */
  toolSchemas: number;
  /** User + assistant turns (assistant tool-call requests included). */
  history: number;
  /** Regular tool results (file reads, command output, greps, …). */
  toolOutputs: number;
  /** Sub-agent conclusions fed back as tool results (already distilled, but sized separately to confirm). */
  subagentOutputs: number;
  /** Messages-only total (system + history + toolOutputs + subagentOutputs) — matches the app's ctx estimate. */
  total: number;
  /** What the provider actually prices this round: messages + tool schemas. */
  wireTotal: number;
  /** Number of messages in the wire. */
  msgCount: number;
  /** Redundant re-reads so far: read_file calls whose path was already read earlier (attention-quality proxy). */
  rereads: number;
}

/**
 * Redundant re-read count: how many read_file calls target a path that was already read earlier in
 * the conversation. A high count is the signature of context loss — the model re-fetching something
 * it once had — which is exactly the correctness cost an over-aggressive budget would introduce.
 */
export function countRedundantReads(messages: ApiMsg[], calls?: Map<string, { name: string; path: string }>): number {
  const byId = calls ?? indexCalls(messages);
  const seen = new Set<string>();
  let rereads = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const info = byId.get(tc.id);
      if (!info || info.name !== READ_TOOL || !info.path) continue;
      if (seen.has(info.path)) rereads++;
      else seen.add(info.path);
    }
  }
  return rereads;
}

/** Break the wire (messages + tools) into token buckets. Pure; safe to call per round when logging is on. */
export function describeContext(messages: ApiMsg[], tools?: unknown[]): ContextBreakdown {
  const calls = indexCalls(messages);
  let system = 0;
  let history = 0;
  let toolOutputs = 0;
  let subagentOutputs = 0;
  for (const m of messages) {
    const tk = msgTokens(m) + 4; // +4 mirrors countMessagesTokens' per-message overhead
    if (m.role === "system") {
      system += tk;
    } else if (m.role === "tool") {
      const info = calls.get(m.tool_call_id);
      if (info?.name === SUBAGENT_TOOL) subagentOutputs += tk;
      else toolOutputs += tk;
    } else {
      history += tk; // user + assistant
    }
  }
  const toolSchemas = tools && tools.length ? countTokens(JSON.stringify(tools)) : 0;
  const total = system + history + toolOutputs + subagentOutputs;
  return {
    system,
    toolSchemas,
    history,
    toolOutputs,
    subagentOutputs,
    total,
    wireTotal: total + toolSchemas,
    msgCount: messages.length,
    rereads: countRedundantReads(messages, calls),
  };
}

// ── Phase 2: offline budget-replay harness ──────────────────────────────────────────────────────

/** One candidate compaction policy to simulate. Absolute values in tokens; undefined = window-relative. */
export interface BudgetCandidate {
  label: string;
  /** Absolute trigger (tokens). Effective trigger is min(window*pct, this). Omit for pure window-relative (current prod). */
  triggerTokens?: number;
  /** Absolute target (tokens). Effective target is min(window*pct, this). Omit for pure window-relative. */
  targetTokens?: number;
}

export interface TurnSample {
  turn: number; // 1-based user turn
  /** Raw context at turn start (what production's frozen trigger actually sees, before this turn's tool spew). */
  startTokens: number;
  /** Raw context at turn end (peak of the turn — all of this turn's tool outputs included). */
  peakRawTokens: number;
  /** Peak wire size under this budget (buildWireContext applied to the turn-end snapshot) + schema tax. */
  peakWireTokens: number;
  /** Whether a summariser call would fire at this turn's start (a new summary was generated). */
  summarised: boolean;
  /** Whether the frozen prefix changed vs the previous turn (a prefix-cache cold write). */
  prefixChanged: boolean;
}

export interface BudgetReport {
  label: string;
  samples: TurnSample[];
  /** Number of summariser model calls the policy would incur across the task. */
  summariserCalls: number;
  /** Number of prefix-cache cold writes (prefix rewrites) the policy would incur. */
  coldWrites: number;
  /** Peak wire size across the whole task (the number that drives worst-case latency + attention). */
  maxWireTokens: number;
  /** Mean wire size across turns. */
  avgWireTokens: number;
  /** Estimated tokens spent feeding the summariser model (sum of summarised spans). */
  summariserInputTokens: number;
}

export interface SimulationInput {
  messages: ApiMsg[];
  contextWindow: number;
  /** Serialized tool schemas token count (constant per round) — added to every wire size for realism. */
  schemaTokens?: number;
  candidates: BudgetCandidate[];
  /**
   * Assumed compression ratio of the summariser (summary tokens ÷ covered tokens). Labelled estimate,
   * used only to synthesise a summary body of realistic length so freeze/reuse cadence is faithful.
   */
  assumedCompression?: number;
}

/** Build a synthetic summary string of approximately `tokens` tokens (each "x " ≈ 1 token in cl100k). */
function synthSummary(tokens: number): string {
  const n = Math.max(1, Math.min(4000, Math.round(tokens)));
  return new Array(n).fill("x").join(" ");
}

/** Indices of every user message (turn boundaries). */
function userTurnIndices(messages: ApiMsg[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") idx.push(i);
  return idx;
}

/**
 * Replay a whole conversation through one budget candidate, turn by turn, mirroring how maybeCompact
 * freezes a plan at each turn start and reuses the previous summary while the boundary is stable.
 */
function simulateOne(input: SimulationInput, cand: BudgetCandidate): BudgetReport {
  const { messages, contextWindow } = input;
  const schemaTokens = input.schemaTokens ?? 0;
  const compression = input.assumedCompression ?? 0.2;
  const turns = userTurnIndices(messages);

  let prev: CompactionState | null = null;
  let prevFrozenSig = "";
  let summariserCalls = 0;
  let coldWrites = 0;
  let summariserInputTokens = 0;
  const samples: TurnSample[] = [];

  for (let t = 0; t < turns.length; t++) {
    const startCut = turns[t] + 1; // include this turn's user message
    const endCut = t + 1 < turns.length ? turns[t + 1] : messages.length;
    const startSnap = messages.slice(0, startCut);
    const endSnap = messages.slice(0, endCut);
    const startBase = countMessagesTokens(startSnap); // counted once, reused as currentTokens below
    const startTokens = startBase + schemaTokens;
    const peakRawTokens = countMessagesTokens(endSnap) + schemaTokens;

    const res = planCompaction(startSnap, {
      contextWindow,
      currentTokens: startBase,
      prev,
      triggerTokens: cand.triggerTokens,
      targetTokens: cand.targetTokens,
    });

    let state: CompactionState | null = null;
    let summarised = false;
    if (res) {
      const { plan, summarizeMessages } = res;
      let summaryText: string | null = null;
      if (plan.coversCount > 0) {
        if (prev?.summaryText && prev.coversCount === plan.coversCount) {
          summaryText = prev.summaryText; // reuse — no summariser call (mirrors maybeCompact)
        } else {
          const covered = countMessagesTokens(summarizeMessages);
          summaryText = synthSummary(covered * compression);
          summariserCalls++;
          summariserInputTokens += covered;
          summarised = true;
        }
      }
      state = { ...plan, summaryText };
    }
    // res === null → below threshold: maybeCompact clears compaction (no manual state in a replay),
    // so state stays null and the next turn starts from an uncompressed prefix, exactly like production.

    // Peak wire = the heaviest point of the turn: this turn's full tool spew under the frozen plan.
    const wire = buildWireContext(endSnap, state);
    const peakWireTokens = countMessagesTokens(wire) + schemaTokens;

    // Prefix-cache cold write: did the frozen prefix (summary + stubs + coversCount) change?
    const sig = state
      ? `${state.coversCount}:${state.summaryText?.length ?? 0}:${state.stubs.size}`
      : "none";
    const prefixChanged = sig !== prevFrozenSig;
    if (prefixChanged && sig !== "none") coldWrites++;
    prevFrozenSig = sig;

    samples.push({ turn: t + 1, startTokens, peakRawTokens, peakWireTokens, summarised, prefixChanged });
    prev = state;
  }

  const wires = samples.map((s) => s.peakWireTokens);
  return {
    label: cand.label,
    samples,
    summariserCalls,
    coldWrites,
    maxWireTokens: wires.length ? Math.max(...wires) : 0,
    avgWireTokens: wires.length ? Math.round(wires.reduce((a, b) => a + b, 0) / wires.length) : 0,
    summariserInputTokens,
  };
}

export interface SimulationResult {
  turns: number;
  contextWindow: number;
  schemaTokens: number;
  /** Deterministic dedup-only reclaim across the full conversation (no model call needed). */
  dedupReclaimTokens: number;
  /** Bucket breakdown of the final full conversation (no compaction). */
  finalBreakdown: ContextBreakdown;
  reports: BudgetReport[];
}

/**
 * Run the offline replay across all candidates. Returns decision-relevant numbers only; the caller
 * (a dev harness / console) formats them. Assumption-light: working-set curve, summariser cadence and
 * dedup reclaim are exact; wire sizes under summarisation use the labelled `assumedCompression`.
 */
export function simulateBudgets(input: SimulationInput): SimulationResult {
  // Memoize tokenization for the whole run: planCompaction / buildWireContext / describeContext all
  // re-count the same message strings across every candidate and turn, which is what made a naive
  // replay re-tokenize the full conversation hundreds of times (a multi-minute main-thread freeze).
  setTokenCache(true);
  try {
    const { messages, contextWindow } = input;
    const calls = indexCalls(messages);
    const hasSystem = messages[0]?.role === "system";
    const dedupStubs = computeStaleStubs(messages, calls, hasSystem ? 1 : 0);
    const dedupReclaimTokens =
      countMessagesTokens(messages) - countMessagesTokens(applyStubs(messages, dedupStubs));

    return {
      turns: userTurnIndices(messages).length,
      contextWindow,
      schemaTokens: input.schemaTokens ?? 0,
      dedupReclaimTokens,
      finalBreakdown: describeContext(messages, undefined),
      reports: input.candidates.map((c) => simulateOne(input, c)),
    };
  } catch (e) {
    console.error("simulateBudgets failed", e);
    throw e;
  } finally {
    setTokenCache(false); // clear the cache so it never lingers on the normal (production) path
  }
}

/** Default candidate set: current window-relative behaviour plus a spread of absolute budgets. */
export function defaultBudgetCandidates(contextWindow: number): BudgetCandidate[] {
  const rel = (label: string) => ({ label }); // window-relative (current prod)
  const abs = (k: number): BudgetCandidate => ({
    label: `${k}K budget`,
    triggerTokens: Math.min(contextWindow * COMPACT_TRIGGER_PCT, k * 1000),
    targetTokens: Math.min(contextWindow * COMPACT_TARGET_PCT, Math.round(k * 1000 * 0.65)),
  });
  return [rel("current (window-relative)"), abs(40), abs(60), abs(80), abs(120)];
}

/** Human-readable one-line-per-turn + per-budget summary, for console / dev output. */
export function formatSimulation(r: SimulationResult): string {
  const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
  const lines: string[] = [];
  lines.push(
    `Conversation: ${r.turns} turns · window ${k(r.contextWindow)} · tool schemas ${k(r.schemaTokens)}`,
  );
  const b = r.finalBreakdown;
  lines.push(
    `Final buckets — system ${k(b.system)} · schemas ${k(r.schemaTokens)} · history ${k(b.history)} · ` +
      `tool outputs ${k(b.toolOutputs)} · subagent ${k(b.subagentOutputs)} · messages-total ${k(b.total)}`,
  );
  lines.push(`Dedup-only reclaim (deterministic): ${k(r.dedupReclaimTokens)} · redundant re-reads: ${b.rereads}`);
  lines.push("");
  lines.push(
    `${"budget".padEnd(26)} ${"maxWire".padStart(9)} ${"avgWire".padStart(9)} ${"summarise".padStart(10)} ${"coldWrites".padStart(11)} ${"sumInput".padStart(9)}`,
  );
  for (const rep of r.reports) {
    lines.push(
      `${rep.label.padEnd(26)} ${k(rep.maxWireTokens).padStart(9)} ${k(rep.avgWireTokens).padStart(9)} ` +
        `${String(rep.summariserCalls).padStart(10)} ${String(rep.coldWrites).padStart(11)} ${k(rep.summariserInputTokens).padStart(9)}`,
    );
  }
  return lines.join("\n");
}
