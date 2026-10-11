/**
 * The toolkit's two roots — the working directory every tool is confined to, and the read-only asset folder —
 * plus the path guard that enforces them and the workspace file browsing the sidebar uses.
 *
 * Split out of aiToolkit.mjs, which re-exports the public part unchanged. This module OWNS WORKDIR and ASSET_DIR:
 * only the setters here assign them, and the other parts read them through getWorkingDir() / getAssetDir() (an
 * ESM importer cannot assign another module's binding, so a second copy elsewhere would silently go stale).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePath } from "../paths.mjs";
import { invalidateFileList as invalidateRustFileList } from "../rustRuntime.mjs";
import { resetObservations } from "../projectMemory/observations.mjs";
import { resetConversationCapture } from "../projectMemory/conversation.mjs";

const MAX_READ_BYTES = 2 * 1024 * 1024; // editor open cap (wsReadFile). The read_file TOOL has no size limit — see read_file.rs.

// ── Working directory ────────────────────────────────────────────────────────
let WORKDIR = path.join(os.homedir(), "zeraix-workspace");

/** Set the working directory (absolute path). Returns the normalized path.
 *  Each session's workdir is set at session start and never changes afterward. The sandbox needs no notice of it:
 *  every command binds its own cwd to /workspace, so a new workdir costs nothing to adopt (this used to prewarm the
 *  engine to fold the directory into the VM's mount set). */
export function setWorkingDir(dir) {
  WORKDIR = path.resolve(dir);
  // The runtime caches a file list per workspace and cannot see that the workspace changed.
  invalidateRustFileList(WORKDIR);
  resetObservations(); // reads observed for the previous workspace say nothing about this one
  resetConversationCapture();
  return WORKDIR;
}
export function getWorkingDir() {
  return WORKDIR;
}

// ── Workspace file browsing (for the sidebar file tree + right-hand editor UI, not the AI tool loop) ────────────────────────
// Everything is confined within WORKDIR (resolveInside). The frontend expands level by level on demand, so read_dir lists only one level and does not recurse.

/** List the direct children of a directory (relative to WORKDIR), returned structured as [{name,isDir}] (directories first, sorted by name). */
export async function wsReadDir(relPath = "") {
  const abs = relPath ? resolveInside(relPath) : WORKDIR;
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/**
 * Read a file for "view / edit" and determine whether it can be opened. Returns:
 *  - { ok:true, editable:true, content, size }            -- text file, viewable / editable
 *  - { ok:false, reason, size? }                          -- cannot open (directory / too large / binary / read failure); reason gives the cause
 */
export async function wsReadFile(relPath) {
  const abs = resolveInside(relPath);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return { ok: false, reason: `Unable to read: ${e?.message ?? e}` };
  }
  if (st.isDirectory()) return { ok: false, reason: "This is a directory" };
  if (st.size > MAX_READ_BYTES)
    return { ok: false, reason: `File too large (${st.size} bytes > ${MAX_READ_BYTES}); opening in the editor is not supported yet`, size: st.size };
  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    return { ok: false, reason: `Unable to read: ${e?.message ?? e}`, size: st.size };
  }
  // Binary detection: a NUL byte within the first 8KB marks the file as binary; not for text view / edit.
  if (buf.subarray(0, Math.min(buf.length, 8000)).includes(0))
    return { ok: false, reason: "Binary file; cannot view / edit as text (open with the system default app instead)", size: st.size };
  return { ok: true, editable: true, content: buf.toString("utf8"), size: st.size };
}

/** Save file content (the user's direct edit in the editor, not an AI change). Returns { ok } or { ok:false, error }. */
export async function wsWriteFile(relPath, content) {
  try {
    const abs = resolveInside(relPath, { write: true });
    await fs.writeFile(abs, String(content ?? ""), "utf8");
    invalidateRustFileList(WORKDIR); // a new file may have been created; the runtime's list is now stale
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Ensure WORKDIR exists (create it on first use). */
export async function ensureWorkdir() {
  await fs.mkdir(WORKDIR, { recursive: true });
}

/**
 * The asset folder: a SECOND root, readable but never writable. See tools/paths.mjs for the rules and why
 * they live there rather than here.
 *
 * Empty means "not configured", and then these tools behave exactly as they did with one root.
 */
let ASSET_DIR = "";

/** Point the read-only root at a directory (absolute), or "" to disable it. */
export function setAssetDir(dir) {
  ASSET_DIR = typeof dir === "string" && dir.trim() ? path.resolve(dir) : "";
  return ASSET_DIR;
}

export function getAssetDir() {
  return ASSET_DIR;
}

/** Resolve a caller-given path against the two roots. Thin: the rules are in tools/paths.mjs, where they can be tested. */
export function resolveInside(p, { write = false } = {}) {
  return resolvePath(p, { workdir: WORKDIR, assetDir: ASSET_DIR, write });
}
