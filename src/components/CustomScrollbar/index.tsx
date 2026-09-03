'use client'
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { dragScroll, fadeDecision, thumbMetrics } from "./logic";

interface CustomScrollbarProps {
  children: React.ReactNode;
  config?: {
    thumbWidth?: number;       // Scrollbar thickness
    thumbColorActive?: string; // Color while being dragged
    thumbColor?: string;       // Default color
    alwaysVisible?: boolean;   // Whether to always show the scrollbar
    hideDelay?: number;        // ms without scrolling before the thumb fades out
  },
  /** Scroll event, forwarded to the inner div */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Extra classes for the outer box — how this component sizes itself in its parent's layout. */
  className?: string;
  /** Extra classes for the scrolling element itself (background, padding, flow of the content). */
  viewportClassName?: string;
  /**
   * Receives the scrolling element. The native scroller is this component's own inner div, so a parent that drives
   * scrolling itself (scrollTo, scrollTop/scrollHeight reads, an IntersectionObserver root) needs a handle on it —
   * a ref to the wrapper would be the wrong element and silently do nothing.
   */
  viewportRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * Preset for the app's page-level scroll areas: pinned visible rather than appearing on scroll, and coloured from the
 * theme variables so the thumb reads on the light and the dark surface alike (the plain-black default does not).
 * A module constant, so every call site shares one stable object identity instead of allocating a literal per render.
 */
export const PAGE_SCROLLBAR = {
  alwaysVisible: true,
  thumbWidth: 6,
  thumbColor: "var(--line-strong)",
  thumbColorActive: "var(--ink-subtle)",
} as const;

export default function CustomScrollbar({
  children,
  config,
  onScroll,
  className,
  viewportClassName,
  viewportRef,
}: CustomScrollbarProps) {
  const {
    thumbWidth = 6,
    thumbColor = "#00000033",
    thumbColorActive = "#00000077",
    alwaysVisible = false,
    hideDelay = 1200,
  } = config || {};

  // Which tracks exist. This is the only scroll-derived value kept in React state, and it flips when the content
  // becomes (un)scrollable — not while scrolling. Thumb length and offset are written straight to the DOM (see
  // applyMetrics): holding them in state re-rendered this component on every single scroll event.
  const [axes, setAxes] = useState({ v: false, h: false });
  // Drag state is state (not just a ref) because the thumb's colour depends on it. It changes twice per drag.
  const [dragging, setDragging] = useState<null | "v" | "h">(null);
  // Whether the bar is currently on screen. Deliberately NOT driven by hovering the content: the bar stays out of
  // the way until the user actually scrolls, then fades out again once they stop.
  const [visible, setVisible] = useState(false);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const vThumbRef = useRef<HTMLDivElement>(null);
  const hThumbRef = useRef<HTMLDivElement>(null);

  /**
   * Publish the scrolling element to the caller's ref as well as our own. Memoized on purpose: an inline callback ref
   * is a new function every render, which makes React detach it (calling it with null) and re-attach on each one —
   * the caller's ref would keep blinking to null between renders.
   */
  const attachViewport = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (viewportRef) viewportRef.current = node;
    },
    [viewportRef],
  );

  // Mirrors of the above, for the event handlers: they let a scroll / hover decide whether anything actually changed
  // before touching state, which is what keeps a scroll burst at zero re-renders.
  const axesRef = useRef(axes);
  const visibleRef = useRef(false);
  const draggingRef = useRef<null | "v" | "h">(null);
  const overThumbRef = useRef(false);

  const frameRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the bar was last told to show. The fade-out timer reads this instead of being reset per scroll event. */
  const lastRevealRef = useRef(0);
  /** The thumb lengths last written, so a scroll frame that only moved the thumb writes only the transform. */
  const lastLenRef = useRef({ v: -1, h: -1 });
  const startRef = useRef({ x: 0, y: 0, scrollL: 0, scrollT: 0 });

  /**
   * Measure the scroll box and write each thumb's length + offset directly to its style. No React state, so a scroll
   * costs one layout read and two style writes instead of a render pass. The offset is a transform rather than `top` /
   * `left` to keep it off the layout path.
   */
  const applyMetrics = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const { clientHeight, scrollHeight, clientWidth, scrollWidth, scrollTop, scrollLeft } = el;

    const v = scrollHeight > clientHeight;
    const h = scrollWidth > clientWidth;
    if (v !== axesRef.current.v || h !== axesRef.current.h) {
      axesRef.current = { v, h };
      // A track that unmounts takes its written length with it; forget it, so the next mount is sized again.
      if (!v) lastLenRef.current.v = -1;
      if (!h) lastLenRef.current.h = -1;
      setAxes({ v, h }); // Mounts / unmounts a track; a layout effect below re-measures once the thumb exists
    }

    // The arithmetic lives in logic.ts (clamped thumb, offset spread over the travel it actually has), where its
    // edge cases are tested. Here it is only read and written.
    const vThumb = vThumbRef.current;
    if (v && vThumb) {
      const { len, pos } = thumbMetrics(clientHeight, scrollHeight, scrollTop);
      if (len !== lastLenRef.current.v) {
        lastLenRef.current.v = len;
        vThumb.style.height = `${len}px`;
      }
      vThumb.style.transform = `translateY(${pos}px)`;
    }

    const hThumb = hThumbRef.current;
    if (h && hThumb) {
      const { len, pos } = thumbMetrics(clientWidth, scrollWidth, scrollLeft);
      if (len !== lastLenRef.current.h) {
        lastLenRef.current.h = len;
        hThumb.style.width = `${len}px`;
      }
      hThumb.style.transform = `translateX(${pos}px)`;
    }
  }, []);

  /** Coalesce measurements to one per frame — a scroll fires far more often than the screen updates. */
  const scheduleUpdate = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      applyMetrics();
    });
  }, [applyMetrics]);

  const setVisibleBoth = useCallback((next: boolean) => {
    if (visibleRef.current === next) return; // Already there: skip the render entirely
    visibleRef.current = next;
    setVisible(next);
  }, []);

  /**
   * Show the bar and arm its fade-out. This is the ONLY thing that reveals it — hovering the content does not, which
   * is the point: the bar appears in response to scrolling and then gets out of the way again.
   */
  const reveal = useCallback(() => {
    // Pinned visible: nothing to reveal and nothing to time out. Skipping this keeps a scroll at zero re-renders and
    // zero timer churn, which matters where the content re-renders constantly anyway (the chat transcript).
    if (alwaysVisible) return;
    setVisibleBoth(true);
    // One timer per fade, not one per scroll event. A wheel or a fling delivers scroll events far faster than the
    // bar needs to know about them, and clearing + re-arming a timeout on each one was pure churn. The timer instead
    // reads WHEN the bar was last revealed, and sleeps for whatever remains of the delay.
    lastRevealRef.current = performance.now();
    if (hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(function tick() {
      const held = draggingRef.current !== null || overThumbRef.current;
      const next = fadeDecision(hideDelay, lastRevealRef.current, performance.now(), held);
      if (!next.hide) {
        hideTimerRef.current = setTimeout(tick, next.ms);
        return;
      }
      hideTimerRef.current = null;
      setVisibleBoth(false);
    }, hideDelay);
  }, [alwaysVisible, hideDelay, setVisibleBoth]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    scheduleUpdate();
    reveal();
    onScroll?.(e);
  };

  // Container resize + initial measurement. Note this observes the scroll box, so it does not fire when the content
  // grows inside an unchanged box — the layout effect below covers that by re-measuring whenever children change.
  useEffect(() => {
    const el = contentRef.current;
    applyMetrics();
    const observer = new ResizeObserver(scheduleUpdate);
    if (el) observer.observe(el);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [applyMetrics, scheduleUpdate]);

  // Re-measure when the content changes (new children) or a track just appeared. The latter matters because
  // applyMetrics may have decided an axis is scrollable while its thumb was still unmounted, leaving it unsized.
  // A plain effect is enough: the work is deferred to a frame either way, and the bar is hidden while this settles.
  useEffect(() => {
    scheduleUpdate();
  }, [children, axes, scheduleUpdate]);

  // Drag to scroll. Listeners exist only for the duration of a drag.
  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const el = contentRef.current;
      if (!el) return;
      const { scrollHeight, clientHeight, scrollWidth, clientWidth } = el;
      // The same clamped-thumb model as applyMetrics, inverted (dragScroll), so the thumb stays under the cursor.
      if (dragging === "v") {
        const next = dragScroll(clientHeight, scrollHeight, startRef.current.scrollT, e.clientY - startRef.current.y);
        if (next !== null) el.scrollTop = next;
      } else {
        const next = dragScroll(clientWidth, scrollWidth, startRef.current.scrollL, e.clientX - startRef.current.x);
        if (next !== null) el.scrollLeft = next;
      }
    };
    const onMouseUp = () => {
      draggingRef.current = null;
      setDragging(null);
      document.body.style.userSelect = "";
      reveal(); // Drag over: re-arm the fade-out rather than leaving the bar up for good
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      // Unmounting mid-drag never reaches onMouseUp, which used to leave the whole document unselectable for good.
      document.body.style.userSelect = "";
    };
  }, [dragging, reveal]);

  const beginDrag = (axis: "v" | "h") => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = contentRef.current;
    draggingRef.current = axis;
    setDragging(axis);
    startRef.current = { x: e.clientX, y: e.clientY, scrollL: el?.scrollLeft ?? 0, scrollT: el?.scrollTop ?? 0 };
    document.body.style.userSelect = "none";
  };

  // Pointer over the thumb only feeds the fade-out timer, through a ref — hovering must not cost a render, and it
  // must not reveal a hidden bar either.
  const onThumbEnter = () => { overThumbRef.current = true; };
  const onThumbLeave = () => { overThumbRef.current = false; };

  const shown = alwaysVisible || visible || dragging !== null;
  // An opacity-0 element still hit-tests, so a hidden thumb would leave an invisible strip down the edge of the
  // content swallowing clicks. Gate its pointer events on being on screen.
  const thumbEvents: React.CSSProperties["pointerEvents"] = shown ? "auto" : "none";

  return (
    <div className={cn("relative w-full h-full overflow-hidden", className)}>
      {/* Content container. The native bar is hidden with the global .scrollbar-hide utility (globals.css) rather
          than a styled-jsx block, which injected and scoped an identical rule for every instance. */}
      <div
        ref={attachViewport}
        onScroll={handleScroll}
        className={cn("w-full h-full overflow-auto scrollbar-hide", viewportClassName)}
      >
        {children}
      </div>

      {/* --- Vertical custom scrollbar --- */}
      {axes.v && (
        <div
          className="pointer-events-none absolute right-0 top-0 bottom-0 z-30 transition-opacity duration-300"
          style={{ width: `${thumbWidth + 4}px`, opacity: shown ? 1 : 0 }}
        >
          <div
            ref={vThumbRef}
            onMouseDown={beginDrag("v")}
            onMouseEnter={onThumbEnter}
            onMouseLeave={onThumbLeave}
            className="absolute right-1 top-0 cursor-pointer rounded-full transition-colors"
            style={{
              backgroundColor: dragging === "v" ? thumbColorActive : thumbColor,
              width: `${thumbWidth}px`,
              pointerEvents: thumbEvents,
            }}
          />
        </div>
      )}

      {/* --- Horizontal custom scrollbar --- */}
      {axes.h && (
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 z-30 transition-opacity duration-300"
          style={{ height: `${thumbWidth + 4}px`, opacity: shown ? 1 : 0 }}
        >
          <div
            ref={hThumbRef}
            onMouseDown={beginDrag("h")}
            onMouseEnter={onThumbEnter}
            onMouseLeave={onThumbLeave}
            className="absolute bottom-1 left-0 cursor-pointer rounded-full transition-colors"
            style={{
              backgroundColor: dragging === "h" ? thumbColorActive : thumbColor,
              height: `${thumbWidth}px`,
              pointerEvents: thumbEvents,
            }}
          />
        </div>
      )}
    </div>
  );
}
