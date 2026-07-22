import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, runTool, getWorkingDir, setWorkingDir, saveAttachment, setLLMConfig, getLLMConfig, setServiceEventHandler, stopProcess, listProcesses, initEngine, disposeEngines, getSandboxStatus, setSandboxMode, onSandboxStatus, restartSandbox, sandboxVmInfo, wsReadDir, wsReadFile, wsWriteFile } from "./tools/aiToolkit.mjs";
import { discoverProjectSkills, setProjectSkillDecision, readProjectSkillFile, loadEnabledProjectSkills } from "./tools/projectSkills.mjs";
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killByWebContents, killAllTerminals } from "./tools/terminal.mjs";
import { llmChat, llmChatStream } from "./llm/proxy.mjs";
import * as localLlm from "./llm/localServer.mjs";
import { installTransferBridge, onTransfer } from "./transferBridge.mjs";
import {
  loadIndex,
  loadProject,
  saveIndex,
  saveProject,
  deleteProject,
  getStorePath,
  setStorePath,
} from "./store/conversationStore.mjs";
import {
  loadAppConfig,
  getAppConfig,
  setAppConfig,
  removeAppConfig,
  getConfigPath,
  ensureConfigFile,
  ensureAppConfigKeys,
} from "./appConfig.mjs";
import {
  initIntegrity,
  encryptionStatus,
  getDeviceId,
  loadMeta,
  saveMeta,
  deleteMeta,
  listMeta,
} from "./integrity/integrityStore.mjs";
import {
  saveMemoryFile,
  listMemoryFiles,
  deleteMemoryFile,
  openMemoryDir,
  importFromPaths,
  countMemoryFiles,
  saveTemplateFile,
  exportMemoriesZip,
} from "./memoryFiles.mjs";
import { registerNotifications } from "./ipc/notificationIpc.mjs";
import { registerGoogleAuth } from "./ipc/googleAuthIpc.mjs";
import { registerUpdater } from "./ipc/updaterIpc.mjs";
import { loadEnvFiles } from "./loadEnv.mjs";
import { registerProtocolClient, findDeepLink } from "./services/deepLink.mjs";
import { initAutomation, shutdownAutomation, setAutomationNotifier } from "./automation/paths.mjs";
import { closeDb } from "./automation/db.mjs";
import {
  initBackground,
  isBackgroundEnabled,
  isBackgroundLaunch,
  setBackgroundEnabled,
  isOpenAtLogin,
  setOpenAtLogin,
  setTrayLabels,
  isPaused,
  setPaused,
  destroyTray,
  isTraySupported,
} from "./services/background.mjs";

