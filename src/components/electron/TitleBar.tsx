"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";

/* CSS 拖拽区域（Electron 无边框窗口）。WebkitAppRegion 非标准属性，需 cast。
 * 整条 bar 可拖动；栏内可点击元素需加 noDrag 才能响应点击。 */
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * 旧版页面的自绘标题栏 —— 仅在 Electron 中渲染。
 *
 * 窗口为无边框（`titleBarStyle: 'hidden'`，且已移除 Windows 的 titleBarOverlay）：
 * - Windows / Linux：本组件右侧自绘「最小化 / 最大化 / 关闭」按钮（走 windowControls IPC）。
 * - macOS：左上角显示原生红绿灯，给标题留出左内边距即可，无需自绘按钮。
 *
 * /agent 模块有自己的窗口控制（侧边栏红绿灯），此处不渲染，避免重复。
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

  // 浏览器（非 Electron）下不渲染；/agent 自带窗口控制，也不渲染。
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

      {/* Windows / Linux：自绘窗口控制按钮（macOS 用原生红绿灯，无需自绘） */}
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
