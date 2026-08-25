/**
 * Context compaction — deciding what the model still gets to see.
 *
 * A conversation outgrows any window eventually. Compaction is the answer: fold the oldest turns into a
 * summary, dedup repeated reads, and send the wire view instead of the whole buffer. What makes it delicate
 * is not the folding but the PREFIX CACHE — every request re-prefills from the first byte that changed, so a
 * summary that is regenerated when it did not have to be costs more than the tokens it saved. Hence the
 * frozen boundary, the reuse counter, and the byte-stability rules described inline below and in
 * docs/context-compression.md.
 *
 * Three things this module must never get wrong, all of them about WHICH conversation it is acting on:
 *
 *  - the target is captured before the first await. The summariser call takes seconds and the user can
 *    switch conversations inside that window, so anything read afterwards belongs to a different chat;
 *  - a background round persists through an explicit snapshot rather than through `compactionRef`, which by
 *    then describes whatever the user switched TO;
 *  - only the conversation actually on screen may move the context bar.
 *
 * The dependency list is wide, and honestly so: compaction reads the buffer, writes the compaction state,
 * touches Task Memory when the summariser extracts a brief, and drives two pieces of UI. That is the real
 * coupling, not an artefact of the split — narrowing the interface here would mean hiding it.
 */
import { toast } from "sonner";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { resolveContextWindow } from "@/lib/ai/models";
import { countMessagesTokens } from "@/lib/ai/tokenizer";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { StoredCompaction } from "@/lib/ai/conversation";
import type { TFunc } from "@/lib/i18n";
import {
  buildWireContext,
  compactionSavings,
  planCompaction,
  resolveHybridBudget,
  serializeCompaction,
  MANUAL_COMPACT_MIN_PCT,
  MAX_SUMMARY_REUSE,
  type CompactionState,
} from "./contextCompress";
import { mergeExtracted, type ExtractedTaskState, type TaskMemory } from "./taskMemory";
import type { ApiMsg, RequestLog } from "./types";

/** One conversation's compaction snapshot, as held in the session cache. */
export interface CachedCompaction {
  state: CompactionState | null;
  manual: boolean;
  compacted: boolean;
  ctxTokens: number;
}

export interface CompactionApi {
  /** Save the current conversation's state into the session cache before switching away. */
  snapshotCompaction: (convId: string | null) => void;
  /** Write the snapshot to disk, so reopening does not re-summarise. */
  persistCompaction: (
    convId: string | null,
    explicit?: { state: CompactionState | null; manual: boolean; ctxTokens: number },
  ) => void;
  /** The automatic path, called once per round; returns the state the round should send with. */
  maybeCompact: (opts?: {
    force?: boolean;
    signal?: AbortSignal;
    log?: RequestLog;
    messages?: ApiMsg[];
    convId?: string | null;
  }) => Promise<CompactionState | null>;
  /** The manual "compact now" button. */
  compactNow: () => Promise<void>;
}

export interface CompactionDeps {
  t: TFunc;
  /** Read for the context window only; compaction is meaningless without one. */
  activeModel: { model?: string; contextWindow?: number } | null;
  /** Live UI state, read at click time by the manual path. */
  compacting: boolean;
  loading: boolean;
  /** Mirrors the `compacted` flag into the session cache; a value, because the snapshot is of this render. */
  compacted: boolean;
  setCompacted: (v: boolean) => void;
  setCompacting: (v: boolean) => void;
  setCtxTokens: (n: number) => void;
  /**
   * Mutable boxes rather than accessors: unlike the read-only factories elsewhere in this page, compaction
   * WRITES three of these (the state, the manual flag, the cache). Handing over the ref is the honest shape
   * for that; an accessor pair would only disguise it.
   */
  convIdRef: { current: string | null };
  convoRef: { current: ApiMsg[] };
  compactionRef: { current: CompactionState | null };
  compactionCacheRef: { current: Map<string, CachedCompaction> };
  manualCompactRef: { current: boolean };
  contextTokensRef: { current: number };
  summarizeHistory: (
    messages: ApiMsg[],
    signal?: AbortSignal,
    log?: RequestLog,
    priorSummary?: string | null,
  ) => Promise<{ summary: string; extracted: ExtractedTaskState | null }>;
  taskMemoryFor: (convId: string | null) => TaskMemory;
  setTaskMemoryFor: (convId: string | null, tm: TaskMemory) => void;
}