// CDP remote-debugging port: puppeteer-core connects through this; automation drives the <webview> in a separate utilityProcess.
// These switches must be appended before app ready. Only listens on 127.0.0.1.
// remote-allow-origins is essential: since Chrome 111+, the DevTools WebSocket rejects non-browser clients by default,
// and without it puppeteer.connect cannot connect (403).
const REMOTE_DEBUG_PORT = 9222;
app.commandLine.appendSwitch("remote-debugging-port", String(REMOTE_DEBUG_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://localhost:3000";

// The main process does not auto-read .env* the way Next does (that is Next dev server behavior). In dev, following Next's
// precedence, load the project root's .env files into process.env for main-process logic (e.g. Google login reading the client id).
// After packaging these files usually do not exist, so silently skip (for packaged distribution, prefer injecting the client id via app.config).
if (isDev) loadEnvFiles(path.join(__dirname, ".."), process.env.NODE_ENV || "development");

// Single-instance lock: on Windows/Linux, a `zeraix://` deep link launches this app as a "new process + argv carrying the URL",
// so the single-instance lock must hand it back to the first instance; otherwise every link click spawns another app window.
// Failing to acquire the lock = we are the second instance launched by a deep link: hand the URL to the first instance and quit immediately (see second-instance).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Register as the default handler for the zeraix:// protocol (registered dynamically in dev, declared by electron-builder when packaged).
registerProtocolClient();

// Cold start with a deep link (Windows/Linux: clicking a link while the app is not running -> the URL is in argv on first launch).
// Before app ready we can only stash it and process it once the window is ready. macOS cold start goes through open-url, see the listener below.
let pendingDeepLink = findDeepLink(process.argv);

/** Bring the main window to the foreground (restore if minimized, show and focus if hidden); create a new one if none exists. */
function focusMainWindow() {
  onWindowShown(); // cancel a pending local-model release: the user is back
  // macOS: the dock icon is hidden while running in the background, restore it before showing.
  if (process.platform === "darwin") app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Ensure a loaded main window exists, then return it. Unlike focusMainWindow this awaits the initial
 * page load, so callers that immediately send to webContents (notification click -> route:navigate)
 * do not fire before the renderer is listening. Needed because background mode can have no window.
 */
async function ensureMainWindow() {
  onWindowShown();
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (process.platform === "darwin") app.dock?.show();
    await createWindow();
    return mainWindow;
  }
  focusMainWindow();
  return mainWindow;
}

/** Perform a real quit (tray "Quit"): flip the latch first so the window `close` handler stops hiding. */
function quitApp() {
  isQuitting = true;
  destroyTray();
  app.quit();
}

/**
 * Idle grace period before a hidden window releases the local model. Long enough that hiding and
 * reopening does not pay the multi-GB reload cost, short enough that a tray-resident app is not
 * quietly holding that memory for the rest of the session.
 */
const LOCAL_MODEL_IDLE_MS = 5 * 60 * 1000;
let localModelIdleTimer = null;

/**
 * The window just went to the background. Schedule release of the expensive resident cost: a
 * llama.cpp server parked in the tray means multiple GB held permanently on the user's machine,
 * which is exactly what makes people kill the process. It restarts on demand on next use.
 */
function onWindowHidden() {
  clearTimeout(localModelIdleTimer);
  localModelIdleTimer = setTimeout(() => {
    // Never yank the model out from under a running generation -- an in-flight stream means the
    // user (or a scheduled automation) is still working, hidden window or not.
    if (llmStreamControllers.size > 0) {
      onWindowHidden(); // still busy: re-arm rather than dropping the check entirely
      return;
    }
    try {
      localLlm.stop();
    } catch {
      /* ignore -- nothing running */
    }
  }, LOCAL_MODEL_IDLE_MS);
}

/** The window came back: cancel any pending local-model release. */
function onWindowShown() {
  clearTimeout(localModelIdleTimer);
  localModelIdleTimer = null;
}

/**
 * Handle one `zeraix://…` deep link: bring the app to the foreground and forward the parsed structure to the renderer
 * (for optional in-app routing after login completes). If the app is not ready, stash it first; the startup flow processes it after ready.
 */
function handleDeepLink(url) {
  if (!url) return;
  if (!app.isReady()) {
    pendingDeepLink = url;
    return;
  }
  console.log("[deep-link] launched by:", url);
  focusMainWindow();
  try {
    const u = new URL(url);
    mainWindow?.webContents.send("deep-link", {
      url,
      host: u.host,
      pathname: u.pathname,
      params: Object.fromEntries(u.searchParams),
    });
  } catch {
    /* Invalid URL: the window is already in the foreground, ignore the parse failure */
  }
}

// Windows/Linux: a second instance (usually launched by a deep link) starts -> the first instance receives its argv here,
// extracts the deep link, and brings the window to the foreground.
app.on("second-instance", (_e, argv) => {
  focusMainWindow();
  handleDeepLink(findDeepLink(argv));
});

// macOS: the system delivers deep links via the open-url event (may arrive before app ready; handleDeepLink stashes it internally).
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Safety net: any uncaught exception / unhandled rejection in the main process is merely logged, never allowed to bring the whole app down.
// (For example, built-in browser load failures, automation/child-process async errors, etc. must not take down the main window.)
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception (ignored, app keeps running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled promise rejection (ignored):", reason);
});

/** Next.js static export directory (distDir: "Zeraix" in next.config.ts) */
const WEB_ROOT = path.join(app.getAppPath(), "Zeraix");

/** Custom protocol for loading static export files in production (file:// cannot handle absolute-path resources) */
const APP_SCHEME = "app";
const APP_URL = `${APP_SCHEME}://localhost/`;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/**
 * Resolve the request path following Next.js static-export routing rules:
 * /foo -> foo | foo.html | foo/index.html, finally falling back to 404.html / index.html
 */
async function handleAppRequest(request) {
  const { pathname } = new URL(request.url);
  const decoded = decodeURIComponent(pathname);
  // Strip leading slashes and prevent path traversal
  const rel = path
    .normalize(decoded)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.([/\\]|$))+/, "");

  const candidates =
    rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
  candidates.push("404.html", "index.html");

  for (const candidate of candidates) {
    try {
      const data = await fs.promises.readFile(path.join(WEB_ROOT, candidate));
      let type =
        MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
      // Next.js static export writes RSC/segment-cache payloads as .txt (full-page `<route>.txt` and prefetch `__next.*.txt`).
      // The App Router client strictly validates that their content-type must be text/x-component, otherwise client navigation throws
      // (E394 "unexpected response"): router.push falls back to __pendingUrl for a full-page hard redirect and "looks normal",
      // but <Link>, which takes the prefetch/segment-cache path, has no such fallback and silently does nothing on click (exactly the case for the sidebar "Skills/Automation").
      // This directory is a pure Next export where all .txt files are RSC payloads, so return them uniformly as text/x-component.
      if (candidate.endsWith(".txt")) type = "text/x-component";
      return new Response(data, { headers: { "content-type": type } });
    } catch {
      // Try the next candidate path
    }
  }
  return new Response("Not Found", { status: 404 });
}

let mainWindow = null;
let splashWindow = null;
/** True once a real quit is under way, so the window `close` handler stops hiding and lets it through. */
let isQuitting = false;

