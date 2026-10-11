"use client";

import { useEffect, useRef, useState } from "react";
import type { DisplayMsg } from "../types";
import type { ViewToken } from "../transcript/displayBaseline";

export interface ChatDisplay {
  display: DisplayMsg[];
  setDisplay: React.Dispatch<React.SetStateAction<DisplayMsg[]>>;
  /** Synchronous mirror of `display`, for code that cannot wait for a re-render (see the declaration). */
  displayRef: React.RefObject<DisplayMsg[]>;
  /** Which transcript `displayRef` currently holds — whose it is, and which rebuild of it. */
  viewTokenRef: React.RefObject<ViewToken>;
  /** Adopt a transcript as `owner`'s: called wherever the whole display array is replaced. */
  adoptDisplay: (owner: string | null) => void;
  pushDisplay: (m: DisplayMsg) => void;
  /** Replace one already-pushed display entry, matched by object identity, keeping its position. */
  replaceDisplay: (target: DisplayMsg, next: DisplayMsg) => void;
  /** Finish an in-flight bubble: replace it if it is still there, append it if it is not. */
  completeDisplay: (target: DisplayMsg, next: DisplayMsg) => void;
  /** Attach the archive index to the last assistant display entry, so it can be rated and persisted. */
  tagLastAssistantStoredIndex: (idx: number) => void;
}

/**
 * Owns the transcript on screen: the `display` array, its synchronous mirror, and the token saying whose it is.
 *
 * Every write to the transcript goes through here or through `setDisplay` directly, and each writer keeps the
 * mirror in step — the send loop reads `displayRef` synchronously to rebuild a round from its baseline, so a
 * mirror that lagged behind the state would wipe rows that had already been drawn.
 */
export function useChatDisplay(): ChatDisplay {
  const [display, setDisplay] = useState<DisplayMsg[]>([]);
  // A synchronous mirror of the display array: lets streaming rendering synchronously read "the display baseline before this round started" as increments arrive,
  // without waiting for a setState re-render. Every entry point that writes display updates it synchronously (pushDisplay / loadConversation / streaming rendering).
  const displayRef = useRef<DisplayMsg[]>([]);
  /**
   * Which transcript `displayRef` currently holds — whose it is, and which rebuild of it.
   *
   * `convIdRef` cannot answer that. It moves the instant the user clicks another conversation, while the
   * transcript is rebuilt one `await` later inside swapInConversation, so between the two an in-flight round
   * sees `active() === true` over a display that is still the previous conversation's. That window is what
   * blanked the transcript when a background round was switched back to; see displayBaseline.ts.
   *
   * The epoch is bumped only where the display is REPLACED wholesale (a switch, a new conversation, a cleared
   * one). A round appending its own rows must NOT bump it, or the baseline would be re-taken from a display
   * that already contains those rows and grow on every delta.
   */
  const viewTokenRef = useRef<ViewToken>({ owner: null, epoch: 0 });
  /** Adopt a transcript as `owner`'s: called wherever the whole display array is replaced. */
  const adoptDisplay = (owner: string | null) => {
    viewTokenRef.current = { owner, epoch: viewTokenRef.current.epoch + 1 };
  };

  const pushDisplay = (m: DisplayMsg) => {
    // Key: update the mirror synchronously. A setState updater function only runs at React flush, so if the mirror is only updated in there, within this synchronous stack
    // the mirror is still the old value — the next send loop capturing the baseline with `liveBase = displayRef.current` would miss the tool bubble just pushed,
    // and then renderTurn rebuilding from the stale baseline would "wipe" it (manifesting as: the bubble flashes then disappears). So update the mirror once synchronously here first.
    displayRef.current = [...displayRef.current, m];
    // Still write React state with a functional update (taking the latest state as authoritative), preserving concurrent updates like choice cards; re-align the mirror to the latest state at flush.
    setDisplay((d) => {
      const next = [...d, m];
      displayRef.current = next;
      return next;
    });
  };
  /** Replace one already-pushed display entry, matched by object identity, keeping its position.
   *  Used to grow a bubble in place while it is still running (a sub-agent appending its steps), which
   *  push/pop cannot express. Mirrors pushDisplay's synchronous-mirror-then-setState discipline for the
   *  same reason: the send loop reads displayRef synchronously to rebuild from a baseline. */
  const replaceDisplay = (target: DisplayMsg, next: DisplayMsg) => {
    const swap = (d: DisplayMsg[]) => d.map((x) => (x === target ? next : x));
    displayRef.current = swap(displayRef.current);
    setDisplay((d) => {
      const n = swap(d);
      displayRef.current = n;
      return n;
    });
  };
  /**
   * Finish an in-flight bubble: replace it if it is still there, append it if it is not.
   *
   * `replaceDisplay` matches by object identity and is a silent no-op when the target has gone — correct for a
   * delegation growing its steps, where a lost update costs one stale row. It is the wrong shape for completing
   * a tool call: the display list is rebuilt from a baseline on every streamed delta, so a bubble pushed before
   * a call can legitimately be absent by the time the call returns, and a no-op there would strand the row as
   * permanently "running" AND drop the result with it.
   *
   * Appending is the right fallback because the result is the thing that matters; its position is not.
   */
  const completeDisplay = (target: DisplayMsg, next: DisplayMsg) => {
    if (displayRef.current.includes(target)) {
      replaceDisplay(target, next);
      return;
    }
    pushDisplay(next);
  };
  // Fallback: after any other setDisplay path (choice-card updates, etc.) renders, sync the mirror, to avoid the mirror lagging behind the state.
  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  // Attach the archive index to the "last assistant display entry" (called after this conversation's just-generated final reply is persisted), so it can be rated and persisted.
  const tagLastAssistantStoredIndex = (idx: number) => {
    setDisplay((d) => {
      const copy = [...d];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].kind === "assistant") {
          copy[i] = { ...copy[i], storedIndex: idx } as DisplayMsg;
          break;
        }
      }
      displayRef.current = copy;
      return copy;
    });
  };

  return {
    display,
    setDisplay,
    displayRef,
    viewTokenRef,
    adoptDisplay,
    pushDisplay,
    replaceDisplay,
    completeDisplay,
    tagLastAssistantStoredIndex,
  };
}
