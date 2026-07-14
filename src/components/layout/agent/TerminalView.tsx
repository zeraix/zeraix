"use client";

/**
 * Built-in terminal view: xterm.js frontend <-> main-process node-pty session (see src/lib/terminal.ts).
 * Mounting spawns a new PTY session (starting in the current working directory); unmounting ends it. The fit
 * addon + ResizeObserver reflow the terminal to fit the panel size and sync the size to the PTY, so TUIs like
 * vim/top lay out correctly.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";
import { useT } from "@/lib/i18n";
import { terminalBridge, isTerminalAvailable } from "@/lib/terminal";
import { toast } from "sonner";

/** xterm light/dark color scheme (roughly matches the app's surface tones, styling follows VS Code). */
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

  // Initialize xterm + establish the PTY session (once only).
  useEffect(() => {
    const bridge = terminalBridge();
    const host = hostRef.current;
    if (!host || !bridge) return;

    const isDark = resolvedTheme === "dark";
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, Menlo, 'Courier New', monospace",
      cursorBlink: true,
      // Keep the bottom padding smooth; give scrollback plenty of history lines.
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
      /* Container has no size yet; ResizeObserver will handle it later */
    }
    termRef.current = term;
    fitRef.current = fit;

    let id: number | null = null;
    let disposed = false;
    let offData = () => {};
    let offExit = () => {};

    // User input -> pass through to the PTY.
    const inputSub = term.onData((d) => {
      if (id != null) bridge.write(id, d);
    });
    // Size change -> sync to the PTY.
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (id != null) bridge.resize(id, cols, rows);
    });
    // Copy-on-select: when the selection changes and is non-empty, automatically write it to the system
    // clipboard (like most system terminals). onSelectionChange fires continuously during a drag, so debounce
    // it -- copy once after the selection settles and show a single "copied" toast, avoiding a clipboard write /
    // toast refresh on every mousemove. Use a fixed toast id so repeated copies update in place rather than stack.
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
            /* Silently ignore when the clipboard is unavailable / permission denied */
          });
      }, 120);
    });

    void (async () => {
      let sid: number;
      try {
        sid = await bridge.create({ cols: term.cols, rows: term.rows });
      } catch (err) {
        // spawn failure (e.g. macOS posix_spawnp): show a readable message in the terminal rather than an uncaught Promise rejection.
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

    // Container size change -> re-fit (and sync the PTY via onResize).
    const ro = new ResizeObserver(() => {
      // Don't fit while hidden (display:none -> 0 size): otherwise char metrics / cols&rows compute to 0,
      // resizing the PTY to a bad size and causing misaligned rendering the next time it's shown.
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
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
    // Initialize once only; theme changes are handled by the separate effect below, avoiding a terminal rebuild that would lose the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: only update the colors, don't rebuild the terminal.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = resolvedTheme === "dark" ? THEMES.dark : THEMES.light;
  }, [resolvedTheme]);

  // When switching from hidden back to visible (the bottom terminal re-expands): wait for the container to
  // finish layout (has a real size), then fit and force a full redraw to clear stale / misaligned rendering
  // left over while hidden, and finally focus. A single frame isn't enough (layout hasn't settled after
  // display:none->flex), so poll until it has a size.
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
        r2 = requestAnimationFrame(run); // Layout not ready, retry next frame
        return;
      }
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      term.refresh(0, Math.max(0, term.rows - 1)); // Full redraw to fix misalignment from while hidden
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

  // Dark background, a little padding on all sides so text doesn't touch the edges.
  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-[#ffffff] px-2 py-1.5 dark:bg-[#1e1e1e]" />;
}