/** Main window ready: show the main window (the splash screen has been removed, splashWindow is always null, so it takes the direct-show branch). Safe to call repeatedly (idempotent). */
let splashDismissed = false;
function dismissSplash() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (!splashWindow) {
    mainWindow?.show();
    return;
  }
  // Trigger the page fade-out animation before closing for a smoother transition; the main window is shown at the end of the animation to avoid overlap.
  splashWindow.webContents
    .executeJavaScript(`document.getElementById("stage")?.classList.add("leaving")`)
    .catch(() => {});
  setTimeout(() => {
    try {
      splashWindow?.close();
    } catch {
      /* ignore */
    }
    mainWindow?.show();
    mainWindow?.focus();
  }, 320);
}

async function createWindow() {
  // Reset the one-shot show latch: the window can legitimately be created more than once now
  // (tray "Open" after a --background cold start, or macOS dock activate), and a stale `true` here
  // would leave every subsequent window hidden forever.
  splashDismissed = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    // Stay hidden until content is ready; the splash screen covers the blank loading window (see dismissSplash)
    show: false,
    // Frameless window: no native title bar / overlay buttons; window controls are all drawn by the renderer
    // (/agent uses sidebar traffic lights, legacy pages use the TitleBar right-side buttons -- see the windowControls bridge).
    // Windows/Linux: drop titleBarOverlay, otherwise the system draws native minimize/maximize/close in the top-right corner.
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // Enable <webview> (automation target)
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Open external links in the system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Built-in <webview> opening a new tab: the guest's window.open / target=_blank (e.g. Baidu results) -> intercept, then notify
  // the renderer to open a new tab in the browser panel. did-attach-webview is the canonical hook for accessing the webview guest.
  mainWindow.webContents.on("did-attach-webview", (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      console.log("[webview window-open]", url);
      if (/^https?:\/\//.test(url)) mainWindow?.webContents.send("webview:new-tab", { url });
      return { action: "deny" };
    });
    // Built-in browser load failure (e.g. a local dev server not yet started for preview -> ERR_CONNECTION_REFUSED):
    // only log it; the guest itself shows an error page; never bubble up as a main-process crash.
    guest.on("did-fail-load", (_ev, code, desc, url) => {
      if (code === -3) return; // ERR_ABORTED: navigation superseded by a new navigation, normally ignored
      console.warn(`[webview] load failed ${code} ${desc}: ${url}`);
    });
    guest.on("render-process-gone", (_ev, details) => {
      console.warn("[webview] guest process gone:", details?.reason);
    });
  });

  // Renderer (main window) crash: only log it, leaving a manual refresh to the developer / user.
  // Note: do not auto-reload here -- if the renderer keeps crashing it would cause an infinite refresh loop.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] renderer process gone:", details?.reason);
  });

  // Sync the maximize state to the renderer to drive the icon toggle of the self-drawn "zoom" button.
  const emitMaximize = () =>
    mainWindow?.webContents.send("window:maximize-changed", mainWindow.isMaximized());
  mainWindow.on("maximize", emitMaximize);
  mainWindow.on("unmaximize", emitMaximize);

  // Dismiss the splash screen and show the main window as soon as the first content frame is ready (ready-to-show fires before loadURL resolves,
  // minimizing the blank period). Safety net: in case ready-to-show never fires, force-dismiss after load completes too.
  mainWindow.once("ready-to-show", dismissSplash);

  // Background mode: closing the window hides it instead of tearing it down, so the scheduler (and
  // any in-flight run) survives. A real quit goes through before-quit, which sets isQuitting first.
  mainWindow.on("close", (e) => {
    if (isQuitting || !isBackgroundEnabled()) return;
    e.preventDefault();
    mainWindow?.hide();
    if (process.platform === "darwin") app.dock?.hide();
    onWindowHidden();
  });

  // Drop the reference once the window is actually gone; otherwise focusMainWindow would call
  // methods on a destroyed BrowserWindow instead of creating a fresh one.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    await mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadURL(APP_URL);
  }
  dismissSplash();
}

/** AI toolkit IPC: renderer window.aiTools.* -> main process execution (fs / child process) */
// Built-in terminal: renderer xterm.js <-> main-process node-pty session. create returns the session id (via invoke);
// write/resize/kill are high-frequency/one-way messages (via send). PTY output is pushed back to the originating window via terminal:data / terminal:exit.
function registerTerminal() {
  ipcMain.handle("terminal:create", (e, opts) => createTerminal(e.sender, opts || {}));
  ipcMain.on("terminal:write", (_e, { id, data }) => writeTerminal(id, data));
  ipcMain.on("terminal:resize", (_e, { id, cols, rows }) => resizeTerminal(id, cols, rows));
  ipcMain.on("terminal:kill", (_e, id) => killTerminal(id));
  // Terminate all PTY sessions owned by the originating window (fully kill all terminal background processes when the file sidebar is closed).
  ipcMain.on("terminal:kill-all", (e) => killByWebContents(e.sender));
}

