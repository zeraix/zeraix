/**
 * File-based memory IPC: renderer window.memoryFiles.* -> main process reads/writes userData/memories/<id>.md.
 * One Markdown file per memory; written by the AI's save_memory tool, and listed/deleted/directory-opened by the renderer.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  saveMemoryFile,
  listMemoryFiles,
  deleteMemoryFile,
  openMemoryDir,
  importFromPaths,
  countMemoryFiles,
  saveTemplateFile,
  exportMemoriesZip,
} from "../memoryFiles.mjs";

export function registerMemoryFiles() {
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
