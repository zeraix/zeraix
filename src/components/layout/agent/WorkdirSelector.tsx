"use client";

/**
 * Working-directory selector row (used on the /agent home page): runtime environment (local) + choose folder.
 * Pick the working directory in the stage "before" entering the conversation — OPTIONAL. With no folder chosen the
 * conversation page falls back to the app-managed default under userData/agent (see resolveEffectiveWorkdir), which is
 * what a new session in a fresh workspace gets. Nothing here ever blocks sending.
 * Once chosen, it is set as the Electron working directory and persisted (AGENT_WORKDIR_KEY); the conversation page /agent/chat reuses it.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, Folder, FolderSymlink, Monitor, X } from "lucide-react";
import { getStorage, setStorage } from "@zzcpt/zztool";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  chooseWorkingDir,
  getWorkingDir,
  isToolkitAvailable,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import {
  AGENT_WORKDIR_KEY,
  AGENT_WORKDIR_RECENTS_KEY,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
} from "@/constants/Agent";
import { clearAgentWorkdir, putStorage } from "@/lib/ai/agentStorage";
import { useT } from "@/lib/i18n";

/** Take the last path segment as the folder name (handles both Windows \ and POSIX /). */
function folderName(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || p;
}

/** How many previously used folders the panel offers before you have to open the native dialog. */
const RECENTS_LIMIT = 5;

const readRecents = (): string[] => {
  const list = getStorage(AGENT_WORKDIR_RECENTS_KEY);
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && !!p) : [];
};