function registerAiTools() {
  ipcMain.handle("ai-tools:list", (_e, format) => listTools(format));
  ipcMain.handle("ai-tools:call", (_e, { name, args }) => runTool(name, args));
  ipcMain.handle("ai-tools:get-workdir", () => getWorkingDir());
  ipcMain.handle("ai-tools:set-workdir", (_e, dir) => setWorkingDir(dir));
  // Workspace file browsing (sidebar file tree + right-side editor): structured directory listing, file reading with openability detection, and file saving.
  ipcMain.handle("workspace:read-dir", (_e, relPath) => wsReadDir(relPath || ""));
  ipcMain.handle("workspace:read-file", (_e, relPath) => wsReadFile(relPath));
  ipcMain.handle("workspace:write-file", (_e, { path: p, content }) => wsWriteFile(p, content));
  // Project-level skill discovery: scan skill files in directories like .claude/.cursor/.zeraix, read/write the user's
  // "add / ignore" decisions in .zeraix/config.json, and read individual skill content (for "view content") and enabled skill bodies (for feeding the agent).
  ipcMain.handle("project-skills:discover", () => discoverProjectSkills());
  ipcMain.handle("project-skills:decide", (_e, { path: p, enabled }) => setProjectSkillDecision(p, enabled));
  ipcMain.handle("project-skills:read", (_e, relPath) => readProjectSkillFile(relPath));
  ipcMain.handle("project-skills:load-enabled", () => loadEnabledProjectSkills());
  // Save chat attachments to the working directory so the model can process them directly with file tools/sandbox commands.
  //  - Real disk file: payload={ name, srcPath }, the main process does a kernel-level copy by host path, bytes never go through IPC;
  //  - Synthetic file with no host path: goes through the transfer channel below (MessagePort hands over bytes, see transferBridge.mjs).
  ipcMain.handle("ai-tools:save-attachment", (_e, payload) => saveAttachment(payload));
  // Generic "renderer -> main process" bulk-data transfer channel + attachment byte-transfer handler (synthetic files take this path).
  installTransferBridge();
  onTransfer("save-attachment", (meta, buffer) => saveAttachment({ name: meta?.name, bytes: buffer }));
  // Background service (dev server, etc.) start/stop events -> broadcast to all windows (GlobalNotifications shows "running projects").
  setServiceEventHandler((evt) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("services:event", evt);
  });
  // Stop a background service (by pid); list current background services (initial sync).
  ipcMain.handle("ai-tools:stop-process", (_e, pid) => stopProcess(pid));
  ipcMain.handle("ai-tools:list-processes", () => listProcesses());
  // Sandbox status: initial sync + mode routing (only everyday mode uses the sandbox) + initialization progress broadcast to all windows.
  ipcMain.handle("sandbox:get-status", () => getSandboxStatus());
  ipcMain.handle("sandbox:set-mode", (_e, mode) => setSandboxMode(mode));
  // VM image directory (for the sandbox startup dialog to display / open the folder): dynamically load qemu.mjs on demand to compute the static path.
  ipcMain.handle("sandbox:vm-dir", async () => {
    try { const m = await import("./tools/sandbox/qemu.mjs"); return m.vmImageDir(); } catch { return null; }
  });
  // VM image version / install info (for the dialog to display the version and decide whether an "update" is needed).
  ipcMain.handle("sandbox:vm-info", () => sandboxVmInfo());
  // Update the runtime environment: stop the current VM -> reinitialize and force-download the target version from versions.json (delete the old image after download completes).
  ipcMain.handle("sandbox:update", () => restartSandbox({ update: true }));
  // Restart the runtime environment (without forcing a download): bring the VM back up from the existing image after it crashes/exits.
  ipcMain.handle("sandbox:restart", () => restartSandbox({}));
  onSandboxStatus((st) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("sandbox:status", st);
  });
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

/** AbortController for each in-flight streaming request, keyed by the stream id generated by the renderer (used by llm:chat:abort to interrupt). */
const llmStreamControllers = new Map();

/** LLM request proxy IPC: renderer window.llm.chat -> main process forwards it (bypassing CORS) */
function registerLlmProxy() {
  ipcMain.handle("llm:chat", (_e, req) => llmChat(req));
  // Streaming: initiated via invoke, pushes deltas to the originating window via llm:chat:chunk, and resolves on completion (same result structure as llmChat).
  // Interruption goes through llm:chat:abort (one-way send), canceling the corresponding AbortController by id.
  ipcMain.handle("llm:chat:stream", async (e, { id, req }) => {
    const controller = new AbortController();
    llmStreamControllers.set(id, controller);
    try {
      return await llmChatStream(
        req,
        (chunk) => {
          if (!e.sender.isDestroyed()) e.sender.send("llm:chat:chunk", { id, chunk });
        },
        controller.signal,
      );
    } finally {
      llmStreamControllers.delete(id);
    }
  });
  ipcMain.on("llm:chat:abort", (_e, id) => {
    llmStreamControllers.get(id)?.abort();
  });
}

/** OSS upload proxy IPC: renderer window.upload.putOSS -> main process PUTs to a presigned URL.
 *  In production the renderer origin is app://localhost, which the Alibaba Cloud OSS bucket's CORS rules usually do not include, so a direct browser PUT would be blocked by the CORS preflight;
 *  instead the main process (Node, not subject to browser CORS) issues the PUT. data is an ArrayBuffer passed over IPC. */
