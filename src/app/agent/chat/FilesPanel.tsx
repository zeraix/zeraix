"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { X, Save, ExternalLink, FileWarning, Loader2, Maximize2, Minimize2, SquareTerminal, Plus } from "lucide-react";
import { onOpenFile, onCloseFile, monacoLanguage } from "@/lib/fileViewer";
import { monacoOptions, configureMonacoIntelliSense } from "@/lib/monacoConfig";
import { wsReadFile, wsWriteFile, callTool } from "@/lib/ai/toolkit";
import { isTerminalAvailable, terminalBridge } from "@/lib/terminal";
import { WORKDIR_SET_EVENT, WORKDIR_CLEAR_EVENT, AGENT_FILES_MAXIMIZED_KEY } from "@/constants/Agent";
import { getStorage } from "@zzcpt/zztool";
import { putStorage } from "@/lib/ai/agentStorage";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";

// Monaco is heavy, so load it client-side only (avoids SSR under static export).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
// The terminal pulls in xterm (including CSS), so it is also loaded client-side only.
const TerminalView = dynamic(() => import("@/components/layout/agent/TerminalView"), { ssr: false });

type PanelState = "idle" | "loading" | "ok" | "error";

/** An open file tab: path (relative to the project root) + its own load state / content / dirty flag. */
interface FileTab {
  path: string;
  state: PanelState;
  content: string;
  reason: string;
  dirty: boolean;
}

