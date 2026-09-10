/**
 * The skin store on disk: `<userData>/skins/<id>/` holding skin.json, meta.json and up to three images.
 *
 * Every skin that is not built in lives here -- store installs and the user's own. The main process owns it for the
 * reasons it owns app.config: it survives a cleared renderer profile, every window reads one list, and one writer
 * means no races. It is also the trust boundary for everything a person can drop into the app:
 *
 *   - skin.json is re-sanitized on every read: the folder is user-writable, so a hand edit is untrusted input;
 *   - images are identified by their bytes (PNG/JPEG/WebP/GIF), size-capped, and stored under fixed names, so the only
 *     image address a skin can ever hold is one this module minted (schema.storedImageUrl);
 *   - packages go through zipio.mjs, which never treats an entry name as a path and hard-caps inflation;
 *   - `origin` (store vs custom) lives in meta.json, written only here, so a skin cannot promote itself to editable.
 *
 * Editor images take a draft step: picking writes `<slot>-draft.<ext>`, saving promotes it, cancelling deletes it.
 * Without that, replacing an image and then pressing Cancel would still have replaced the image.
 *
 * Errors carry a `code` (see SkinError), never user-facing prose: the renderer owns the translated message.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  IMAGE_EXTS,
  IMAGE_SLOTS,
  LIMITS,
  draftImageUrl,
  isSkinId,
  parseDraftImageUrl,
  parseStoredImageUrl,
  sanitizeSkin,
  sniffImage,
  storedImageUrl,
} from "./schema.mjs";
import { readZip, writeZip } from "./zipio.mjs";
import { buildTemplateZip } from "./template.mjs";

/** Route prefix on the app:// origin. URLs are minted by schema.storedImageUrl; nothing builds them by hand. */
export const SKINS_PREFIX = "/__skins/";

const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const MANIFEST_MAX = 256 * 1024;
const PACKAGE_IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const CANCELED = Symbol("canceled");

export class SkinError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

let dirOverride = null;
/** Tests point the store at a scratch folder; the app never calls this. */
export function setSkinsDir(dir) {
  dirOverride = dir;
}
const root = () => dirOverride ?? path.join(app.getPath("userData"), "skins");

function dirOf(id) {
  if (!isSkinId(id)) throw new SkinError("invalid");
  return path.join(root(), id);
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const rm = (p) => fs.rmSync(p, { force: true });

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

export const newSkinId = () => `custom-${randomBytes(5).toString("hex")}`;

/* ------------------------------------------------------------------ reading */

function readMeta(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf8"));
    return { origin: m.origin === "store" ? "store" : "custom", installedAt: Number.isFinite(m.installedAt) ? m.installedAt : 0 };
  } catch {
    return { origin: "custom", installedAt: 0 };
  }
}

/** Drop image references whose file is gone, so the renderer never asks for something that 404s. */
function withExistingImages(skin) {
  const images = skin.decor?.images;
  if (!images) return skin;
  const dir = dirOf(skin.id);
  const kept = {};
  for (const [slot, url] of Object.entries(images)) {
    const p = parseStoredImageUrl(url);
    if (p && exists(path.join(dir, `${slot}.${p.ext}`))) kept[slot] = url;
  }
  const decor = { ...skin.decor };
  if (Object.keys(kept).length) decor.images = kept;
  else delete decor.images;
  return { ...skin, decor };
}

export function readSkin(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dirOf(id), "skin.json"), "utf8"));
    // The folder name is the id. A skin.json claiming another id does not get to become that skin.
    const skin = sanitizeSkin({ ...raw, id }, { origin: readMeta(id).origin });
    return skin ? withExistingImages(skin) : null;
  } catch {
    return null;
  }
}

