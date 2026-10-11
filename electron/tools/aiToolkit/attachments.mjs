/**
 * Chat attachments: saving one into the working directory, from a host path, inline bytes or a URL.
 * Split out of aiToolkit.mjs, which re-exports saveAttachment unchanged.
 */

import fs from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import { ensureWorkdir, getWorkingDir, resolveInside } from "./workdir.mjs";
import { httpGet } from "./web.mjs";

/** Save a chat attachment into the current working directory and return the saved absolute path. Once
 *  on disk, the file tools and sandbox commands can operate on the file the user dropped in (the
 *  workdir is mounted into the sandbox). Two sources, each with its strength:
 *   - srcPath (the real host path, from webUtils.getPathForFile): a kernel-level copy (COPYFILE_FICLONE,
 *     zero-data copy on reflink-capable filesystems), the file bytes never go through IPC — real
 *     on-disk files (including very large ones) take this path;
 *   - bytes (inline bytes): only for "synthetic" files with no host path (dragged out of an in-app
 *     webview / a program-generated Blob); their bytes only ever exist in memory, with no other source,
 *     and are written to disk after being passed in over IPC.
 *  The filename is sanitized (illegal characters and whitespace → _) and de-duplicated on name collision (-1/-2…). */
export async function saveAttachment({ name, srcPath, bytes, url, subdir }) {
  await ensureWorkdir();
  /**
   * Optional subfolder, relative to the working directory.
   *
   * The media library keeps its assets in one place (`.zeraix-media`) rather than scattered through the
   * project root. It stays INSIDE the working directory deliberately: the sandbox mounts a command's cwd at
   * /workspace and nothing else, so a folder anywhere else would be invisible to every file tool the model
   * has — a generated clip it could not open, let alone process.
   *
   * Routed through resolveInside, which is the same traversal guard the workspace file tools use: `subdir`
   * reaches here from the renderer, and "../../.ssh" must be an error rather than a write.
   */
  const dir = subdir ? resolveInside(String(subdir), { write: true }) : getWorkingDir();
  if (subdir) await fs.mkdir(dir, { recursive: true });
  // A URL-only image has no local File or host path — only a link. This happens when the user edits /
  // resends a message (images are reconstructed from their stored URLs), when an image is handed off from
  // the home-page composer, or when a conversation is restored from history: in all three the original
  // File object is gone. Download its bytes HERE in the main process — no renderer CORS limits, and a
  // large image's base64 never has to cross IPC — so it lands in the working directory like any other
  // attachment and the model can EDIT it (imagemagick / ffmpeg), not merely look at it.
  let inBytes = bytes ? Buffer.from(bytes) : null;
  let inferredExt = "";
  if (!srcPath && !inBytes && url) {
    const dl = await downloadAttachment(url);
    inBytes = dl.bytes;
    inferredExt = dl.ext;
  }
  const base =
    path.basename(String(name || "attachment")).replace(/[\\/:*?"<>|\u0000-\u001f\s]/g, "_") || "attachment";
  // Reconstructed names like "image-1" carry no extension; append the type learned on download so
  // extension-driven tools (imagemagick, ffmpeg) recognize the format.
  const named = !path.extname(base) && inferredExt ? `${base}.${inferredExt}` : base;
  const ext = path.extname(named);
  const stem = named.slice(0, named.length - ext.length) || "attachment";
  let target = path.join(dir, named);
  for (let i = 1; ; i++) {
    try {
      await fs.access(target);
      target = path.join(dir, `${stem}-${i}${ext}`); // Already exists → try a different name
    } catch {
      break; // Doesn't exist → available
    }
  }
  if (srcPath) {
    // FICLONE: zero-copy on reflink-capable filesystems (APFS / Btrfs / XFS); otherwise falls back to a normal copy automatically.
    await fs.copyFile(String(srcPath), target, FS.COPYFILE_FICLONE);
  } else {
    if (!inBytes) throw new Error("saveAttachment requires srcPath, bytes, or url");
    await fs.writeFile(target, inBytes); // Synthetic / downloaded file: bytes written straight to disk.
  }
  return target;
}

// ── URL / data-URI → bytes (saveAttachment's `url` source) ─────────────────────
const ATTACH_DL_MAX_BYTES = 100 * 1024 * 1024; // guard: never pull an unbounded download into memory

/** image/* MIME → a file extension imagemagick/ffmpeg will recognize ("" when unknown). */
function extFromMime(mime) {
  switch (String(mime).toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/svg+xml": return "svg";
    case "image/bmp": return "bmp";
    case "image/tiff": return "tiff";
    case "image/avif": return "avif";
    case "image/heic": return "heic";
    case "image/x-icon":
    case "image/vnd.microsoft.icon": return "ico";
    default: return "";
  }
}

/** Last-resort extension from a URL's path (…/photo.png?x=1 → "png"), used when content-type gives nothing. */
function extFromUrlPath(u) {
  try {
    const e = path.extname(new URL(u).pathname).replace(/^\./, "").toLowerCase();
    return /^[a-z0-9]{2,5}$/.test(e) ? e : "";
  } catch {
    return "";
  }
}

/** Download a URL-only attachment to bytes: data: URIs decoded inline, http(s) fetched via httpGet
 *  (main process → no CORS). Returns { bytes, ext } (ext may be ""); throws on failure so the caller's
 *  try/catch degrades to a filename-only note rather than blocking the send. */
async function downloadAttachment(url) {
  const s = String(url);
  const dm = s.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
  if (dm) {
    const buf = dm[2] ? Buffer.from(dm[3], "base64") : Buffer.from(decodeURIComponent(dm[3]), "utf8");
    if (buf.length > ATTACH_DL_MAX_BYTES) throw new Error(`attachment too large (${buf.length} bytes)`);
    return { bytes: buf, ext: extFromMime(dm[1]) };
  }
  if (!/^https?:\/\//i.test(s)) throw new Error(`unsupported attachment url: ${s.slice(0, 32)}`);
  const res = await httpGet(s, { accept: "image/*,*/*;q=0.8" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > ATTACH_DL_MAX_BYTES) throw new Error(`attachment too large (${len} bytes)`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > ATTACH_DL_MAX_BYTES) throw new Error(`attachment too large (${ab.byteLength} bytes)`);
  const ctype = (res.headers.get("content-type") || "").split(";")[0].trim();
  return { bytes: Buffer.from(ab), ext: extFromMime(ctype) || extFromUrlPath(s) };
}
