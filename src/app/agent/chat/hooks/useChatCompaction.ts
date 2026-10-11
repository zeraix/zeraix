"use client";

import { useRef, useState } from "react";
import type { StoredCompaction } from "@/lib/ai/conversation";
import type { TFunc } from "@/lib/i18n";
import { deserializeCompaction, type CompactionState } from "../context/contextCompress";
import {
  countSentTokens,
  createCompaction,
  type CachedCompaction,
  type CompactionApi,
  type CompactionDeps,
} from "../context/chatCompaction";
import type { TaskMemory } from "../context/taskMemory";
import type { ApiMsg } from "../types";

export interface ChatCompaction extends CompactionApi {
  /** Whether the current conversation's wire context is compacted (drives the "compacted" badge). */
  compacted: boolean;
  /** Manual compaction in progress. */
  compacting: boolean;
  /** The compaction plan of the conversation on screen; null means not compacted. */
  compactionRef: React.RefObject<CompactionState | null>;
  /** History changed or went away: drop the plan and the manual flag. Does not persist — callers that must, do. */
  resetCompaction: () => void;
  /** A conversation was opened: restore its plan from the session cache, then the disk, then an estimate. */
  restoreCompaction: (convId: string, conv: { compaction?: StoredCompaction }) => void;
}

/**
 * Owns the conversation-on-screen's compaction state, and binds chatCompaction.ts's operations to it.
 *
 * The decisions themselves (when to fold, what to keep, which conversation a late result belongs to) are all in
 * chatCompaction.ts; this hook only holds the state those decisions read and write, which is why `convoRef` and
 * the usage mirrors arrive from outside — they are owned elsewhere and merely read or written here.
 */
export function useChatCompaction({
  t,
  activeModel,
  loading,
  convIdRef,
  convoRef,
  setCtxTokens,
  contextTokensRef,
  summarizeHistory,
  taskMemoryFor,
  setTaskMemoryFor,
}: {
  t: TFunc;
  activeModel: CompactionDeps["activeModel"];
  loading: boolean;
  convIdRef: React.RefObject<string | null>;
  convoRef: React.RefObject<ApiMsg[]>;
  setCtxTokens: (n: number) => void;
  contextTokensRef: React.RefObject<number>;
  summarizeHistory: CompactionDeps["summarizeHistory"];
  taskMemoryFor: (convId: string | null) => TaskMemory;
  setTaskMemoryFor: (convId: string | null, tm: TaskMemory) => void;
}): ChatCompaction {
  // Context compaction state: the compaction plan frozen at the start of each round (including the history summary text); null means not compacted, wire view == full conversation.
  const compactionRef = useRef<CompactionState | null>(null);
  // The user's manual "compact now" flag: once set, the generated compaction is kept even if usage falls back below the threshold (not auto-cleared).
  const manualCompactRef = useRef(false);
  // Whether the current conversation's wire context is compacted (only drives the "compacted" badge, does not display counts).
  const [compacted, setCompacted] = useState(false);
  const [compacting, setCompacting] = useState(false); // Manual compaction in progress, disable the button
  // Session-level compaction cache (only for this run session, not persisted): the summary is a runtime artifact; used to restore compaction when switching away and back to the same conversation,
  // avoiding "compaction lost after switching, progress bar bouncing back to the uncompressed size". key = conversation id.
  const compactionCacheRef = useRef<Map<string, CachedCompaction>>(new Map());

  // ── Context compaction ────────────────────────────────────────────────────────────────
  // Folding old turns into a summary, and the wire view that results. See chatCompaction.ts — the whole
  // cluster moved there, including the disk snapshot, because every part of it is about the same decision.
  //
  // Built on every render for the same reason createChatRequest is (see the page), and exempt for the same
  // reason: the factory itself reads none of what it is handed. `compactNow` is wired to a button, so this cannot
  // be deferred into the turn the way the delegation and renderer tables are.
  const { snapshotCompaction, persistCompaction, maybeCompact, compactNow } =
    // eslint-disable-next-line react-hooks/refs
    createCompaction({
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
    });

  /**
   * Plan and freeze compaction at the start of each round (or manually). force=true is the manual "compact now", which ignores the threshold and compacts as much as possible.
   * Reuse memory: if a summary with the same coversCount already exists (history is append-only, so the earlier prefix is unchanged), reuse it directly, to avoid re-summarizing every round.
   */
  /**
   * Commit a computed compaction plan to the conversation it belongs to.
   *
   * The summariser call inside maybeCompact can take seconds, and the user can switch conversations while it runs. By then
   * compactionRef / convoRef belong to a DIFFERENT conversation, so writing them would give that conversation this one's plan and
   * persist it under its id. When the round is no longer the active view, the plan goes to the per-conversation cache (which
   * loadConversation restores from) and to disk under the round's own id instead, and the live refs and UI state are left alone.
   */

  const resetCompaction = () => {
    compactionRef.current = null;
    manualCompactRef.current = false;
    setCompacted(false);
  };

  const restoreCompaction = (id: string, conv: { compaction?: StoredCompaction }) => {
    // Restore the compaction state, to avoid "compaction lost, progress bar bouncing back to the uncompressed size" after switching back / reopening. Prefer the session-level cache
    // (the latest within this run), then the disk snapshot (across restarts). If neither exists, start from uncompressed (rebuilt on demand on the first send).
    const cached = compactionCacheRef.current.get(id);
    const fromDisk = conv.compaction
      ? {
          state: deserializeCompaction(conv.compaction),
          manual: conv.compaction.manual,
          compacted: conv.compaction.compacted,
          ctxTokens: conv.compaction.ctxTokens,
        }
      : null;
    const restored = cached ?? fromDisk;
    if (restored) {
      compactionRef.current = restored.state;
      manualCompactRef.current = restored.manual;
      setCompacted(restored.compacted);
      setCtxTokens(restored.ctxTokens);
    } else {
      compactionRef.current = null;
      manualCompactRef.current = false;
      setCompacted(false);
      // No cache: estimate usage from the current conversation size, so the progress bar has a value immediately (refreshed with the provider's exact value on the next send).
      setCtxTokens(countSentTokens(convoRef.current, activeModel));
    }
  };

  return {
    compacted,
    compacting,
    compactionRef,
    snapshotCompaction,
    persistCompaction,
    maybeCompact,
    compactNow,
    resetCompaction,
    restoreCompaction,
  };
}
