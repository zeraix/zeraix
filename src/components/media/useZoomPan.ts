"use client";

/**
 * Zoom, pan and rotate for one picture.
 *
 * `scale` is relative to the fitted size (1 = fits the stage), so "reset" means the same thing whatever the
 * picture's pixel size. Zooming keeps the point under the cursor still, which is what makes wheel zoom usable
 * for inspecting a detail: the detail stays under the mouse instead of sliding away from it.
 *
 * The wheel listener is attached natively rather than as `onWheel`: React registers wheel listeners as
 * passive, so a React handler could not stop the page behind the viewer from scrolling along.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;
/** One click of a zoom button. */
const STEP = 1.25;
/** One wheel notch — gentler than a button, because a wheel delivers many. */
const WHEEL_STEP = 1.1;
/** Where a double-click lands. */
const DETAIL_SCALE = 2.5;
/** Under this much pointer travel a down/up pair is a click, not a drag. */
const DRAG_THRESHOLD = 4;

export interface ZoomPanState {
  scale: number;
  x: number;
  y: number;
  rotation: number;
}

const FIT: ZoomPanState = { scale: 1, x: 0, y: 0, rotation: 0 };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function useZoomPan(stageRef: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<ZoomPanState>(FIT);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; lastX: number; lastY: number; travel: number } | null>(null);
  /** Set when a drag ends, read by the click that follows it — that click must not count as one. */
  const dragged = useRef(false);

  /** Multiply the scale by `factor` about a point given relative to the stage centre. */
  const zoomAt = useCallback((factor: number, px = 0, py = 0) => {
    setState((s) => {
      const scale = clampScale(s.scale * factor);
      const k = scale / s.scale;
      return { ...s, scale, x: px - (px - s.x) * k, y: py - (py - s.y) * k };
    });
  }, []);

  const zoomIn = useCallback(() => zoomAt(STEP), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(1 / STEP), [zoomAt]);
  const reset = useCallback(() => setState(FIT), []);
  const rotate = useCallback(
    () => setState((s) => ({ ...s, rotation: (s.rotation + 90) % 360 })),
    [],
  );

  /** A pointer position as an offset from the stage centre — the space `x`/`y` live in. */
  const offsetOf = useCallback(
    (clientX: number, clientY: number) => {
      const r = stageRef.current?.getBoundingClientRect();
      return r
        ? { px: clientX - (r.left + r.width / 2), py: clientY - (r.top + r.height / 2) }
        : { px: 0, py: 0 };
    },
    [stageRef],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { px, py } = offsetOf(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageRef, offsetOf, zoomAt]);

  /** Double-click: into a detail at the pointer, or back out to the fit. */
  const toggle = useCallback(
    (clientX: number, clientY: number) => {
      const { px, py } = offsetOf(clientX, clientY);
      setState((s) =>
        s.scale !== 1 || s.x !== 0 || s.y !== 0
          ? { ...FIT, rotation: s.rotation }
          : { ...s, scale: DETAIL_SCALE, x: px - px * DETAIL_SCALE, y: py - py * DETAIL_SCALE },
      );
    },
    [offsetOf],
  );

  // Panning only once zoomed in: at the fit there is nowhere to pan to, and a drag would only knock the
  // picture off centre.
  const canPan = state.scale > 1;

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !canPan) return;
      drag.current = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, travel: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [canPan],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.travel += Math.abs(dx) + Math.abs(dy);
    if (d.travel < DRAG_THRESHOLD) return;
    setDragging(true);
    setState((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    dragged.current = d.travel >= DRAG_THRESHOLD;
    drag.current = null;
    setDragging(false);
  }, []);

  /** Whether the click being handled is the tail of a drag. Reading it clears it. */
  const wasDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return {
    state,
    dragging,
    canPan,
    zoomIn,
    zoomOut,
    reset,
    rotate,
    toggle,
    wasDrag,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
