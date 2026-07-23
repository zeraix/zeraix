/**
 * AI toolkit (executed in the main process).
 *
 * Exposes a set of "file / directory / command" tools for the LLM to call by name: the renderer
 * (sandboxed, no Node) calls `runTool(name, args)` via preload + IPC, while the actual fs /
 * child-process operations happen in the main process.
 *
 * Security constraints: all paths are confined to the "working directory" (WORKDIR); out-of-bounds
 * access is rejected. `run_command` also runs under WORKDIR, with a timeout and an output cap.
 * Call setWorkingDir when a broader scope is needed.
 *
 * Tool declarations follow the caller-provided fn(name, description, params, required) shape;
 * `list(format)` can directly produce the OpenAI / Anthropic tools structure.
 */

import fs from "node:fs/promises";
import { constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shell } from "electron";

import { llmChat } from "../llm/proxy.mjs";
import {
  getEngine,
  initEngine as engineInit,
  listProcesses as engineListProcesses,
  stopProcess as engineStopProcess,
} from "./sandbox/engine.mjs";
import { ensureProjectMemory, summarise as summariseMemory } from "./projectMemory/index.mjs";
import { rememberProject } from "./projectMemory/remember.mjs";
import { noteFileRead, resetObservations } from "./projectMemory/observations.mjs";
import { noteUserMessage, resetConversationCapture } from "./projectMemory/conversation.mjs";

// Command execution is abstracted into a pluggable engine (native = run directly on the host
// (legacy behavior); qemu = hardware-isolated VM, see the probing/selection in
// ./sandbox/engine.mjs). Here we re-export the engine layer's public interface unchanged, so
// main.mjs's existing imports (setServiceEventHandler / stopProcess / listProcesses /
// stopBackgroundProcs) keep working.
export {
  setServiceEventHandler,
  listProcesses,
  stopProcess,
  stopBackgroundProcs,
  disposeEngines,
  getEngineInfo,
  getSandboxStatus,
  setSandboxMode,
  onSandboxStatus,
  restartSandbox,
  sandboxVmInfo,
} from "./sandbox/engine.mjs";

/** Start the sandbox's background initialization (injecting a working-directory reader: on init it
 *  mounts and starts a long-lived sandbox for the current WORKDIR). */
export function initEngine() {
  return engineInit({ getWorkdir: getWorkingDir });
}

// The "execution environment switched" note in run_command results: the sandbox becoming ready in
// the background (or degrading / switching mode) can happen mid-session, and the system prompt can't
// be updated — so we announce it through the tool result, a channel the model keeps reading, so the
// model immediately switches to commands matching the new environment (Linux vs the host system).
let lastRunEngineId = null;
function engineSwitchNote(engineId) {
  if (lastRunEngineId === engineId) return "";
  const first = lastRunEngineId === null;
  lastRunEngineId = engineId;
  if (first) return ""; // No note on the session's first run (the system prompt already describes the current environment)
  // qemu (HVF/WHPX/KVM VM): an isolated Debian/bash sandbox with the host directory mounted in; the model switches to Linux commands accordingly.
  if (engineId === "qemu") {
    return (
      "[Execution environment switched] From this command on, commands run inside an isolated Linux " +
      "(Debian, bash) sandbox; the working directory and file tools still point to the same directory " +
      "(the host directory is mounted into the sandbox). Please use Linux commands.\n\n"
    );
  }
  const host =
    process.platform === "win32" ? "Windows (cmd/PowerShell)" : process.platform === "darwin" ? "macOS (zsh/bash)" : "Linux (bash)";
  return `[Execution environment switched] From this command on, commands run directly on the host ${host} again; please use commands matching that system.\n\n`;
}

/** URL → origin (scheme+host+port), for matching background services by address. */
function toOrigin(u) {
  try {
    const x = new URL(String(u));
    const h = x.hostname === "0.0.0.0" ? "localhost" : x.hostname;
    return `${x.protocol}//${h}${x.port ? `:${x.port}` : ""}`;
  } catch {
    return String(u);
  }
}

/** Whether this is a dangerous command that could kill this app / mass-terminate processes (should be rejected). */
function isAppKillingCommand(cmd) {
  const c = cmd.toLowerCase();
  // taskkill /IM node.exe|electron.exe|zeraix.exe (mass-terminate by image name)
  if (/\btaskkill\b/.test(c) && /\/im\s+["']?(node|electron|zeraix)/.test(c)) return true;
  // pkill / killall node|electron
  if (/\b(pkill|killall)\b/.test(c) && /\b(node|electron)\b/.test(c)) return true;
  // wmic ... process ... (node|electron) ... delete
  if (/\bwmic\b/.test(c) && /process/.test(c) && /(node|electron)/.test(c) && /delete/.test(c)) return true;
  // Terminating this app's own process pid
  if (/\b(taskkill|kill)\b/.test(c) && new RegExp(`\\b${process.pid}\\b`).test(c)) return true;
  return false;
}

// ── Limits / defaults ────────────────────────────────────────────────────────
const MAX_READ_BYTES = 2 * 1024 * 1024; // read_file per-file cap: 2MB
const READ_DEFAULT_MAX_LINES = 2000; // read_file: lines returned when no explicit limit is given
const READ_MAX_CHARS = 200_000; // read_file per-call ceiling; a line cap cannot bound a minified single-line file
const MAX_MATCHES = 200; // search_* result cap
const MAX_LINE_LEN = 400; // search_in_files per-line echo cap
const CMD_TIMEOUT_MS = 60_000; // run_command timeout
const CMD_MAX_BUFFER = 10 * 1024 * 1024; // run_command output cap: 10MB
// web_search / fetch_url (headless HTTP in the main process; no visible browser).
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WEB_TIMEOUT_MS = 15_000; // per HTTP request
const WEB_SEARCH_MAX = 10; // hard cap on results returned by web_search
const WEB_SEARCH_DEFAULT = 6; // default result count
const WEB_FETCH_MAX_CHARS = 8_000; // fetch_url readable-text cap
// Heavy directories skipped during recursive traversal, to avoid noise and performance issues.
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "Zeraix"]);

// ── Working directory ────────────────────────────────────────────────────────
let WORKDIR = path.join(os.homedir(), "zeraix-workspace");

/** Set the working directory (absolute path). Returns the normalized path.
 *  Each session's workdir is set at session start and never changes afterward — here we also let the
 *  sandbox engine prewarm that directory in the background (fold it into the VM's mount set) so the
 *  session's first command hits the sandbox with zero wait; the native engine has no prewarm, so this
 *  is a harmless no-op. */
