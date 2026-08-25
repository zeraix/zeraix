/**
 * Module hooks that let `electron/tools/aiToolkit.mjs` load in a plain Node process.
 *
 * The toolkit imports `shell` from `electron` so that `open_path` can hand a file to the host's
 * default application, and that single import makes the whole module unloadable outside the app --
 * `electron/tools/toolSchemas.mjs` exists precisely because the seed tooling hit this and had to split
 * the static schemas out to get at them.
 *
 * The A/B parity harness has the same problem for a different reason: it needs the REAL handlers, not
 * a copy of them, because a copy would prove nothing. So `electron` is resolved to a stub with just
 * enough surface for the modules on the import path to initialise. Nothing here is called during a
 * read-only tool call; if a future comparison exercises a tool that does reach one of these, it throws
 * rather than silently returning a plausible value.
 *
 * Usage: node --import ./scripts/electron-stub-hook.mjs <script>
 */
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STUB = "zeraix:electron-stub";

export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return { url: STUB, format: "module", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url !== STUB) return next(url, context);
  const userData = path.join(os.tmpdir(), "zeraix-ab-harness");
  const source = `
const unreachable = (name) => () => {
  throw new Error("electron stub: " + name + " was called; the harness only supports paths that do not touch Electron");
};
export const app = {
  getPath: (which) => ${JSON.stringify(userData)} + "/" + which,
  getName: () => "Zeraix",
  getVersion: () => "0.0.0-harness",
  isPackaged: false,
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
};
export const shell = { openPath: unreachable("shell.openPath"), openExternal: unreachable("shell.openExternal") };
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
export const dialog = { showOpenDialog: unreachable("dialog.showOpenDialog") };
export const BrowserWindow = class { static getAllWindows() { return []; } };
export const Notification = class { static isSupported() { return false; } show() {} };
export const net = { fetch: (...a) => globalThis.fetch(...a) };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, shell, ipcMain, dialog, BrowserWindow, Notification, net, safeStorage };
`;
  return { format: "module", shortCircuit: true, source };
}

register(pathToFileURL(import.meta.filename));
