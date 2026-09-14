/**
 * Sandbox IPC: renderer window.sandbox.* -> main process.
 *
 * Status: initial sync + engine routing (the active session's secure-environment switch) + initialization progress
 * broadcast to all windows. And the VM image: where it is, which version, update, restart.
 */
import { BrowserWindow, ipcMain } from "electron";
import { getSandboxStatus, setSandboxMode, onSandboxStatus, restartSandbox, sandboxVmInfo } from "../tools/aiToolkit.mjs";

export function registerSandbox() {
  ipcMain.handle("sandbox:get-status", () => getSandboxStatus());
  ipcMain.handle("sandbox:set-mode", (_e, preference) => setSandboxMode(preference));
  // VM image directory (for the sandbox startup dialog to display / open the folder): dynamically load qemu.mjs on demand to compute the static path.
  ipcMain.handle("sandbox:vm-dir", async () => {
    try { const m = await import("../tools/sandbox/qemu.mjs"); return m.vmImageDir(); } catch { return null; }
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
}