export function setWorkingDir(dir) {
  WORKDIR = path.resolve(dir);
  invalidateWalkCache(); // directory changed: the old file-list cache is now stale
  resetObservations(); // reads observed for the previous workspace say nothing about this one
  resetConversationCapture();
  getEngine().prewarm?.(WORKDIR);
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
    const abs = resolveInside(relPath);
    await fs.writeFile(abs, String(content ?? ""), "utf8");
    invalidateWalkCache(); // a new file may have been created; invalidate the file-list cache
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Ensure WORKDIR exists (create it on first use). */
async function ensureWorkdir() {
  await fs.mkdir(WORKDIR, { recursive: true });
}

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
export async function saveAttachment({ name, srcPath, bytes }) {
  await ensureWorkdir();
  const base =
    path.basename(String(name || "attachment")).replace(/[\\/:*?"<>|\u0000-\u001f\s]/g, "_") || "attachment";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "attachment";
  let target = path.join(WORKDIR, base);
  for (let i = 1; ; i++) {
    try {
      await fs.access(target);
      target = path.join(WORKDIR, `${stem}-${i}${ext}`); // Already exists → try a different name
    } catch {
      break; // Doesn't exist → available
    }
  }
  if (srcPath) {
    // FICLONE: zero-copy on reflink-capable filesystems (APFS / Btrfs / XFS); otherwise falls back to a normal copy automatically.
    await fs.copyFile(String(srcPath), target, FS.COPYFILE_FICLONE);
  } else {
    await fs.writeFile(target, Buffer.from(bytes)); // Synthetic file: bytes only in memory, passed in over IPC and written to disk.
  }
  return target;
}

// ── LLM config (for tools like refine_question that make a secondary model call) ──────────────────
// Tools are called by name by the model, and the call arguments should not (and do not) carry
// sensitive config like endpoint / apiKey. So, like WORKDIR, we keep a single copy centrally in the
// main process, injected by the renderer via IPC before a session starts.
let LLM_CONFIG = {
  endpoint: "", // OpenAI-compatible /chat/completions endpoint
  apiKey: "", // Auth key (kept in memory only, not persisted)
  model: "", // Model name
  headers: undefined, // Optional extra request headers
};

/**
 * Set the LLM config used by tools such as "question refinement" when they make a secondary model call.
 * The given fields are shallow-merged with the existing config (only the provided fields are overwritten).
 * Returns the merged config (with sensitive fields not echoed back).
 */
export function setLLMConfig(cfg = {}) {
  LLM_CONFIG = {
    endpoint: cfg.endpoint ?? LLM_CONFIG.endpoint,
    apiKey: cfg.apiKey ?? LLM_CONFIG.apiKey,
    model: cfg.model ?? LLM_CONFIG.model,
    headers: cfg.headers ?? LLM_CONFIG.headers,
  };
  return getLLMConfig();
}

/** Read the current LLM config (apiKey only returns whether it is set, to avoid leaking it). */
export function getLLMConfig() {
  return {
    endpoint: LLM_CONFIG.endpoint,
    model: LLM_CONFIG.model,
    hasApiKey: !!LLM_CONFIG.apiKey,
    headers: LLM_CONFIG.headers,
  };
}

/** Resolve a user-given path inside WORKDIR, preventing out-of-bounds access (path traversal). */
function resolveInside(p) {
  if (typeof p !== "string") throw new Error("path must be a string");
  const abs = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return abs;
}

/** For display: a path relative to WORKDIR (with slashes normalized). */
function rel(abs) {
  const r = path.relative(WORKDIR, abs) || ".";
  return r.split(path.sep).join("/");
}

// ── Encoding / line-ending preservation ──────────────────────────────────────
// Writing every edit back as plain "utf8" silently dropped UTF-8 BOMs, flipped CRLF→LF, and turned a GBK/UTF-16
// file into mojibake (`�`). These helpers let write_file / edit_file / append_file keep a file's original bytes
// intact outside the actual change — the "preserve encoding / line endings / BOM" guarantees, enforced in code
// rather than asked for in the prompt (a model cannot reliably deliver them itself).

/** Dominant newline of a text: CRLF only if the file has CRLFs and they are at least as common as bare LFs. */
function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf; // bare LFs (not part of a CRLF)
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
}

/** Re-emit `content` (held in LF-space) with the given newline style, so an edit never introduces mixed endings. */
function applyNewline(content, newline) {
  return newline === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

/** Encode a working string (BOM-free, any newlines) back to bytes, re-attaching the UTF-8 BOM if the original had one. */
function encodeText(text, hasBom) {
  return Buffer.from(hasBom ? `﻿${text}` : text, "utf8");
}

/**
 * Read a text file for editing, capturing the byte-level traits a write must preserve.
 * Returns { text (BOM stripped), hasBom, newline }. Refuses non-UTF-8 files (UTF-16 BOM, or bytes that are not
 * valid UTF-8) instead of decoding them into `�` and clobbering them — surfacing the encoding so the caller can
 * convert deliberately. A missing file propagates the original ENOENT (code preserved) so callers can treat it as new.
 */
async function readTextForEdit(abs) {
  const buf = await fs.readFile(abs); // ENOENT propagates with .code intact
  // UTF-16 / UTF-32 BOM → not our encoding; decoding as UTF-8 would corrupt it.
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    throw new Error(
      `${rel(abs)} is UTF-16 encoded, not UTF-8. This tool edits UTF-8 text only; editing it here would corrupt it. ` +
        `Convert it to UTF-8 first if you mean to work with it as text.`,
    );
  }
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf); // throws on any non-UTF-8 byte
  } catch {
    throw new Error(
      `${rel(abs)} is not valid UTF-8 (it may be GBK, GB2312, or another legacy encoding). Editing it as text here ` +
        `would replace its non-ASCII characters with "�". Convert it to UTF-8 first.`,
    );
  }
  // TextDecoder keeps the BOM as a leading U+FEFF; strip it so offsets/diffs/line counts see clean text, re-add on write.
  if (hasBom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, hasBom, newline: detectNewline(text) };
}

