/**
 * Crash recovery IPC (docs/agent-runtime-crash-recovery.md C9 / C10): renderer window.recovery.* -> main process.
 *
 * Whether the previous session died, and the log of what the app did about it. Read-only; the renderer shows a
 * one-time notice and, later, a Diagnostics view. Plus the crash page's two buttons.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { readRecoveryLog, recoveryLogPath } from "../store/recoveryLog.mjs";
import { lastSession } from "../store/sessionLock.mjs";
import { bridgeStatus as rustBridgeStatus } from "../tools/rustRuntime.mjs";

/** `crashPolicyFor` and `loadAppInto` come from main/window.mjs, which owns each window's crash record and the app URL. */
export function registerRecovery({ crashPolicyFor, loadAppInto }) {
  ipcMain.handle("recovery:last-session", () => lastSession());
  ipcMain.handle("recovery:read", (_e, limit) => readRecoveryLog(Number.isInteger(limit) ? limit : 200));
  ipcMain.handle("recovery:log-path", () => recoveryLogPath());
  ipcMain.handle("recovery:bridge-status", () => rustBridgeStatus());
  // The crash page's two buttons. It is loaded into the same webContents, so it reaches these through the ordinary
  // preload. "Try again" navigates rather than reloading (webContents.reload() would only redraw the crash page) and
  // clears the crash record first: the user asking to retry is what grants a fresh budget, never the app itself.
  ipcMain.on("recovery:reload-window", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    crashPolicyFor(win)?.reset();
    void loadAppInto(win);
  });
  ipcMain.on("recovery:quit-app", () => app.quit());
}
