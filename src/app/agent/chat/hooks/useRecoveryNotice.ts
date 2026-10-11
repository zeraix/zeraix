"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { StoredTurnState } from "@/lib/ai/conversation";
import { lastSession } from "@/lib/ai/recovery";
import { describeInterruptedTurn, summarizeInterruptedTurn } from "../turn/turnState";
import type { RecoveryNotice } from "../components/RecoveryBanner";

export interface RecoveryNoticeState {
  /** What the user sees: the banner for the conversation whose last turn was interrupted. */
  recoveryNotice: RecoveryNotice | null;
  dismissRecovery: () => void;
  /** The sentence the model is told on the next send, keyed by conversation. Consumed by that send. */
  pendingRecoveryRef: React.RefObject<Map<string, string>>;
  /** A conversation was opened with a leftover turn checkpoint: arm both the banner and the model's notice. */
  noteInterruptedTurn: (convId: string, interrupted: StoredTurnState) => void;
  /** Mount: read whether the previous app session ended cleanly (C9). Stable. */
  notePriorSession: () => void;
}

/**
 * Owns what the user and the model are told about work a crash cut short (docs/agent-runtime-crash-recovery.md).
 *
 * Two scopes: a conversation's own interrupted turn (C2), announced when that conversation is opened, and the
 * previous app session as a whole (C9), announced once per launch. Nothing here resumes or re-runs anything.
 */
export function useRecoveryNotice({
  t,
}: {
  t: (key: string, vars?: Record<string, string>) => string;
}): RecoveryNoticeState {
  /**
   * The interrupted-turn notice (docs/agent-runtime-crash-recovery.md C2).
   *
   * Set when a conversation is opened with a leftover turn checkpoint, which can only happen if the process died
   * mid-turn. `recoveryNotice` is what the user sees; `pendingRecoveryRef` is the sentence the model is told on the
   * next send, keyed by conversation because a background conversation may be reopened later and must still get its
   * own notice. Both are one-shot: the banner is dismissible and the reminder is emitted once (reminders.ts).
   */
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  const pendingRecoveryRef = useRef<Map<string, string>>(new Map());
  /** Whether the PREVIOUS app session died without a clean shutdown (C9). Announced once by the effect below. */
  const [priorCrash, setPriorCrash] = useState(false);
  const priorCrashToldRef = useRef(false);

  // C9: the previous session left its lock behind, so it died before finishing its teardown. Only the flag is
  // read here — the toast is fired by its own effect below, which can depend on the translator without
  // dragging the page's mount-only block along with it.
  const notePriorSession = useCallback(() => void lastSession().then((prev) => setPriorCrash(prev.unclean)), []);

  // Say it once, quietly, and only after the translator is ready: the actionable detail is per-conversation and
  // arrives as the banner above when an interrupted conversation is opened. Latched, so a language change (which
  // re-runs this effect) does not announce the same crash a second time.
  useEffect(() => {
    if (!priorCrash || priorCrashToldRef.current) return;
    priorCrashToldRef.current = true;
    toast.info(t("chat.recovery.uncleanShutdown"));
  }, [priorCrash, t]);

  const noteInterruptedTurn = (convId: string, interrupted: StoredTurnState) => {
    pendingRecoveryRef.current.set(convId, describeInterruptedTurn(interrupted));
    setRecoveryNotice({ convId, ...summarizeInterruptedTurn(interrupted) });
  };

  return {
    recoveryNotice,
    dismissRecovery: () => setRecoveryNotice(null),
    pendingRecoveryRef,
    noteInterruptedTurn,
    notePriorSession,
  };
}
