"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWorkingDir,
  defaultWorkingDir,
  isToolkitAvailable,
  listTools,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import { isLlmProxyAvailable } from "@/lib/ai/llm";
import { getStorage } from "@zzcpt/zztool";
import { AGENT_WORKDIR_KEY, WORKDIR_CLEAR_EVENT, WORKDIR_SET_EVENT } from "@/constants/Agent";
import { putStorage } from "@/lib/ai/agentStorage";
import { isMemoryFilesAvailable } from "@/lib/ai/memoryFiles";
import { buildSystemPrompt, buildToolSet as buildToolSet_ } from "@/lib/ai/promptPrefix";

export interface WorkdirSetup {
  /** Whether the Electron toolkit is available (local tools / working directory / sandbox). */
  toolsReady: boolean;
  proxyReady: boolean;
  /** The directory AI tool calls are confined to. */
  workdir: string;
  /** Whether the user has explicitly chosen the working directory (see the declaration). */
  workdirChosen: boolean;
  /** The settings area (working directory / run parameters); opened when the working directory cannot be applied. */
  settingsOpen: boolean;
  /** Mount: probe the toolkit and the LLM proxy. Returns whether the toolkit is available. Stable. */
  probeToolkit: () => boolean;
  /** Mount: restore the persisted working directory, or read the main process's current one. Stable. */
  restoreWorkdir: (ready: boolean) => Promise<void>;
  /** A conversation was opened: point the tools back at the directory it was created in. */
  adoptWorkdir: (dir: string) => Promise<void>;
  /** The working-directory policy, applied on every send. Null means the send must be abandoned. */
  resolveEffectiveWorkdir: () => Promise<string | null>;
  /** Compose messages[0] (see the declaration). */
  composeSystemPrompt: () => string;
  /** Build the tool array sent with every request. */
  buildToolSet: () => Promise<unknown[]>;
}

/**
 * Owns the local toolkit's readiness and the directory it works in.
 *
 * The working directory has three writers — the mount-time restore, the project/new-chat events from the sidebar,
 * and the per-send policy that falls back to a default workspace — and one reader that matters, the send that
 * has to know where this turn runs. All of them live here. The prompt prefix composers live here too, because
 * both are functions of whether the toolkit is available and nothing else this hook does not own.
 *
 * `onError` is the page's error banner: the per-send policy reports why a send was abandoned through it.
 */
