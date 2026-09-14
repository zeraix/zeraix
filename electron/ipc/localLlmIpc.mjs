/**
 * Local llama.cpp model IPC: hardware probe / recommendation / start-stop / status; status changes are pushed to renderer window.localLlm.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import * as localLlm from "../llm/localServer.mjs";

/** `getWindow` returns the main window (or null), which receives the status pushes. */
export function registerLocalLlm({ getWindow }) {
  localLlm.onStatus((st) => getWindow()?.webContents.send("llm:local:status", st));
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
  // The renderer deleted conversations -> drop their persisted KV (see localServer.eraseConversationsKv). A list,
  // because deleting one conversation also deletes every sub-agent conversation it ran.
  ipcMain.handle("llm:local:eraseConversationKv", (_e, id) => localLlm.eraseConversationKv(id));
  ipcMain.handle("llm:local:eraseConversationsKv", (_e, ids) => localLlm.eraseConversationsKv(ids));
  ipcMain.handle("llm:local:models-dir", () => localLlm.modelsDir());
  ipcMain.handle("llm:local:estimate", (_e, opts) => localLlm.estimate(opts));
  ipcMain.handle("llm:local:llama-info", () => localLlm.llamaInfo());
  // Browse tab: Hub GGUF search / one repo's quants + metadata + arch-compat verdict.
  ipcMain.handle("llm:local:hf-search", (_e, opts) => localLlm.hfSearch(opts));
  ipcMain.handle("llm:local:hf-repo", (_e, opts) => localLlm.hfRepo(opts));
}