function registerUploadProxy() {
  ipcMain.handle("upload:put-oss", async (_e, { url, contentType, data }) => {
    try {
      const res = await fetch(url, {
        method: "PUT",
        body: Buffer.from(data),
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.message ? String(e.message) : String(e) };
    }
  });
}

/** Local llama.cpp model IPC: hardware probe / recommendation / start-stop / status; status changes are pushed to renderer window.localLlm. */
function registerLocalLlm() {
  localLlm.onStatus((st) => mainWindow?.webContents.send("llm:local:status", st));
  ipcMain.handle("llm:local:hardware", () => localLlm.getHardware());
  ipcMain.handle("llm:local:storageInfo", () => localLlm.storageInfo());
  ipcMain.handle("llm:local:setStorageDir", (_e, dir) => localLlm.setStorageDir(dir));
  ipcMain.handle("llm:local:chooseStorageDir", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: localLlm.storageInfo().dir };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    // Selecting a directory means "change folder": migrate the downloaded runtime/models/logs to the new location (near-instant on the same drive, a copy across drives).
    const r = await localLlm.migrateStorageTo(res.filePaths[0]);
    return { ...localLlm.storageInfo(), migrateOk: r.ok, migrateError: r.error };
  });
  ipcMain.handle("llm:local:migrateStorage", (_e, dir) => localLlm.migrateStorageTo(dir));
  ipcMain.handle("llm:local:installInfo", (_e, opts) => localLlm.installInfo(opts));
  ipcMain.handle("llm:local:installStatus", () => localLlm.installStatus());
  ipcMain.handle("llm:local:install", (_e, opts) => localLlm.install(opts));
  ipcMain.handle("llm:local:probe", (_e, opts) => localLlm.probe(opts));
  ipcMain.handle("llm:local:recommend", (_e, opts) => localLlm.recommend(opts));
  ipcMain.handle("llm:local:start", (_e, opts) => localLlm.start(opts));
  ipcMain.handle("llm:local:stop", () => localLlm.stop());
  ipcMain.handle("llm:local:reset", () => localLlm.reset());
  ipcMain.handle("llm:local:status", () => localLlm.status());
  // Model library: downloaded model list / delete / directory / memory estimate / runtime info.
  ipcMain.handle("llm:local:models", () => localLlm.listDownloaded());
  ipcMain.handle("llm:local:delete", (_e, opts) => localLlm.deleteLocalModel(opts));
  ipcMain.handle("llm:local:models-dir", () => localLlm.modelsDir());
  ipcMain.handle("llm:local:estimate", (_e, opts) => localLlm.estimate(opts));
  ipcMain.handle("llm:local:llama-info", () => localLlm.llamaInfo());
  // Browse tab: Hub GGUF search / one repo's quants + metadata + arch-compat verdict.
  ipcMain.handle("llm:local:hf-search", (_e, opts) => localLlm.hfSearch(opts));
  ipcMain.handle("llm:local:hf-repo", (_e, opts) => localLlm.hfRepo(opts));
}

/** app.config (an INI file alongside the executable) IPC: renderer window.appConfig.* -> main process reads/writes.
 *  get-all-sync uses the synchronous channel, to load file values into the renderer store at startup (avoiding async races). */
function registerAppConfig() {
  loadAppConfig();
  // Pre-populate the [google] section so users can see and fill in Google login credentials directly in app.config
  // (in dev just override with .env; for packaged distribution fill it in here manually). For a distributed
  // Desktop client, both client_id and client_secret are "not treated as secret" and can be shipped with the package; Google's Desktop-client token exchange requires
  // sending client_secret, so both are pre-populated.
  ensureAppConfigKeys("google", ["client_id", "client_secret"]);
  ipcMain.on("appconfig:get-all-sync", (e) => {
    e.returnValue = getAppConfig();
  });
  ipcMain.handle("appconfig:set", (_e, { section, key, value }) =>
    setAppConfig(section, key, value),
  );
  ipcMain.handle("appconfig:remove", (_e, { section, key }) => removeAppConfig(section, key));
  // Open app.config in the system default editor; if the file does not exist, create it on disk first. Returns { ok, path, error? }.
  ipcMain.handle("appconfig:open-file", async () => {
    const p = ensureConfigFile();
    const error = await shell.openPath(p); // Returns "" on success, an error string on failure
    return { ok: !error, path: p, error: error || undefined };
  });
  // Return the absolute path of app.config (for the renderer to display).
  ipcMain.handle("appconfig:get-path", () => getConfigPath());
}

