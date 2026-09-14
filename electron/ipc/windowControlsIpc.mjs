/**
 * Window control IPC: the renderer's self-drawn macOS-style traffic lights -> main process controls the window
 * (minimize / zoom / close / always-on-top). Also window.shellApi's open-path.
 */
import { BrowserWindow, ipcMain, shell } from "electron";

export function registerWindowControls() {
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
