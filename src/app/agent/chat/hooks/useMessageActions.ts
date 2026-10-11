"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAgentChatStore } from "@/store/agentChatStore";
import { FEEDBACK_DOWN_NUDGE, FEEDBACK_UP_NUDGE } from "../constants";
import type { ApiMsg, Attachment, DisplayMsg } from "../types";

export interface MessageActions {
  /** Edit a user message and resend from it. Stable. */
  editUser: (displayIndex: number, newText: string) => void;
  /** Regenerate an AI reply, optionally carrying the user's rating of it into the regeneration. Stable. */
  regenerate: (assistantIndex: number, rating?: "up" | "down" | null) => void;
  /** Rate an AI reply (thumbs up / down / clear). Stable. */
  rateMessage: (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => void;
}

/**
 * The actions the transcript offers on a message that has already been sent: edit, regenerate, rate.
 *
 * All three are stable callbacks, because they are handed to the memoized MessageItem; edit and regenerate reach
 * the CURRENT `send` through a ref refreshed after every render.
 */
export function useMessageActions({
  loading,
  convIdRef,
  convoRef,
  displayRef,
  setDisplay,
  attachIdRef,
  feedbackNudgeRef,
  resetCompaction,
  persistCompaction,
  send,
}: {
  loading: boolean;
  convIdRef: React.RefObject<string | null>;
  convoRef: React.RefObject<ApiMsg[]>;
  displayRef: React.RefObject<DisplayMsg[]>;
  setDisplay: React.Dispatch<React.SetStateAction<DisplayMsg[]>>;
  attachIdRef: React.RefObject<number>;
  /** Armed here by a rated regeneration; consumed by the next send. */
  feedbackNudgeRef: React.RefObject<string | null>;
  resetCompaction: () => void;
  persistCompaction: (convId: string | null) => void;
  send: (opts?: { text?: string; attachments?: Attachment[] }) => Promise<void>;
}): MessageActions {
  // Rate an AI reply (thumbs up / down / clear): persist it to the corresponding StoredMessage.rating (not in the hash, does not change content),
  // synchronously update the rating in the in-memory wire buffer (kept for audit; stripWireMetadata removes it before sending), and highlight it in the display.
  // useCallback keeps the reference stable (independent of send / state), to avoid a full re-render of the memoized MessageItem.
  const rateMessage = useCallback(
    (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => {
      const convId = convIdRef.current;
      if (convId && storedIndex != null) {
        useAgentChatStore.getState().setMessageRating(convId, storedIndex, rating);
        // Sync the in-memory wire buffer: archived messages are all non-system, so "the storedIndex-th non-system message in convoRef" corresponds
        // to that StoredMessage — locating by this correctly skips the leading system prompt, which is more robust than index + offset.
        // (Nudges no longer occupy messages of their own — they ride inside existing turns' content — so the only remaining skew
        // is an empty assistant turn, which exists live but is never persisted.)
        // Rebuilt rather than mutated in place: the buffer is read by an in-flight round (which captured it as
        // `roundConvo` before its first await) and by the compaction planner, and editing a message object under
        // them changes what those already-captured arrays contain. Only the rated turn is replaced.
        let seen = -1;
        convoRef.current = convoRef.current.map((cm) => {
          if (cm.role === "system") return cm;
          seen++;
          if (seen !== storedIndex || cm.role !== "assistant") return cm;
          const copy = { ...cm };
          if (rating) copy.rating = rating;
          else delete copy.rating;
          return copy;
        });
      }
      const next = displayRef.current.map((m, i) =>
        i === displayIndex && m.kind === "assistant" ? { ...m, rating: rating ?? undefined } : m,
      );
      displayRef.current = next;
      setDisplay(next);
    },
    [convIdRef, convoRef, displayRef, setDisplay],
  );

  // The implementation of "edit user message / regenerate": updated to the latest closure on every render (capturing the latest send / states),
  // so the stably-referenced regenerate / editUser below call the latest version when clicked (avoiding useCallback capturing a stale send).
  const resendRef = useRef<(displayIndex: number, newText: string, feedbackNudge?: string | null) => void>(() => {});

  // Resend from "the displayIndex-th display message (must be a user message)": truncate this point and everything after it
  // (the display / wire / persistence are aligned by "user message ordinal" — user messages correspond one-to-one across all three), then resend with newText.
  // Shared by "edit user message" (newText = the edited text) and "regenerate" (newText = the original user text).
  const editUser = useCallback((displayIndex: number, newText: string) => {
    resendRef.current(displayIndex, newText);
  }, []);
  // Regenerate an AI reply: trace back to the nearest user message before it and resend from that point with the original text (discarding that round and everything after).
  // rating: the user's rating of the reply being regenerated (up / down) — used to inject a one-time English feedback hint, letting the rating influence this regeneration in real time.
  const regenerate = useCallback((assistantIndex: number, rating?: "up" | "down" | null) => {
    const disp = displayRef.current;
    let userIdx = -1;
    for (let i = Math.min(assistantIndex, disp.length - 1); i >= 0; i--) {
      if (disp[i]?.kind === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const um = disp[userIdx];
    // Armed INSIDE resendRef, after its early returns — not here. resendRef bails when the target text is empty, which happens
    // for an image-only turn, and arming the ref first left it set: the nudge then landed on the user's next, unrelated message.
    // Harmless while nudges were wire-only; permanent now that they are written into the turn and persisted.
    const nudge = rating === "down" ? FEEDBACK_DOWN_NUDGE : rating === "up" ? FEEDBACK_UP_NUDGE : null;
    resendRef.current(userIdx, um.kind === "user" ? um.content : "", nudge);
  }, [displayRef]);

  // Refreshed after every render, for the closure reason given at the declaration above. Assigned in an effect
  // rather than during render: a ref written while rendering is read by whatever rendered first, and React may
  // discard a render entirely. It is only ever called from an event — i.e. after the commit — so binding it
  // post-commit changes nothing about which closure the caller gets.
  useEffect(() => {
    // On every render, refresh the "resend from a user message" implementation, capturing the latest send / state (see the note at the resendRef declaration).
    resendRef.current = (displayIndex, newText, feedbackNudge) => {
      if (loading) return; // Editing / regenerating is not allowed while generating
      if (!newText.trim()) return;
      const disp = displayRef.current;
      const target = disp[displayIndex];
      if (!target || target.kind !== "user") return;
      // Past every early return, so the resend is definitely happening: a nudge armed here cannot leak onto a later message.
      if (feedbackNudge !== undefined) feedbackNudgeRef.current = feedbackNudge;
      // Preserve the images the user originally attached to this message: editing the text or regenerating
      // must not silently drop them. Reconstruct minimal image attachments from the stored image URLs
      // (OSS link for a cloud model, data URI for a local one — both are directly usable as image_url at
      // send time, so no file/hostPath is needed). We deliberately pass ONLY these below, never the
      // input-box's currently staged attachments, so an edit can't merge in unrelated files.
      const keptImages: Attachment[] = (target.images ?? []).map((url, i) => ({
        id: ++attachIdRef.current,
        name: `image-${i + 1}`,
        size: 0,
        kind: "image" as const,
        url,
      }));
      // Which user message this is (1-based): user messages correspond one-to-one across "display / wire / persistence", serving as the alignment anchor.
      let k = 0;
      for (let i = 0; i <= displayIndex; i++) if (disp[i]?.kind === "user") k++;
      if (k === 0) return;
      const convId = convIdRef.current;
      // 1) Truncate the display: remove this user message and everything after it.
      const nextDisplay = disp.slice(0, displayIndex);
      displayRef.current = nextDisplay;
      setDisplay(nextDisplay);
      // 2) Truncate the wire conversation (convoRef): keep up to just before the k-th user message (system is at index 0 and is kept by the slice).
      {
        let seen = 0;
        let cut = convoRef.current.length;
        for (let i = 0; i < convoRef.current.length; i++) {
          if (convoRef.current[i].role === "user") {
            seen++;
            if (seen === k) { cut = i; break; }
          }
        }
        convoRef.current = convoRef.current.slice(0, cut);
      }
      // 3) Truncate the persisted messages: likewise keep up to just before the k-th user StoredMessage.
      if (convId) {
        const msgs = useAgentChatStore.getState().getConversation(convId)?.messages ?? [];
        let seen = 0;
        let cut = msgs.length;
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].role === "user") {
            seen++;
            if (seen === k) { cut = i; break; }
          }
        }
        useAgentChatStore.getState().truncateMessages(convId, cut);
      }
      // History changed: reset context compaction (the old summary may reference deleted rounds), and send will rebuild it on demand.
      resetCompaction();
      persistCompaction(convId);
      // Resend from this point with the new text, re-attaching the original message's images (see keptImages)
      // and nothing else — the input-box's staged attachments are intentionally excluded.
      void send({ text: newText, attachments: keptImages });
    };
  }); // no dependency array: the binding must be refreshed on EVERY render, which is the whole point

  return { editUser, regenerate, rateMessage };
}
