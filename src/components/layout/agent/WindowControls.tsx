"use client";

import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";
import { TITLE_BAR_HEIGHT } from "./titleBar";

/* Frameless-window drag region (WebkitAppRegion is a non-standard property, needs a cast). */
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** Width of the three buttons, for the shell to reserve in the title bar so nothing is laid out underneath them. */
export const WINDOW_CONTROLS_WIDTH = 3 * 46;

/**
 * Whether this build draws its own top-right window buttons: Electron on Windows / Linux only. macOS uses the
 * sidebar's traffic lights and the browser has a real title bar, so neither reserves the space.
 *
 * Shared with the shell, so the reserved gap and the buttons can never disagree about whether they exist.
 */
export function useWindowControlsPresent(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setShow(ua.includes("Electron") && !ua.includes("Macintosh"));
    })();
  }, []);
  return show;
}

/**
 * /agent window controls for Windows / Linux: custom-drawn "minimize / maximize / close" in the top-right,
 * styled to resemble system title-bar buttons. The whole top strip is a drag region; the buttons themselves are no-drag.
 *
 * Not rendered on macOS (which uses the sidebar's macOS-style traffic lights); also not rendered in the browser (non-Electron).
 */
export default function WindowControls() {
  const show = useWindowControlsPresent();

  if (!show) return null;

  const base = "flex h-full w-[46px] items-center justify-center text-foreground/80 transition-colors";

  // Anchored top-right, over the gap the shell's title bar reserves for it. Nothing but the buttons is in this box:
  // a draggable pad to their left used to sit here, and now that the conversation header shares the row it would
  // swallow the clicks on whatever the header puts at its right edge. The title bar underneath is the drag region.
  return (
    <div className={`absolute right-0 top-0 z-40 flex ${TITLE_BAR_HEIGHT} items-stretch`}>
      <div style={noDrag} className="flex">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => minimizeWindow()}
          className={`${base} hover:bg-black/5`}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => void toggleMaximizeWindow()}
          className={`${base} hover:bg-black/5`}
        >
          <Square className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeWindow()}
          className={`${base} hover:bg-[#e81123] hover:text-white`}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
