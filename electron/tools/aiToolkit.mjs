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
import { resolvePath } from "./paths.mjs";
import { looksLongRunning as commandLooksLongRunning } from "./commandShape.mjs";
import { constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shell } from "electron";

import { llmChat } from "../llm/proxy.mjs";
import {
  getEngine,
  getSandboxEngine,
  initEngine as engineInit,
  listProcesses as engineListProcesses,
  stopProcess as engineStopProcess,
} from "./sandbox/engine.mjs";
import { sandboxInventory } from "./sandbox/inventory.mjs";
import { ensureProjectMemory, summarise as summariseMemory } from "./projectMemory/index.mjs";
import { rememberProject } from "./projectMemory/remember.mjs";
import { noteFileRead, resetObservations } from "./projectMemory/observations.mjs";
import { noteUserMessage, resetConversationCapture } from "./projectMemory/conversation.mjs";
// MCP tools join the registry here rather than at each call site: the chat IPC (main.mjs), the agent
// loop (agent/turn.mjs) and the automation dispatcher (automation/paths.mjs) all already go through
// listTools/runTool, so one merge lights MCP up in all three. See docs/mcp-integration.md.
import { callMcpTool, isMcpTool, listMcpTools } from "../mcp/client.mjs";
import { callPluginTool, describePluginTools, isPluginTool, listPluginTools } from "../plugins/tools.mjs";
// The other direction: tools for MANAGING MCP servers, so a user can connect one by asking in chat
// instead of filling in the settings form. Kept in its own module because it is the only part of the
// toolkit that writes app configuration and grants trust -- see its header for the two-gate model.
import { mcpAdminHandlers } from "./mcpAdmin.mjs";
// Rust Agent Runtime sidecar. Fails open on every path: a missing binary, a refused spawn, a protocol
// mismatch or a tool it does not implement all resolve to "the JS handler serves this call", so the
// only observable difference when it is unavailable is that it is not used. See its header and
// docs/agent-runtime-migration.md.
import {
  invalidateFileList as invalidateRustFileList,
  isReady as isRuntimeReady,
  missingRuntimeTools,
  tryRunTool,
} from "./rustRuntime.mjs";
// page_console's window lifecycle. Its own module because this one is already far past the file-size
// ceiling, and because a hidden BrowserWindow has to be leak-proof on every exit path.
import { capturePageConsole } from "./pageConsole.mjs";

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
      "(Debian, bash) sandbox, where the working directory is /workspace — the same folder the file tools use, " +
      "so use /workspace or relative paths, not the host path. Please use Linux commands.\n\n"
    );
  }
  const host =
    process.platform === "win32" ? "Windows (cmd/PowerShell)" : process.platform === "darwin" ? "macOS (zsh/bash)" : "Linux (bash)";
  // Leaving the sandbox takes /workspace with it, so the one instruction that holds in both environments is "relative".
  return `[Execution environment switched] From this command on, commands run directly on the host ${host} again; please use commands matching that system, and relative paths (there is no /workspace outside the sandbox).\n\n`;
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
export const READ_DEFAULT_MAX_LINES = 2000; // read_file: lines returned when no explicit limit is given
const CMD_TIMEOUT_MS = 60_000; // run_command timeout
/**
 * The ceiling for commands whose job IS to fetch over the network.
 *
 * `npm install` on a cold cache routinely runs for several minutes, so at 60s it was killed every time,
 * half-way through writing node_modules. What the model does next is the visible damage: the kill notice
 * below used to read as "a GUI or service may already have started", which is nonsense for an install, so
 * it would re-run it, or push it to the background and then poll again and again asking whether it had
 * finished. Both cost far more of the user's time than simply waiting would have.
 *
 * A ceiling, not a delay: a warm `npm install` still returns in two seconds. The trade is that a fetch
 * command wedged on an unreachable mirror now takes ten minutes to report instead of one — acceptable,
 * because the alternative failed the common case in order to fail the rare one faster.
 */
const CMD_FETCH_TIMEOUT_MS = 600_000;
/**
 * Commands that download. Matched on the command line because there is nothing else to go on: output is
 * buffered until exit (see the engine contract), so an idle-based timeout — which would need no list at
 * all — is not available until run_command streams. Deliberately narrow: a false positive here only
 * delays reporting a hung command, but a false negative kills a legitimate install mid-write.
 */
