"use client";

/**
 * Working-directory selector row (used on the /agent home page): runtime environment (local) + choose folder.
 * Pick the working directory in the stage "before" entering the conversation:
 *   - Dev mode: a folder must be chosen, otherwise report blocking=true upward (the home page disables sending accordingly);
 *   - Daily mode: optional; if none is chosen, the conversation page falls back to the default directory (under userData/agent, matching where data is stored).
 * Once chosen, it is set as the Electron working directory and persisted (AGENT_WORKDIR_KEY); the conversation page /agent/chat reuses it.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderSymlink, Monitor } from "lucide-react";
import { getStorage } from "@zzcpt/zztool";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  chooseWorkingDir,
  getWorkingDir,
  isToolkitAvailable,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import {
  AGENT_MODE_KEY,
  AGENT_WORKDIR_KEY,
  MODE_CHANGE_EVENT,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
  type AgentMode,
} from "@/constants/Agent";
import { putStorage } from "@/lib/ai/agentStorage";
import { useT } from "@/lib/i18n";

/** Take the last path segment as the folder name (handles both Windows \ and POSIX /). */
function folderName(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || p;
}

export default function WorkdirSelector({
  onBlockingChange,
}: {
  /** blocking=true means "dev mode with no directory chosen"; the caller disables sending accordingly. */
  onBlockingChange?: (blocking: boolean) => void;
}) {
  const t = useT();
  const [toolsReady, setToolsReady] = useState(false);
  const [mode, setMode] = useState<AgentMode>("daily");
  const [workdir, setWorkdir] = useState("");
  const [chosen, setChosen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // On mount: probe tools + restore the persisted working directory (and sync it to the main process).
  useEffect(() => {
    const ready = isToolkitAvailable();
    setToolsReady(ready);
    const saved = getStorage(AGENT_WORKDIR_KEY);
    if (typeof saved === "string" && saved) {
      setWorkdir(saved);
      setChosen(true);
      if (ready) void setWorkingDir(saved).catch(() => {});
    } else if (ready) {
      void getWorkingDir().then(setWorkdir).catch(() => {});
    }
  }, []);

  // Sync the sidebar's "daily / dev" mode (same-tab custom event).
  useEffect(() => {
    const read = () => {
      const v = getStorage(AGENT_MODE_KEY);
      if (v === "daily" || v === "dev") setMode(v);
    };
    read();
    const onCustom = (e: Event) => {
      const v = (e as CustomEvent).detail;
      if (v === "daily" || v === "dev") setMode(v);
    };
    // Switching mode / starting a new conversation clears the chosen directory -> reset this component's selection state.
    const onClear = () => {
      setChosen(false);
      setWorkdir("");
      setMsg(null);
    };
    // The sidebar's "click a project" / right-click "new conversation in project" broadcasts the chosen directory ->
    // this component restores it and lifts the dev-mode block. Key point: switching from daily to dev (no project
    // chosen) first goes through onClear, which clears and blocks; then, on right-click project "new conversation",
    // if already on the /agent home page, router.push("/agent") is a no-op navigation and this component won't
    // remount to re-read storage. Without listening for this event it would stay stuck in the "must choose a folder
    // first" blocked state, disabling the input and preventing sending.
    const onSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setChosen(true);
      setMsg(null);
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(MODE_CHANGE_EVENT, onCustom);
    window.addEventListener(WORKDIR_CLEAR_EVENT, onClear);
    window.addEventListener(WORKDIR_SET_EVENT, onSet);
    return () => {
      window.removeEventListener(MODE_CHANGE_EVENT, onCustom);
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onSet);
    };
  }, []);

  // Report "whether sending is blocked" upward (hold the callback in a ref so its reference changes don't trigger extra effects).
  const blocking = toolsReady && mode === "dev" && !chosen;
  const cbRef = useRef(onBlockingChange);
  cbRef.current = onBlockingChange;
  useEffect(() => {
    cbRef.current?.(blocking);
  }, [blocking]);

  const browse = async () => {
    if (!toolsReady) return;
    setMsg(null);
    try {
      const dir = await chooseWorkingDir();
      if (!dir) return; // User cancelled
      setWorkdir(dir);
      setChosen(true);
      putStorage(AGENT_WORKDIR_KEY, dir); // Persist for the conversation page to reuse
      // Broadcast the chosen directory: the conversation page sets workdirChosen to true and applies it to the tool
      // sandbox. Without this event, even if a directory is chosen here, the persistently-mounted conversation page
      // wouldn't know (storage changes aren't notified across components) and dev-mode sending would wrongly report
      // "must choose a working directory first".
      window.dispatchEvent(new CustomEvent(WORKDIR_SET_EVENT, { detail: dir }));
    } catch (e) {
      setMsg(`Selection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        {/* Runtime environment: local (placeholder dropdown, extensible later to cloud, etc.) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              <Monitor className="size-3.5 text-muted-foreground" />
              {t("env.local")}
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            <DropdownMenuItem>
              <Monitor className="size-3.5" /> {t("env.local")}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Monitor className="size-3.5 disabled" /> {t("env.cloud")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Choose folder: optional in daily / required in dev; shows the folder name once chosen */}
        <button
          type="button"
          onClick={() => void browse()}
          disabled={!toolsReady}
          title={!toolsReady ? t("workdir.needDesktop") : chosen ? workdir : undefined}
          className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${
            blocking ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
          }`}
        >
          <FolderSymlink className="size-3.5 shrink-0" />
          <span className="truncate">
            {chosen ? (
              <span className="text-foreground">{folderName(workdir)}</span>
            ) : mode === "dev" ? (
              t("workdir.required")
            ) : (
              t("workdir.optional")
            )}
          </span>
        </button>
      </div>
      {/* {blocking && (
        <p className="mt-1 px-0.5 text-[11px] text-amber-600 dark:text-amber-400">
          Dev mode: please choose a folder before starting the conversation.
        </p>
      )} */}
      {msg && <p className="mt-1 px-0.5 text-[11px] text-amber-600 dark:text-amber-400">{msg}</p>}
    </div>
  );
}