/** Get the file name from a path (handles both / and \\ separators). */
function basename(p: string): string {
  const s = p.replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Right-side file panel: clicking a file in the sidebar file tree -> requestOpenFile -> loads and displays / edits it here.
 * Text files that can be opened use the Monaco editor (savable); files that cannot be opened (directory / too large /
 * binary / read failure) show the reason and offer "Open with the system default app". Manages its own open/close state
 * and renders as a sibling of BrowserPanel.
 */
export default function FilesPanel() {
  const t = useT();
  const { resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // VS Code-style bottom terminal panel: supports multiple tabs. termOpen controls whether the panel is expanded/collapsed
  // (sessions are kept when collapsed); terms holds each terminal tab id (auto-incrementing), activeTerm is the current tab;
  // termHeight is the panel height (adjustable by dragging).
  const [termOpen, setTermOpen] = useState(false);
  const [terms, setTerms] = useState<number[]>([]);
  const [activeTerm, setActiveTerm] = useState<number | null>(null);
  const termSeqRef = useRef(0);
  const [termHeight, setTermHeight] = useState(240);
  const [termAvailable] = useState(() => isTerminalAvailable());
  const bodyRef = useRef<HTMLDivElement>(null); // the body area containing the editor + terminal, used to compute the drag height cap
  const tabBarRef = useRef<HTMLDivElement>(null); // the file tab bar container, used for horizontal wheel scrolling + auto-scrolling the active tab into view
  const activeTabRef = useRef<HTMLDivElement>(null); // the current active tab element, used to auto-scroll it into the visible range
  // Multi-file editing tabs: one tab per open file, each keeping its own load state / content / dirty flag. activePath is the current tab.
  const [files, setFiles] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const filesRef = useRef<FileTab[]>([]); // mirror, so the onOpenFile listener can synchronously check whether a file is already open
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const activeFile = files.find((f) => f.path === activePath) ?? null;
  const hasFiles = files.length > 0;
  const lastWorkdirRef = useRef<string | null>(null); // the most recent working directory; used to detect "project switch" and clear the tabs

  // Clear all open file tabs (reset when switching projects / closing the panel, to avoid leftover files from the previous project).
  const clearFiles = () => {
    setFiles([]);
    setActivePath(null);
  };

  // Persist the maximized state: kept across close / reopen / restart (no longer reset when closing the panel). putStorage
  // stores a string, and clears it with null when not maximized (to avoid stale data), so "1" is used as the flag.
  const setMaximizedPersist = (v: boolean) => {
    setMaximized(v);
    putStorage(AGENT_FILES_MAXIMIZED_KEY, v ? "1" : null);
  };
  // Restore the last maximized choice on mount.
  useEffect(() => {
    if (getStorage(AGENT_FILES_MAXIMIZED_KEY) === "1") setMaximized(true);
  }, []);

  // When the active tab changes -> auto horizontal scroll so it enters the tab bar's visible range (horizontal only, doesn't affect other scroll containers).
  useEffect(() => {
    const el = activeTabRef.current;
    const bar = tabBarRef.current;
    if (!el || !bar) return;
    const barRect = bar.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.left < barRect.left) bar.scrollBy({ left: elRect.left - barRect.left - 8, behavior: "smooth" });
    else if (elRect.right > barRect.right) bar.scrollBy({ left: elRect.right - barRect.right + 8, behavior: "smooth" });
  }, [activePath, files.length]);

  // The tab bar supports horizontal scrolling with the mouse wheel (vertical wheel -> horizontal scroll). Uses a native
  // non-passive listener so it can preventDefault, avoiding the wheel also scrolling ancestor containers. Added / removed
  // as the tab bar mounts / unmounts.
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, [hasFiles]);

  // Locate a tab by path and partially update it (switching tabs won't clobber other tabs).
  const patchFile = (p: string, patch: Partial<FileTab>) =>
    setFiles((fs) => fs.map((f) => (f.path === p ? { ...f, ...patch } : f)));

  const load = async (p: string) => {
    const r = await wsReadFile(p);
    patchFile(p, r.ok ? { state: "ok", content: r.content, dirty: false } : { state: "error", reason: r.reason });
  };

  // Open a file: if it's already a tab just activate it (keeps unsaved changes, doesn't reload); otherwise create a new tab and load it.
  useEffect(
    () =>
      onOpenFile((p) => {
        if (!p) return;
        setOpen(true);
        setActivePath(p);
        if (!filesRef.current.some((f) => f.path === p)) {
          setFiles((fs) => [...fs, { path: p, state: "loading", content: "", reason: "", dirty: false }]);
          void load(p);
        }
      }),
    [],
  );

  // Switching projects -> the working directory changes: clear the previous project's leftover file tabs (their relative
  // paths now point elsewhere). Compare working directories to determine a "real directory change", avoiding accidental
  // clears from duplicate events within the same project.
  useEffect(() => {
    const onWorkdirSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string") return;
      if (lastWorkdirRef.current !== null && dir !== lastWorkdirRef.current) clearFiles();
      lastWorkdirRef.current = dir;
    };
    const onWorkdirClear = () => {
      if (lastWorkdirRef.current) clearFiles();
      lastWorkdirRef.current = "";
    };
    window.addEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    window.addEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
    return () => {
      window.removeEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When collapsing the file tree sidebar (see AgentShell.closeFiles): close the file panel, clear the file tabs, and fully
  //  terminate all terminal background processes -- clearing terms unmounts every TerminalView (each kills its PTY), then
  //  killAll is called as a fallback to ensure no leftover shell. The maximized state is intentionally not reset (it's
  //  persisted), so it stays maximized on the next reopen.
  useEffect(
    () =>
      onCloseFile(() => {
        setOpen(false);
        clearFiles();
        setTermOpen(false);
        setTerms([]);
        setActiveTerm(null);
        terminalBridge()?.killAll();
      }),
    [],
  );

  const save = async () => {
    const f = activeFile;
    if (!f || saving) return;
    setSaving(true);
    const r = await wsWriteFile(f.path, f.content);
    setSaving(false);
    if (r.ok) {
      patchFile(f.path, { dirty: false });
      toast.success(t("files.saved"));
    } else {
      toast.error(`${t("files.saveFailed")}${r.error ? `: ${r.error}` : ""}`);
    }
  };

  // Close a file tab: remove it from the list; if it's the active tab, switch to an adjacent tab (or clear the active tab if none remain).
  const closeFile = (p: string) => {
    const idx = files.findIndex((f) => f.path === p);
    const next = files.filter((f) => f.path !== p);
    setFiles(next);
    if (activePath === p) setActivePath(next.length ? next[Math.min(idx, next.length - 1)].path : null);
  };

  // When the file can't be opened as text: open the current file with the host system's default app (reuses the AI tool open_path, restricted to within the working directory).
  const openExternal = () => {
    if (activePath) void callTool("open_path", { path: activePath });
  };

  // Create a new terminal tab: auto-increment the id, set it as the active tab, and expand the panel.
  const addTerm = () => {
    const id = ++termSeqRef.current;
    setTerms((ts) => [...ts, id]);
    setActiveTerm(id);
    setTermOpen(true);
  };

  // Close a terminal tab: remove it from the list (unmounts its TerminalView -> kills its PTY); if it's the active tab,
  // switch to an adjacent tab; collapse the panel when all are closed.
  const closeTerm = (id: number) => {
    const idx = terms.indexOf(id);
    const next = terms.filter((x) => x !== id);
    setTerms(next);
    if (activeTerm === id) setActiveTerm(next.length ? next[Math.min(idx, next.length - 1)] : null);
    if (next.length === 0) setTermOpen(false);
  };

  // Bottom status bar terminal toggle: if expanded -> collapse (keeps sessions); if not expanded -> expand when there are tabs, or create one when there are none.
  const toggleTerminal = () => {
    if (termOpen) setTermOpen(false);
    else if (terms.length === 0) addTerm();
    else setTermOpen(true);
  };

  // Drag the divider to adjust the terminal panel height (VS Code-style): terminal height = the mouse's distance from the body's bottom edge, clamped to [80, body height - 80].
  const startTermResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(80, rect.height - 80);
      setTermHeight(Math.max(80, Math.min(rect.bottom - ev.clientY, max)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    // The outer layer only animates and clips the width (0 <-> 520 <-> full width); the inner layer keeps a fixed width and slides smoothly in/out as the outer layer reveals/collapses.
    <div
      className={`h-full shrink-0 overflow-hidden transition-[width] duration-300 ${
        open ? (maximized ? "w-full" : "w-[520px]") : "w-0"
      }`}
    >
      <div className={`flex h-full min-w-[520px] flex-col border-l border-line bg-surface ${maximized ? "w-full" : "w-[520px]"}`}>
      {/* Header: control buttons (close panel / maximize / save) moved to the far left; after them, the active file's path relative to the project root is shown. */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          aria-label={t("files.close")}
          title={t("files.close")}
          onClick={() => setOpen(false)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        <button
          type="button"
          aria-label={maximized ? t("files.restore") : t("files.maximize")}
          title={maximized ? t("files.restore") : t("files.maximize")}
          onClick={() => setMaximizedPersist(!maximized)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        {activeFile?.state === "ok" && (
          <button
            type="button"
            aria-label={t("files.save")}
            title={t("files.save")}
            onClick={() => void save()}
            disabled={!activeFile.dirty || saving}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          </button>
        )}
        {/* The active file's relative path (relative to the project root); hover shows the full path. */}
        <span className="min-w-0 flex-1 truncate pl-1 text-xs text-muted-foreground" title={activePath ?? ""}>
          {activePath ?? t("files.title")}
        </span>
      </div>

      {/* File tab bar: multiple files coexist, click to switch, x to close a tab; dirty files show a dot.
          Supports horizontal wheel scrolling + auto-scrolling the active tab into view; the scrollbar only appears on hover (tab-scrollbar). */}
      {files.length > 0 && (
        <div
          ref={tabBarRef}
          className="tab-scrollbar flex items-center gap-1 overflow-x-auto border-b border-line bg-surface-muted/40 px-2 py-1"
        >
          {files.map((f) => {
            const isActive = f.path === activePath;
            return (
              <div
                key={f.path}
                ref={isActive ? activeTabRef : undefined}
                onClick={() => setActivePath(f.path)}
                title={f.path}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs ${
                  isActive ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="max-w-[160px] truncate">{basename(f.path)}</span>
                {f.dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                <button
                  type="button"
                  aria-label={t("files.close")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(f.path);
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Body: the editor area (top) + a dockable bottom terminal (VS Code-style). bodyRef is used to compute the drag height cap. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {/* Editor / loading / error: occupies the remaining space above the terminal. Content comes from the current active tab. */}
        <div className="min-h-0 flex-1">
          {!activeFile && (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("files.noOpen")}
            </div>
          )}
          {activeFile?.state === "loading" && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> {t("files.loading")}
            </div>
          )}
          {activeFile?.state === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileWarning className="size-8 text-amber-500" />
              <p className="text-sm text-muted-foreground">{activeFile.reason}</p>
              <button
                type="button"
                onClick={openExternal}
                className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface-muted"
              >
                <ExternalLink className="size-3.5" /> {t("files.openExternal")}
              </button>
            </div>
          )}
          {activeFile?.state === "ok" && (
            <MonacoEditor
              height="100%"
              path={activeFile.path}
              language={monacoLanguage(activeFile.path)}
              theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
              value={activeFile.content}
              // Language service configuration (TS/JS/JSON completion / IntelliSense): set once before the editor is created.
              beforeMount={configureMonacoIntelliSense}
              onChange={(v) => {
                if (activePath) patchFile(activePath, { content: v ?? "", dirty: true });
              }}
              // Options come from monaco-react.json in the root directory; the minimap only shows when the panel is maximized.
              options={monacoOptions(maximized)}
            />
          )}
        </div>

        {/* Bottom terminal dock area (multi-tab): once the panel is expanded all terminals are mounted, only the active tab is visible (hidden ones keep their session);
            the top divider can be dragged to resize. Clearing terms (e.g. closing the file sidebar) unmounts all of them and kills their PTYs. */}
        {terms.length > 0 && (
          <div className={termOpen ? "flex shrink-0 flex-col" : "hidden"} style={{ height: termHeight }}>
            <div
              onMouseDown={startTermResize}
              className="h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-primary/50"
            />
            {/* Tab bar: each terminal tab (click to switch / x to close) + new + collapse panel */}
            <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface-muted/50 px-2 py-1">
              {terms.map((id, i) => {
                const isActive = id === activeTerm;
                const label = `${t("terminal.title")} ${i + 1}`;
                return (
                  <div
                    key={id}
                    onClick={() => setActiveTerm(id)}
                    title={label}
                    className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs ${
                      isActive ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <SquareTerminal className="size-3.5 shrink-0" />
                    <span className="whitespace-nowrap">{label}</span>
                    <button
                      type="button"
                      aria-label={t("files.close")}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerm(id);
                      }}
                      className="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                aria-label={t("terminal.new")}
                title={t("terminal.new")}
                onClick={addTerm}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={t("files.close")}
                title={t("files.close")}
                onClick={() => setTermOpen(false)}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              {terms.map((id) => (
                <div key={id} className={id === activeTerm ? "h-full w-full" : "hidden"}>
                  <TerminalView active={termOpen && id === activeTerm} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom status bar: the always-present terminal toggle at the bottom (VS Code-style). */}
      {termAvailable && (
        <div className="flex shrink-0 items-center border-t border-line bg-surface px-2 py-1">
          <button
            type="button"
            aria-label={t("terminal.title")}
            title={t("terminal.title")}
            onClick={toggleTerminal}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition ${
              termOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <SquareTerminal className="size-3.5" />
            {t("terminal.title")}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