/** Compile a glob (* ? and character classes) into a regex that matches the "filename". */
function globToRegExp(glob) {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`, "i");
}

/** Recursively list files under WORKDIR (skipping SKIP_DIRS), returning an array of absolute paths. */
async function walkFiles(startAbs) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }
  await walk(startAbs);
  return out;
}

// File-list cache: search_* originally walked the whole directory on every call, so dozens of searches in one investigation = dozens of full-tree walks.
// Cache the result of a single walk (file path list only; content is still read fresh each time, so content changes are always visible). Invalidated on write / delete / move / command
// or when the working directory changes (see runTool's MUTATING check and setWorkingDir).
let _walkCache = null; // { workdir, files }
function invalidateWalkCache() {
  _walkCache = null;
}
async function walkFilesCached() {
  if (_walkCache && _walkCache.workdir === WORKDIR) return _walkCache.files;
  const files = await walkFiles(WORKDIR);
  _walkCache = { workdir: WORKDIR, files };
  return files;
}

// ── Unified diff (returned by write_file / edit_file, for the frontend to render + for the model to see changes) ──────
const DIFF_MAX_LINES = 200; // diff line cap; truncated beyond this (to avoid feeding back too many tokens)
const DIFF_MAX_INPUT = 6000; // If the combined old+new line count exceeds this, skip the line-by-line diff

/** LCS-based line-by-line diff, returning a sequence of [type, line], where type is ' ' | '-' | '+'. */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

/**
 * Diagnose a failed edit_file match by locating the line where the supplied text stops agreeing with
 * the file.
 *
 * The dominant failure mode is a long block retyped from memory with a line or two wrong somewhere in
 * the middle: the exact match fails, and the whitespace-collapse check fails too because the
 * divergence is real text rather than spacing. Both leave the model with nothing to act on, so it
 * re-guesses at a variation and fails identically — the loop the user keeps hitting.
 *
 * So anchor on the first non-blank supplied line, walk forward while lines keep agreeing (comparing
 * trimmed, since indentation is the *other* common miss and is already reported separately), and name
 * the first line that differs, both sides quoted with line numbers. That turns "not found" into a
 * single targeted re-read.
 *
 * Returns "" when there is no anchor at all — the block genuinely isn't in this file, and the caller's
 * generic message is already the right advice.
 */
function describeEditDivergence(text, oldStr) {
  const fileLines = text.split("\n");
  const oldLines = oldStr.split("\n");
  const firstIdx = oldLines.findIndex((l) => l.trim());
  if (firstIdx === -1) return "";
  const anchor = oldLines[firstIdx].trim();

  // Best anchor = the occurrence that keeps agreeing for the most lines. Ambiguous anchors (a common
  // line like "}" or "try {") are why this picks the longest run instead of the first hit.
  let best = null;
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== anchor) continue;
    let n = 0;
    while (
      firstIdx + n < oldLines.length &&
      i + n < fileLines.length &&
      fileLines[i + n].trim() === oldLines[firstIdx + n].trim()
    ) {
      n++;
    }
    if (!best || n > best.matched) best = { start: i, matched: n };
  }
  if (!best) return "";

  const oi = firstIdx + best.matched; // first supplied line that disagrees
  const fi = best.start + best.matched; // the file line it was compared against
  if (oi >= oldLines.length) return ""; // every supplied line agreed → a pure whitespace miss, reported by the caller's other branch

  const clip = (s) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  const fileSide =
    fi < fileLines.length ? JSON.stringify(clip(fileLines[fi].trim())) : "past the end of the file";
  return (
    ` Your first ${best.matched} line(s) DO match, starting at line ${best.start + 1} — the text diverges at` +
    ` your line ${oi + 1}: you supplied ${JSON.stringify(clip(oldLines[oi].trim()))}, but line ${fi + 1}` +
    ` of the file is ${fileSide}. Re-read that range and copy it verbatim rather than adjusting what you wrote.`
  );
}

/**
 * Produce a unified diff (with @@ line-number headers and context), wrapped in a ```diff code block.
 * Returns an empty string if the content is identical; returns a short note for oversized files.
 */
function makeUnifiedDiff(before, after, context = 3) {
  if (before === after) return "";
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  if (a.length + b.length > DIFF_MAX_INPUT) {
    return `\n\`\`\`diff\n@@ ${a.length} → ${b.length} lines (file too large, diff omitted) @@\n\`\`\``;
  }

  // Line-by-line diff, annotating old and new line numbers.
  const ops = diffLines(a, b);
  let oldLn = 1;
  let newLn = 1;
  const rows = ops.map(([t, line]) => {
    const row = { t, line, oldLn: t === "+" ? null : oldLn, newLn: t === "-" ? null : newLn };
    if (t !== "+") oldLn++;
    if (t !== "-") newLn++;
    return row;
  });

  // Find the changed positions and group them into hunks by context.
  const changed = [];
  rows.forEach((r, idx) => {
    if (r.t !== " ") changed.push(idx);
  });
  if (!changed.length) return "";
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(rows.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - context <= end + 1) {
      end = Math.min(rows.length - 1, changed[k] + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, changed[k] - context);
      end = Math.min(rows.length - 1, changed[k] + context);
    }
  }
  hunks.push([start, end]);

  const out = [];
  let total = 0;
  for (const [s, e] of hunks) {
    let oFirst = null;
    let nFirst = null;
    let oCount = 0;
    let nCount = 0;
    for (let k = s; k <= e; k++) {
      const r = rows[k];
      if (r.t !== "+") {
        if (oFirst == null) oFirst = r.oldLn;
        oCount++;
      }
      if (r.t !== "-") {
        if (nFirst == null) nFirst = r.newLn;
        nCount++;
      }
    }
    out.push(`@@ -${oFirst ?? 0},${oCount} +${nFirst ?? 0},${nCount} @@`);
    for (let k = s; k <= e; k++) {
      const r = rows[k];
      out.push((r.t === "+" ? "+" : r.t === "-" ? "-" : " ") + r.line);
      if (++total >= DIFF_MAX_LINES) {
        out.push("... (diff truncated)");
        return `\n\`\`\`diff\n${out.join("\n")}\n\`\`\``;
      }
    }
  }
  return `\n\`\`\`diff\n${out.join("\n")}\n\`\`\``;
}

// ── Project verification (build / test) ───────────────────────────────────────
const CHECK_TIMEOUT_MS = 180_000; // Per-step timeout for build / test (more lenient than a normal command)
const CHECK_OUT_CAP = 4000; // Per-step output feedback cap (characters)

