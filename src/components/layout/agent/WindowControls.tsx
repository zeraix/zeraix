"use client";

import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";
import { TITLE_BAR_HEIGHT } from "./titleBar";

/* Frameless-window drag region (WebkitAppRegion is a non-standard property, needs a cast). */
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** Width of the three buttons, for the shell to reserve in the title bar so nothing is laid out underneath them. */
export const WINDOW_CONTROLS_WIDTH = 3 * 46;

/** Width of the traffic lights (3 x size-3 with gap-2), for reserving the space they occupy. */
export const TRAFFIC_LIGHTS_WIDTH = 3 * 12 + 2 * 8;

/**
 * Which window chrome this build draws, decided on the client only so the server render cannot disagree with it.
 *
 * One detection feeding every consumer: which buttons appear, and how much room is left for them. They used to be
 * detected in three places, which is how the sidebar came to reserve macOS's traffic-light inset on Windows, where
 * nothing is drawn in it.
 */
function usePlatform(): { electron: boolean; mac: boolean } {
  const [state, setState] = useState({ electron: false, mac: false });
  // Deferred to a microtask rather than set in the effect body: the render this schedules is the point (the server
  // render has to be the neutral "no chrome" one), and setting it synchronously is what the cascading-render rule
  // is there to catch. Same shape as before this detection was shared.
  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setState({ electron: ua.includes("Electron"), mac: ua.includes("Macintosh") });
    })();
  }, []);
  return state;
}

/**
 * Whether this build draws its own top-right window buttons: Electron on Windows / Linux only. macOS uses the
 * traffic lights and the browser has a real title bar, so neither reserves the space.
 *
 * Shared with the shell, so the reserved gap and the buttons can never disagree about whether they exist.
 */
export function useWindowControlsPresent(): boolean {
  const { electron, mac } = usePlatform();
  return electron && !mac;
}

/**
 * Whether the traffic lights are drawn, and whether they actually drive the window.
 *
 * `show` is the exact complement of useWindowControlsPresent, and it is what any surface reserving space at the top
 * left must key on: Windows and Linux draw nothing there, so an unconditional inset is just a band of dead pixels
 * above the content. `active` is narrower — only under macOS Electron do the lights control a real window; in a
 * browser they are decoration, and clicking them must do nothing.
 */
export function useTrafficLights(): { show: boolean; active: boolean } {
  const { electron, mac } = usePlatform();
  return { show: !(electron && !mac), active: electron && mac };
}

/**
 * macOS-style window controls (red = close / yellow = minimize / green = zoom).
 *
 * In Electron they are clickable and drive the real window (the native traffic lights are hidden by the main process);
 * in a browser they degrade to pure decoration and show no symbols on hover. Rendered by whichever surface owns the
 * window's top-left corner — the sidebar when it is open, the shell's collapsed-sidebar cluster when it is not.
 */
export function TrafficLights() {
  const { show, active } = useTrafficLights();
  if (!show) return null;

  const buttons = [
    { color: "#ff5f57", label: "Close", glyph: "\u2715", onClick: closeWindow },
    { color: "#febc2e", label: "Minimize", glyph: "\u2212", onClick: minimizeWindow },
    { color: "#28c840", label: "Zoom", glyph: "+", onClick: () => void toggleMaximizeWindow() },
  ];

  return (
    <div className="group/lights flex items-center gap-2">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          title={b.label}
          tabIndex={active ? 0 : -1}
          onClick={active ? b.onClick : undefined}
          style={{ backgroundColor: b.color, WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className={`flex size-3 items-center justify-center rounded-full ${
            active ? "cursor-pointer" : "pointer-events-none"
          }`}
        >
          <span className="text-[8px] font-bold leading-none text-black/55 opacity-0 transition-opacity group-hover/lights:opacity-100">
            {active ? b.glyph : ""}
          </span>
        </button>
      ))}
    </div>
  );
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
