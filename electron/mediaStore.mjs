/**
 * The media library on disk: `<data storage location>/media`, with `index.json` at its root.
 *
 * ── Why the app writes here and the model does not ──────────────────────────────────────────────────────────
 *
 * This folder is the model's READ-ONLY root. `tools/paths.mjs` refuses a write to it from any file tool, and
 * the sandbox binds it `--ro-bind` so a shell command cannot write there either. Those guards exist to stop
 * the MODEL from altering originals the user cannot get back.
 *
 * The app is not the model. It is the thing that creates these files in the first place — a generated video,
 * an attachment the user sent — and it maintains the index that describes them. So it writes through here,
 * with ordinary `fs`, deliberately bypassing a guard that was never aimed at it. Routing the app's own writes
 * through the model's restriction would mean either weakening the restriction or having no way to save an
 * asset at all.
 *
 * ── Why it lives under the data storage location ────────────────────────────────────────────────────────────
 *
 * Because that is where this app keeps the user's data, and the user can move it (Settings → General). A
 * library under the working directory would be a different library per project and would disappear when they
 * switched folders; a library hardcoded to userData would ignore a location they deliberately chose.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { shell } from "electron";

/** Resolved by the caller (main.mjs owns the store path); "" until it is set. */
let MEDIA_DIR = "";

export function setMediaDir(dir) {
  MEDIA_DIR = typeof dir === "string" && dir.trim() ? path.resolve(dir) : "";
  return MEDIA_DIR;
}

export function getMediaDir() {
  return MEDIA_DIR;
}

const INDEX_FILE = () => path.join(MEDIA_DIR, "index.json");

/** Create the folder on demand. Every write goes through this, so nothing has to create it up front. */
async function ensureDir() {
  if (!MEDIA_DIR) throw new Error("no media directory is configured");
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

/**
 * Read `index.json`, or "" when there is not one yet.
 *
 * A missing file is the ordinary empty case — the folder does not exist until the first asset is saved — so
 * it is not an error. A malformed one is returned as-is and left for the caller to validate: repairing JSON
 * here would hide the fact that something wrote nonsense into it.
 */
export async function readIndex() {
  if (!MEDIA_DIR) return "";
  try {
    return await fs.readFile(INDEX_FILE(), "utf8");
  } catch {
    return "";
  }
}

/**
 * Replace `index.json`.
 *
 * Written to a temporary file and renamed, because rename is atomic on every platform this runs on: a crash
 * or a concurrent read during a plain overwrite can otherwise observe a half-written index, and a truncated
 * index reads as an empty library — every asset the user has, gone from the UI in one blink.
 */
export async function writeIndex(json) {
  await ensureDir();
  const target = INDEX_FILE();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, String(json ?? "[]"), "utf8");
  await fs.rename(tmp, target);
  return true;
}

/** Filesystem-safe, collision-free name inside the media folder. Mirrors saveAttachment's naming. */
async function uniqueTarget(name) {
  const base =
    // A SET of reserved punctuation plus whitespace. Written with a stray "space to backslash-s"
    // it looks identical and is a RANGE, which strips most of the printable alphabet and turns
    // every filename into underscores.
    path.basename(String(name || "asset")).replace(/[\\/:*?"<>|\s]/g, "_") || "asset";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "asset";
  let target = path.join(MEDIA_DIR, base);
  for (let i = 1; ; i++) {
    try {
      await fs.access(target);
      target = path.join(MEDIA_DIR, `${stem}-${i}${ext}`);
    } catch {
      return target;
    }
  }
}

/**
 * Put a file into the library and return its absolute path and size.
 *
 * Three sources, matching saveAttachment's: a host path to copy, inline bytes, or a URL to download. The
 * download happens HERE rather than in the renderer for the same reasons it does there — no CORS, and a
 * multi-megabyte payload never crosses IPC.
 *
 * The size is measured from the file that actually landed, not from the response that produced it. A
 * Content-Length can be absent, wrong, or describe a compressed transfer; `stat` describes the bytes the
 * user now has on disk, which is the number the library is claiming to show.
 */
export async function saveMedia({ name, srcPath, bytes, url }) {
  await ensureDir();
  const target = await uniqueTarget(name);
  if (srcPath) {
    await fs.copyFile(String(srcPath), target, fsSync.constants.COPYFILE_FICLONE);
  } else if (bytes) {
    await fs.writeFile(target, Buffer.from(bytes));
  } else if (url) {
    const res = await fetch(String(url));
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
  } else {
    throw new Error("saveMedia requires srcPath, bytes, or url");
  }
  let size = 0;
  try {
    size = (await fs.stat(target)).size;
  } catch {
    // The file is written either way; an unmeasurable size is a missing detail, not a failed save.
  }
  return { path: target, bytes: size };
}

/** Reveal the folder in the system file manager. Created first, so the button never fails on an empty library. */
export async function openMediaDir() {
  await ensureDir();
  const error = await shell.openPath(MEDIA_DIR);
  return { ok: !error, path: MEDIA_DIR, error: error || undefined };
}