export function createCompaction(deps: CompactionDeps): CompactionApi {
  const {
    t,
    activeModel,
    compacting,
    loading,
    compacted,
    setCompacted,
    setCompacting,
    setCtxTokens,
    convIdRef,
    convoRef,
    compactionRef,
    compactionCacheRef,
    manualCompactRef,
    contextTokensRef,
    summarizeHistory,
    taskMemoryFor,
    setTaskMemoryFor,
  } = deps;

  /** Snapshot the current conversation's compaction state into the session-level cache, to restore when switching back later (the fast path within this run). */
  const snapshotCompaction = (convId: string | null) => {
    if (!convId) return;
    compactionCacheRef.current.set(convId, {
      state: compactionRef.current,
      manual: manualCompactRef.current,
      compacted,
      ctxTokens: contextTokensRef.current,
    });
  };

  /**
   * Persist the current conversation's compaction snapshot to disk (so compaction can be restored after close and reopen, without re-summarizing).
   * compaction is not part of the integrity hash (see canonical.ts), so it does not trigger re-signing, and the existing signature stays valid.
   * Called after every change to the compaction state (auto-compaction on send / manual "compact now" / clearing on falloff), keeping the disk always current.
   */
  const persistCompaction = (
    convId: string | null,
    // Explicit state for a round whose conversation is no longer the active view: compactionRef belongs to
    // whatever the user switched TO, so a background round must pass its own.
    explicit?: { state: CompactionState | null; manual: boolean; ctxTokens: number },
  ) => {
    if (!convId) return;
    const state = explicit ? explicit.state : compactionRef.current;
    let stored: StoredCompaction | null = null;
    if (state) {
      const s = compactionSavings(state);
      stored = {
        ...serializeCompaction(state),
        manual: explicit ? explicit.manual : manualCompactRef.current,
        compacted: s.summarizedTurns > 0 || s.dedupedReads > 0,
        ctxTokens: explicit ? explicit.ctxTokens : contextTokensRef.current,
      };
    }
    useAgentChatStore.getState().setConversationCompaction(convId, stored);
  };

  const commitCompaction = (convId: string | null, state: CompactionState | null) => {
    const savings = state ? compactionSavings(state) : null;
    const compactedNow = !!savings && (savings.summarizedTurns > 0 || savings.dedupedReads > 0);
    if (convId && convId !== convIdRef.current) {
      const cached = convId ? compactionCacheRef.current.get(convId) : undefined;
      const ctxTokens = cached?.ctxTokens ?? 0;
      const manual = cached?.manual ?? false;
      compactionCacheRef.current.set(convId, { state, manual, compacted: compactedNow, ctxTokens });
      persistCompaction(convId, { state, manual, ctxTokens });
      return;
    }
    compactionRef.current = state;
    setCompacted(compactedNow);
    persistCompaction(convId);
  };

  const maybeCompact = async (
    opts: {
      force?: boolean;
      signal?: AbortSignal;
      log?: RequestLog;
      /** The round's own buffer and conversation, captured before any await. Omitted → the active view (manual "compact now"). */
      messages?: ApiMsg[];
      convId?: string | null;
    } = {},
  ): Promise<CompactionState | null> => {
    // Both captured before the first await: everything below must act on the conversation this round started in.
    const targetConvId = opts.convId !== undefined ? opts.convId : convIdRef.current;
    const full = opts.messages ?? convoRef.current;
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    const currentTokens = countMessagesTokens(full);
    // Hybrid working-set budget: cap the trigger/target at an absolute token budget (configurable in
    // Settings → General, default 120K, 0 = off) so a large-window model can't defer compaction until
    // it has hoarded hundreds of thousands of tokens. null when disabled → original window-relative path.
    const budget = resolveHybridBudget(cw, getContextBudgetK());
    // prev: pass in the previous compaction state so planCompaction "freezes the boundary" — reuse the old summary boundary until the tail again
    // exceeds the threshold; if coversCount is stable, the old summary body is reused below, so the post-compaction prefix is byte-stable and hits the prefix cache (§4.1).
    const res = planCompaction(full, {
      contextWindow: cw,
      currentTokens,
      force: opts.force,
      prev: compactionRef.current,
      triggerTokens: budget?.triggerTokens,
      targetTokens: budget?.targetTokens,
    });
    if (!res) {
      // Below the threshold: if it is not a manual compaction, clear it (wire view == full conversation, most stable prefix cache); a manual compaction is kept as-is.
      if (!manualCompactRef.current) {
        commitCompaction(targetConvId, null); // Sync to disk after clearing (remove the old snapshot)
        return null;
      }
      return compactionRef.current;
    }
    const { plan, summarizeMessages } = res;
    let summaryText: string | null = null;
    let reuseCount = 0;
    if (plan.coversCount > 0) {
      const prev = compactionRef.current;
      const prevReuse = prev?.reuseCount ?? 0;
      const canReuse = !!prev?.summaryText && prev.coversCount === plan.coversCount;
      if (canReuse && prevReuse < MAX_SUMMARY_REUSE) {
        // Coverage unchanged and under the reuse cap → reuse the old summary (saves a model call), but
        // COUNT it so a slowly-growing conversation can't keep an unverified summary alive forever (§B1).
        summaryText = prev!.summaryText;
        reuseCount = prevReuse + 1;
      } else {
        // Regenerate. Three shapes:
        //  - forced-from-scratch: the reuse cap was hit (canReuse but over MAX) → re-read the FULL covered
        //    span from the verbatim originals, so drift/errors reset (§B1). Planner returned no
        //    summarizeMessages (freeze-reuse signals reuse with an empty list), so reconstruct the span.
        //  - incremental (§8.1): the boundary advanced past a usable prior summary → summarise only
        //    (prior summary + the newly-covered span), avoiding a from-scratch pass over everything.
        //  - first summary: no prior summary → from-scratch of the covered span.
        const hasSystem = full[0]?.role === "system";
        const body = hasSystem ? full.slice(1) : full;
        const prevCovers = prev?.coversCount ?? 0;
        const canIncrement =
          !canReuse && !!prev?.summaryText && prevCovers > 0 && prevCovers < plan.coversCount;
        const toSummarize = canIncrement
          ? body.slice(prevCovers, plan.coversCount) // only the newly-folded messages
          : summarizeMessages.length
            ? summarizeMessages
            : body.slice(0, plan.coversCount); // full covered span (first summary / forced reset)
        const priorSummary = canIncrement ? prev!.summaryText : null;
        try {
          const { summary, extracted } = await summarizeHistory(toSummarize, opts.signal, opts.log, priorSummary);
          summaryText = summary;
          // The guarantee: capture any mission/plan/constraints from the span being discarded into Task
          // Memory, non-destructively. Fills an empty brief or refreshes a prior auto-extracted one (§B2),
          // never clobbering a model-authored brief. See docs/context-memory-tiers-design.md §5.3.
          if (extracted) {
            const convId = opts.log?.convId ?? convIdRef.current;
            const prevTm = taskMemoryFor(convId);
            const merged = mergeExtracted(prevTm, extracted);
            if (merged.notes !== prevTm.notes) setTaskMemoryFor(convId, merged);
          }
        } catch {
          summaryText = null; // Summary failed → fall back to dedup-only (buildWireContext ignores an empty summary)
        }
        reuseCount = 0; // fresh summary
      }
    }
    const next: CompactionState = { ...plan, summaryText, reuseCount };
    if (opts.force) manualCompactRef.current = true;
    commitCompaction(targetConvId, next);
    // Refresh the progress bar immediately: estimate usage from the post-compaction wire size, without waiting for the next
    // request. Only meaningful for the conversation actually on screen — a background round must not move the active view's bar.
    if (!targetConvId || targetConvId === convIdRef.current) {
      setCtxTokens(countMessagesTokens(buildWireContext(full, next)));
    }
    return next;
  };

  /** The manual "compact now" button: compact once ignoring the auto threshold, but disallowed when usage is too low (<20%), reporting the result. */
  const compactNow = async () => {
    if (compacting || loading) return;
    // When usage is below 20% of the window AND below any absolute budget, there is too little content
    // and compaction is meaningless, so reject directly (consistent with the button's disabled condition).
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    const budgetK = getContextBudgetK();
    const overBudget = budgetK > 0 && contextTokensRef.current >= budgetK * 1000;
    if (!overBudget && cw > 0 && contextTokensRef.current / cw < MANUAL_COMPACT_MIN_PCT) {
      toast.message(t("chat.compactMinTitle"));
      return;
    }
    setCompacting(true);
    try {
      await maybeCompact({ force: true });
      const s = compactionSavings(compactionRef.current);
      if (s.summarizedTurns === 0 && s.dedupedReads === 0) {
        toast.message(t("chat.compactTooShort"));
      } else {
        toast.success(t("chat.compactDone"));
      }
    } finally {
      setCompacting(false);
    }
  };

  // commitCompaction is deliberately not exported: it is how maybeCompact installs a result, and letting a
  // caller install one directly would bypass the planning that decides whether there should be one at all.
  return { snapshotCompaction, persistCompaction, maybeCompact, compactNow };
}