const FETCH_COMMAND_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|up|rebuild)\b/i,
  /\b(npx|uvx|bunx|pipx)\b/i, // package runners fetch on first use
  /\b(pip3?|uv)\s+(install|sync|add|pip\s+install)\b/i,
  /\b(apt|apt-get|dnf|yum|apk|brew)\s+(install|update|upgrade|add)\b/i,
  /\bgit\s+(clone|fetch|pull|submodule)\b/i,
  /\b(cargo|go|gem|composer|mvn|gradle|dotnet|bundle)\s+(install|build|get|add|fetch|restore|tidy|download|mod)\b/i,
  /\bdocker\s+(pull|build)\b/i,
  /\bwget\b/i,
  // curl only when it is downloading TO A FILE. Bare `curl` is just as often a one-second poke at a local
  // endpoint, and handing that the ten-minute ceiling would mean a black-holed request hangs the turn.
  /\bcurl\b[^|]*(\s-O\b|\s-o\s|--output\b|--remote-name\b)/i,
];
const isFetchCommand = (cmd) => FETCH_COMMAND_PATTERNS.some((re) => re.test(cmd));

/**
 * What the model is told when the user stopped a running command.
 *
 * It has to be unmistakably different from a timeout, because the reasonable reaction to each is the
 * opposite: a timeout invites one careful retry, whereas re-running something the user just stopped is
 * the single worst thing to do here. The partial output is included — a stopped `npm install` or `pytest`
 * has usually said something worth reading, and it is also the only evidence of how far the work got.
 */
function cancellationResult(r) {
  const parts = [];
  if (r.stdout) parts.push(String(r.stdout).trim());
  if (r.stderr) parts.push(`[stderr]\n${String(r.stderr).trim()}`);
  parts.push(
    "[stopped by the user] The user interrupted this command, so it was terminated and did NOT finish. " +
      "Any output above is partial, and whatever it was doing may be half-done (a partial install, a " +
      "partially written file). Do NOT re-run it and do not start anything else: the user stopped you on " +
      "purpose. Wait for their next instruction; if they ask what happened, say plainly that the command " +
      "was stopped part-way and describe what had already been done.",
  );
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Did this command fail only because the program it names is not installed? Returns the program, or "".
 *
 * Every shell says so differently, and the exit code alone is not enough — 127 is conventional on POSIX but
 * a script is free to return it, and cmd.exe uses 9009. So the code is corroborated by the message, and the
 * name is read out of the message when the shell gives it, since the first token of the command line can be
 * `env`, `sudo` or a variable assignment rather than the thing that was missing.
 */
function missingExecutable(r, cmd) {
  const text = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  const patterns = [
    // zsh MUST come before the bash pattern. zsh says `zsh: command not found: python` — the shell's own name
    // sits where bash puts the missing program, so the bash rule matches it first and reports "zsh" as missing.
    /command not found: (\S+)/im, // zsh
    /(?:^|[:\s])([^\s:]+): (?:command not found|not found)/im, // bash / sh / dash
    /'([^']+)' is not recognized as an internal or external command/im, // cmd.exe
    /The term '([^']+)' is not recognized as (?:the name of )?a cmdlet/im, // PowerShell
    /(\S+): No such file or directory/im, // exec of an absolute path that is not there
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  // Message unrecognised: trust the code only, and fall back to the first bare word of the command.
  if (r?.code === 127 || r?.code === 9009) return cmd.trim().split(/\s+/)[0] ?? "";
  return "";
}

/**
 * Is it safe to re-run this whole command somewhere else after a missing-program failure?
 *
 * Only when nothing in it can already have taken effect. A bare `python x.py` failed before doing anything,
 * so running it again in the sandbox costs nothing. `rm -rf build && python x.py` did NOT — the removal
 * happened, and a blind re-run would repeat it. Redirections are excluded for the same reason: `> out.txt`
 * truncates the file whether or not the program exists.
 */
