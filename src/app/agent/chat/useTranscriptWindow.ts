"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayMsg } from "./types";

/**
 * Transcript windowing. A long conversation used to mount every message at once — hundreds of markdown /
 * code-highlight subtrees in one commit, which stalls opening the conversation and makes every subsequent
 * re-render (each streaming token flushes `display`) walk the whole list. Only the tail is mounted; earlier
 * turns are added in batches as the user scrolls up. `display` itself still holds the full transcript — it is
 * the display source of truth and message indices must stay absolute — this only bounds what reaches the DOM.
 */
const INITIAL_VISIBLE_TURNS = 5; // Turns mounted when a conversation is opened
const LOAD_MORE_TURNS = 5; // Turns added per "load earlier" step

/** How close to the bottom still counts as "pinned", in pixels. */
const SCROLL_BOTTOM_THRESHOLD = 48;

/**
 * Index in `display` where the last `turns` user messages begin (a "turn" = a user message plus everything the
 * assistant produced in response). Returns 0 when the transcript holds fewer than `turns` of them, i.e. the
 * whole thing is already visible. Because the result always lands on a user message (or 0), the window never
 * splits a run of tool/reasoning entries that ProcessGroup collapses into one card.
 */
function startOfLastTurns(display: DisplayMsg[], turns: number): number {
  let seen = 0;
  for (let i = display.length - 1; i >= 0; i--) {
    if (display[i].kind === "user" && ++seen >= turns) return i;
  }
  return 0;
}

/** Index where the `turns` user messages immediately preceding `before` begin (0 once the start is reached). */
function startOfTurnsBefore(display: DisplayMsg[], before: number, turns: number): number {
  let seen = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (display[i].kind === "user" && ++seen >= turns) return i;
  }
  return 0;
}

/**
 * Layout effect that is safe to prerender. This project builds with `output: "export"`, so client components are
 * rendered on the server at build time, where useLayoutEffect does nothing and React says so on the console.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface TranscriptWindow {
  /** The scrolling viewport. Handed to CustomScrollbar. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The "reveal earlier turns" sentinel, mounted at the top of the window by ChatTranscript. */
  earlierSentinelRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Synchronous read of "follow new content when it arrives". Separate from `atBottom` on purpose: the
   * follow decision is made in event handlers and in `send`, where async state is a round too late.
   */
  atBottomRef: React.RefObject<boolean>;
  /** Drives the "back to bottom" button's visibility. */
  atBottom: boolean;
  /** Scroll handler for the viewport. */
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Scroll to the bottom and resume auto-follow. */
  scrollToBottom: (smooth?: boolean) => void;
  /** Resume auto-follow without moving the viewport (the next append scrolls it). */
  pinToBottom: () => void;
  /**
   * Back to the tail-only window, pinned to the bottom. What every reset path wants: a new conversation, a
   * cleared one, and a conversation switched in all open showing their last turns and following from there.
   */
  resetView: () => void;
  /** Index in `display` where the mounted window starts. */
  visibleStart: number;
  /** Whether anything is hidden above the window. */
  hasEarlier: boolean;
  /** Reveal the previous batch of turns. */
  loadEarlier: () => void;
}

/**
 * Owns the transcript's scroll position and how much of `display` is mounted.
 *
 * `display` and `displayRef` are read-only here: this hook never writes the transcript, it only decides which
 * slice of it reaches the DOM and where the viewport sits. `loading` is a dependency of the auto-follow effect
 * alone — the generation state changes the container's height (the status row appears and disappears) without
 * changing `display`.
 */
export function useTranscriptWindow(
  display: DisplayMsg[],
  loading: boolean,
  displayRef: React.RefObject<DisplayMsg[]>,
): TranscriptWindow {
  const scrollRef = useRef<HTMLDivElement>(null);
  const earlierSentinelRef = useRef<HTMLDivElement>(null);

  // Auto-scroll follow: pinned to the bottom by default. If the user manually scrolls up while generating → pause auto-scroll and surface a "back to bottom" button; scrolling back to the bottom resumes it.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Transcript window: how far back into `display` the DOM currently reaches. An absolute index rather than a
  // "how many turns" count, so that appending to the tail (streaming, a new send) does not push already-revealed
  // history back out of view — indices of earlier entries are stable, every write to `display` is tail-only.
  // MAX_SAFE_INTEGER = "not expanded", meaning just the initial tail. Reset on conversation switch / clear.
  const [historyAnchor, setHistoryAnchor] = useState(Number.MAX_SAFE_INTEGER);
  // Distance from the bottom to preserve across a "load earlier" expansion, handed to the layout effect below.
  const scrollAnchorRef = useRef<number | null>(null);

  const isAtBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  };

  // Scroll listener: update "whether pinned to the bottom". Manual scroll-up while generating → pause auto-scroll, show the button; scroll back to the bottom → resume.
  const onScroll = () => {
    const near = isAtBottom();
    atBottomRef.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  };

  // Back to bottom: smoothly scroll to the bottom and resume auto-follow (used by the "back to bottom" button and when sending / loading a conversation).
  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const pinToBottom = () => {
    atBottomRef.current = true;
    setAtBottom(true);
  };

  const resetView = () => {
    setHistoryAnchor(Number.MAX_SAFE_INTEGER);
    pinToBottom();
  };

  // Auto-scroll to the bottom: only follow new content / generation state while the user is currently pinned to the bottom; after a manual scroll-up, stop bothering them until they scroll back to the bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [display, loading]);

  // Where the mounted window starts. min(anchor, tail) does double duty: it keeps expanded history expanded, and it
  // re-clamps after a truncation (edit / regenerate drops the tail, which can leave the anchor past the end) so the
  // last turns are always mounted no matter what happened to `display`.
  const visibleStart = useMemo(
    () => Math.min(historyAnchor, startOfLastTurns(display, INITIAL_VISIBLE_TURNS)),
    [display, historyAnchor],
  );
  const hasEarlier = visibleStart > 0;

  // Reveal the previous batch of turns. The container grows above the viewport, so record the distance from the
  // bottom first and restore it once the new nodes are laid out — otherwise the browser keeps scrollTop and the
  // view jumps backwards by the height of everything just inserted.
  const loadEarlier = useCallback(() => {
    if (visibleStart <= 0) return;
    const el = scrollRef.current;
    scrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setHistoryAnchor(startOfTurnsBefore(displayRef.current, visibleStart, LOAD_MORE_TURNS));
  }, [visibleStart, displayRef]);

  // Restore the scroll position against the taller content, before the browser paints the expanded list.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const keep = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (el && keep != null) el.scrollTop = el.scrollHeight - keep;
  }, [visibleStart]);

  // Scrolling up to the sentinel pulls in the next batch. Guarded on the container actually being scrollable:
  // a transcript shorter than the viewport has its sentinel permanently in view, and auto-expanding there would
  // walk the whole history on open — exactly what the window exists to prevent. The button covers that case.
  useEffect(() => {
    const node = earlierSentinelRef.current;
    if (!node || !hasEarlier) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const el = scrollRef.current;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        loadEarlier();
      },
      { root: scrollRef.current, rootMargin: "200px 0px 0px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasEarlier, loadEarlier]);

  return {
    scrollRef,
    earlierSentinelRef,
    atBottomRef,
    atBottom,
    onScroll,
    scrollToBottom,
    pinToBottom,
    resetView,
    visibleStart,
    hasEarlier,
    loadEarlier,
  };
}