export function listSkins() {
  let ids;
  try {
    ids = fs
      .readdirSync(root(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSkinId(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return ids
    .map((id) => ({ skin: readSkin(id), at: readMeta(id).installedAt }))
    .filter((x) => x.skin)
    .sort((a, b) => a.at - b.at || a.skin.id.localeCompare(b.skin.id))
    .map((x) => x.skin);
}

/* ------------------------------------------------------------------ writing */

function writeSkin(skin, origin) {
  const dir = dirOf(skin.id);
  fs.mkdirSync(dir, { recursive: true });
  const { builtin: _b, origin: _o, ...persisted } = skin;
  writeAtomic(path.join(dir, "skin.json"), JSON.stringify(persisted, null, 2));
  const installedAt = readMeta(skin.id).installedAt || Date.now();
  writeAtomic(path.join(dir, "meta.json"), JSON.stringify({ origin, installedAt }));
}

function checkImage(bytes) {
  if (bytes.length > LIMITS.imageBytes) throw new SkinError("imageTooLarge");
  const ext = sniffImage(bytes);
  if (!ext) throw new SkinError("imageType");
  return ext;
}

function removeSlot(dir, slot, draft) {
  for (const ext of IMAGE_EXTS) rm(path.join(dir, `${slot}${draft ? "-draft" : ""}.${ext}`));
}

function writeImage(id, slot, bytes, { draft }) {
  const ext = checkImage(bytes);
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  removeSlot(dir, slot, draft);
  fs.writeFileSync(path.join(dir, `${slot}${draft ? "-draft" : ""}.${ext}`), bytes);
  return (draft ? draftImageUrl : storedImageUrl)(id, slot, ext, Date.now());
}

/** Read a file the user pointed at: no links, nothing that is not a regular file, nothing past the cap. */
async function readUserFile(file, max, tooLargeCode) {
  const st = await fsp.lstat(file);
  if (!st.isFile()) throw new SkinError("notFile");
  if (st.size > max) throw new SkinError(tooLargeCode);
  return fsp.readFile(file);
}

const decorOf = (raw) => (raw.decor && typeof raw.decor === "object" && !Array.isArray(raw.decor) ? raw.decor : {});

/** A picked image lands as a draft for this skin (saved or not yet); its URL goes back to the editor. */
export async function pickImageFile(id, slot, file) {
  if (!IMAGE_SLOTS.includes(slot)) throw new SkinError("invalid");
  dirOf(id);
  return writeImage(id, slot, await readUserFile(file, LIMITS.imageBytes, "imageTooLarge"), { draft: true });
}

export function discardDrafts(id) {
  const dir = dirOf(id);
  for (const slot of IMAGE_SLOTS) removeSlot(dir, slot, true);
  // A new skin that was never saved leaves nothing behind.
  if (!exists(path.join(dir, "skin.json"))) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create or update a custom skin from the editor.
 *
 * Validated BEFORE any file moves, so a rejected save leaves the folder as it was. Then per slot: a draft for this
 * skin is promoted, this skin's existing image is kept, and anything else -- including an image removed in the
 * editor -- clears the slot.
 */
export function saveCustomSkin(raw) {
  if (!raw || typeof raw !== "object") throw new SkinError("invalid");
  const id = raw.id;
  const decorIn = decorOf(raw);
  if (!sanitizeSkin({ ...raw, decor: { ...decorIn, images: undefined } }, { origin: "custom" })) {
    throw new SkinError(isSkinId(id) ? "needsColors" : "invalid");
  }
  const dir = dirOf(id);
  if (exists(path.join(dir, "skin.json")) && readMeta(id).origin === "store") throw new SkinError("storeReadonly");
  fs.mkdirSync(dir, { recursive: true });
  const requested = decorIn.images && typeof decorIn.images === "object" ? decorIn.images : {};
  const images = {};
  for (const slot of IMAGE_SLOTS) {
    const draft = parseDraftImageUrl(requested[slot]);
    const stored = parseStoredImageUrl(requested[slot]);
    const draftFile = draft && draft.id === id && draft.slot === slot ? path.join(dir, `${slot}-draft.${draft.ext}`) : null;
    if (draftFile && exists(draftFile)) {
      removeSlot(dir, slot, false);
      fs.renameSync(draftFile, path.join(dir, `${slot}.${draft.ext}`));
      images[slot] = storedImageUrl(id, slot, draft.ext, Date.now());
    } else if (stored && stored.id === id && stored.slot === slot && exists(path.join(dir, `${slot}.${stored.ext}`))) {
      images[slot] = requested[slot];
    } else {
      removeSlot(dir, slot, false);
    }
    removeSlot(dir, slot, true);
  }
  writeSkin(sanitizeSkin({ ...raw, decor: { ...decorIn, images } }, { origin: "custom" }), "custom");
  return readSkin(id);
}

export function installStoreSkin(raw) {
  const skin = sanitizeSkin(raw, { origin: "store" });
  if (!skin) throw new SkinError("invalid");
  if (exists(path.join(dirOf(skin.id), "skin.json")) && readMeta(skin.id).origin === "custom") {
    throw new SkinError("idTaken");
  }
  // Store skins carry no images today. If they ever do, they arrive as a package through importPackageBuffer.
  if (skin.decor) delete skin.decor.images;
  writeSkin(skin, "store");
  return readSkin(skin.id);
}

export function removeSkin(id) {
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/* ------------------------------------------------------------- import / export */

const isPackageName = (name) => {
  const l = name.toLowerCase();
  return l === "skin.json" || IMAGE_SLOTS.some((s) => PACKAGE_IMAGE_EXTS.some((e) => l === `${s}.${e}`));
};

/**
 * Install a skin from a package's parts: the manifest and whatever slot images came with it.
 *
 * Always lands as an editable custom skin. An id that is missing, invalid or already taken is replaced with a fresh
 * one -- importing never silently overwrites something installed. Image names in the manifest are ignored: images
 * are looked up by fixed slot names only, so nothing in a package can point at a file.
 */
export function importParts(manifest, imageFor) {
  if (manifest.length > MANIFEST_MAX) throw new SkinError("manifestInvalid");
  let raw;
  try {
    raw = JSON.parse(manifest.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new SkinError("manifestInvalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SkinError("manifestInvalid");
  const id = isSkinId(raw.id) && !exists(path.join(root(), raw.id)) ? raw.id : newSkinId();
  const decorIn = decorOf(raw);
  if (!sanitizeSkin({ ...raw, id, decor: { ...decorIn, images: undefined } }, { origin: "custom" })) {
    throw new SkinError("needsColors");
  }
  // Check every image before writing any, so one bad image does not leave a half-installed skin.
  const pending = [];
  for (const slot of IMAGE_SLOTS) {
    const bytes = imageFor(slot);
    if (bytes) {
      checkImage(bytes);
      pending.push([slot, bytes]);
    }
  }
  const images = {};
  for (const [slot, bytes] of pending) images[slot] = writeImage(id, slot, bytes, { draft: false });
  writeSkin(sanitizeSkin({ ...raw, id, decor: { ...decorIn, images } }, { origin: "custom" }), "custom");
  return readSkin(id);
}

export function importPackageBuffer(buf) {
  let entries;
  try {
    entries = readZip(buf, {
      allow: isPackageName,
      maxEntryBytes: LIMITS.imageBytes,
      maxTotalBytes: LIMITS.packageBytes,
      maxEntries: 64,
    });
  } catch (err) {
    throw new SkinError(/too large|too many/.test(err?.message ?? "") ? "packageTooLarge" : "packageCorrupt");
  }
  const byName = new Map([...entries].map(([k, v]) => [k.toLowerCase(), v]));
  const manifest = byName.get("skin.json");
  if (!manifest) throw new SkinError("noManifest");
  return importParts(manifest, (slot) => {
    for (const e of PACKAGE_IMAGE_EXTS) {
      const b = byName.get(`${slot}.${e}`);
      if (b) return b;
    }
    return null;
  });
}

/** An unzipped template: skin.json plus images beside it under their fixed slot names. */
export async function importJsonFile(file) {
  const manifest = await readUserFile(file, MANIFEST_MAX, "manifestInvalid");
  const dir = path.dirname(file);
  const images = {};
  for (const slot of IMAGE_SLOTS) {
    for (const e of PACKAGE_IMAGE_EXTS) {
      const p = path.join(dir, `${slot}.${e}`);
      if (!images[slot] && exists(p)) images[slot] = await readUserFile(p, LIMITS.imageBytes, "imageTooLarge");
    }
  }
  return importParts(manifest, (slot) => images[slot] ?? null);
}

export function exportPackage(id) {
  const skin = readSkin(id);
  if (!skin) throw new SkinError("missing");
  const { builtin: _b, origin: _o, decor, ...rest } = skin;
  const files = [];
  const outDecor = decor ? { ...decor } : null;
  if (outDecor?.images) {
    for (const [slot, url] of Object.entries(outDecor.images)) {
      const p = parseStoredImageUrl(url);
      if (p) files.push({ name: `${slot}.${p.ext}`, data: fs.readFileSync(path.join(dirOf(id), `${slot}.${p.ext}`)) });
    }
    // Images travel as files beside the manifest, never as addresses: an address only means something on this machine.
    delete outDecor.images;
  }
  const manifest = {
    format: "zeraix-skin",
    formatVersion: 1,
    ...rest,
    ...(outDecor && Object.keys(outDecor).length ? { decor: outDecor } : {}),
  };
  return writeZip([{ name: "skin.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...files]);
}

/* -------------------------------------------------------------------- serving */

const SERVE_RE = /^([a-z0-9][a-z0-9-]{1,39})\/(backdrop|hero|corner)(-draft)?\.(png|jpg|webp|gif)$/;

/** `app://localhost/__skins/<id>/<slot>[-draft].<ext>`: fixed names only, so a request cannot name any other file. */
export async function serveSkinFile(rel) {
  const m = SERVE_RE.exec(rel);
  if (!m || !isSkinId(m[1])) return new Response("not found", { status: 404 });
  try {
    const data = await fsp.readFile(path.join(dirOf(m[1]), `${m[2]}${m[3] ?? ""}.${m[4]}`));
    return new Response(data, {
      headers: { "content-type": MIME[m[4]], "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

/* ------------------------------------------------------------------------ IPC */

function broadcastList() {
  const list = listSkins();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("skins:changed", list);
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      const r = await fn(e, ...args);
      return r === CANCELED ? { ok: false, canceled: true } : { ok: true, ...(r ?? {}) };
    } catch (err) {
      if (!(err instanceof SkinError)) console.error(`[skins] ${channel} failed:`, err);
      return { ok: false, code: err instanceof SkinError ? err.code : "failed" };
    }
  });
}

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

async function openFile(e, opts) {
  const w = winOf(e);
  const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths?.[0] ? null : r.filePaths[0];
}

async function saveFile(e, opts) {
  const w = winOf(e);
  const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}

const fileSlug = (name) =>
  (String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skin").slice(0, 40);

export function registerSkins() {
  // Synchronous for first paint: the active skin's palette must be known before the window draws.
  ipcMain.on("skins:list-sync", (e) => {
    e.returnValue = listSkins();
  });
  handle("skins:save", (_e, raw) => {
    const skin = saveCustomSkin(raw);
    broadcastList();
    return { skin };
  });
  handle("skins:install", (_e, raw) => {
    const skin = installStoreSkin(raw);
    broadcastList();
    return { skin };
  });
  handle("skins:remove", (_e, id) => {
    removeSkin(id);
    broadcastList();
    return {};
  });
  handle("skins:discard-drafts", (_e, id) => {
    discardDrafts(id);
    return {};
  });
  handle("skins:pick-image", async (e, id, slot) => {
    const file = await openFile(e, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (!file) return CANCELED;
    return { url: await pickImageFile(id, slot, file) };
  });
  handle("skins:import", async (e) => {
    const file = await openFile(e, {
      properties: ["openFile"],
      filters: [{ name: "Zeraix skin", extensions: ["zeraixskin", "zip", "json"] }],
    });
    if (!file) return CANCELED;
    const skin = /\.json$/i.test(file)
      ? await importJsonFile(file)
      : importPackageBuffer(await readUserFile(file, LIMITS.packageBytes, "packageTooLarge"));
    broadcastList();
    return { skin };
  });
  handle("skins:export", async (e, id) => {
    const skin = readSkin(id);
    if (!skin) throw new SkinError("missing");
    const file = await saveFile(e, {
      defaultPath: `${fileSlug(skin.name)}.zeraixskin`,
      filters: [{ name: "Zeraix skin", extensions: ["zeraixskin"] }],
    });
    if (!file) return CANCELED;
    await fsp.writeFile(file, exportPackage(id));
    return { path: file };
  });
  handle("skins:download-template", async (e) => {
    const file = await saveFile(e, {
      defaultPath: "zeraix-skin-template.zip",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!file) return CANCELED;
    await fsp.writeFile(file, buildTemplateZip());
    return { path: file };
  });
}
