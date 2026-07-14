"use client";

/**
 * 内置终端视图：xterm.js 前端 ⇄ 主进程 node-pty 会话（见 src/lib/terminal.ts）。
 * 挂载即新建一个 PTY 会话（起始目录为当前工作目录），卸载时结束会话。fit 插件 + ResizeObserver
 * 令终端随面板尺寸自适应重排，并把尺寸同步给 PTY，使 vim/top 等 TUI 正确布局。
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";
import { useT } from "@/lib/i18n";
import { terminalBridge, isTerminalAvailable } from "@/lib/terminal";
import { toast } from "sonner";

/** xterm 明/暗配色（与应用表面色调大致协调，细节沿用 VS Code 风格）。 */
const THEMES = {
  dark: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "#264f78",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#add6ff",
  },
} as const;

export default function TerminalView({ active = true }: { active?: boolean }) {
  const t = useT();
  const { resolvedTheme } = useTheme();
  const [available] = useState(() => isTerminalAvailable());
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // 初始化 xterm + 建立 PTY 会话（仅一次）。
  useEffect(() => {
    const bridge = terminalBridge();
    const host = hostRef.current;
    if (!host || !bridge) return;

    const isDark = resolvedTheme === "dark";
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, Menlo, 'Courier New', monospace",
      cursorBlink: true,
      // 让底部留白顺滑；scrollback 给足回溯行数。
      scrollback: 5000,
      theme: isDark ? THEMES.dark : THEMES.light,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* 容器尚无尺寸，稍后由 ResizeObserver 兜底 */
    }
    termRef.current = term;
    fitRef.current = fit;

    let id: number | null = null;
    let disposed = false;
    let offData = () => {};
    let offExit = () => {};

    // 用户输入 → 透传给 PTY。
    const inputSub = term.onData((d) => {
      if (id != null) bridge.write(id, d);
    });
    // 尺寸变化 → 同步给 PTY。
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (id != null) bridge.resize(id, cols, rows);
    });
    // 选中即复制（copy-on-select）：选择变化且非空时自动写入系统剪贴板（与多数系统终端一致）。
    // onSelectionChange 在拖拽期间会连续触发，故防抖——待选择稳定后再复制一次，并弹一次「已复制」提示，
    // 避免每次 mousemove 都写剪贴板 / 刷提示。用固定 toast id，重复复制时原地更新而非堆叠。
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const selSub = term.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        const sel = term.getSelection();
        if (!sel || typeof navigator === "undefined" || !navigator.clipboard) return;
        void navigator.clipboard
          .writeText(sel)
          .then(() => toast.success(t("terminal.copied"), { id: "terminal-copy", duration: 1500 }))
          .catch(() => {
            /* 剪贴板不可用 / 无权限时静默忽略 */
          });
      }, 120);
    });

    void (async () => {
      let sid: number;
      try {
        sid = await bridge.create({ cols: term.cols, rows: term.rows });
      } catch (err) {
        // spawn 失败（如 macOS posix_spawnp）：在终端里给出可读提示，而非未捕获的 Promise 异常。
        if (!disposed) {
          const msg = err instanceof Error ? err.message : String(err);
          term.write(`\r\n\x1b[31m${t("terminal.startFailed")}\x1b[0m\r\n${msg}\r\n`);
        }
        return;
      }
      if (disposed) {
        bridge.kill(sid);
        return;
      }
      id = sid;
      offData = bridge.onData((msg) => {
        if (msg.id === id) term.write(msg.data);
      });
      offExit = bridge.onExit((msg) => {
        if (msg.id === id) term.write(`\r\n\x1b[90m${t("terminal.exited")}\x1b[0m\r\n`);
      });
      term.focus();
    })();

    // 容器尺寸变化 → 重新 fit（并借 onResize 同步 PTY）。
    const ro = new ResizeObserver(() => {
      // 隐藏（display:none → 0 尺寸）时不要 fit：否则字符度量 / 行列会被算成 0，
      // 令 PTY 被 resize 成异常尺寸，下次显示时渲染错位。
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* 忽略 */
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      inputSub.dispose();
      resizeSub.dispose();
      selSub.dispose();
      if (copyTimer) clearTimeout(copyTimer);
      offData();
      offExit();
      if (id != null) bridge.kill(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 仅初始化一次；主题变化由下方独立 effect 更新，避免重建终端丢失会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题切换：只更新配色，不重建终端。
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = resolvedTheme === "dark" ? THEMES.dark : THEMES.light;
  }, [resolvedTheme]);

  // 从隐藏切回可见（底部终端重新展开）时：等容器完成布局（有真实尺寸）再 fit，并强制整屏重绘，
  // 清除隐藏期间遗留的陈旧 / 错位渲染，最后聚焦。单帧不够（display:none→flex 后布局尚未落地），
  // 故轮询到有尺寸为止。
  useEffect(() => {
    if (!active) return;
    let r1 = 0;
    let r2 = 0;
    const run = () => {
      const host = hostRef.current;
      const fit = fitRef.current;
      const term = termRef.current;
      if (!host || !fit || !term) return;
      if (host.offsetWidth === 0 || host.offsetHeight === 0) {
        r2 = requestAnimationFrame(run); // 布局未就绪，下一帧再试
        return;
      }
      try {
        fit.fit();
      } catch {
        /* 忽略 */
      }
      term.refresh(0, Math.max(0, term.rows - 1)); // 整屏重绘，修正隐藏期间的错位
      term.focus();
    };
    r1 = requestAnimationFrame(run);
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [active]);

  if (!available) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("terminal.unavailable")}
      </div>
    );
  }

  // 深色底，四周留一点内边距，避免文本贴边。
  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-[#ffffff] px-2 py-1.5 dark:bg-[#1e1e1e]" />;
}
