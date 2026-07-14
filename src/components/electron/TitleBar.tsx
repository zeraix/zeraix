"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";

/* CSS drag region (Electron frameless window). WebkitAppRegion is a non-standard property, so it needs a cast.
 * The whole bar is draggable; clickable elements inside the bar need noDrag to respond to clicks. */
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * Custom-drawn title bar for legacy pages -- rendered only in Electron.
 *
 * The window is frameless (`titleBarStyle: 'hidden'`, with Windows' titleBarOverlay removed):
 * - Windows / Linux: this component draws the "minimize / maximize / close" buttons on the right (via windowControls IPC).
 * - macOS: the native traffic lights appear in the top-left; just leave left padding for the title, no custom buttons needed.
 *
 * The /agent module has its own window controls (sidebar traffic lights), so this isn't rendered there to avoid duplication.
 */
export default function TitleBar() {
  const pathname = usePathname();
  const [env, setEnv] = useState<{ electron: boolean; mac: boolean }>({
    electron: false,
    mac: false,
  });

  useEffect(() => {
    void (async () => {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      setEnv({ electron: ua.includes("Electron"), mac: ua.includes("Macintosh") });
    })();
  }, []);

  // Not rendered in the browser (non-Electron); /agent has its own window controls, so it isn't rendered there either.
  if (!env.electron) return null;
  if (pathname === "/agent" || pathname.startsWith("/agent/")) return null;

  return (
    <div
      style={{ ...drag, height: "env(titlebar-area-height, 36px)" }}
      className={`flex shrink-0 select-none items-center gap-2 bg-[#1f6feb] text-xs font-medium text-white ${
        env.mac ? "pl-20" : "pl-3"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/image/logo-white.png" alt="" className="h-4 w-4" draggable={false} />
      <span>Zeraix</span>

      {/* Windows / Linux: custom-drawn window control buttons (macOS uses native traffic lights, no custom drawing needed) */}
      {!env.mac && (
        <div style={noDrag} className="ml-auto flex h-full items-stretch">
          <button
            type="button"
            aria-label="Minimize"
            onClick={() => minimizeWindow()}
            className="flex w-11 items-center justify-center transition-colors hover:bg-white/15"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Maximize"
            onClick={() => void toggleMaximizeWindow()}
            className="flex w-11 items-center justify-center transition-colors hover:bg-white/15"
          >
            <Square className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={() => closeWindow()}
            className="flex w-11 items-center justify-center transition-colors hover:bg-[#e81123]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
