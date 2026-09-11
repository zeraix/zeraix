/**
 * Module hook that resolves `electron` to a stub rich enough to load main-process modules under
 * `node --test` and drive their IPC handlers directly.
 *
 * Unlike scripts/electron-stub-hook.mjs (which only needs the toolkit to initialise), this one
 * records what a module registers: `ipcMain.handle` / `ipcMain.on` handlers land in
 * `globalThis.__electronStub.handlers` / `.syncHandlers`, `protocol.handle` in `.protocols`, and the
 * dialogs answer with whatever the test put in `.dialog`. Nothing is called on the test's behalf;
 * the test invokes handlers as the renderer would, with a fake event.
 *
 * Usage, at the top of a test:
 *   register("./helpers/electronStub.mjs", import.meta.url);
 *   const stub = globalThis.__electronStub;   // after the first import of an electron module
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const STUB = "zeraix:electron-test-stub";

export async function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: STUB, format: "module", shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url !== STUB) return next(url, context);
  const source = `
const stub = (globalThis.__electronStub ??= {
  userData: process.env.ZERAIX_STUB_USERDATA ?? process.cwd(),
  version: process.env.ZERAIX_STUB_VERSION ?? "2.0.0",
  handlers: {},
  syncHandlers: {},
  protocols: {},
  privileged: [],
  /** What the dialogs answer: { open: string | null, save: string | null }. */
  dialog: { open: null, save: null },
  sent: [],
});
export const app = {
  // userData is THE directory the test named; anything else hangs off it, the way Electron nests logs/ etc.
  getPath: (which) => (which === "userData" ? stub.userData : stub.userData + "/" + which),
  getName: () => "Zeraix",
  getVersion: () => stub.version,
  isPackaged: false,
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
};
export const ipcMain = {
  handle: (channel, fn) => { stub.handlers[channel] = fn; },
  on: (channel, fn) => { stub.syncHandlers[channel] = fn; },
  removeHandler: (channel) => { delete stub.handlers[channel]; },
};
export const dialog = {
  showOpenDialog: async () => (stub.dialog.open ? { canceled: false, filePaths: [stub.dialog.open] } : { canceled: true, filePaths: [] }),
  showSaveDialog: async () => (stub.dialog.save ? { canceled: false, filePath: stub.dialog.save } : { canceled: true }),
};
export const protocol = {
  registerSchemesAsPrivileged: (list) => { stub.privileged.push(...list); },
  handle: (scheme, fn) => { stub.protocols[scheme] = fn; },
};
export const BrowserWindow = class {
  static getAllWindows() { return []; }
  static fromWebContents() { return null; }
};
export const nativeTheme = { themeSource: "system", shouldUseDarkColors: false, on: () => {} };
export const shell = {};
export const net = { fetch: (...a) => globalThis.fetch(...a) };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, dialog, protocol, BrowserWindow, nativeTheme, shell, net, safeStorage };
`;
  return { format: "module", shortCircuit: true, source };
}

export { pathToFileURL, register };
