"use client";

import { useRef, useState } from "react";

/** Resolve once the browser has painted, so a state change made just before is actually on screen. */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    // rAF runs *before* the paint, hence the nested timeout. The outer timeout is a ceiling, not a delay (the first
    // resolve wins): rAF is paused while the window is minimised or occluded, and a conversation switch must not
    // hang waiting for a frame that only arrives when the user comes back.
    setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

/** Rebuild the view from a conversation record. `stale` turns true once a newer switch has started. */
export type SwapIn = (id: string, projectId: string | undefined, stale: () => boolean) => Promise<void>;

export interface ConversationSwitch {
  /** A switch is in progress: the message area shows a skeleton instead of the outgoing transcript. */
  switching: boolean;
  /** Open a conversation, with a skeleton in the message area for as long as the swap takes. */
  loadConversation: (id: string, projectId?: string) => Promise<void>;
  /** Abandon an in-flight switch (see the declaration). */
  cancelPendingSwitch: () => void;
}

/**
 * Serialises conversation switches and owns the skeleton shown while one runs.
 *
 * The swap itself — what opening a conversation restores — belongs to the page, which owns everything it touches;
 * it is passed in as `swapIn`, lazily, because it is declared after this hook is called.
 */
export function useConversationSwitch({ swapIn }: { swapIn: SwapIn }): ConversationSwitch {
  // Conversation switch in progress: the message area shows a skeleton instead of the outgoing transcript.
  const [switching, setSwitching] = useState(false);
  // Serialises switches. Clicking through the sidebar starts overlapping loads (the archive read and the
  // working-directory hand-off both await), and whichever finished last used to win regardless of which the user
  // actually asked for. Each load carries a token; once a newer one starts, the older one stops before it commits.
  const switchTokenRef = useRef(0);
  /**
   * Abandon an in-flight conversation switch. Used by the reset paths ("new conversation" / "clear chat"): bumping the
   * token stops the load before it commits, which both keeps it from overwriting the freshly emptied view and — since a
   * stale load deliberately leaves the skeleton alone — is why the flag has to be cleared here rather than by that load.
   */
  const cancelPendingSwitch = () => {
    switchTokenRef.current++;
    setSwitching(false);
  };

  /**
   * Open a conversation, with a skeleton in the message area for as long as the swap takes. The paint yield is what
   * makes the skeleton visible at all: without it the "show skeleton" state and the finished transcript land in the
   * same frame, so the placeholder would never reach the screen even though the swap itself is slow.
   */
  const loadConversation = async (id: string, projectId?: string) => {
    const token = ++switchTokenRef.current;
    const stale = () => switchTokenRef.current !== token;
    setSwitching(true);
    try {
      await afterPaint();
      if (stale()) return;
      await swapIn(id, projectId, stale);
    } finally {
      // Only the newest switch may take the skeleton down — otherwise an overtaken load would clear it while the
      // conversation the user actually clicked is still loading.
      if (!stale()) setSwitching(false);
    }
  };

  return { switching, loadConversation, cancelPendingSwitch };
}