/** Window control IPC: the renderer's self-drawn macOS-style traffic lights -> main process controls the window (minimize / zoom / close) */
function registerWindowControls() {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle("window:minimize", (e) => winOf(e)?.minimize());
  ipcMain.handle("window:toggle-maximize", (e) => {
    const w = winOf(e);
    if (!w) return false;
    if (w.isMaximized()) {
      w.unmaximize();
      return false;
    }
    w.maximize();
    return true;
  });
  ipcMain.handle("window:close", (e) => winOf(e)?.close());
  ipcMain.handle("window:is-maximized", (e) => !!winOf(e)?.isMaximized());
  // Window always-on-top: query / set / toggle. The always-on-top state decides whether to use an in-app hint or a system notification when "output completes".
  ipcMain.handle("window:is-always-on-top", (e) => !!winOf(e)?.isAlwaysOnTop());
  ipcMain.handle("window:set-always-on-top", (e, on) => {
    const w = winOf(e);
    if (!w) return false;
    w.setAlwaysOnTop(!!on);
    const next = w.isAlwaysOnTop();
    w.webContents.send("window:always-on-top-changed", next); // Broadcast the new state; the renderer syncs the button / hint strategy
    return next;
  });
  ipcMain.handle("window:toggle-always-on-top", (e) => {
    const w = winOf(e);
    if (!w) return false;
    const next = !w.isAlwaysOnTop();
    w.setAlwaysOnTop(next);
    w.webContents.send("window:always-on-top-changed", next);
    return next;
  });
  // macOS only: hide / restore the native traffic lights on demand. Hidden when the /agent module mounts (handed over to the sidebar's
  // self-drawn buttons), restored when leaving, to prevent other pages that still rely on the native traffic lights from losing window controls.
  ipcMain.handle("window:set-native-buttons", (e, visible) => {
    if (process.platform !== "darwin") return;
    winOf(e)?.setWindowButtonVisibility(!!visible);
  });
  // Open a path (file or folder) in the system file manager / default app: for UI like the sidebar's "Open Folder" to call.
  ipcMain.handle("shell:open-path", async (_e, p) => {
    if (!p || typeof p !== "string") return { ok: false, error: "empty path" };
    const error = await shell.openPath(p); // Returns "" on success, an error string on failure
    return { ok: !error, error: error || undefined };
  });
}

/**
 * Background / tray mode IPC: renderer window.background.* -> main process.
 * The renderer also pushes its translated tray labels here on load, because the main process has no
 * i18n runtime and the tray must render on a headless start with no renderer at all (see background.mjs).
 */
function registerBackground() {
  // ipcMain.handle("background:get", () => ({
  //   enabled: isBackgroundEnabled(),
  //   openAtLogin: isOpenAtLogin(),
  //   paused: isPaused(),
  //   // The tray is the only way back into a windowless app; without it, background mode is unsafe
  //   // to offer at all (common on minimal Linux desktops with no StatusNotifier host).
  //   traySupported: isTraySupported(),
  // }));
  // ipcMain.handle("background:set-enabled", (_e, on) => setBackgroundEnabled(on));
  // ipcMain.handle("background:set-open-at-login", (_e, on) => setOpenAtLogin(on));
  // ipcMain.handle("background:set-paused", (_e, on) => setPaused(on));
  // ipcMain.on("background:set-tray-labels", (_e, labels) => setTrayLabels(labels));
}

function registerAgentStore() {
  ipcMain.handle("agent-store:load-index", () => loadIndex());
  ipcMain.handle("agent-store:load-project", (_e, id) => loadProject(id));
  ipcMain.handle("agent-store:save-index", (_e, projects) => saveIndex(projects));
  ipcMain.handle("agent-store:save-project", (_e, { id, conversations }) => saveProject(id, conversations));
  ipcMain.handle("agent-store:delete-project", (_e, id) => deleteProject(id));
  ipcMain.handle("agent-store:get-path", () => getStorePath());
  ipcMain.handle("agent-store:set-path", (_e, dir) => setStorePath(dir));
  // Pop up a native directory picker; the selection becomes the storage directory (migrate data and persist), returning the new file path; return null on cancel.
  ipcMain.handle("agent-store:choose-path", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: path.dirname(getStorePath()) };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return setStorePath(res.filePaths[0]);
  });
}

/**
 * Chat integrity IPC: renderer window.chatIntegrity.* -> main process manages the deviceId, encryption status,
 * and each conversation's integrity metadata sidecar (version/hash/signature, pure metadata, no body).
 * Encryption itself is transparent to the renderer (conversationStore encrypts/decrypts automatically on disk I/O).
 */
function registerIntegrity() {
  ipcMain.handle("integrity:get-device-id", () => getDeviceId());
  ipcMain.handle("integrity:encryption-status", () => encryptionStatus());
  ipcMain.handle("integrity:load-meta", (_e, chatId) => loadMeta(chatId));
  ipcMain.handle("integrity:save-meta", (_e, { chatId, meta }) => saveMeta(chatId, meta));
  ipcMain.handle("integrity:delete-meta", (_e, chatId) => deleteMeta(chatId));
  ipcMain.handle("integrity:list-meta", () => listMeta());
}

/**
 * File-based memory IPC: renderer window.memoryFiles.* -> main process reads/writes userData/memories/<id>.md.
 * One Markdown file per memory; written by the AI's save_memory tool, and listed/deleted/directory-opened by the renderer.
 */
