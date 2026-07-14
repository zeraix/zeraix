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
  // qemu (HVF/WHPX/KVM VM)：宿主目录挂入的 Debian/bash 隔离沙箱，模型据此改用 Linux 命令。
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
  invalidateWalkCache(); // 目录变了：旧的文件列表缓存作废
  getEngine().prewarm?.(WORKDIR);
  return WORKDIR;
}
export function getWorkingDir() {
  return WORKDIR;
}

// ── 工作区文件浏览（供侧栏文件树 + 右侧编辑器 UI，非 AI 工具循环）────────────────────────
// 都限制在 WORKDIR 内（resolveInside）。前端按需逐层展开，故 read_dir 只列一层、不递归。

/** 列出某目录（相对 WORKDIR）的直接子项，结构化返回 [{name,isDir}]（目录在前，按名排序）。 */
export async function wsReadDir(relPath = "") {
  const abs = relPath ? resolveInside(relPath) : WORKDIR;
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/**
 * 读取某文件用于「查看 / 编辑」，并判断是否可打开。返回：
 *  - { ok:true, editable:true, content, size }            —— 文本文件，可查看 / 编辑
 *  - { ok:false, reason, size? }                          —— 不可打开（目录 / 过大 / 二进制 / 读失败），reason 为原因
 */
export async function wsReadFile(relPath) {
  const abs = resolveInside(relPath);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return { ok: false, reason: `无法读取：${e?.message ?? e}` };
  }
  if (st.isDirectory()) return { ok: false, reason: "这是一个目录" };
  if (st.size > MAX_READ_BYTES)
    return { ok: false, reason: `文件过大（${st.size} 字节 > ${MAX_READ_BYTES}），暂不支持在编辑器中打开`, size: st.size };
  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    return { ok: false, reason: `无法读取：${e?.message ?? e}`, size: st.size };
  }
  // 二进制探测：前 8KB 内出现 NUL 字节即视为二进制，不作文本查看 / 编辑。
  if (buf.subarray(0, Math.min(buf.length, 8000)).includes(0))
    return { ok: false, reason: "二进制文件，无法以文本查看 / 编辑（可用系统默认应用打开）", size: st.size };
  return { ok: true, editable: true, content: buf.toString("utf8"), size: st.size };
}

