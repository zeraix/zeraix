/**
 * Conversation store and media library IPC: renderer window.agentStore.* and window.mediaStore.* -> main process.
 *
 * Together because the media library lives under the data storage location: moving one moves the other.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import {
  loadIndex,
  loadProject,
  saveIndex,
  saveProject,
  deleteProject,
  getStorePath,
  setStorePath,
} from "../store/conversationStore.mjs";
import { readIndex, writeIndex, saveMedia, openMediaDir, getMediaDir } from "../mediaStore.mjs";
import { syncAssetRoot } from "../main/assetRoot.mjs";

export function registerAgentStore() {
  ipcMain.handle("agent-store:load-index", () => loadIndex());
  ipcMain.handle("agent-store:load-project", (_e, id) => loadProject(id));
  ipcMain.handle("agent-store:save-index", (_e, projects) => saveIndex(projects));
  ipcMain.handle("agent-store:save-project", (_e, { id, conversations }) => saveProject(id, conversations));
  ipcMain.handle("agent-store:delete-project", (_e, id) => deleteProject(id));
  ipcMain.handle("agent-store:get-path", () => getStorePath());
  ipcMain.handle("agent-store:media-path", () => syncAssetRoot());
  // The media library. These bypass the read-only guards on purpose — see mediaStore.mjs: those guards exist
  // to stop the MODEL altering originals, and the app is the thing that creates them.
  ipcMain.handle("media:dir", () => getMediaDir() || syncAssetRoot());
  ipcMain.handle("media:read-index", () => readIndex());
  ipcMain.handle("media:write-index", (_e, json) => writeIndex(json));
  ipcMain.handle("media:save", (_e, payload) => saveMedia(payload ?? {}));
  ipcMain.handle("media:open", () => openMediaDir());
  ipcMain.handle("agent-store:set-path", async (_e, dir) => {
    const next = await setStorePath(dir);
    // The library moves with the data, so both roots are re-pointed before the renderer reads anything back.
    syncAssetRoot();
    return next;
  });
  // Pop up a native directory picker; the selection becomes the storage directory (migrate data and persist), returning the new file path; return null on cancel.
  ipcMain.handle("agent-store:choose-path", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: path.dirname(getStorePath()) };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    const next = await setStorePath(res.filePaths[0]);
    syncAssetRoot();
    return next;
  });
}