/** Whether a file / directory exists under WORKDIR. */
async function existsInWorkdir(relPath) {
  try {
    await fs.access(path.join(WORKDIR, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Run one command under WORKDIR, returning { ok, code, out, killed } (never throws). Goes through the current execution engine. */
async function runShell(cmd) {
  const r = await getEngine().run(cmd, {
    cwd: WORKDIR,
    timeoutMs: CHECK_TIMEOUT_MS,
    maxBuffer: CMD_MAX_BUFFER,
  });
  return {
    ok: r.code === 0 && !r.killed,
    code: r.code,
    killed: !!r.killed,
    out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(),
  };
}

/**
 * Infer the "build / test" steps to run based on the project type, returning [{ label, cmd }].
 * Supports Node/TS, Rust, Go, Python; returns an empty array if none is detected.
 */
async function detectCheckSteps() {
  const steps = [];

  if (await existsInWorkdir("package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(await fs.readFile(path.join(WORKDIR, "package.json"), "utf8"));
    } catch {
      pkg = {};
    }
    const scripts = pkg.scripts || {};
    // Pick the package manager (by lock file).
    const pm = (await existsInWorkdir("pnpm-lock.yaml"))
      ? "pnpm"
      : (await existsInWorkdir("yarn.lock"))
        ? "yarn"
        : (await existsInWorkdir("bun.lockb"))
          ? "bun"
          : "npm";
    const runScript = (s) => (pm === "npm" ? `npm run ${s} --silent` : `${pm} run ${s}`);

    // Build / type-check: prefer the project's own script, otherwise run tsc --noEmit for TS projects.
    if (scripts.typecheck) steps.push({ label: "typecheck", cmd: runScript("typecheck") });
    else if (await existsInWorkdir("tsconfig.json"))
      steps.push({ label: "typecheck", cmd: "npx tsc --noEmit" });
    if (scripts.lint) steps.push({ label: "lint", cmd: runScript("lint") });
    // Test: only when a real test script exists (skip npm's default placeholder).
    if (scripts.test && !/no test specified/i.test(scripts.test))
      steps.push({ label: "test", cmd: runScript("test") });
  } else if (await existsInWorkdir("Cargo.toml")) {
    steps.push({ label: "compile", cmd: "cargo check" });
    steps.push({ label: "test", cmd: "cargo test" });
  } else if (await existsInWorkdir("go.mod")) {
    steps.push({ label: "compile", cmd: "go build ./..." });
    steps.push({ label: "test", cmd: "go test ./..." });
  } else if (
    (await existsInWorkdir("pyproject.toml")) ||
    (await existsInWorkdir("setup.py")) ||
    (await existsInWorkdir("requirements.txt"))
  ) {
    steps.push({ label: "compile", cmd: "python -m compileall -q ." });
    steps.push({ label: "test", cmd: "pytest -q" });
  }
  return steps;
}

// ── Secondary LLM call ─────────────────────────────────────────────────────────
const REFINE_MAX_CHARS = 4000; // Truncation length for a single input field (question / context), to avoid feeding back too many tokens

/**
 * Run one non-streaming chat with the configured LLM and return the first candidate's text content.
 * Throws if the config is missing or the request fails; runTool wraps that into a tool error result.
 */
async function chatComplete(messages, { temperature = 0.2, maxTokens } = {}) {
  const { endpoint, apiKey, model, headers } = LLM_CONFIG;
  if (!endpoint) throw new Error("LLM endpoint is not configured; call setLLMConfig first to inject the LLM config");
  if (!model) throw new Error("LLM model is not configured; call setLLMConfig first to inject the LLM config");

  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await llmChat({ endpoint, apiKey, body, headers });
  if (!res?.ok) {
    const detail = res?.error || (res?.data ? JSON.stringify(res.data).slice(0, 500) : "");
    throw new Error(`LLM request failed (status ${res?.status ?? "?"})${detail ? `: ${detail}` : ""}`);
  }
  const content = res.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM returned empty content");
  }
  return content.trim();
}

// ── Web search / fetch (headless HTTP; no visible browser) ─────────────────────
// These give the model a built-in way to look things up and read pages WITHOUT opening the
// in-app browser panel each time. They run in the main process (Node), so they are not subject
// to the renderer's CORS restrictions. web_search scrapes Bing's HTML result page (keyless; Bing is
// reachable in both mainland China and internationally); fetch_url downloads a single URL and strips
// HTML to readable text.

/** GET a URL with a browser-like UA and a hard timeout. Returns the Response (throws on error/timeout). */
async function httpGet(url, { accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": WEB_UA,
        "Accept-Language": "en-US,en;q=0.9",
        ...(accept ? { Accept: accept } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Named HTML entities commonly seen in search snippets / page text (beyond the numeric forms). */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ensp: " ", emsp: " ", thinsp: " ", middot: "·", bull: "•", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
};

/** Decode the HTML entities that appear in titles / snippets / page text (numeric + common named). */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePointOr(parseInt(h, 16), _))
    .replace(/&#(\d+);/g, (_, d) => codePointOr(parseInt(d, 10), _))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m,
    );
}
function codePointOr(cp, fallback) {
  try {
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : fallback;
  } catch {
    return fallback;
  }
}

/** Strip HTML → collapsed readable plain text (drops script/style, keeps rough block breaks). */
function htmlToText(html) {
  const stripped = String(html)
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bing result href → the real destination URL. Most organic results are direct links; some are
 *  wrapped in a /ck/a redirect whose `u` param is `a1` + base64url(url). Returns null for a Bing
 *  redirect we can't decode (so the caller skips it) rather than surfacing a tracker URL. */
function unwrapBingUrl(href) {
  try {
    const u = new URL(href, "https://www.bing.com");
    if (/(^|\.)bing\.com$/i.test(u.hostname) && /\/ck\/a/i.test(u.pathname)) {
      const raw = u.searchParams.get("u") || "";
      const b64 = raw.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
      if (b64) {
        const dec = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//i.test(dec)) return dec;
      }
      return null; // undecodable Bing redirect → drop it
    }
    return u.href;
  } catch {
    return href;
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────
// Each implementation returns a "string" as the tool result text for the model; exceptions are caught uniformly by runTool.
const handlers = {
  /**
   * Question refinement: rewrite the session's vague / colloquial original question, together with
   * optional context, into a clear, specific, unambiguous question that is easy to search and answer.
   * Returns only the refined question text.
   */
  async refine_question({ question, context } = {}) {
    const q = String(question ?? "").trim();
    if (!q) throw new Error("question must not be empty");
    const ctx = String(context ?? "").trim();

    const userParts = [`Original question:\n${q.slice(0, REFINE_MAX_CHARS)}`];
    if (ctx) userParts.push(`\nConversation context (only to understand intent, do not answer it directly):\n${ctx.slice(0, REFINE_MAX_CHARS)}`);

    const messages = [
      {
        role: "system",
        content:
          "You are a \"question refinement\" assistant. Rewrite the user's original question (optionally " +
          "using the provided conversation context) into a clear, specific, unambiguous, self-contained " +
          "question that is easy to search and answer. Requirements: preserve the user's original intent " +
          "and key constraints; fill in obviously missing references; remove pleasantries and redundancy; " +
          "use the same language as the original question. Output only the refined question itself, with " +
          "no explanation, prefix, or quotes.",
      },
      { role: "user", content: userParts.join("\n") },
    ];

    return await chatComplete(messages, { temperature: 0.2, maxTokens: 512 });
  },

  /**
   * Project memory: bring ZERAIX.md at the working-directory root up to date, and return it.
   *
   * Freshness is pulled, not pushed: every section of the document declares which files it is a
   * function of, and only sections whose declared inputs actually moved get rebuilt (see
   * ./projectMemory/). An unchanged project costs a handful of stat/read calls and no write at
   * all. Hand-authored sections are seeded once and never machine-written after that.
   */
  async init_command({ refresh } = {}) {
    const result = await ensureProjectMemory({
      workdir: WORKDIR,
      mode: refresh ? "full" : "auto",
      llm: { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete },
      detectCheckSteps,
    });
    return `${summariseMemory(result)}\n\n${result.markdown}`;
  },

  /**
   * Offer a user message to conversational capture.
   *
   * Deliberately absent from TOOLS: the chat page calls this over IPC after the user sends, not the
   * model. Returns at once — the gate and any extraction run in the background, so a slow or failing
   * capture can never delay a message.
   */
  async note_conversation({ text } = {}) {
    noteUserMessage({
      workdir: WORKDIR,
      text,
      llm: { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete },
    });
    return "ok";
  },

  /**
   * Write back into project memory what this session learned.
   *
   * The generated sections can only ever describe what is derivable from the repository's shape.
   * Anything the model works out by actually reading code — or anything the user explains — dies
   * with the turn unless it is recorded here.
   */
  async remember_project({ note, module: mod } = {}) {
    const result = await rememberProject({
      workdir: WORKDIR,
      note,
      module: mod,
      ensure: () =>
        ensureProjectMemory({
          workdir: WORKDIR,
          mode: "auto",
          llm: { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete },
          detectCheckSteps,
        }),
    });
    if (!result.ok) throw new Error(result.message);
    return result.message;
  },

  // Returns a line range rather than always the whole file: a targeted read keeps the model's context
  // small, and — unlike a downstream character cap — never removes the middle of a file it is reasoning about.
  async read_file({ path: p, offset, limit }) {
    const abs = resolveInside(p);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`file too large (${stat.size} bytes > ${MAX_READ_BYTES})`);
    }
    const text = await fs.readFile(abs, "utf8");

    const lines = text.split("\n");
    // A trailing newline yields a final "" element; dropping it keeps the reported total honest.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;

    const start = Math.max(1, Math.floor(Number(offset) || 1));
    const count = Math.max(1, Math.floor(Number(limit) || READ_DEFAULT_MAX_LINES));
    if (start > total) {
      return `[read_file] offset ${start} is past the end of ${p} — the file has ${total} lines.`;
    }
    const end = Math.min(total, start + count - 1);

    let body = lines.slice(start - 1, end).join("\n");
    let charTrimmed = false;
    if (body.length > READ_MAX_CHARS) {
      body = body.slice(0, READ_MAX_CHARS);
      charTrimmed = true;
    }

    if (start === 1 && end === total && !charTrimmed) return body;

    const notes = [`showing lines ${start}-${end} of ${total}`];
    if (charTrimmed) notes.push(`trimmed at ${READ_MAX_CHARS} characters`);
    if (end < total) notes.push(`read on with offset:${end + 1}`);
    return `${body}\n\n[read_file] ${p}: ${notes.join("; ")}.`;
  },

  // Open a file / folder in the HOST's default application (always runs on the host, never the sandbox).
  // "Opening" is a host GUI action; run_command in daily mode runs inside a headless Linux VM and cannot
  // launch host apps — so this is the correct tool for "open / show / play this file for the user".
  async open_path({ path: p }) {
    const abs = resolveInside(p);
    await fs.access(abs); // exists? (throws a clear error otherwise, incl. "outside working directory")
    const err = await shell.openPath(abs); // "" on success; a non-empty string is the failure reason
    if (err) throw new Error(`failed to open in the default application: ${err}`);
    return `Opened in the host's default application: ${abs}`;
  },

  async write_file({ path: p, content }) {
    const abs = resolveInside(p);
    const toLf = (s) => s.replace(/\r\n/g, "\n");
    const afterLf = toLf(String(content ?? ""));
    // Capture the existing file's traits so a rewrite keeps its encoding, BOM, and newline style instead of forcing
    // LF/no-BOM UTF-8 onto it. A missing file is a new file: LF, no BOM. A non-UTF-8 file is refused (readTextForEdit
    // throws), because rewriting it as UTF-8 would convert it — exactly what "preserve encoding" forbids.
    let before = "";
    let hasBom = false;
    let newline = detectNewline(afterLf);
    try {
      const info = await readTextForEdit(abs);
      before = info.text;
      hasBom = info.hasBom;
      newline = info.newline;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const bytes = encodeText(applyNewline(afterLf, newline), hasBom);
    await fs.writeFile(abs, bytes);
    const verb = before ? "Wrote" : "Created";
    const diff = makeUnifiedDiff(toLf(before), afterLf);
    return `${verb} ${bytes.length} bytes to ${rel(abs)}.${diff}`;
  },

  async edit_file({ path: p, old_string, new_string, replace_all }) {
    const abs = resolveInside(p);
    if (String(old_string ?? "") === "") throw new Error("old_string must not be empty");

    const { text: rawText, hasBom, newline } = await readTextForEdit(abs);
    // Match and splice in LF-space, then restore the file's own newline style on write. This means a match succeeds
    // whether the model supplied "\n" or "\r\n", and the edit never leaves a CRLF file with mixed endings.
    const toLf = (s) => s.replace(/\r\n/g, "\n");
    const text = toLf(rawText);
    const oldStr = toLf(String(old_string ?? ""));
    const newStr = toLf(String(new_string ?? ""));
    if (oldStr === newStr) throw new Error("old_string and new_string are identical");

    // Literal count (not regex): count how many times old_string occurs.
    let count = 0;
    for (let i = text.indexOf(oldStr); i !== -1; i = text.indexOf(oldStr, i + oldStr.length)) {
      count++;
    }
    if (count === 0) {
      // A bare "not found" gives the model nothing to correct, so it re-guesses and fails the same way. Say which kind
      // of miss this was: a whitespace mismatch (the text IS there — it just wasn't copied verbatim) is by far the most
      // common, and needs the opposite fix from text that genuinely isn't in the file.
      const collapse = (s) => s.replace(/\s+/g, " ").trim();
      const loose = collapse(oldStr);
      if (loose && collapse(text).includes(loose)) {
        // Report where it starts, so the fix is one targeted read away.
        const firstLine = oldStr.split("\n").find((l) => l.trim()) ?? "";
        const at = text.indexOf(firstLine.trim());
        const line = at === -1 ? null : text.slice(0, at).split("\n").length;
        throw new Error(
          `old_string not found in ${p}, but the same text IS present with different whitespace` +
            (line ? ` (starts around line ${line})` : "") +
            `. Do not retype it: read_file that range and copy the text exactly as returned, keeping its ` +
            `indentation and line breaks byte-for-byte.`,
        );
      }
      throw new Error(
        `old_string not found in ${p} — that text is not in the file (the file has ${text.split("\n").length} lines).` +
          describeEditDivergence(text, oldStr) +
          ` Do not guess at another variation: read_file the relevant part first, then copy the exact text to replace.`,
      );
    }
    if (!replace_all && count > 1) {
      throw new Error(
        `old_string is not unique (${count} occurrences); set replace_all or add more context`,
      );
    }

    // Literal replacement: use split/join to avoid treating $ etc. as special regex-replacement symbols.
    let next;
    if (replace_all) {
      next = text.split(oldStr).join(newStr);
    } else {
      const idx = text.indexOf(oldStr);
      next = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
    }

    await fs.writeFile(abs, encodeText(applyNewline(next, newline), hasBom));
    const summary = replace_all
      ? `Replaced ${count} occurrence(s) in ${rel(abs)}.`
      : `Replaced 1 occurrence in ${rel(abs)}.`;
    return `${summary}${makeUnifiedDiff(text, next)}`;
  },

  async append_file({ path: p, content }) {
    const abs = resolveInside(p);
    const add = String(content ?? "");
    // Only the appended text is normalized to the file's newline style; existing bytes (and any BOM at the start)
    // are left exactly as they are — an append must not rewrite content it isn't adding.
    let before = "";
    let newline = detectNewline(add);
    try {
      const info = await readTextForEdit(abs);
      before = info.text;
      newline = info.newline;
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // non-UTF-8 file: refuse rather than corrupt it
    }
    const addNorm = applyNewline(add.replace(/\r\n/g, "\n"), newline);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, addNorm, "utf8"); // appends at EOF; existing content and BOM untouched
    const toLf = (s) => s.replace(/\r\n/g, "\n");
    const diff = makeUnifiedDiff(toLf(before), toLf(before) + toLf(addNorm));
    return `Appended ${Buffer.byteLength(addNorm)} bytes to ${rel(abs)}.${diff}`;
  },

  async delete_file({ path: p }) {
    const abs = resolveInside(p);
    await fs.unlink(abs);
    return `Deleted ${rel(abs)}.`;
  },

  async copy_file({ source, destination }) {
    const s = resolveInside(source);
    const d = resolveInside(destination);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(s, d);
    return `Copied ${rel(s)} -> ${rel(d)}.`;
  },

  async move_file({ source, destination }) {
    const s = resolveInside(source);
    const d = resolveInside(destination);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.rm(d, { force: true });
    await fs.rename(s, d);
    return `Moved ${rel(s)} -> ${rel(d)}.`;
  },

  async file_info({ path: p }) {
    const abs = resolveInside(p);
    const st = await fs.stat(abs);
    const info = {
      path: rel(abs),
      type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
      size: st.size,
      modified: st.mtime.toISOString(),
      created: st.birthtime.toISOString(),
    };
    return JSON.stringify(info, null, 2);
  },

  async list_directory({ path: p } = {}) {
    const abs = p ? resolveInside(p) : WORKDIR;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return `(empty) ${rel(abs)}`;
    const lines = entries
      .slice()
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`);
    return `${rel(abs)}:\n${lines.join("\n")}`;
  },

  async create_directory({ path: p }) {
    const abs = resolveInside(p);
    await fs.mkdir(abs, { recursive: true });
    return `Created directory ${rel(abs)}.`;
  },

  async search_files({ pattern }) {
    const re = globToRegExp(String(pattern));
    const files = await walkFilesCached();
    const hits = files.filter((f) => re.test(path.basename(f))).map(rel);
    if (hits.length === 0) return `No files match "${pattern}".`;
    const shown = hits.slice(0, MAX_MATCHES);
    const more = hits.length > shown.length ? `\n… and ${hits.length - shown.length} more` : "";
    return `${hits.length} match(es):\n${shown.join("\n")}${more}`;
  },

  async search_in_files({ query, pattern, regex, ignore_case, context }) {
    const needle = String(query ?? "");
    if (!needle) throw new Error("query must not be empty");
    const ctx = Number.isFinite(context) ? Math.max(0, Math.min(5, Math.floor(context))) : 2;
    const nameRe = pattern ? globToRegExp(String(pattern)) : null;
    // Matcher: regex -> regular expression (case-insensitive optional); otherwise substring (case-insensitive optional).
    let test;
    if (regex) {
      let re;
      try {
        re = new RegExp(needle, ignore_case ? "i" : "");
      } catch (e) {
        throw new Error(`invalid regex: ${e?.message ?? e}`);
      }
      test = (line) => re.test(line);
    } else if (ignore_case) {
      const low = needle.toLowerCase();
      test = (line) => line.toLowerCase().includes(low);
    } else {
      test = (line) => line.includes(needle);
    }
    const clip = (s) => (s.length > MAX_LINE_LEN ? `${s.slice(0, MAX_LINE_LEN)}…` : s);
    const files = (await walkFilesCached()).filter((f) => !nameRe || nameRe.test(path.basename(f)));
    const blocks = [];
    let total = 0;
    for (const f of files) {
      if (total >= MAX_MATCHES) break;
      let text;
      try {
        const st = await fs.stat(f);
        if (st.size > MAX_READ_BYTES) continue; // skip oversized / likely-binary files
        text = await fs.readFile(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      const hits = [];
      for (let i = 0; i < lines.length && total + hits.length < MAX_MATCHES; i++) {
        if (test(lines[i])) hits.push(i);
      }
      if (hits.length === 0) continue;
      // Merge matched lines into hunks by ±ctx (adjacent / overlapping ones are combined), output with line numbers: "N:" for a matched line, "N-" for context.
      const hitSet = new Set(hits);
      const hunks = [];
      for (const h of hits) {
        const start = Math.max(0, h - ctx);
        const end = Math.min(lines.length - 1, h + ctx);
        const last = hunks[hunks.length - 1];
        if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
        else hunks.push({ start, end });
      }
      const parts = hunks.map((hunk) => {
        const buf = [];
        for (let i = hunk.start; i <= hunk.end; i++) {
          buf.push(`${i + 1}${hitSet.has(i) ? ":" : "-"} ${clip(lines[i])}`);
        }
        return buf.join("\n");
      });
      blocks.push(`${rel(f)}:\n${parts.join("\n--\n")}`);
      total += hits.length;
    }
    if (blocks.length === 0) {
      return `No matches for ${regex ? `/${needle}/` : `"${needle}"`}${ignore_case ? " (case-insensitive)" : ""}.`;
    }
    const capped =
      total >= MAX_MATCHES
        ? `\n\n[…capped at ${MAX_MATCHES} matches — narrow the query or add a name pattern]`
        : "";
    return (
      `${total} match(es) with ±${ctx} context lines ` +
      `(working-directory-relative paths; "N:" = match line, "N-" = context):\n\n` +
      `${blocks.join("\n\n")}${capped}`
    );
  },

  async run_command({ command, background }) {
    await ensureWorkdir();
    const cmd = String(command ?? "").trim();
    if (!cmd) throw new Error("command must not be empty");
    // Safety guardrail: reject commands that could kill this app (Electron / Node) or mass-terminate
    // processes by image name. To stop a background service you started yourself, use stop_service
    // instead (it only ends that service's process tree and never affects this app).
    if (isAppKillingCommand(cmd)) {
      return (
        "Refused to execute: this command could terminate this app or many unrelated processes (e.g. " +
        "taskkill/pkill node/electron by image name, or terminating this app's process). To stop a " +
        "background service you started earlier, use the stop_service tool instead (pass a pid or url)."
      );
    }
    // Long-lived processes such as dev servers / watchers: start non-blocking in the background so they
    // aren't killed by the 60s timeout. When not explicitly specified, auto-detect by command shape
    // (dev/serve/start/watch/preview, vite/webpack/nodemon/next dev).
    const looksLongRunning =
      /\b(dev|serve|start|watch|preview)\b/i.test(cmd) ||
      /\bvite\b|\bwebpack(-dev-server)?\b|\bnodemon\b|next\s+dev/i.test(cmd);
    // Through the current execution engine (native = run directly on the host; qemu = isolated
    // execution inside a VM). When the engine differs from last time (sandbox became ready mid-run
    // / degraded / switched mode), prepend the environment-switch note before the result.
    const engine = getEngine();
    const note = engineSwitchNote(engine.id);
    if (background ?? looksLongRunning) {
      const msg = await engine.startBackground(cmd, { cwd: WORKDIR });
      return `${note}${msg}`;
    }
    const r = await engine.run(cmd, {
      cwd: WORKDIR,
      timeoutMs: CMD_TIMEOUT_MS,
      maxBuffer: CMD_MAX_BUFFER,
    });
    if (r.code === 0 && !r.killed) {
      const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
      return `${note}${out || "(no output, exit code 0)"}`;
    }
    const parts = [];
    if (note) parts.push(note.trim());
    if (r.stdout) parts.push(r.stdout.trim());
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.trim()}`);
    parts.push(`[exit code ${r.code ?? "?"}${r.killed ? ", killed (timeout)" : ""}]`);
    // A timeout is usually because the command started a program that opens a window / stays resident
    // (a GUI / server) and blocked waiting: explicitly tell the model not to keep retrying similar
    // commands, to avoid a spinning loop.
    if (r.killed) {
      parts.push(
        "Note: the command did not finish within 60 seconds and was terminated. If this is a program " +
          "that opens a window or keeps running (e.g. a GUI app or a service), it may already have " +
          "started. Do not keep retrying similar commands; to run in the background use a non-blocking " +
          "launch, or just tell the user to run it manually.",
      );
    }
    return parts.filter(Boolean).join("\n");
  },

  async stop_service({ pid, url } = {}) {
    const procs = engineListProcesses();
    const has = (t) => procs.some((s) => s.pid === t);
    let target = pid != null && pid !== "" ? Number(pid) : NaN;
    if ((Number.isNaN(target) || !has(target)) && url) {
      const want = toOrigin(url);
      const hit = procs.find((s) => s.url && toOrigin(s.url) === want);
      if (hit) target = hit.pid;
    }
    // When unspecified and there's exactly one background service, stop it by default.
    if ((Number.isNaN(target) || !has(target)) && procs.length === 1) {
      target = procs[0].pid;
    }
    if (Number.isNaN(target) || !has(target)) {
      const running = procs
        .map((s) => `pid ${s.pid}${s.url ? ` (${s.url})` : ""}`)
        .join("; ");
      return `No matching background service found (it may have already stopped). Currently running: ${running || "none"}.`;
    }
    engineStopProcess(target);
    return `Stopped background service pid ${target}.`;
  },

  async check_project({ skip_tests } = {}) {
    await ensureWorkdir();
    let steps = await detectCheckSteps();
    if (skip_tests) steps = steps.filter((s) => s.label !== "test");
    if (steps.length === 0) {
      return "No verifiable project type detected (supports Node/TS, Rust, Go, Python).";
    }

    const blocks = [];
    let allOk = true;
    for (const s of steps) {
      const r = await runShell(s.cmd);
      if (!r.ok) allOk = false;
      const status = r.ok
        ? "✅ Passed"
        : `❌ Failed (exit ${r.code}${r.killed ? ", timeout" : ""})`;
      const body = r.out
        ? `\n${r.out.length > CHECK_OUT_CAP ? `${r.out.slice(0, CHECK_OUT_CAP)}\n… (output truncated)` : r.out}`
        : "";
      blocks.push(`## ${s.label}: \`${s.cmd}\`\n${status}${body}`);
    }
    const header = allOk ? "All checks passed ✅" : "Some checks failed ❌";
    return `${header}\n\n${blocks.join("\n\n")}`;
  },

  /**
   * Web search (built-in, headless): query Bing's HTML endpoint and return the top ranked results
   * as text (title, URL, snippet) — no visible browser, no API key. Bing is chosen because it is
   * reachable both internationally and inside mainland China (unlike Google / DuckDuckGo), so the
   * same code works for both app editions. The model uses this as its primary way to look things
   * up; it can then fetch_url a result to read it in full.
   */
  async web_search({ query, count } = {}) {
    const q = String(query ?? "").trim();
    if (!q) throw new Error("query must not be empty");
    const want = Math.max(1, Math.min(WEB_SEARCH_MAX, Number(count) || WEB_SEARCH_DEFAULT));

    const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`;
    const res = await httpGet(endpoint, { accept: "text/html" });
    if (!res.ok) throw new Error(`search backend returned HTTP ${res.status}`);
    const html = await res.text();

    // Each organic result is an <li class="b_algo"> block: title + href in <h2><a href>, snippet
    // in the block's caption <p>. Split on the block marker, then extract per block.
    const results = [];
    const seen = new Set();
    for (const block of html.split(/<li class="b_algo"/).slice(1)) {
      if (results.length >= want) break;
      const hm = block.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!hm) continue;
      const url = unwrapBingUrl(decodeEntities(hm[1]));
      const title = htmlToText(hm[2]);
      if (!title || !url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const sm =
        block.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
        block.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = sm ? htmlToText(sm[1]) : "";
      results.push({ title, url, snippet });
    }

    if (results.length === 0) {
      return (
        `No web results found for "${q}". The search page may have changed or the query returned ` +
        `nothing — try rephrasing with more distinctive keywords, or use openBrowser to search visually.`
      );
    }

    const lines = results.map(
      (r, n) => `${n + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
    );
    return (
      `Web search results for "${q}" (top ${results.length}):\n\n${lines.join("\n\n")}\n\n` +
      `Next: call fetch_url on the most relevant URL to read its full content, then answer and cite the source. ` +
      `Use openBrowser only if the user needs to see the page or it requires interaction.`
    );
  },

  /**
   * Fetch a single URL (headless) and return its main readable text. HTML is stripped to text;
   * JSON / plain text is returned as-is. Does not run JavaScript and cannot log in / interact —
   * for that the model should use openBrowser + browser instead.
   */
  async fetch_url({ url } = {}) {
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(target)) throw new Error("url must be an absolute http(s) URL");

    const res = await httpGet(target, {
      accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const raw = await res.text();
    const finalUrl = res.url || target;

    let body;
    if (ctype.includes("html") || /^\s*<(?:!doctype|html)\b/i.test(raw)) {
      const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleM ? htmlToText(titleM[1]) : "";
      body = (title ? `# ${title}\n\n` : "") + htmlToText(raw);
    } else {
      body = raw; // JSON / plain text / other textual content
    }
    body = body.trim();
    const truncated = body.length > WEB_FETCH_MAX_CHARS;
    if (truncated) body = body.slice(0, WEB_FETCH_MAX_CHARS);

    const statusNote = res.ok ? "" : ` (HTTP ${res.status})`;
    const typeNote = ctype ? ` [${ctype.split(";")[0]}]` : "";
    return (
      `Fetched ${finalUrl}${statusNote}${typeNote}:\n\n${body || "(empty response body)"}` +
      (truncated ? `\n\n… (content truncated at ${WEB_FETCH_MAX_CHARS} characters)` : "")
    );
  },
};

/**
 * Execute a tool. Catches exceptions uniformly and returns { ok, content }, where content is the
 * result text that can be fed back to the model.
 */
/** Tools that change the working directory's file list (add / delete / move / possibly create files): invalidate the file-list cache after running. */
const FILE_LIST_MUTATORS = new Set([
  "write_file",
  "append_file",
  "delete_file",
  "copy_file",
  "move_file",
  "create_directory",
  "run_command",
  "init_command",
  "remember_project",
]);

export async function runTool(name, args = {}) {
  const handler = handlers[name];
  if (!handler) return { ok: false, content: `Unknown tool: ${name}` };
  try {
    await ensureWorkdir();
    const content = await handler(args ?? {});
    if (FILE_LIST_MUTATORS.has(name)) invalidateWalkCache(); // the file list may have changed: the next search_* re-walks
    // Observe reads so project memory can learn from what was actually opened. This is the right
    // layer for it: sub-agent tool calls come through here too, and sub-agents do most of the
    // exploring. Fire-and-forget — it can neither delay nor fail this call.
    if (name === "read_file") {
      noteFileRead({
        workdir: WORKDIR,
        relPath: args?.path,
        text: content,
        llm: { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete },
      });
    }
    return { ok: true, content: String(content) };
  } catch (e) {
    return { ok: false, content: `Error in ${name}: ${e?.message ?? String(e)}` };
  }
}

// ── Tool declarations (JSON Schema) ────────────────────────────────────────────
const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const num = (description) => ({ type: "number", description });
const fn = (name, description, properties, required) => ({
  name,
  description,
  parameters: { type: "object", properties, required },
});

/** Corresponds one-to-one with the caller's C++ declarations. */
const TOOLS = [
  fn("read_file",
     `Read the UTF-8 text content of a file. Small files come back whole. For a large file, read the slice you actually need via offset/limit instead of pulling in the entire file — use search_in_files first to find the line you want, then read around it. The result says which lines you got and whether more remain (up to ${READ_DEFAULT_MAX_LINES} lines per call by default).`,
     { path: str("File path."),
       offset: num("First line to read, 1-based. Defaults to 1 (start of file)."),
       limit: num(`How many lines to read from offset. Defaults to ${READ_DEFAULT_MAX_LINES}.`) },
     ["path"]),
  fn("open_path",
     "Open a file or folder in the host's DEFAULT APPLICATION for the user to see (view an image, play a video/audio, open a document/PDF, reveal a folder). This runs on the host machine. Use THIS — not run_command — to open/show/play a file: run_command in daily mode runs inside an isolated headless Linux sandbox with no GUI, so it cannot launch the host's apps. Path is resolved inside the working directory.",
     { path: str("Path to the file or folder to open, relative to the working directory.") }, ["path"]),
  fn("write_file", "Write UTF-8 text to a file, overwriting it.",
     { path: str("File path."), content: str("Full text to write.") }, ["path", "content"]),
  fn("edit_file", "Replace a literal string in a file. Without replace_all the match must be unique.",
     { path: str("File path."),
       old_string: str("Exact text to replace (literal, not regex)."),
       new_string: str("Replacement text."),
       replace_all: bool("Replace every occurrence; defaults to false.") },
     ["path", "old_string", "new_string"]),
  fn("append_file", "Append UTF-8 text to a file (creating it if needed).",
     { path: str("File path."), content: str("Text to append.") }, ["path", "content"]),
  fn("delete_file", "Delete a file.",
     { path: str("File path.") }, ["path"]),
  fn("copy_file", "Copy a file to a new path (overwrites the destination).",
     { source: str("Source path."), destination: str("Destination path.") }, ["source", "destination"]),
  fn("move_file", "Move or rename a file (overwrites the destination).",
     { source: str("Source path."), destination: str("Destination path.") }, ["source", "destination"]),
  fn("file_info", "Get metadata for a file or directory (size, type, modified time).",
     { path: str("Path to inspect.") }, ["path"]),
  fn("list_directory", "List the entries of a directory (defaults to the working directory).",
     { path: str("Directory path; optional.") }, []),
  fn("create_directory", "Create a directory (including parents).",
     { path: str("Directory path to create.") }, ["path"]),
  fn("search_files", "Find files by name using a glob pattern, recursively.",
     { pattern: str("Glob, e.g. *.txt or report*.md.") }, ["pattern"]),
  fn("search_in_files",
     "Search file contents recursively and return each match WITH surrounding context lines, so you usually don't need to open the file afterward. Prefer ONE precise search (use regex / a filename pattern) over many broad ones.",
     { query: str("Text or regular expression to search for."),
       pattern: str("Optional filename glob to scope the search, e.g. *.md or *.{ts,tsx}."),
       regex: bool("Treat query as a JavaScript regular expression; defaults to false (plain substring)."),
       ignore_case: bool("Case-insensitive match; defaults to false."),
       context: num("Context lines to show around each match (0–5, default 2).") },
     ["query"]),
  fn("run_command",
     "Run a shell command in the working directory and return its output. For long-running / persistent processes (dev servers, watchers, `npm run dev`, `pnpm start`, vite/webpack/nodemon, etc.) pass background:true so it keeps running instead of being killed at the 60s timeout — the tool returns early with the startup output (including any http://localhost:PORT). (Such commands are also auto-detected as background.) Starting a dev server is not a reason to open a browser: report the URL to the user, and only open it if they asked or the work is finished.",
     { command: str("The shell command line to execute."),
       background: bool("Run as a persistent, non-blocking background process (dev servers / watchers / long-running tasks). Not killed at the timeout.") },
     ["command"]),
  fn("stop_service",
     "Stop a background service (e.g. a dev server) you started earlier via run_command, by its pid (from the start result) or url. ALWAYS use this to stop such services — NEVER use taskkill/kill/pkill on node/electron or the app itself, which would kill this application or unrelated processes.",
     { pid: num("The pid of the background service to stop (from the run_command start result)."),
       url: str("Alternatively the service URL, e.g. http://localhost:8081.") }, []),
  fn("check_project",
     "Compile and test the project, auto-detecting its type (Node/TS → tsc/lint/test, Rust → cargo check/test, Go → go build/test, Python → compileall/pytest). Call this after modifying code to verify it still builds and passes; fix any reported failures.",
     { skip_tests: bool("Only run compilation / type-check, skip tests; defaults to false.") }, []),
  fn("refine_question",
     "Refine a vague or colloquial question into a clear, specific, self-contained one that is easier to search and answer. Returns only the refined question, in the same language as the input.",
     { question: str("The original (possibly vague) question to refine."),
       context: str("Optional surrounding conversation/context to clarify intent; not answered, only used to understand the question.") },
     ["question"]),
  fn("init_command",
     "Initialize or refresh project memory: bring ZERAIX.md at the working-directory root up to date and return it — a structured map of the project (repo type, tech stack, key config files, directory structure, scripts, README) that later turns read instead of rescanning the repo. Use this when the user asks to initialize / analyze / understand the project, explain the codebase, or 'what's in this folder'. Cheap to call repeatedly: it only rebuilds the sections whose underlying files actually changed, and writes nothing when the project is unchanged, so call it at the start of a task rather than assuming an existing ZERAIX.md is current. Sections a human has written or frozen are never overwritten. Pass refresh:true to force every generated section to be rebuilt. Only reads config/text files (never binaries) and skips node_modules/.git/dist/build/coverage/.next etc.",
     { refresh: bool("Rebuild every generated section even if its inputs are unchanged; defaults to false, which rebuilds only what went stale.") },
     []),
  fn("remember_project",
     "Record something you learned about THIS project into its long-term memory (ZERAIX.md), so future sessions start knowing it instead of rediscovering it. Call this whenever you worked something out that the project map does not already state — especially right after reading code or running a sub-agent to answer a question about how part of the codebase works, and whenever the user explains a convention, constraint or gotcha ('we use npm here, not pnpm', 'never touch fs from the renderer'). Two uses: pass `module` plus a one-sentence `note` to replace that module's line in the Module Map with a description based on what you actually read (this pins the line so it is never regenerated); or pass `note` alone to append a durable fact to the project's Invariants & Gotchas section. Keep each note to one specific, self-contained sentence, and record only things that will still be true next week — not what you are doing right now.",
     { note: str("One clear sentence. As a module description: what that directory is responsible for and its entry point. As a standalone note: an invariant, convention, constraint or gotcha worth knowing before touching this project."),
       module: str("Optional module path exactly as it appears in the Module Map, e.g. 'electron' or 'src/lib'. Omit to append a general note instead.") },
     ["note"]),
  fn("web_search",
     "Search the web and get ranked results (title, URL, snippet) back as text, directly — WITHOUT opening the visible browser panel. This is your built-in, fastest way to look things up online: current events, facts that may have changed since training, documentation, library/API usage, exact error messages, product/price info, etc. Prefer web_search over openBrowser for information lookups. Typical flow: web_search to find sources → fetch_url on the most relevant result to read it → answer and cite the URL. Do NOT answer from memory when the user asks about anything current, niche, or verifiable; search first. Only use openBrowser instead when the user needs to visually SEE a page, or the page requires interaction / login / JavaScript.",
     { query: str("The search query. Prefer concise, keyword-style queries; for precise lookups include distinctive terms (exact error text, proper names, version numbers). Use the user's language unless an English query would find better sources."),
       count: num("Number of results to return (1–10, default 6). Ask for more only when you need to compare several sources.") },
     ["query"]),
  fn("fetch_url",
     "Fetch a single web page or HTTP(S) API by URL and return its main readable text (HTML is stripped to text; JSON / plain text is returned as-is) — headless, without opening the visible browser. Use it to read a specific result from web_search, or any URL you already know (docs page, raw file, JSON API). It does NOT execute JavaScript and cannot log in, click, or fill forms; for pages that need rendering / interaction, or that the user should see on screen, use openBrowser + browser instead. Long pages are truncated, so target the specific page you need rather than large index pages.",
     { url: str("Absolute http(s) URL to fetch.") },
     ["url"]),
];

/**
 * Return the tool declarations in the target LLM format:
 *  - "raw"       : { name, description, parameters }
 *  - "openai"    : { type: "function", function: { name, description, parameters } }
 *  - "anthropic" : { name, description, input_schema }
 */
export function listTools(format = "raw") {
  if (format === "openai") {
    return TOOLS.map((t) => ({ type: "function", function: t }));
  }
  if (format === "anthropic") {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return TOOLS;
}