/** 保存某文件内容（用户在编辑器里的直接编辑，非 AI 改动）。返回 { ok } 或 { ok:false, error }。 */
export async function wsWriteFile(relPath, content) {
  try {
    const abs = resolveInside(relPath);
    await fs.writeFile(abs, String(content ?? ""), "utf8");
    invalidateWalkCache(); // 可能新建了文件，文件列表缓存失效
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

// 文件列表缓存：search_* 原本每次都全量遍历目录，一次调查里几十次搜索 = 几十次全树遍历。
// 缓存一次遍历结果（仅文件路径列表；内容仍每次现读，故内容变更始终可见）。写 / 删 / 移 / 命令
// 或切换工作目录时失效（见 runTool 的 MUTATING 判定与 setWorkingDir）。
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

// ── Project memory (init_command) ─────────────────────────────────────────────
// init_command scans the working directory, identifies the repo type / tech stack / key config /
// common scripts / README, produces a structured "project memory", and writes it to ZERAIX.md at the
// working-directory root so later turns can read it directly, avoiding rescanning the repo.
// Constraints: only reads config and text files, never binaries; skips heavy dirs; limits how much is scanned.
const INIT_MEMORY_FILE = "ZERAIX.md"; // Filename the project memory is written to (at the WORKDIR root)
// Additional build / cache / dependency directories skipped during scanning (on top of SKIP_DIRS; used
// only for the init scan, and does not affect the traversal range of tools like search_*).
const INIT_SKIP_DIRS = new Set([
  ...SKIP_DIRS,
  "build", "out", "coverage", ".turbo", ".cache", ".parcel-cache",
  "target", "vendor", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
const INIT_MAX_ENTRIES = 40; // Max entries listed per directory level (limits scan / feedback size)
const INIT_README_CHARS = 1200; // Character cap kept for the README summary

// In-memory cache for the init scan: key = WORKDIR, value = the generated markdown. Avoids rescanning within the same session.
const initMemoryCache = new Map();

/** Read and parse a JSON config file under WORKDIR; returns null if it's missing or fails to parse. */
async function readJsonInWorkdir(relPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(WORKDIR, relPath), "utf8"));
  } catch {
    return null;
  }
}

/** Safely read a text file: returns null if it's over the cap or contains a NUL byte (likely binary) — never reads binaries. */
async function readTextCapped(abs, cap = MAX_READ_BYTES) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > cap) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null; // Contains a NUL byte → treated as binary, skipped
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** Find the README under WORKDIR (case- / extension-insensitive), returning { name, text } or null. */
async function findReadme() {
  let entries;
  try {
    entries = await fs.readdir(WORKDIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(
    (e) => e.isFile() && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name),
  );
  if (!hit) return null;
  const text = await readTextCapped(path.join(WORKDIR, hit.name));
  return text == null ? null : { name: hit.name, text };
}

/** Identify the repo type: whether it's a Git repository, and whether it's a monorepo (and how it's managed). */
async function detectRepoType() {
  const isGit = await existsInWorkdir(".git");
  let monorepo = null;
  if (await existsInWorkdir("pnpm-workspace.yaml")) monorepo = "pnpm workspaces";
  else if (await existsInWorkdir("lerna.json")) monorepo = "Lerna";
  else if (await existsInWorkdir("turbo.json")) monorepo = "Turborepo";
  else {
    const pkg = await readJsonInWorkdir("package.json");
    if (pkg && pkg.workspaces) monorepo = "npm/yarn workspaces";
  }
  return { isGit, monorepo };
}

/** Infer the package manager by lock file; returns null if none is detected. */
async function detectPackageManager() {
  if (await existsInWorkdir("pnpm-lock.yaml")) return "pnpm";
  if (await existsInWorkdir("yarn.lock")) return "yarn";
  if (await existsInWorkdir("bun.lockb")) return "bun";
  if (await existsInWorkdir("package-lock.json")) return "npm";
  return null;
}

/** Infer the tech stack from config files and the dependency manifest, returning a deduped array of labels (prefers config, does not read source). */
async function detectTechStack(pkg) {
  const stack = new Set();
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  if (pkg) stack.add("Node.js");
  if (has("typescript") || (await existsInWorkdir("tsconfig.json"))) stack.add("TypeScript");
  if (has("next")) stack.add("Next.js");
  else if (has("react")) stack.add("React");
  if (has("vue")) stack.add("Vue");
  if (has("electron")) stack.add("Electron");
  if (has("vite")) stack.add("Vite");
  if (has("webpack")) stack.add("Webpack");
  if (has("tailwindcss")) stack.add("Tailwind CSS");
  if (has("express")) stack.add("Express");
  if (has("@nestjs/core")) stack.add("NestJS");
  if (has("jest")) stack.add("Jest");
  if (has("vitest")) stack.add("Vitest");

  if (await existsInWorkdir("Cargo.toml")) stack.add("Rust");
  if (await existsInWorkdir("go.mod")) stack.add("Go");
  if (
    (await existsInWorkdir("pyproject.toml")) ||
    (await existsInWorkdir("requirements.txt")) ||
    (await existsInWorkdir("setup.py"))
  )
    stack.add("Python");
  if ((await existsInWorkdir("pom.xml")) || (await existsInWorkdir("build.gradle"))) stack.add("Java");
  if (await existsInWorkdir("Gemfile")) stack.add("Ruby");
  if (await existsInWorkdir("composer.json")) stack.add("PHP");
  if ((await existsInWorkdir("Dockerfile")) || (await existsInWorkdir("docker-compose.yml"))) stack.add("Docker");

  return [...stack];
}

/** Produce the top-level (plus one level of subdirectories) directory-structure text, skipping heavy dirs and limiting the entry count. */
async function buildDirTree() {
  let top;
  try {
    top = await fs.readdir(WORKDIR, { withFileTypes: true });
  } catch {
    return "(unable to read working directory)";
  }
  const keep = (list) =>
    list
      .filter((e) => !INIT_SKIP_DIRS.has(e.name))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );

  const lines = [];
  for (const e of keep(top).slice(0, INIT_MAX_ENTRIES)) {
    if (!e.isDirectory()) {
      lines.push(`      ${e.name}`);
      continue;
    }
    lines.push(`[dir] ${e.name}/`);
    let children = [];
    try {
      children = await fs.readdir(path.join(WORKDIR, e.name), { withFileTypes: true });
    } catch {
      children = [];
    }
    const kids = keep(children);
    for (const c of kids.slice(0, INIT_MAX_ENTRIES)) {
      lines.push(`        ${c.isDirectory() ? `${c.name}/` : c.name}`);
    }
    if (kids.length > INIT_MAX_ENTRIES) lines.push(`        … (+${kids.length - INIT_MAX_ENTRIES})`);
  }
  return lines.join("\n") || "(empty directory)";
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
   * Initialize project memory: scan the working directory, identify the repo type / tech stack / key
   * config / directory structure / common scripts / README, produce a structured "project memory",
   * and write it to ZERAIX.md at the working-directory root so later turns can read it directly,
   * avoiding rescanning the repo.
   * By default, reuses a cache hit or an existing ZERAIX.md; pass refresh:true to force a rescan.
   */
  async init_command({ refresh } = {}) {
    // 1) In-memory cache hit: repeated calls within the same session reuse it directly (unless forced to refresh).
    if (!refresh && initMemoryCache.has(WORKDIR)) {
      return `Project memory ready (cache hit · ${INIT_MEMORY_FILE}).\n\n${initMemoryCache.get(WORKDIR)}`;
    }
    // ZERAIX.md already exists and no refresh requested: read it back and reuse, avoiding a rescan.
    if (!refresh) {
      const existing = await readTextCapped(path.join(WORKDIR, INIT_MEMORY_FILE));
      if (existing) {
        initMemoryCache.set(WORKDIR, existing);
        return (
          `Project memory already exists (${INIT_MEMORY_FILE}); reusing it. ` +
          `Call init_command({ refresh: true }) to rescan.\n\n${existing}`
        );
      }
    }

    // 2) Parse config files (prefer config, avoid reading source where possible).
    const pkg = await readJsonInWorkdir("package.json");
    const { isGit, monorepo } = await detectRepoType();
    const pm = await detectPackageManager();
    const stack = await detectTechStack(pkg);
    const tree = await buildDirTree();
    const checkSteps = await detectCheckSteps();
    const readme = await findReadme();

    const projectName = pkg?.name || path.basename(WORKDIR);
    const description = pkg?.description || "";

    // 3) Common scripts (from package.json scripts).
    const scripts = pkg?.scripts || {};
    const runPrefix = pm === "npm" || !pm ? "npm run" : `${pm} run`;
    const scriptLines = Object.entries(scripts)
      .slice(0, 30)
      .map(([k, v]) => `- \`${runPrefix} ${k}\` — ${String(v).slice(0, 120)}`);

    // 4) List of key config files (listed only if present).
    const configCandidates = [
      "package.json", "tsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
      "vite.config.ts", "vite.config.js", "electron-builder.yml", "pnpm-workspace.yaml",
      "turbo.json", "eslint.config.mjs", ".eslintrc.json", "tailwind.config.ts", "tailwind.config.js",
      "postcss.config.mjs", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
      "Dockerfile", "docker-compose.yml", ".env.example",
    ];
    const presentConfigs = [];
    for (const c of configCandidates) {
      if (await existsInWorkdir(c)) presentConfigs.push(c);
    }

    // 5) Optional enrichment: when an LLM is configured, use it to write a more natural project overview (best-effort, falls back on failure).
    let overview = description || (readme ? readme.text.slice(0, 400).trim() : "");
    if (LLM_CONFIG.endpoint && LLM_CONFIG.model) {
      try {
        const facts = [
          `Project name: ${projectName}`,
          description && `package.json description: ${description}`,
          stack.length && `Tech stack: ${stack.join(", ")}`,
          readme && `README (excerpt):\n${readme.text.slice(0, REFINE_MAX_CHARS)}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        overview = await chatComplete(
          [
            {
              role: "system",
              content:
                "You are a codebase-analysis assistant. Based on the given project information, summarize in 2-4 " +
                "sentences what this project does and its core technologies and purpose. Output only the summary " +
                "itself, in English, with no heading, prefix, or quotes.",
            },
            { role: "user", content: facts },
          ],
          { temperature: 0.2, maxTokens: 300 },
        );
      } catch {
        // LLM unavailable / request failed: silently fall back to description or README excerpt.
      }
    }

    // 6) Assemble the structured markdown (null lines are filtered out, "" lines are kept for spacing).
    const now = new Date().toISOString();
    const md = [
      `# Project Memory · ${projectName}`,
      "",
      `> Auto-generated by \`init_command\` at ${now}.`,
      "> Purpose: later turns can read this file to quickly understand the project instead of rescanning the repo.",
      "> Refresh: call `init_command({ refresh: true })` to rescan.",
      "",
      "## Overview",
      overview || "(no description)",
      "",
      "## Basics",
      `- Working directory: \`${WORKDIR}\``,
      `- Repository type: ${isGit ? "Git repository" : "non-Git directory"}${monorepo ? ` · Monorepo (${monorepo})` : ""}`,
      pm ? `- Package manager: ${pm}` : null,
      pkg?.version ? `- Version: ${pkg.version}` : null,
      "",
      "## Tech Stack",
      stack.length ? stack.map((s) => `- ${s}`).join("\n") : "- (not detected)",
      "",
      "## Directory Structure (top level)",
      "```",
      tree,
      "```",
      "",
      "## Key Config Files",
      presentConfigs.length ? presentConfigs.map((c) => `- ${c}`).join("\n") : "- (none)",
      "",
      "## Common Scripts / Commands",
      scriptLines.length ? scriptLines.join("\n") : "- (no scripts defined in package.json)",
      checkSteps.length
        ? `\n**Checks (build / test):**\n${checkSteps.map((s) => `- ${s.label}: \`${s.cmd}\``).join("\n")}`
        : "",
      "",
      readme
        ? `## README Summary (${readme.name})\n\n${readme.text.slice(0, INIT_README_CHARS).trim()}${
            readme.text.length > INIT_README_CHARS ? `\n\n… (truncated; see ${readme.name} for the full content)` : ""
          }`
        : "",
    ]
      .filter((l) => l !== null)
      .join("\n");

    // 7) Persist to ZERAIX.md at the working-directory root, and write the in-memory cache.
    await fs.writeFile(path.join(WORKDIR, INIT_MEMORY_FILE), md, "utf8");
    initMemoryCache.set(WORKDIR, md);

    return (
      `Generated project memory and wrote it to ${INIT_MEMORY_FILE} (working-directory root). ` +
      `Later turns can read this file directly instead of rescanning.\n\n${md}`
    );
  },

  async read_file({ path: p }) {
    const abs = resolveInside(p);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`file too large (${stat.size} bytes > ${MAX_READ_BYTES})`);
    }
    return await fs.readFile(abs, "utf8");
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
    const after = String(content ?? "");
    // Capture the old content before writing, to generate a diff (a missing file is treated as empty = a new file).
    let before = "";
    try {
      before = await fs.readFile(abs, "utf8");
    } catch {
      before = "";
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, after, "utf8");
    const verb = before ? "Wrote" : "Created";
    const diff = makeUnifiedDiff(before, after);
    return `${verb} ${Buffer.byteLength(after)} bytes to ${rel(abs)}.${diff}`;
  },

  async edit_file({ path: p, old_string, new_string, replace_all }) {
    const abs = resolveInside(p);
    const oldStr = String(old_string ?? "");
    const newStr = String(new_string ?? "");
    if (oldStr === "") throw new Error("old_string must not be empty");
    if (oldStr === newStr) throw new Error("old_string and new_string are identical");

    const text = await fs.readFile(abs, "utf8");

    // Literal count (not regex): count how many times old_string occurs.
    let count = 0;
    for (let i = text.indexOf(oldStr); i !== -1; i = text.indexOf(oldStr, i + oldStr.length)) {
      count++;
    }
    if (count === 0) throw new Error("old_string not found");
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

    await fs.writeFile(abs, next, "utf8");
    const summary = replace_all
      ? `Replaced ${count} occurrence(s) in ${rel(abs)}.`
      : `Replaced 1 occurrence in ${rel(abs)}.`;
    return `${summary}${makeUnifiedDiff(text, next)}`;
  },

  async append_file({ path: p, content }) {
    const abs = resolveInside(p);
    const add = String(content ?? "");
    let before = "";
    try {
      before = await fs.readFile(abs, "utf8");
    } catch {
      before = "";
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, add, "utf8");
    const diff = makeUnifiedDiff(before, before + add);
    return `Appended ${Buffer.byteLength(add)} bytes to ${rel(abs)}.${diff}`;
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
    // 匹配器：regex → 正则（可忽略大小写）；否则子串（可忽略大小写）。
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
        if (st.size > MAX_READ_BYTES) continue; // 跳过超大 / 疑似二进制文件
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
      // 命中行按 ±ctx 合并成 hunk（相邻 / 重叠的合并），带行号输出："N:" 为命中行，"N-" 为上下文。
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
/** 会改变工作目录文件列表（新增 / 删除 / 移动 / 可能创建文件）的工具：执行后使文件列表缓存失效。 */
const FILE_LIST_MUTATORS = new Set([
  "write_file",
  "append_file",
  "delete_file",
  "copy_file",
  "move_file",
  "create_directory",
  "run_command",
  "init_command",
]);

export async function runTool(name, args = {}) {
  const handler = handlers[name];
  if (!handler) return { ok: false, content: `Unknown tool: ${name}` };
  try {
    await ensureWorkdir();
    const content = await handler(args ?? {});
    if (FILE_LIST_MUTATORS.has(name)) invalidateWalkCache(); // 文件列表可能已变：下次 search_* 重新遍历
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
  fn("read_file", "Read the UTF-8 text content of a file.",
     { path: str("File path.") }, ["path"]),
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
     "Run a shell command in the working directory and return its output. For long-running / persistent processes (dev servers, watchers, `npm run dev`, `pnpm start`, vite/webpack/nodemon, etc.) pass background:true so it keeps running instead of being killed at the 60s timeout — the tool returns early with the startup output (including any http://localhost:PORT), then you can openBrowser that URL. (Such commands are also auto-detected as background.)",
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
     "Initialize project memory: scan the working directory to identify repo type (Git/monorepo), tech stack, key config files, directory structure, scripts and README, then generate a structured project memory and persist it to ZERAIX.md at the working-directory root — so later turns can read that file instead of rescanning the repo. Use this when the user asks to initialize / analyze / understand the project, explain the codebase, or 'what's in this folder'. Reuses an existing ZERAIX.md (or in-memory cache) on later calls; pass refresh:true to force a fresh rescan. Only reads config/text files (never binaries) and skips node_modules/.git/dist/build/coverage/.next etc.",
     { refresh: bool("Force a fresh rescan even if ZERAIX.md / cache already exists; defaults to false.") },
     []),
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
