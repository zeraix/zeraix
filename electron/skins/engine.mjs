/**
 * Skin packages (`.skinpkg`) in the main process: a forwarding layer over the Rust engine.
 *
 * This file holds no business logic. Every validation, every byte written under userData, and the
 * active-skin state file belong to native/skin-engine (Rust); what lives here is the addon loader,
 * the IPC channels, the file dialogs and the `skin://` protocol registration -- the parts only the
 * main process can do. If a rule about what a package may contain is wanted, it goes in Rust.
 *
 * Results cross IPC as `{ ok: true, ... }` or `{ ok: false, error: { code, message, detail } }`,
 * exactly as the engine returns them: `code` is what the UI translates, `detail` is the specific
 * file or value it shows alongside. A missing addon (no Rust toolchain on a dev machine) is
 * `code: "engineUnavailable"` on every call rather than a crash: the rest of the app does not need
 * skin packages.
 *
 * Channels are namespaced `skinpkg:` because `skins:` already belongs to the v1 data skins
 * (electron/skins/store.mjs); the two coexist.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { ALLOWED_REFS, APP_REGISTRY } from "./layoutRefs.mjs";
import { SKIN_SCHEME, SKIN_SCHEME_PRIVILEGES, serveSkinRequest } from "./protocol.mjs";
import { TEMPLATE_FILE_NAME, buildPackageTemplateZip } from "./packageTemplate.mjs";

export { SKIN_SCHEME_PRIVILEGES };

const require = createRequire(import.meta.url);

let engine = null;
let loadError = null;

/** The addon, loaded on first use. A failure is remembered, not retried on every call. */
function load() {
  if (engine || loadError) return engine;
  try {
    engine = require("../../native/skin-engine/index.js");
    console.info(`[skin-engine] ${engine.ping()}`);
  } catch (err) {
    loadError = err;
    console.warn(`[skin-engine] addon unavailable (skin packages are off): ${err?.message ?? err}`);
  }
  return engine;
}

export const isEngineAvailable = () => !!load();

/* ------------------------------------------------------------------ paths */

let dirOverride = null;
/** Tests point the store at a scratch folder; the app never calls this. */
export function setSkinPackagesDir(dir) {
  dirOverride = dir;
}
const skinsDir = () => dirOverride ?? path.join(app.getPath("userData"), "skin-packages");
const statePath = () => (dirOverride ? `${dirOverride}-active.json` : path.join(app.getPath("userData"), "skin-packages-active.json"));

/* --------------------------------------------------------------- results */

const UNAVAILABLE = () => ({
  ok: false,
  error: { code: "engineUnavailable", message: "the skin engine addon is not loaded", detail: loadError?.message ?? null },
});
const FAILED = (err) => ({ ok: false, error: { code: "failed", message: String(err?.message ?? err), detail: null } });
const CANCELED = { ok: false, canceled: true };

/** Run `fn` with the engine, turning a thrown error (a broken bridge) into a structured failure. */
async function withEngine(fn) {
  const e = load();
  if (!e) return UNAVAILABLE();
  try {
    return await fn(e);
  } catch (err) {
    console.error("[skin-engine] call failed:", err);
    return FAILED(err);
  }
}

/** The active id for first paint, or null. Synchronous: the state file is a few bytes. */
export function activeSkinIdSync() {
  const e = load();
  if (!e) return null;
  try {
    return e.getActiveSkinSync(statePath());
  } catch {
    return null;
  }
}

/**
 * State writes are chained so two quick `setActive` calls land in call order: the engine runs each
 * on the thread pool and makes every write atomic, but only ordering here makes "the last call
 * wins" true for the caller.
 */