export function useWorkdirSetup({
  onError,
  t,
}: {
  onError: (text: string) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}): WorkdirSetup {
  const [toolsReady, setToolsReady] = useState(false);
  // Mirror, for callers that outlive the render they were created in. __seedPrefix is registered in a mount-only effect, so it
  // closes over the FIRST render's toolsReady (false) permanently — reading the state there silently drops the whole local-tool
  // block from the captured prefix, which would produce a seed that never matches a real request.
  const toolsReadyRef = useRef(false);
  const [proxyReady, setProxyReady] = useState(false);
  // Working directory: AI tool calls (read/write files / run commands) are confined to this directory.
  const [workdir, setWorkdir] = useState("");
  const [workdirInput, setWorkdirInput] = useState("");
  // Whether the user has "explicitly chosen" the working directory (tools always have a WORKDIR by default, so this needs a separate flag).
  // An explicit choice is expected; without one it falls back to the default working directory (under userData/agent).
  const [workdirChosen, setWorkdirChosen] = useState(false);
  // The default workspace is minted once per session: defaultWorkingDir returns a NEW directory each call, so re-applying
  // it per message would spread one conversation's files over a different folder every turn.
  const defaultAppliedRef = useRef(false);
  // The settings area (working directory / run parameters) is collapsed by default; it expands on demand in dev mode when a working directory is missing.
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Compose messages[0], and build the tool array.
   *
   * Both are pulled out of send() so seed generation can obtain the EXACT prefix the app sends without driving the UI and without
   * reimplementing the composition. A seed is keyed on the bytes of [messages[0] + tools]; if the generator built those bytes by
   * its own route, a divergence would show up as a seed that silently never matches. One code path, two callers.
   *
   * Both come from src/lib/ai/promptPrefix.ts, so send() and the seed generator compose them by exactly one code path. The native
   * schemas are fetched over IPC here; the generator reads them straight off disk.
   */
  const composeSystemPrompt = (): string =>
    buildSystemPrompt({ toolsReady: toolsReadyRef.current, memory: isMemoryFilesAvailable() });

  const buildToolSet = async (): Promise<unknown[]> =>
    buildToolSet_(toolsReadyRef.current ? await listTools("openai") : [], { memory: isMemoryFilesAvailable() });

  // The toolkit half of the mount initialization (the page's mount effect runs the whole sequence, in order).
  const probeToolkit = useCallback(() => {
    const ready = isToolkitAvailable();
    setToolsReady(ready);
    toolsReadyRef.current = ready;
    setProxyReady(isLlmProxyAvailable());
    return ready;
  }, []);

  const restoreWorkdir = useCallback(async (ready: boolean) => {
    // Working directory: prefer the directory explicitly chosen and persisted on the home page (the previous stage); otherwise take the main process's current directory.
    const savedWorkdir = getStorage(AGENT_WORKDIR_KEY);
    if (typeof savedWorkdir === "string" && savedWorkdir) {
      setWorkdir(savedWorkdir);
      setWorkdirInput(savedWorkdir);
      setWorkdirChosen(true); // Already explicitly chosen in the previous stage, satisfying the dev-mode requirement
      if (ready) await setWorkingDir(savedWorkdir).catch(() => {});
    } else if (ready) {
      try {
        const dir = await getWorkingDir();
        setWorkdir(dir);
        setWorkdirInput(dir);
      } catch {
        /* Keep empty if reading fails */
      }
    }
  }, []);

  // Apply the working directory: set the tools' working directory to the path the user entered; afterwards all tool calls are confined to this directory.
  // const applyWorkdir = async () => {
  //   const dir = workdirInput.trim();
  //   if (!dir || !toolsReady) return;
  //   setWorkdirMsg(null);
  //   try {
  //     const resolved = await setWorkingDir(dir);
  //     setWorkdir(resolved);
  //     setWorkdirInput(resolved);
  //     setWorkdirChosen(true); // Explicitly specified by the user, satisfying the dev-mode requirement
  //     putStorage(AGENT_WORKDIR_KEY, resolved); // Persist, reused across pages / reopens
  //     setWorkdirMsg(t("chat.workdirSet", { dir: resolved }));
  //   } catch (e) {
  //     setWorkdirMsg(t("chat.workdirApplyFail", { err: e instanceof Error ? e.message : String(e) }));
  //   }
  // };

  // // Pop up the native directory picker to let the user choose the working directory themselves; it takes effect once selected.
  // const browseWorkdir = async () => {
  //   if (!toolsReady) return;
  //   setWorkdirMsg(null);
  //   try {
  //     const dir = await chooseWorkingDir();
  //     if (!dir) return; // User canceled
  //     setWorkdir(dir);
  //     setWorkdirInput(dir);
  //     setWorkdirChosen(true); // Explicitly chosen by the user, satisfying the dev-mode requirement
  //     putStorage(AGENT_WORKDIR_KEY, dir); // Persist, reused across pages / reopens
  //     setWorkdirMsg(t("chat.workdirSet", { dir }));
  //   } catch (e) {
  //     setWorkdirMsg(t("chat.workdirBrowseFail", { err: e instanceof Error ? e.message : String(e) }));
  //   }
  // };

  useEffect(() => {
    // Creating a new conversation cleared the chosen directory → reset this page's working-directory selection state.
    const onWorkdirClear = () => {
      setWorkdirChosen(false);
      setWorkdir("");
      setWorkdirInput("");
      defaultAppliedRef.current = false; // a new conversation gets its own default workspace
    };
    // Clicking a project set the working directory → sync it to this page's working-directory input and apply it to the tool sandbox.
    const onWorkdirSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setWorkdirInput(dir);
      setWorkdirChosen(true);
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
    window.addEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    return () => {
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    };
  }, []);

  const adoptWorkdir = async (restoredDir: string) => {
    setWorkdir(restoredDir);
    setWorkdirInput(restoredDir);
    setWorkdirChosen(true);
    putStorage(AGENT_WORKDIR_KEY, restoredDir); // Persist, reused across pages / reopens
    if (isToolkitAvailable()) await setWorkingDir(restoredDir).catch(() => {});
  };

  /**
   * Working-directory policy, applied on every send (only when Electron tools are available). Choosing a folder is
   * OPTIONAL: a session without one runs in the app-managed default workspace under userData/agent, which is what a new
   * session in a fresh workspace gets. Nothing here refuses a send for want of a folder.
   *
   * Order matters. An explicit choice is looked for FIRST, including one this page may not have heard about, and only a
   * genuine absence falls through to the default. Reversed, a folder picked on the home page would be silently ignored in
   * favour of a scratch directory whenever the event announcing it did not arrive — the session would run somewhere the
   * user did not choose, which is worse than either policy on its own.
   *
   * Returns the directory this round should use, or null when the send must be abandoned — in which case the
   * reason is already on screen.
   */
  const resolveEffectiveWorkdir = async (): Promise<string | null> => {
    if (!toolsReady) return workdir;
    if (workdirChosen) return workdir;
    // If the input box already has a path (e.g. a default prefill) → adopt and apply it directly, without first clicking "apply" manually.
    // Fall back to reading the persisted AGENT_WORKDIR_KEY: after the home page WorkdirSelector chooses a directory it is already persisted, but the permanently-mounted chat page may
    // still have workdirChosen false and workdirInput empty because it did not receive WORKDIR_SET_EVENT — in that case recover it from storage, so an explicit choice is not lost.
    const savedDir = getStorage(AGENT_WORKDIR_KEY);
    const dir = workdirInput.trim() || (typeof savedDir === "string" ? savedDir.trim() : "");
    if (dir) {
      try {
        const resolved = await setWorkingDir(dir);
        setWorkdir(resolved);
        setWorkdirInput(resolved);
        setWorkdirChosen(true);
        putStorage(AGENT_WORKDIR_KEY, resolved); // Persist, reused across pages / reopens
        return resolved;
      } catch (e) {
        onError(t("chat.workdirSetFail", { err: e instanceof Error ? e.message : String(e) }));
        setSettingsOpen(true);
        return null;
      }
    }
    // No folder anywhere: the default workspace. Applied ONCE per session — defaultWorkingDir mints a fresh directory per
    // call, so re-resolving it on every message would scatter one conversation's files across a new folder each turn.
    if (!defaultAppliedRef.current) {
      try {
        const d = await defaultWorkingDir();
        defaultAppliedRef.current = true;
        setWorkdir(d);
        setWorkdirInput(d);
        return d;
      } catch (e) {
        onError(t("chat.workdirDefaultFail", { err: e instanceof Error ? e.message : String(e) }));
        return null;
      }
    }
    return workdir;
  };

  return {
    toolsReady,
    proxyReady,
    workdir,
    workdirChosen,
    settingsOpen,
    probeToolkit,
    restoreWorkdir,
    adoptWorkdir,
    resolveEffectiveWorkdir,
    composeSystemPrompt,
    buildToolSet,
  };
}
