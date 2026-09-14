/**
 * Facts about this main process that the modules main.mjs composes share.
 *
 * No side effects: the command-line switches and the .env loading that use these values are applied by main.mjs, in
 * the order the app needs them.
 */
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The electron/ directory: preload.cjs, crash.html and automation/cdpAgent.cjs are resolved against it. */
export const ELECTRON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const isDev = !app.isPackaged;
export const DEV_SERVER_URL = "http://localhost:3000";

/** CDP remote-debugging port: main.mjs opens it before app ready; the browser automation child connects through it. */
export const REMOTE_DEBUG_PORT = 9222;
