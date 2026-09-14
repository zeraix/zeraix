/**
 * Built-in terminal IPC: renderer xterm.js <-> main-process node-pty session.
 *
 * create returns the session id (via invoke); write/resize/kill are high-frequency/one-way messages (via send).
 * PTY output is pushed back to the originating window via terminal:data / terminal:exit.
 */
import { ipcMain } from "electron";
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killByWebContents } from "../tools/terminal.mjs";

export function registerTerminal() {
  ipcMain.handle("terminal:create", (e, opts) => createTerminal(e.sender, opts || {}));
  ipcMain.on("terminal:write", (_e, { id, data }) => writeTerminal(id, data));
  ipcMain.on("terminal:resize", (_e, { id, cols, rows }) => resizeTerminal(id, cols, rows));
  ipcMain.on("terminal:kill", (_e, id) => killTerminal(id));
  // Terminate all PTY sessions owned by the originating window (fully kill all terminal background processes when the file sidebar is closed).
  ipcMain.on("terminal:kill-all", (e) => killByWebContents(e.sender));
}