let chain = Promise.resolve();
function serialized(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function snapshot(e) {
  const [skins, active] = await Promise.all([e.listSkins(skinsDir()), e.getActiveSkin(statePath())]);
  return { skins, active };
}

async function broadcast(e) {
  let payload;
  try {
    payload = await snapshot(e);
  } catch {
    return;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("skinpkg:changed", payload);
  }
}

/* --------------------------------------------------------------- install */

const appVersion = () => {
  try {
    return app.getVersion();
  } catch {
    return null;
  }
};

/** What the engine checks a package against: every layout ref, sidebar id and icon name the app renders. */
const registry = () => ({
  refs: [...APP_REGISTRY.refs],
  navItems: [...APP_REGISTRY.navItems],
  sections: [...APP_REGISTRY.sections],
  controls: [...APP_REGISTRY.controls],
  menu: [...APP_REGISTRY.menu],
  icons: [...APP_REGISTRY.icons],
});

async function install(filePath) {
  if (typeof filePath !== "string" || !filePath) return { ok: false, error: { code: "packageUnreadable", message: "no file", detail: null } };
  return withEngine(async (e) => {
    const r = await e.installSkinPackageAsync(filePath, skinsDir(), registry(), appVersion());
    if (r.ok) await broadcast(e);
    return r;
  });
}

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

/* ------------------------------------------------------------------- IPC */

export function registerSkinPackages() {
  // First paint: the renderer needs the active id before the window draws, or the default palette
  // flashes for a frame. Same reason skins:list-sync exists for the v1 skins.
  ipcMain.on("skinpkg:get-active-sync", (e) => {
    e.returnValue = { available: isEngineAvailable(), active: activeSkinIdSync() };
  });
  ipcMain.handle("skinpkg:available", () => ({ available: isEngineAvailable(), error: loadError?.message ?? null }));
  ipcMain.handle("skinpkg:list", () => withEngine(async (e) => ({ ok: true, ...(await snapshot(e)) })));
  ipcMain.handle("skinpkg:get-active", () => withEngine(async (e) => ({ ok: true, active: await e.getActiveSkin(statePath()) })));
  ipcMain.handle("skinpkg:set-active", (_e, id) =>
    serialized(() =>
      withEngine(async (e) => {
        const r = await e.setActiveSkin(statePath(), skinsDir(), String(id ?? ""));
        if (r.ok) await broadcast(e);
        return r;
      }),
    ),
  );
  ipcMain.handle("skinpkg:delete", (_e, id) =>
    serialized(() =>
      withEngine(async (e) => {
        const r = await e.deleteSkin(skinsDir(), statePath(), String(id ?? ""));
        if (r.ok) await broadcast(e);
        return r;
      }),
    ),
  );
  ipcMain.handle("skinpkg:install", (_e, filePath) => install(filePath));
  ipcMain.handle("skinpkg:inspect", (_e, filePath) =>
    withEngine((e) => e.inspectSkinPackageAsync(String(filePath ?? ""), registry(), appVersion())),
  );
  // Stage 8's 'dialog:selectSkinPackage': the picker and the install in one round trip.
  ipcMain.handle("skinpkg:pick", async (e) => {
    const w = winOf(e);
    const opts = { properties: ["openFile"], filters: [{ name: "Skin package", extensions: ["skinpkg", "zip"] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths?.[0]) return CANCELED;
    return install(r.filePaths[0]);
  });
  // layout.json / components.json / tokens.css for the renderer. Over IPC, not fetch: Chromium refuses a
  // cross-origin fetch() to a custom scheme however the handler answers, so skin:// only serves what
  // element loads need (the stylesheet, images) and the text the renderer parses comes through here.
  // `id` names an installed package; absent, it is the active one. Presets have no files: text null.
  ipcMain.handle("skinpkg:read-text", (_e, rel, id) =>
    withEngine(async (e) => {
      const target = typeof id === "string" && id ? id : activeSkinIdSync();
      if (!target || target.startsWith("builtin-")) return { ok: true, text: null };
      return e.readSkinText(skinsDir(), target, String(rel ?? ""));
    }),
  );
  ipcMain.handle("skinpkg:validate-layout", (_e, layout, components) =>
    withEngine((e) => e.validateLayoutJson(layout == null ? null : String(layout), components == null ? null : String(components), [...ALLOWED_REFS])),
  );
  // The renderer builds the text; the dialog is the main process's; the write is the engine's.
  ipcMain.handle("skinpkg:export-text", async (e, payload) => {
    const name = typeof payload?.defaultName === "string" ? payload.defaultName : "layout.json";
    const text = typeof payload?.text === "string" ? payload.text : null;
    if (text === null) return FAILED(new Error("nothing to export"));
    const w = winOf(e);
    const opts = { defaultPath: name, filters: [{ name: "JSON", extensions: ["json"] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return CANCELED;
    return withEngine(async (eng) => {
      const w2 = await eng.writeTextFile(r.filePath, text);
      return w2.ok ? { ok: true, path: r.filePath } : w2;
    });
  });
  // The official package template: README, a ready-to-install my-skin/ and editor schemas, zipped by
  // packageTemplate.mjs from electron/skins/package-template and written by the engine.
  ipcMain.handle("skinpkg:download-template", async (e) => {
    const w = winOf(e);
    const opts = { defaultPath: TEMPLATE_FILE_NAME, filters: [{ name: "ZIP", extensions: ["zip"] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return CANCELED;
    return withEngine(async (eng) => {
      const written = await eng.writeFileBytes(r.filePath, buildPackageTemplateZip());
      return written.ok ? { ok: true, path: r.filePath } : written;
    });
  });
}

/** After app.whenReady: `skin://` requests go to the pure handler in protocol.mjs. */
export function registerSkinProtocol() {
  protocol.handle(SKIN_SCHEME, (request) => serveSkinRequest(request.url, { skinsDir: skinsDir(), activeId: activeSkinIdSync() }));
}