function registerMemoryFiles() {
  ipcMain.handle("memory-md:save", (_e, input) => saveMemoryFile(input || {}));
  ipcMain.handle("memory-md:list", () => listMemoryFiles());
  ipcMain.handle("memory-md:delete", (_e, id) => deleteMemoryFile(id));
  ipcMain.handle("memory-md:open-dir", () => openMemoryDir());
  // Import: pop up a native file picker (multi-select .md/.markdown/.txt allowed), parse each and save as a memory. Returns { imported }.
  ipcMain.handle("memory-md:import", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown / Text", extensions: ["md", "markdown", "txt"] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { imported: 0 };
    const items = importFromPaths(res.filePaths);
    return { imported: items.length };
  });
  // Download template: pop up a save dialog and write out a memory template .md (random id, timestamp of the download moment). Returns { ok, path? }.
  ipcMain.handle("memory-md:download-template", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      defaultPath: "memory-template.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      saveTemplateFile(res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  // One-click export: package all memories into a ZIP. Returns { ok:false, empty:true } when there are no memories. Returns { ok, path?, count? }.
  ipcMain.handle("memory-md:export-zip", async (e) => {
    if (countMemoryFiles() === 0) return { ok: false, empty: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { defaultPath: "memories.zip", filters: [{ name: "ZIP", extensions: ["zip"] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      const count = exportMemoriesZip(res.filePath);
      return { ok: true, path: res.filePath, count };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/**
 * <webview> automation IPC: renderer window.automation.* -> main process runs puppeteer-core in a separate utilityProcess,
 * connecting via the CDP remote-debugging port and watching the <webview> page; when triggers like a search hit, events are relayed back to the renderer.
 * The automation code is isolated from the main / renderer threads, so a crash does not affect the main process.
 */
let automationChild = null;
const automationPending = new Map(); // action id -> resolve
let automationActionSeq = 0;
function registerAutomation() {
  const relay = (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("automation:event", msg);
    }
  };
  const ensureChild = () => {
    if (automationChild) return automationChild;
    automationChild = utilityProcess.fork(path.join(__dirname, "automation", "cdpAgent.cjs"), [], {
      serviceName: "cdp-automation",
      stdio: "inherit",
    });
    automationChild.on("message", (msg) => {
      // action-result: resolve the corresponding action Promise; forward all other messages to the renderer (status / triggers).
      if (msg && msg.type === "action-result") {
        const resolve = automationPending.get(msg.id);
        if (resolve) {
          automationPending.delete(msg.id);
          resolve(msg);
        }
        return;
      }
      relay(msg);
    });
    automationChild.on("exit", () => {
      automationChild = null;
      // Child process exit: fail all pending actions.
      for (const [, resolve] of automationPending) resolve({ ok: false, error: "Automation process has exited" });
      automationPending.clear();
    });
    return automationChild;
  };
  ipcMain.handle("automation:start", (_e, config) => {
    ensureChild().postMessage({ type: "start", config: { ...config, port: REMOTE_DEBUG_PORT } });
    return true;
  });
  ipcMain.handle("automation:stop", () => {
    automationChild?.postMessage({ type: "stop" });
    return true;
  });
  // Current active tab URL -> let the automation process attach CDP to the corresponding webview (locate the active page when there are multiple tabs).
  ipcMain.handle("automation:set-active-url", (_e, url) => {
    automationChild?.postMessage({ type: "active-url", url });
    return true;
  });
  // Dispatch a page action (read / links / click / type / navigate) and wait for the child process to relay the result.
  ipcMain.handle("automation:action", (_e, payload) => {
    const child = ensureChild();
    const id = ++automationActionSeq;
    return new Promise((resolve) => {
      automationPending.set(id, resolve);
      child.postMessage({ type: "action", id, action: payload?.action, params: payload?.params ?? {} });
      setTimeout(() => {
        if (automationPending.has(id)) {
          automationPending.delete(id);
          resolve({ ok: false, error: "Action timed out" });
        }
      }, 30000);
    });
  });
  // Save a built-in browser screenshot (the data URL from the renderer's webview.capturePage) to a temp file and return the path.
  ipcMain.handle("browser:save-shot", (_e, dataUrl) => {
    try {
      const b64 = String(dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return "";
      const file = path.join(app.getPath("temp"), `zeraix-shot-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    } catch (e) {
      console.warn("[browser] failed to save screenshot:", e?.message || e);
      return "";
    }
  });
}

// New-tab handling for the built-in <webview>: when in-site results try to open a new window via target=_blank / window.open (e.g. Baidu),
// intercept and notify the host renderer to open a new tab in the browser panel (aligning with each search engine's navigation behavior, avoiding runaway system window popups).
function registerWebviewWindowOpen() {
  app.on("web-contents-created", (_e, contents) => {
    if (typeof contents.getType === "function" && contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
          const host = contents.hostWebContents || mainWindow?.webContents;
          host?.send("webview:new-tab", { url });
        }
        return { action: "deny" };
      });
    }
  });
}

/** System notification icon: in dev take it from the source public/, when packaged take it from the Next static-export directory Zeraix/. The adapter layer silently ignores it if missing. */
function notificationIconPath() {
  return isDev
    ? path.join(__dirname, "..", "public", "logo.png")
    : path.join(app.getAppPath(), "Zeraix", "logo.png");
}

app.whenReady().then(() => {
  // The second instance (launched by a deep link) already called app.quit() earlier, so skip initializing windows and services and return directly.
  if (!gotSingleInstanceLock) return;
  // Windows: Toast notifications require setting the AppUserModelID (matching the electron-builder appId),
  // otherwise notifications show no app name/icon or do not pop at all. No side effects on macOS/Linux.
  app.setAppUserModelId("com.operease.app");
  // The splash screen has been removed: the app loads the entry (`/`) directly, and the entry page routes to /agent or /login based on login state.
  // The main window shows as soon as the first content frame is ready (ready-to-show); with no splash, dismissSplash is equivalent to directly showing the main window.
  protocol.handle(APP_SCHEME, handleAppRequest);
  // Initialize the encryption master key first (safeStorage needs app ready); afterward conversationStore reads/writes are transparently encrypted/decrypted.
  initIntegrity();
  registerAppConfig();
  registerAiTools();
  registerTerminal();
  // Select the command-execution engine (start a qemu VM in the background if hardware virtualization is available, otherwise keep running natively on the host).
  // Runs asynchronously in the background; on failure it silently falls back to native without affecting startup.
  initEngine();
  registerLlmProxy();
  registerUploadProxy();
  registerLocalLlm();
  registerWindowControls();
  registerAgentStore();
  registerIntegrity();
  registerMemoryFiles();
  // System-level notifications (renderer window.notification.* -> queue/coalesce/throttle -> OS notification; click relays route:navigate)
  const notificationService = registerNotifications({
    getWindow: () => mainWindow,
    // Background mode: a click on an automation notification must open the app, not fall on the floor.
    ensureWindow: ensureMainWindow,
    iconPath: notificationIconPath(),
  });
  // Automation uses this to nudge the user when a run is waiting on their approval.
  setAutomationNotifier(notificationService);
  // Google login (RFC 8252 native flow: loopback service + PKCE + system browser -> id_token handed back to the renderer)
  registerGoogleAuth();
  // Auto-update (GitHub Releases feed; renderer drives check/download/install via window.updater)
  registerUpdater();
  registerAutomation();
  registerWebviewWindowOpen();
  registerBackground();
  // Automation subsystem: fix the storage root and open/migrate the run-state database.
  // A failure here must not block startup -- the rest of the app is fully usable without it.
  try {
    initAutomation();
  } catch (e) {
    console.error("[automation] initialization failed; automation disabled this session:", e);
  }
  // Tray-resident mode: creates the tray when background mode is on (or when this is an autostart
  // launch) and re-applies the login-item registration.
  const background = initBackground({ onOpen: focusMainWindow, onQuit: quitApp });

  // Autostart launches come up headless -- tray only, no window. Any deep link arriving later, a
  // tray click, or macOS dock activate creates the window on demand via focusMainWindow.
  // `background.active` is false when no tray could be created: staying headless there would leave
  // an invisible, unreachable process, so fall back to showing the window normally.
  const headless = isBackgroundLaunch() && background.active && !pendingDeepLink;
  if (headless) {
    console.log("[background] started headless (tray only)");
    // macOS: keep the dock icon out of the way until the user actually opens a window.
    if (process.platform === "darwin") app.dock?.hide();
  } else {
    createWindow();
  }

  // A deep link present at cold start (Windows/Linux argv / an early open-url on macOS) is processed once the window is ready.
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    handleDeepLink(url);
  }

  // macOS: recreate the window when the Dock icon is clicked and there are no windows
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Let the window `close` handler through: from here on a close is a real teardown, not a hide.
  // Covers every quit path (tray Quit, macOS Cmd-Q, updater restart, OS shutdown).
  isQuitting = true;
  // Kill the automation child process before quitting to avoid it hanging.
  try {
    automationChild?.kill();
  } catch {
    /* ignore */
  }
  // Terminate all built-in terminal PTY sessions before quitting to avoid leftover shell processes.
  try {
    killAllTerminals();
  } catch {
    /* ignore */
  }
  // Kill the local llama-server child process before quitting to avoid a leftover orphan process holding the port.
  try {
    localLlm.stop();
  } catch {
    /* ignore */
  }
  // Kill AI-started background processes (dev server / watcher, etc.) and shut down the sandbox VM (if in use),
  // to avoid leftover orphan processes holding ports after quit.
  try {
    disposeEngines();
  } catch {
    /* ignore */
  }
  // Abort in-flight automation runs (killing their child process trees) before closing the database,
  // so a quit does not leave orphaned processes behind.
  try {
    shutdownAutomation();
  } catch {
    /* ignore */
  }
  // Close the automation database so WAL is checkpointed rather than left for recovery on next open.
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

app.on("window-all-closed", () => {
  // Background mode: stay resident so the automation scheduler keeps running with no window open.
  // The tray is the only way back in, so this must never be reached without a tray present
  // (initBackground guarantees one whenever background mode or a --background launch is active).
  if (isBackgroundEnabled()) return;
  // macOS convention: the app stays active after all windows are closed
  if (process.platform !== "darwin") app.quit();
});
