"use client";

import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "@/lib/electron/windowControls";

/* 无边框窗口拖拽区域（WebkitAppRegion 非标准属性，需 cast）。 */
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * Windows / Linux 的 /agent 窗口控制：右上角自绘「最小化 / 最大化 / 关闭」，
 * 风格贴近系统标题栏按钮。顶部整条为拖拽区，按钮本身 no-drag。
 *
 * macOS 不渲染（改用侧边栏 macOS 风格红绿灯）；浏览器（非 Electron）也不渲染。
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

  // 右上角锚定：左侧留一段可拖拽手柄，按钮 no-drag。
  // 不使用 inset-x-0 满宽拖拽区，否则会吞掉左上角「展开侧边栏」按钮的点击（drag region 会拦截鼠标）。
  return (
    <div className="absolute right-0 top-0 z-40 flex h-8 items-stretch">
      <div style={drag} className="h-full w-40" />
      <div style={noDrag} className="flex">
        <button
          type="button"
          aria-label="最小化"
          onClick={() => minimizeWindow()}
          className={`${base} hover:bg-black/5`}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label="最大化"
          onClick={() => void toggleMaximizeWindow()}
          className={`${base} hover:bg-black/5`}
        >
          <Square className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="关闭"
          onClick={() => closeWindow()}
          className={`${base} hover:bg-[#e81123] hover:text-white`}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