const SAFE_TO_RERUN = /^[^&|;\n<>`$()]+$/;
const CMD_MAX_BUFFER = 10 * 1024 * 1024; // run_command output cap: 10MB
// web_search / fetch_url (headless HTTP in the main process; no visible browser).
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WEB_TIMEOUT_MS = 15_000; // per HTTP request
const WEB_SEARCH_MAX = 10; // hard cap on results returned by web_search
const WEB_SEARCH_DEFAULT = 6; // default result count
const WEB_FETCH_MAX_CHARS = 8_000; // fetch_url readable-text cap

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
  const dir = subdir ? resolveInside(String(subdir), { write: true }) : WORKDIR;
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
function resolveInside(p, { write = false } = {}) {
  return resolvePath(p, { workdir: WORKDIR, assetDir: ASSET_DIR, write });
}

/**
 * For display: a path relative to WORKDIR (with slashes normalized).
 *
 * Relative on purpose — it is what the model passes back to the next tool call, and an absolute path in
 * that position invites it to start addressing files outside the workspace.
 *
 * But relative ALONE is what made "the AI said it wrote the file and it is not in my folder" a real
 * report: the working directory defaults to a path buried in userData, so `Wrote 6535 bytes to
 * minecraft-game/index.html` named a location the user had no way to find. Every tool that puts a file
 * somewhere therefore reports the absolute path alongside it. Reads and searches deliberately do not —
 * they return many paths, and repeating the workspace prefix on each would cost tokens to say nothing.
 */
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

/** Run one command under WORKDIR, returning { ok, code, out, killed, canceled } (never throws). Goes through the current execution engine. */
async function runShell(cmd, signal) {
  const r = await getEngine().run(cmd, {
    cwd: WORKDIR,
    timeoutMs: CHECK_TIMEOUT_MS,
    maxBuffer: CMD_MAX_BUFFER,
    signal,
  });
  return {
    ok: r.code === 0 && !r.killed && !r.canceled,
    code: r.code,
    killed: !!r.killed,
    canceled: !!r.canceled,
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



  async append_file({ path: p, content }) {
    const abs = resolveInside(p, { write: true });
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
    return `Appended ${Buffer.byteLength(addNorm)} bytes to ${rel(abs)} (${abs}).${diff}`;
  },

  async delete_file({ path: p }) {
    const abs = resolveInside(p, { write: true });
    await fs.unlink(abs);
    return `Deleted ${rel(abs)}.`;
  },

  async copy_file({ source, destination }) {
    // The source is only read — copying an asset INTO the workspace is the intended way to work with one.
    const s = resolveInside(source);
    const d = resolveInside(destination, { write: true });
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(s, d);
    return `Copied ${rel(s)} -> ${rel(d)} (${d}).`;
  },

  async move_file({ source, destination }) {
    // Both are writes: a move REMOVES the source, which is exactly what the asset folder must not permit.
    const s = resolveInside(source, { write: true });
    const d = resolveInside(destination, { write: true });
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.rm(d, { force: true });
    await fs.rename(s, d);
    return `Moved ${rel(s)} -> ${rel(d)} (${d}).`;
  },



  async create_directory({ path: p }) {
    const abs = resolveInside(p, { write: true });
    await fs.mkdir(abs, { recursive: true });
    return `Created directory ${rel(abs)} (${abs}).`;
  },



  async run_command({ command, background, sandbox, notify }, { signal } = {}) {
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
    // aren't killed by the 60s timeout. When not explicitly specified, judged by command shape — see
    // commandShape.mjs for what counts, and for the curl-to-a-/dev/-path that used to.
    const looksLongRunning = commandLooksLongRunning(cmd);
    // Through the current execution engine (native = run directly on the host; qemu = isolated
    // execution inside a VM). When the engine differs from last time (sandbox became ready mid-run
    // / degraded / switched mode), prepend the environment-switch note before the result.
    //
    // `sandbox: true` overrides that choice for THIS command only. It exists for dev mode, where the
    // default engine is the host but the document/media toolchain the model needs (imagemagick, ffmpeg,
    // pandoc, OCR) is installed only in the guest image. The working directory is the same either way —
    // it is mounted into the VM — so the artifacts land where the file tools can read them.
    const guest = sandbox === true ? getSandboxEngine() : null;
    if (sandbox === true && !guest) {
      return (
        "The Linux sandbox is not running, so this command cannot be run inside it. Its toolchain " +
        "(imagemagick, ffmpeg, pandoc, OCR, …) is not installed on this machine either — do not fall back " +
        "to running those tools on the host. Tell the user the sandbox needs to be started from the " +
        "sandbox status indicator, or re-run the command without sandbox:true if the host can do the job."
      );
    }
    const engine = guest ?? getEngine();
    // Only the DEFAULT engine's identity is tracked: a one-off `sandbox: true` call is not an environment
    // switch, and letting it move lastRunEngineId would make the NEXT ordinary command announce a switch
    // back to a host it never left.
    const note = guest ? "" : engineSwitchNote(engine.id);
    if (background ?? looksLongRunning) {
      const wantsNotify = notify === true;
      const msg = await engine.startBackground(cmd, { cwd: WORKDIR, notify: wantsNotify });
      // The whole point of notify is that the model STOPS here. Said explicitly, because the default reflex
      // after starting something in the background is to poll it, and polling is exactly what this replaces.
      const wait = wantsNotify
        ? "\n\nYou asked to be notified, so this command will announce its own completion with its output. " +
          "Do NOT poll it, re-run it, sleep, or check whether it has finished — you will be told. End your turn now: " +
          "tell the user it is running and that you will continue when it lands, then answer anything else they ask " +
          "in the meantime."
        : "";
      return `${note}${msg}${wait}`;
    }
    const fetches = isFetchCommand(cmd);
    const timeoutMs = fetches ? CMD_FETCH_TIMEOUT_MS : CMD_TIMEOUT_MS;
    let r = await engine.run(cmd, {
      cwd: WORKDIR,
      timeoutMs,
      maxBuffer: CMD_MAX_BUFFER,
      signal,
    });
    // The user pressed Stop. Reported before every other branch below and without any of the retry
    // machinery: the fallback-to-sandbox path treats a non-zero exit as "the host cannot do this" and would
    // helpfully re-run, in the sandbox, the very command the user just interrupted.
    if (r.canceled) return cancellationResult(r);
    /**
     * The host does not have that program, but the sandbox does — so use it, rather than reporting defeat.
     *
     * This is the "python is not installed" case: on the host the model runs `python x.py`, gets
     * "command not found", and tells the user the language is missing, when a full Python / Node / JDK is
     * sitting in the sandbox one flag away. It has no way to know that without asking, so it does not ask.
     *
     * Deliberately one-directional. It fires only when the HOST was already the engine — never in daily mode,
     * where commands run in the sandbox precisely so that everyday work cannot touch the user's real machine.
     * Falling back the other way would spend that isolation to fix a convenience problem.
     *
     * `command -v` first rather than just re-running: if the sandbox has not got it either, the honest answer
     * is the host's own error, and a second identical failure would only muddy it.
     */
    let fellBackTo = "";
    if (!guest && engine.id === "native" && !r.killed && r.code !== 0) {
      const missing = missingExecutable(r, cmd);
      const vm = missing && SAFE_TO_RERUN.test(cmd) ? getSandboxEngine() : null;
      if (vm) {
        const probe = await vm.run(`command -v ${JSON.stringify(missing)}`, { cwd: WORKDIR, timeoutMs: 15_000 });
        if (probe.code === 0 && String(probe.stdout).trim()) {
          const retry = await vm.run(cmd, { cwd: WORKDIR, timeoutMs, maxBuffer: CMD_MAX_BUFFER });
          r = retry;
          fellBackTo = missing;
        }
      }
    }
    // Stated on success as well as failure: the model has to know WHERE this ran, or it will describe host
    // state it never touched, and follow-up commands will go back to the host and fail the same way.
    const fellBack = fellBackTo
      ? `[Ran in the Linux sandbox] \`${fellBackTo}\` is not installed on this machine, but the sandbox has it, so the ` +
        `command was re-run there — same working directory, mounted in. Tell the user this ran in the sandbox rather ` +
        `than saying ${fellBackTo} is missing, and pass sandbox:true yourself for follow-up commands that need it.\n\n`
      : "";
    if (r.code === 0 && !r.killed) {
      const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
      return `${note}${fellBack}${out || "(no output, exit code 0)"}`;
    }
    const parts = [];
    if (note) parts.push(note.trim());
    if (fellBack) parts.push(fellBack.trim());
    if (r.stdout) parts.push(r.stdout.trim());
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.trim()}`);
    parts.push(`[exit code ${r.code ?? "?"}${r.killed ? ", killed (timeout)" : ""}]`);
    // What to say about a timeout depends entirely on what timed out, and saying the wrong thing is
    // expensive. The generic advice below — "a GUI or service may already have started" — is actively
    // misleading for an install that was simply still downloading: it invites a re-run or a poll loop,
    // when the truth is that the network is slow and the work is half-done on disk.
    if (r.killed && fetches) {
      parts.push(
        `Note: this download did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was terminated, ` +
          "so whatever it was fetching is incomplete. It was NOT left running in the background — there is " +
          "nothing to poll or wait for, and re-checking will not help. Re-running it is safe and resumes from " +
          "whatever was already cached, but do that at most once: a second timeout means the network or the " +
          "registry mirror is the problem, and the user has to be told rather than waited on.",
      );
    } else if (r.killed) {
      parts.push(
        `Note: the command did not finish within ${Math.round(timeoutMs / 1000)} seconds and was terminated. If this is a program ` +
          "that opens a window or keeps running (e.g. a GUI app or a service), it may already have " +
          "started. Do not keep retrying similar commands; to run in the background use a non-blocking " +
          "launch, or just tell the user to run it manually.",
      );
    }
    return parts.filter(Boolean).join("\n");
  },

  async sandbox_tools({ query } = {}) {
    const guest = getSandboxEngine();
    // Deliberately not "no tools available": the toolchain is a property of the image, not of whether the VM
    // happens to be up, and the actionable part is that it can be started.
    if (!guest) {
      return (
        "The Linux sandbox is not running, so its toolchain cannot be reached or listed. Those tools " +
        "(imagemagick, ffmpeg, pandoc, LibreOffice, OCR, …) are not installed on the user's machine either, so " +
        "do not try to run them here. Tell the user that image / media / document work needs the sandbox, and " +
        "that it can be started or restarted from the sandbox status indicator."
      );
    }
    return sandboxInventory(guest, { query });
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

  async check_project({ skip_tests } = {}, { signal } = {}) {
    await ensureWorkdir();
    let steps = await detectCheckSteps();
    if (skip_tests) steps = steps.filter((s) => s.label !== "test");
    if (steps.length === 0) {
      return "No verifiable project type detected (supports Node/TS, Rust, Go, Python).";
    }

    const blocks = [];
    let allOk = true;
    for (const s of steps) {
      const r = await runShell(s.cmd, signal);
      // Stopped part-way through a multi-step check: kill this step, run no further ones, and report what
      // did complete. Continuing would run a test suite the user has just asked to stop.
      if (r.canceled) {
        blocks.push(`## ${s.label}: \`${s.cmd}\`\n⏹ Stopped by the user${r.out ? `\n${r.out}` : ""}`);
        return `${blocks.join("\n\n")}\n\n${cancellationResult({})}`;
      }
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

  /**
   * Load a page headlessly (JavaScript runs) and return what it logged: console output, uncaught errors,
   * unhandled rejections, failed requests. The window lifecycle lives in ./pageConsole.mjs; what belongs
   * here is turning the model's `url` into something safe to load — an http(s) URL, or a path resolved
   * inside the working directory like every other path this toolkit accepts, never a raw file:// the model
   * composed itself.
   */
  async page_console({ url, wait_ms, level, max } = {}) {
    const raw = String(url ?? "").trim();
    if (!raw) throw new Error("url is required");
    let target = raw;
    if (!/^https?:\/\//i.test(raw)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        throw new Error("url must be an http(s) URL, or a file path inside the working directory");
      }
      const abs = resolveInside(raw);
      await fs.access(abs, FS.R_OK); // fail with "no such file" rather than a blank about:blank capture
      target = pathToFileURL(abs).href;
    }
    return capturePageConsole({ url: target, waitMs: wait_ms, level, max });
  },

  // mcp_discover / mcp_connect. Spread rather than written inline: they operate on app configuration
  // and the MCP connection pool, not on the working directory like everything above them.
  ...mcpAdminHandlers,

  /**
   * Discovery for installed plugin tools. The counterpart of mcp_tools, and declared for the same
   * reason: the tools themselves are routed, so without this the model has no way to learn that the
   * user has installed anything at all.
   */
  plugin_tools({ name, plugin } = {}) {
    return describePluginTools({ name: String(name ?? ""), plugin: String(plugin ?? "") });
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

/**
 * `signal` is the caller's cancellation (the renderer's Stop button, relayed over IPC — see
 * ai-tools:cancel in main.mjs). It is handed to the handler as a second argument rather than folded into
 * `args`, because `args` is the model's own JSON and nothing from the model may be mistaken for a
 * cancellation. Handlers that cannot be interrupted simply ignore it; today only run_command reads it,
 * since it is the only one that can block for minutes.
 */
export async function runTool(name, args = {}, { signal } = {}) {
  // Before the native lookup: an MCP tool is namespaced (`mcp__<server>__<tool>`) so it can never
  // collide with a handler, and callMcpTool honours runTool's { ok, content } contract for every
  // failure mode -- an external server must not be able to abort a turn by throwing.
  if (isMcpTool(name)) return callMcpTool(name, args ?? {});
  // Same arrangement for installed plugins: `plugin__<publisher>_<name>__<capability>` cannot collide
  // with a handler, and callPluginTool honours the { ok, content } contract for every failure mode.
  if (isPluginTool(name)) return callPluginTool(name, args ?? {});
  try {
    await ensureWorkdir();
    // The Rust Agent Runtime is asked FIRST, and for most tools it is the only implementation there is.
    //
    // The order matters now in a way it did not before. While every tool had a JS handler, the handler lookup
    // could come first and the sidecar was an optional shortcut. The handlers for the migrated tools are gone
    // (TODO §0.2 F1), so looking them up first would report `read_file` as an unknown tool and never reach the
    // runtime that implements it.
    //
    // What is left below this line is for the tools the runtime does NOT serve — `append_file`, the ones that
    // touch app state, MCP and plugin tools — which still have handlers of their own.
    const offloaded = await tryRunTool(name, args ?? {}, { signal, workdir: WORKDIR });
    if (offloaded) {
      if (FILE_LIST_MUTATORS.has(name)) {
        invalidateRustFileList(WORKDIR);
      }
      if (name === "read_file" && offloaded.ok) {
        noteFileRead({
          workdir: WORKDIR,
          relPath: args?.path,
          text: offloaded.content,
          llm: { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete },
        });
      }
      return offloaded;
    }

    const handler = handlers[name];
    if (!handler) {
      // No handler, and the runtime did not serve it. There are THREE ways to get here and they need
      // different answers — an earlier version collapsed two of them into "Unknown tool", which told a model
      // that `write_file` does not exist while it was staring at the declaration for it, and told the user
      // nothing at all about the actual cause.
      if (!isRuntimeReady()) {
        return {
          ok: false,
          content:
            `${name} is served by the Zeraix agent runtime, which is not running. No fallback exists for it — ` +
            `the JS implementations were removed at 2.0. Check the runtime binary is installed and see the ` +
            `logs for why it did not start.`,
        };
      }
      // The runtime is up but does not implement this tool, while the app has no handler either. In practice
      // that means the binary predates the tool: it was built when this name still lived in JavaScript.
      if (missingRuntimeTools().includes(name)) {
        return {
          ok: false,
          content:
            `${name} exists but the running agent runtime does not serve it — the runtime binary is older ` +
            `than the app. This is a build problem, not a mistake in the call: rebuilding the runtime ` +
            `(\`npm run build:runtime\`) fixes it. Do not retry this call or work around it; tell the user.`,
        };
      }
      return { ok: false, content: `Unknown tool: ${name}` };
    }
    const content = await handler(args ?? {}, { signal });
    if (FILE_LIST_MUTATORS.has(name)) {
      invalidateRustFileList(WORKDIR);
    }
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

/** Corresponds one-to-one with the caller's C++ declarations. */
import { TOOLS } from "./toolSchemas.mjs";

/**
 * Return the tool declarations in the target LLM format:
 *  - "raw"       : { name, description, parameters }
 *  - "openai"    : { type: "function", function: { name, description, parameters } }
 *  - "anthropic" : { name, description, input_schema }
 */
export function listTools(format = "raw") {
  // Native tools first, then whatever the connected MCP servers currently expose. listMcpTools() is
  // synchronous and cache-backed: this runs once per turn, and a server that is still connecting
  // simply contributes nothing this time round rather than delaying the request.
  const all = [...TOOLS, ...listMcpTools(), ...listPluginTools()];
  if (format === "openai") {
    return all.map((t) => ({ type: "function", function: t }));
  }
  if (format === "anthropic") {
    return all.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return all;
}
