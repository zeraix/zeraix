/**
 * <webview> automation IPC: renderer window.automation.* -> main process runs puppeteer-core in a separate utilityProcess,
 * connecting via the CDP remote-debugging port and watching the <webview> page; when triggers like a search hit, events are relayed back to the renderer.
 * The automation code is isolated from the main / renderer threads, so a crash does not affect the main process.
 *
 * Not the workflow automation subsystem (electron/automation/, channel prefix `wf:`), which keeps clear of these channel names.
 */
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { recordChild, forgetChild } from "../tools/sandbox/orphans.mjs";
import { ELECTRON_DIR, REMOTE_DEBUG_PORT } from "../main/env.mjs";

let automationChild = null;
const automationPending = new Map(); // action id -> resolve
let automationActionSeq = 0;

export function registerBrowserAutomation() {
  const relay = (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("automation:event", msg);
    }
  };
  const ensureChild = () => {
    if (automationChild) return automationChild;
    automationChild = utilityProcess.fork(path.join(ELECTRON_DIR, "automation", "cdpAgent.cjs"), [], {
      serviceName: "cdp-automation",
      stdio: "inherit",
    });
    // Recorded for the startup sweep (docs/agent-runtime-crash-recovery.md C4). `before-quit` kills it; a hard
    // kill of the main process does not, and a browser-driving child left behind holds a Chrome instance open.
    if (automationChild?.pid) recordChild(automationChild.pid, "automation: cdpAgent");
    automationChild.on("message", (msg) => {
      // action-result: resolve the corresponding action Promise; forward all other messages to the renderer (status / triggers).
      if (msg && msg.type === "action-result") {
        const resolve = automationPending.get(msg.id);
        if (resolve) {
          automationPending.delete(msg.id);
          resolve(msg);
        }
        return;
      }
      relay(msg);
    });
    automationChild.on("exit", () => {
      if (automationChild?.pid) forgetChild(automationChild.pid);
      automationChild = null;
      // Child process exit: fail all pending actions.
      for (const [, resolve] of automationPending) resolve({ ok: false, error: "Automation process has exited" });
      automationPending.clear();
    });
    return automationChild;
  };
  ipcMain.handle("automation:start", (_e, config) => {
    ensureChild().postMessage({ type: "start", config: { ...config, port: REMOTE_DEBUG_PORT } });
    return true;
  });
  ipcMain.handle("automation:stop", () => {
    automationChild?.postMessage({ type: "stop" });
    return true;
  });
  // Current active tab URL -> let the automation process attach CDP to the corresponding webview (locate the active page when there are multiple tabs).
  ipcMain.handle("automation:set-active-url", (_e, url) => {
    automationChild?.postMessage({ type: "active-url", url });
    return true;
  });
  // Dispatch a page action (read / links / click / type / navigate) and wait for the child process to relay the result.
  ipcMain.handle("automation:action", (_e, payload) => {
    const child = ensureChild();
    const id = ++automationActionSeq;
    return new Promise((resolve) => {
      automationPending.set(id, resolve);
      child.postMessage({ type: "action", id, action: payload?.action, params: payload?.params ?? {} });
      setTimeout(() => {
        if (automationPending.has(id)) {
          automationPending.delete(id);
          resolve({ ok: false, error: "Action timed out" });
        }
      }, 30000);
    });
  });
  // Save a built-in browser screenshot (the data URL from the renderer's webview.capturePage) to a temp file and return the path.
  ipcMain.handle("browser:save-shot", (_e, dataUrl) => {
    try {
      const b64 = String(dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return "";
      const file = path.join(app.getPath("temp"), `zeraix-shot-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    } catch (e) {
      console.warn("[browser] failed to save screenshot:", e?.message || e);
      return "";
    }
  });
}

/** Kill the automation child (before-quit), so it is not left hanging. */
export function killBrowserAutomation() {
  automationChild?.kill();
}
