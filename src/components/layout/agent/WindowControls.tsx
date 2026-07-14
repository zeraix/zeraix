"use client";

import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";

/* Frameless-window drag regions (WebkitAppRegion is a non-standard property, needs a cast). */
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * /agent window controls for Windows / Linux: custom-drawn "minimize / maximize / close" in the top-right,
 * styled to resemble system title-bar buttons. The whole top strip is a drag region; the buttons themselves are no-drag.
 *
 * Not rendered on macOS (which uses the sidebar's macOS-style traffic lights); also not rendered in the browser (non-Electron).
 */
export default function WindowControls() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setShow(ua.includes("Electron") && !ua.includes("Macintosh"));
    })();
  }, []);

  if (!show) return null;

  const base = "flex h-8 w-[46px] items-center justify-center text-foreground/80 transition-colors";

  // Anchored top-right: leave a draggable handle on the left, buttons are no-drag.
  // Don't use an inset-x-0 full-width drag region, or it would swallow clicks on the top-left "expand sidebar" button (the drag region intercepts the mouse).
  return (
    <div className="absolute right-0 top-0 z-40 flex h-8 items-stretch">
      <div style={drag} className="h-full w-40" />
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
