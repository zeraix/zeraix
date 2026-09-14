/**
 * The main window: creating it, loading the app into it, bringing it back, and the latch that tells a hide from a
 * real quit.
 *
 * Other modules reach the window through getMainWindow() instead of keeping a reference: it can be destroyed and
 * created again (tray "Open" after a --background cold start, macOS dock activate).
 */
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { createCrashPolicy } from "../rendererRecovery.mjs";
import { recordRecovery } from "../store/recoveryLog.mjs";
// First-launch agreement to the Privacy Policy and the Terms of Service; gates every window. See legal/consentWindow.mjs.
import { isLegalAccepted } from "../legal/consentWindow.mjs";
import { windowIconPath } from "../appIdentity.mjs";
import { bringWindowToFront } from "../windowFocus.mjs";
import { destroyTray, isBackgroundEnabled } from "../services/background.mjs";
import { DEV_SERVER_URL, ELECTRON_DIR, isDev } from "./env.mjs";
import { APP_URL } from "./appProtocol.mjs";
import { onWindowHidden, onWindowShown } from "./localModelIdle.mjs";

let mainWindow = null;
let splashWindow = null;
/** True once a real quit is under way, so the window `close` handler stops hiding and lets it through. */
let isQuitting = false;
/** Each window's renderer-crash record (electron/rendererRecovery.mjs). Weak, so a closed window is not retained. */
const crashPolicies = new WeakMap();
export const crashPolicyFor = (win) => crashPolicies.get(win);

/** The main window, or null: background mode can run with none, and a closed window is dropped. */
export const getMainWindow = () => mainWindow;

/** A real quit is under way (before-quit): from here on a close is a teardown, not a hide. */
export function markQuitting() {
  isQuitting = true;
}

/** Bring the main window to the foreground (restore if minimized, show and focus if hidden); create a new one if none exists. */
export function focusMainWindow() {
  onWindowShown(); // cancel a pending local-model release: the user is back
  // macOS: the dock icon is hidden while running in the background, restore it before showing.
  if (process.platform === "darwin") app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  bringWindowToFront(mainWindow);
}

/**
 * Ensure a loaded main window exists, then return it. Unlike focusMainWindow this awaits the initial
 * page load, so callers that immediately send to webContents (notification click -> route:navigate)
 * do not fire before the renderer is listening. Needed because background mode can have no window.
 */
export async function ensureMainWindow() {
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
export function quitApp() {
  isQuitting = true;
  destroyTray();
  app.quit();
}

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

export async function createWindow() {
  // Nothing opens ahead of the consent screen: a tray click or a deep link arriving while it is up gets a
  // window only once it has been answered (see legal/consentWindow.mjs).
  if (!isLegalAccepted()) return;
  // Reset the one-shot show latch: the window can legitimately be created more than once now
  // (tray "Open" after a --background cold start, or macOS dock activate), and a stale `true` here
  // would leave every subsequent window hidden forever.
  splashDismissed = false;
  // Dev only (null when packaged): without it `electron .` shows Electron's own icon on the taskbar / in the Dock.
  const icon = windowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
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
      preload: path.join(ELECTRON_DIR, "preload.cjs"),
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

  // Renderer (main window) crash: reload it, up to a bound (docs/agent-runtime-crash-recovery.md C7).
  //
  // This used to only log, on the grounds that auto-reloading a renderer that crashes on load spins forever. That is
  // right about the danger and wrong about the conclusion: the fix for a loop is a bound, not a blank window. A crash
  // is far more often one bad frame than a page that cannot load, the conversation is on disk either way, and the
  // interrupted turn is reported by its own checkpoint when the conversation is reopened. Past the bound the loop is
  // real, and the window says so instead of flickering.
  const crashPolicy = createCrashPolicy();
  crashPolicies.set(mainWindow, crashPolicy);
  // Starts the renderer's uptime clock. Deliberately NOT a reset: a page that loads and then dies a second later
  // would clear its own record on every attempt, so the bound would never be reached and the reload would loop —
  // which is the failure the bound exists to prevent. Only surviving STABLE_MS forgives the history.
  mainWindow.webContents.on("did-finish-load", () => crashPolicy.noteLoaded());
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const verdict = crashPolicy.onCrash(details, { quitting: isQuitting });
    if (verdict.action === "ignore") return; // our own teardown reported as clean-exit / killed
    console.error(`[main] renderer process gone: ${verdict.reason} (${verdict.count} in the last 5 min)`);
    // C10: the one record of a renderer crash that outlives the session. The interrupted TURN is recorded separately
    // by the renderer's own checkpoint (Conversation.turnState) and reported when that conversation is reopened.
    recordRecovery("renderer", "process-gone", {
      reason: verdict.reason,
      exitCode: details?.exitCode ?? null,
      crashesInWindow: verdict.count,
      action: verdict.action,
    });
    if (mainWindow?.isDestroyed()) return;
    if (verdict.action === "reload") {
      mainWindow.webContents.reload();
      return;
    }
    // Persistent: stop reloading and show what happened, with the log path for a bug report. Its own did-finish-load
    // starts an uptime clock that will never matter — the page is static and cannot crash — and "Try again" resets
    // the record explicitly, which is the user asking for a fresh budget rather than the app granting itself one.
    void mainWindow.loadFile(path.join(ELECTRON_DIR, "crash.html")).catch((e) => {
      console.error("[main] could not show the crash page:", e?.message ?? e);
    });
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
    await loadAppInto(mainWindow);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await loadAppInto(mainWindow);
  }
  dismissSplash();
}

/**
 * Point a window at the app itself.
 *
 * Factored out of createWindow because the crash page needs the same thing: its "Try again" button has to navigate
 * back to the app, and `webContents.reload()` there would only reload the crash page (see render-process-gone).
 */
export function loadAppInto(win) {
  return win.loadURL(isDev ? DEV_SERVER_URL : APP_URL);
}

// New-tab handling for the built-in <webview>: when in-site results try to open a new window via target=_blank / window.open (e.g. Baidu),
// intercept and notify the host renderer to open a new tab in the browser panel (aligning with each search engine's navigation behavior, avoiding runaway system window popups).
export function registerWebviewWindowOpen() {
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
