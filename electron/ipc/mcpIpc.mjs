/**
 * MCP IPC: renderer window.mcp.* -> the main-process connection manager.
 *
 * The renderer manages *configuration and trust*; it never touches the protocol. Two consequences
 * shape this file:
 *  - Nothing here returns a secret. Env values and Authorization headers stay in the main process;
 *    the UI gets publicServer(), which reports only which keys are set.
 *  - Connecting is gated on `approved`. An MCP server is arbitrary third-party code running with the
 *    user's filesystem and network, so it runs only after the user has seen the exact command line
 *    or URL and said yes. Editing a server's target clears that approval (see config.upsertServer).
 *
 * Status is pushed, not polled: a handshake can take seconds and a server can drop at any time, so
 * every window gets `mcp:status` whenever the manager's snapshot changes.
 */
import { BrowserWindow, ipcMain, shell } from "electron";
import {
  getServer,
  importServers,
  listServers,
  publicServer,
  removeServer,
  serversFilePath,
  setServerFlag,
  upsertServer,
} from "../mcp/config.mjs";
import { autoConnectApproved, connectServer, disconnectServer, disposeMcp, mcpStatus, onMcpEvent } from "../mcp/client.mjs";

function broadcast(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("mcp:status", status);
  }
}

/** The full picture the settings panel renders in one round trip. */
function snapshot() {
  return { servers: listServers().map(publicServer), status: mcpStatus() };
}

export function registerMcp() {
  onMcpEvent(broadcast);

  ipcMain.handle("mcp:list", () => snapshot());

  ipcMain.handle("mcp:upsert", (_e, { id, config }) => {
    const res = upsertServer(id, config ?? {});
    return res.ok ? { ...res, ...snapshot() } : res;
  });

  ipcMain.handle("mcp:remove", async (_e, id) => {
    await disconnectServer(id);
    const res = removeServer(id);
    return { ...res, ...snapshot() };
  });

  // Approve = "I have read this command line and accept that it will run on my machine".
  ipcMain.handle("mcp:approve", async (_e, { id, approved }) => {
    const res = setServerFlag(id, "approved", approved);
    if (!res.ok) return res;
    if (!approved) await disconnectServer(id);
    return { ...res, ...snapshot() };
  });

  ipcMain.handle("mcp:set-enabled", async (_e, { id, enabled }) => {
    const res = setServerFlag(id, "disabled", !enabled);
    if (!res.ok) return res;
    if (!enabled) await disconnectServer(id);
    else if (getServer(id)?.approved) void connectServer(id);
    return { ...res, ...snapshot() };
  });

  ipcMain.handle("mcp:connect", async (_e, id) => {
    const cfg = getServer(id);
    if (!cfg) return { ok: false, error: "not-found" };
    if (!cfg.approved) return { ok: false, error: "not-approved" };
    if (cfg.disabled) return { ok: false, error: "disabled" };
    const e = await connectServer(id);
    return { ok: e.status === "ready", error: e.error || undefined, ...snapshot() };
  });

  ipcMain.handle("mcp:disconnect", async (_e, id) => {
    await disconnectServer(id);
    return { ok: true, ...snapshot() };
  });

  // Paste-in of a Claude-Desktop style { mcpServers: {...} } blob. Imported servers always land
  // unapproved: importing a file is not the same as vouching for what is in it.
  ipcMain.handle("mcp:import", (_e, blob) => {
    const res = importServers(blob);
    return res.ok ? { ...res, ...snapshot() } : res;
  });

  ipcMain.handle("mcp:config-path", () => serversFilePath());
  ipcMain.handle("mcp:open-config", async () => {
    const p = serversFilePath();
    const error = await shell.openPath(p);
    return { ok: !error, path: p, error: error || undefined };
  });

  // Approved servers come up in the background once the app is ready; startup never waits on a
  // handshake, but a chat opened a few seconds later already has the tools.
  autoConnectApproved();
}

export { disposeMcp };
