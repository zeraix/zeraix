/**
 * Main-process entry.
 *
 * What must happen before app ready — command-line switches, the single-instance lock, deep-link routing, privileged
 * schemes — then the startup sequence once it is (main/startup.mjs), and the quit handlers. The pieces live in main/
 * (the app shell) and ipc/ (one module per renderer bridge).
 */
import { app } from "electron";
import path from "node:path";
// Loaded first, for its import-time effects alone: modules in its graph (rustRuntime, sandbox/native, mcp/client)
// subscribe to runtime events as they load, and loading it ahead of everything else keeps the order they subscribe in.
import "./tools/aiToolkit.mjs";
import { loadEnvFiles } from "./loadEnv.mjs";
import { ELECTRON_DIR, isDev, REMOTE_DEBUG_PORT } from "./main/env.mjs";
import { registerAppSchemes } from "./main/appProtocol.mjs";
import { installDeepLinkRouting } from "./main/deepLinks.mjs";
import { startApp } from "./main/startup.mjs";
import { installQuitHandlers } from "./main/shutdown.mjs";

// CDP remote-debugging port: puppeteer-core connects through this; automation drives the <webview> in a separate utilityProcess.
// These switches must be appended before app ready. Only listens on 127.0.0.1.
// remote-allow-origins is essential: since Chrome 111+, the DevTools WebSocket rejects non-browser clients by default,
// and without it puppeteer.connect cannot connect (403).
app.commandLine.appendSwitch("remote-debugging-port", String(REMOTE_DEBUG_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");
// app.disableHardwareAcceleration(); /**  */

// The main process does not auto-read .env* the way Next does (that is Next dev server behavior). In dev, following Next's
// precedence, load the project root's .env files into process.env for main-process logic (e.g. Google login reading the client id).
// After packaging these files usually do not exist, so silently skip (for packaged distribution, prefer injecting the client id via app.config).
if (isDev) loadEnvFiles(path.join(ELECTRON_DIR, ".."), process.env.NODE_ENV || "development");

// Single-instance lock: on Windows/Linux, a `zeraix://` deep link launches this app as a "new process + argv carrying the URL",
// so the single-instance lock must hand it back to the first instance; otherwise every link click spawns another app window.
// Failing to acquire the lock = we are the second instance launched by a deep link: hand the URL to the first instance and quit immediately (see second-instance).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// zeraix:// deep links: claim the scheme, stash a cold-start link, and route later ones to the window (main/deepLinks.mjs).
installDeepLinkRouting();

// Safety net: any uncaught exception / unhandled rejection in the main process is merely logged, never allowed to bring the whole app down.
// (For example, built-in browser load failures, automation/child-process async errors, etc. must not take down the main window.)
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception (ignored, app keeps running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled promise rejection (ignored):", reason);
});

registerAppSchemes();

app.whenReady().then(() => {
  // The second instance (launched by a deep link) already called app.quit() earlier, so skip initializing windows and services and return directly.
  if (!gotSingleInstanceLock) return;
  return startApp();
});

// Teardown on every quit path, and whether closing the last window quits (main/shutdown.mjs).
installQuitHandlers();
