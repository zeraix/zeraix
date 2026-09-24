/**
 * AI toolkit IPC: renderer window.aiTools.* -> main process execution (fs / child process).
 *
 * Tool calls and their cancellation, the working directory, workspace file browsing, chat attachments, background
 * services, and the LLM config that tools use for a secondary model call.
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  listTools,
  runTool,
  getAssetDir,
  getWorkingDir,
  setWorkingDir,
  saveAttachment,
  setLLMConfig,
  getLLMConfig,
  setServiceEventHandler,
  stopProcess,
  listProcesses,
  wsReadDir,
  wsReadFile,
  wsWriteFile,
} from "../tools/aiToolkit.mjs";
import { GUEST_SKILLS_DIR, resolveSkillsHostDir } from "../tools/builtinSkills.mjs";
// Sub-agent scheduling in the runtime (Stage 4b). Opt-in; see subagentBridge.mjs.
import { initSubagentBridge } from "../agent/subagentBridge.mjs";
import { initRuntimeTurnBridge } from "../agent/runtimeTurnBridge.mjs";
import { appendEntry as appendUsageEntry } from "../store/usageLogStore.mjs";
import { installTransferBridge, onTransfer } from "../transferBridge.mjs";

/**
 * AbortController per in-flight tool call, keyed by the id the renderer generated (see ai-tools:cancel).
 *
 * Same shape as llmStreamControllers in llmIpc.mjs, and for the same reason: an ipcMain.handle promise cannot be
 * cancelled from the renderer side, so interruption needs a second channel and an id to address.
 */
const toolCallControllers = new Map();

export function registerAiTools() {
  ipcMain.handle("ai-tools:list", (_e, format) => listTools(format));
  ipcMain.handle("ai-tools:call", async (_e, { name, args, callId }) => {
    // No id means a caller that never cancels (the automation runtime, internal calls): run it plainly
    // rather than filling the map with entries nobody can ever reach.
    if (!callId) return runTool(name, args);
    const controller = new AbortController();
    toolCallControllers.set(callId, controller);
    try {
      return await runTool(name, args, { signal: controller.signal });
    } finally {
      toolCallControllers.delete(callId);
    }
  });
  initSubagentBridge();
  // Chat turns in the Rust runtime (on unless ZERAIX_RUST_CHAT_LOOP=off). The workspace comes from here, the same
  // place the file tools read it — never from the renderer that asked for the turn.
  initRuntimeTurnBridge({ getWorkdir: getWorkingDir, getAssetDir, logUsage: appendUsageEntry });

  // One-way, like llm:chat:abort: the renderer is telling us to stop, not asking for a result. Aborting an
  // id that has already finished is a no-op, which is what makes the race harmless — the call can complete
  // between the user's click and this arriving.
  ipcMain.on("ai-tools:cancel", (_e, callId) => {
    toolCallControllers.get(callId)?.abort();
  });
  ipcMain.handle("ai-tools:get-workdir", () => getWorkingDir());
  ipcMain.handle("ai-tools:set-workdir", (_e, dir) => setWorkingDir(dir));
  // Workspace file browsing (sidebar file tree + right-side editor): structured directory listing, file reading with openability detection, and file saving.
  ipcMain.handle("workspace:read-dir", (_e, relPath) => wsReadDir(relPath || ""));
  ipcMain.handle("workspace:read-file", (_e, relPath) => wsReadFile(relPath));
  ipcMain.handle("workspace:write-file", (_e, { path: p, content }) => wsWriteFile(p, content));
  // Save chat attachments to the working directory so the model can process them directly with file tools/sandbox commands.
  //  - Real disk file: payload={ name, srcPath }, the main process does a kernel-level copy by host path, bytes never go through IPC;
  //  - Synthetic file with no host path: goes through the transfer channel below (MessagePort hands over bytes, see transferBridge.mjs).
  ipcMain.handle("ai-tools:save-attachment", (_e, payload) => saveAttachment(payload));
  // Generic "renderer -> main process" bulk-data transfer channel + attachment byte-transfer handler (synthetic files take this path).
  installTransferBridge();
  onTransfer("save-attachment", (meta, buffer) =>
    saveAttachment({ name: meta?.name, bytes: buffer, subdir: meta?.subdir }),
  );
  // Background service (dev server, etc.) start/stop events -> broadcast to all windows (GlobalNotifications shows "running projects").
  setServiceEventHandler((evt) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("services:event", evt);
  });
  // Stop a background service (by pid); list current background services (initial sync).
  ipcMain.handle("ai-tools:stop-process", (_e, pid) => stopProcess(pid));
  ipcMain.handle("ai-tools:list-processes", () => listProcesses());
  // Where the built-in document skills' helper scripts are: on the host, and at the fixed sandbox mount point.
  // The renderer substitutes one of these for `{{SKILLS_DIR}}` in a skill's instructions (see chatTools loadSkill).
  ipcMain.handle("ai-tools:skills-dir", () => ({
    host: resolveSkillsHostDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    sandbox: GUEST_SKILLS_DIR,
  }));
  // Inject / read the LLM config used by tools that need a secondary model call (e.g. refine_question).
  ipcMain.handle("ai-tools:set-llm-config", (_e, cfg) => setLLMConfig(cfg));
  ipcMain.handle("ai-tools:get-llm-config", () => getLLMConfig());
  // Pop up a native directory picker for the user to choose their own working directory; on selection, set it as the working directory and return it. Return null on cancel.
  ipcMain.handle("ai-tools:choose-workdir", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: getWorkingDir() };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return setWorkingDir(res.filePaths[0]);
  });
  // Everyday-mode default working directory: used when the user has not picked a folder. Located under userData/agent,
  // consistent with the conversation-record default storage location (see conversationStore's default path), with the structure agent/ai-agent/default/<app name>.
  // All "everyday sessions with no user-picked folder" share this one fixed directory (no longer generating a random directory per session), avoiding unbounded directory accumulation;
  // after creation, set it as the working directory and return its absolute path.
  ipcMain.handle("ai-tools:default-workdir", () => {
    const base = path.join(app.getPath("userData"), "agent"); // Consistent with the default data storage location
    const dir = path.join(base, "ai-agent", "default", app.getName());
    fs.mkdirSync(dir, { recursive: true });
    return setWorkingDir(dir);
  });
}
