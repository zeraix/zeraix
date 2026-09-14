/**
 * Chat integrity IPC: renderer window.chatIntegrity.* -> main process manages the deviceId
 * and each conversation's integrity metadata sidecar (version/hash/signature, pure metadata, no body).
 */
import { ipcMain } from "electron";
import { getDeviceId, loadMeta, saveMeta, deleteMeta, listMeta } from "../integrity/integrityStore.mjs";

export function registerIntegrity() {
  ipcMain.handle("integrity:get-device-id", () => getDeviceId());
  ipcMain.handle("integrity:load-meta", (_e, chatId) => loadMeta(chatId));
  ipcMain.handle("integrity:save-meta", (_e, { chatId, meta }) => saveMeta(chatId, meta));
  ipcMain.handle("integrity:delete-meta", (_e, chatId) => deleteMeta(chatId));
  ipcMain.handle("integrity:list-meta", () => listMeta());
}
