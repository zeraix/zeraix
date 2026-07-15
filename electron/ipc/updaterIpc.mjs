/**
 * Auto-update IPC surface. Mirrors the registerNotifications shape in ./notificationIpc.mjs:
 * build a broadcast fn over every window, hand it to the service, register handlers.
 *
 * Channels:
 *   invoke  updater:state    -> { status, version, percent, error, supported, currentVersion }
 *   invoke  updater:check    -> { ok, supported, error? }
 *   invoke  updater:download -> { ok, error? }
 *   invoke  updater:install  -> { ok, error? }   (quits the app on success)
 *   event   updater:state    -> pushed on every state transition (including download progress)
 */
import { BrowserWindow, ipcMain } from "electron";
import { initUpdater, getUpdaterState, checkForUpdates, downloadUpdate, quitAndInstall } from "../services/updater.mjs";

export function registerUpdater() {
  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
  };

  initUpdater(broadcast);

  ipcMain.handle("updater:state", () => getUpdaterState());
  ipcMain.handle("updater:check", () => checkForUpdates());
  ipcMain.handle("updater:download", () => downloadUpdate());
  ipcMain.handle("updater:install", () => quitAndInstall());
}