export default function WorkdirSelector({
  onBlockingChange,
  nudge = 0,
}: {
  /** Reported as a constant false now that a folder is optional; kept so an existing caller keeps compiling and gets cleared. */
  onBlockingChange?: (blocking: boolean) => void;
  /** Bump this to replay the "you skipped this" animation — the caller increments it when a send is attempted while blocking. */
  nudge?: number;
}) {
  const t = useT();
  const [toolsReady, setToolsReady] = useState(false);
  const [workdir, setWorkdir] = useState("");
  const [chosen, setChosen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  // Shake runs on a timer rather than animationend so a second attempt mid-animation still replays it.
  const [shaking, setShaking] = useState(false);
  // Sticky once the user has actually tried to send: the hint stays until a folder is chosen.
  const [nudged, setNudged] = useState(false);

  // On mount: probe tools + restore the persisted working directory (and sync it to the main process).
  useEffect(() => {
    const ready = isToolkitAvailable();
    setToolsReady(ready);
    setRecents(readRecents());
    const saved = getStorage(AGENT_WORKDIR_KEY);
    if (typeof saved === "string" && saved) {
      setWorkdir(saved);
      setChosen(true);
      if (ready) void setWorkingDir(saved).catch(() => {});
    } else if (ready) {
      void getWorkingDir().then(setWorkdir).catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Starting a new conversation clears the chosen directory -> reset this component's selection state.
    const onClear = () => {
      setChosen(false);
      setWorkdir("");
      setMsg(null);
      setNudged(false);
    };
    // The sidebar's "click a project" / right-click "new conversation in project" broadcasts the chosen directory ->
    // this component restores it and lifts the block. Key point: onClear runs first and blocks; then, on right-click
    // project "new conversation", if already on the /agent home page, router.push("/agent") is a no-op navigation and
    // this component won't remount to re-read storage. Without listening for this event it would stay stuck in the
    // "must choose a folder first" blocked state, disabling the input and preventing sending.
    const onSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setChosen(true);
      setMsg(null);
      setNudged(false);
      // Also record it: a project opened from the sidebar should show up in the panel's recents.
      const next = [dir, ...readRecents().filter((p) => p !== dir)].slice(0, RECENTS_LIMIT);
      setStorage(AGENT_WORKDIR_RECENTS_KEY, next);
      setRecents(next);
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(WORKDIR_CLEAR_EVENT, onClear);
    window.addEventListener(WORKDIR_SET_EVENT, onSet);
    return () => {
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onSet);
    };
  }, []);

  // Nothing here blocks sending: choosing a folder is optional, and a session without one runs in the default workspace
  // directory instead. The report is still made — as a constant false — so a caller that latched `blocked` from an
  // earlier build is cleared rather than left disabling its own composer for ever.
  const blocking = false;
  const cbRef = useRef(onBlockingChange);
  cbRef.current = onBlockingChange;
  useEffect(() => {
    cbRef.current?.(blocking);
  }, [blocking]);

  // A send was attempted while blocking → replay the shake and keep the hint visible from then on.
  useEffect(() => {
    if (!nudge) return;
    setNudged(true);
    setShaking(true);
    const id = setTimeout(() => setShaking(false), 650); // slightly longer than the 0.6s keyframe
    return () => clearTimeout(id);
  }, [nudge]);

  /** Apply a directory: local state + persistence + recents + the cross-component broadcast. */
  const select = (dir: string) => {
    setWorkdir(dir);
    setChosen(true);
    setNudged(false);
    putStorage(AGENT_WORKDIR_KEY, dir); // Persist for the conversation page to reuse
    const next = [dir, ...readRecents().filter((p) => p !== dir)].slice(0, RECENTS_LIMIT);
    setStorage(AGENT_WORKDIR_RECENTS_KEY, next);
    setRecents(next);
    // Broadcast the chosen directory: the conversation page sets workdirChosen to true and applies it to the tool
    // sandbox. Without this event, even if a directory is chosen here, the persistently-mounted conversation page
    // wouldn't know (storage changes aren't notified across components) and dev-mode sending would wrongly report
    // "must choose a working directory first".
    window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: dir }));
  };

  const browse = async () => {
    if (!toolsReady) return;
    setMsg(null);
    try {
      const dir = await chooseWorkingDir();
      if (!dir) return; // User cancelled
      select(dir);
    } catch (e) {
      setMsg(`Selection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Reuse a folder from the panel: same as browsing, minus the native dialog. */
  const pickRecent = (dir: string) => {
    if (!toolsReady) return;
    setMsg(null);
    select(dir);
    void setWorkingDir(dir).catch(() => {});
  };

  // One chip summarising the run target ("Local / folder"), split into two hit zones: the label opens the
  // folder picker straight away (the only action that's actually taken here), the chevron opens the panel.
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <div
          className={`flex min-w-0 max-w-full items-stretch rounded-lg border text-xs font-medium transition ${
            shaking ? "animate-nudge" : ""
          } ${
            blocking && nudged
              ? "border-warning/60 bg-warning/10 text-warning-ink"
              : "border-line bg-surface text-foreground"
          }`}
        >
          {/* Primary action: one click straight to the native folder picker. */}
          <button
            type="button"
            onClick={() => void browse()}
            disabled={!toolsReady}
            title={!toolsReady ? t("workdir.needDesktop") : chosen ? workdir : t("workdir.browse")}
            className="flex min-w-0 items-center gap-1.5 rounded-l-lg px-2.5 py-1.5 transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0">{t("env.local")}</span>
            <span className="shrink-0 text-line-strong">/</span>
            <span
              className={`truncate ${
                chosen ? "text-foreground" : blocking && nudged ? "" : "text-muted-foreground"
              }`}
            >
              {chosen ? folderName(workdir) : t("workdir.optional")}
            </span>
          </button>

          {/* Clear, inline: only meaningful once a folder is set, so it appears with the selection rather
              than hiding in the panel. Clearing blocks sending again (clearAgentWorkdir broadcasts
              WORKDIR_CLEAR_EVENT, which resets this component). */}
          {chosen && (
            <button
              type="button"
              onClick={() => clearAgentWorkdir()}
              aria-label={t("workdir.clear")}
              title={t("workdir.clear")}
              className="flex shrink-0 items-center px-1 text-muted-foreground transition hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          )}

          {/* Secondary: runtime environment + recently used folders. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("workdir.envLabel")}
                className="flex shrink-0 items-center rounded-r-lg border-l border-inherit px-1.5 transition hover:bg-accent"
              >
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" className="w-64">
              {/* Runtime environment: local only for now; cloud is announced rather than silently dead. */}
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("workdir.envLabel")}
              </DropdownMenuLabel>
              <DropdownMenuItem>
                <Monitor className="size-3.5" /> {t("env.local")}
                <Check className="ml-auto size-3.5" />
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Cloud className="size-3.5" /> {t("env.cloud")}
                <span className="ml-auto rounded border border-line px-1 text-[10px]">
                  {t("env.comingSoon")}
                </span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {/* Working folder: reuse a recent one, or open the native picker. */}
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                {t("workdir.folderLabel")}
              </DropdownMenuLabel>
              {recents.map((p) => (
                <DropdownMenuItem key={p} onClick={() => pickRecent(p)} disabled={!toolsReady} title={p}>
                  <Folder className="size-3.5 shrink-0" />
                  <span className="truncate font-mono text-[11px]">{folderName(p)}</span>
                  {p === workdir && chosen && <Check className="ml-auto size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => void browse()} disabled={!toolsReady}>
                <FolderSymlink className="size-3.5" /> {t("workdir.browse")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {blocking && nudged && (
        <p className="mt-1 px-0.5 text-[11px] text-warning-ink">
          {t("workdir.pickFirst")}
        </p>
      )}
      {msg && <p className="mt-1 px-0.5 text-[11px] text-warning-ink">{msg}</p>}
    </div>
  );
}
