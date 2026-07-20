/**
 * Local llama.cpp (llama-server) child-process management (main process).
 *
 * Multi-step flow (driven by the settings-page wizard, avoiding "guessing VRAM before install"):
 *   1) Detect the backend (CUDA/Vulkan/CPU/Metal) -> install the matching runtime bundle (skip the download if already installed);
 *   2) Probe real VRAM with the installed binary `--list-devices` -> recommend a model from it + compute layer offload (-ngl);
 *   3) Start llama-server (download GGUF weights) -> poll /health until ready.
 * Once ready, expose endpoint = http://127.0.0.1:<port>/v1/chat/completions to the renderer, which registers a "local" model from it.
 *
 * status.phase: idle | downloading | extracting | probing | loading | ready | error (pct is the download percentage).
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { spawn, execSync } from "node:child_process";
import {
  detectHardware, usableModelMemoryGB, recommend as recommendModels, buildServerArgs,
  MODELS, autoQuantId, quantBpw, gpuLayers, localSupported, MIN_LOCAL_MEM_GB, isSharedGpu, pickCtxKv, computeFit, descriptorFromGguf,
} from "./localModels.mjs";
import { ensureInstalled, installedBin, llamaVariant, fallbackVariant, detectCuda, LLAMA_VERSION, localFilesBase, installDir, llamaRootDir, installedLlamaVersions, migrateLegacyLayout } from "./llamaInstaller.mjs";
import { downloadModel, searchModels, repoDetail, TRUSTED_AUTHORS } from "./hfDownload.mjs";
import { SUPPORTED_ARCHS } from "../versions.mjs";
import { getAppConfig, setAppConfig } from "../appConfig.mjs";

const DEFAULT_PORT = Number(process.env.LLAMA_PORT || 8080);
const KV_DIR = path.join(os.tmpdir(), "zeraix-llama-kv");

// Hugging Face endpoint used by -hf to fetch GGUF. Before startup, test huggingface.co reachability: if a direct connection fails (blocked / DNS poisoning / timeout)
// switch to the mirror hf-mirror.com, otherwise connect directly to huggingface.co. The HF_ENDPOINT env var can force an override. The result is cached in this process.
let _hfEndpoint = null;
function reachable(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => { res.resume(); finish(true); }); // any response received = reachable
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}
async function resolveHfEndpoint() {
  if (_hfEndpoint) return _hfEndpoint;
  if (process.env.HF_ENDPOINT) { _hfEndpoint = process.env.HF_ENDPOINT; return _hfEndpoint; }
  const ok = await reachable("https://huggingface.co/");
  _hfEndpoint = ok ? "https://huggingface.co" : "https://hf-mirror.com";
  pushLog(`[llama] HF endpoint: ${_hfEndpoint} (huggingface.co ${ok ? "reachable, connecting directly" : "unreachable -> using mirror"})\n`);
  return _hfEndpoint;
}

const state = {
  proc: null,
  ready: false,
  phase: "idle", // idle | downloading | extracting | fetching | probing | loading | ready | error
  pct: 0, // download progress percentage (downloading = llama runtime; fetching = model weights)
  port: DEFAULT_PORT,
  model: null, // { hf, label, multimodal, id, name }
  variant: null, // llama build variant currently installed/started
  installedVariant: null, // installed variant (reused for probe/startup to avoid re-downloading)
  probe: null, // { vramGB, device, gpuPresent } -- --list-devices result
  ctx: 16384,
  error: null,
  log: [],
  dlAbort: null, // AbortController for the model self-download (aborted on stop/reset)
};

const listeners = new Set();
let healthTimer = null;
// Run-log file: persist all install/probe/download/llama-server output to disk for user troubleshooting (only the most recent 300 lines are kept in memory, see pushLog).
// start() opens a new session and writes a header, pushLog appends in sync, stop()/exit closes it; auto-cleared and restarted when it exceeds 5MB.
let logStream = null;
function logFilePath() { return path.join(localFilesBase(), "logs", "llama-server.log"); }
// Lazily open the append stream: created on the first pushLog, so output from the "install / probe / download" phases (before start) is persisted too. Cleared and restarted past 5MB.
function ensureLog() {
  if (logStream) return;
  try {
    const p = logFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    logStream = fs.createWriteStream(p, { flags: "a" });
  } catch { logStream = null; }
}
function openLog(header) { ensureLog(); if (logStream) { try { logStream.write(`\n===== ${header} =====\n`); } catch { /* ignore */ } } }
function closeLog() { if (logStream) { try { logStream.end(); } catch { /* ignore */ } logStream = null; } }
// Ensure the log file exists (even if no model has run yet), so the "run log" button can always open it (it opens the log under the current folder).
function ensureLogFile() {
  try { const p = logFilePath(); fs.mkdirSync(path.dirname(p), { recursive: true }); if (!fs.existsSync(p)) fs.writeFileSync(p, ""); } catch { /* ignore */ }
  return logFilePath();
}
// Incremented on each start()/stop(): an in-progress launch() checks after every await point, and if stale (the user
// restarted or stopped during "downloading/loading") it no longer spawns, avoiding leaking a second llama-server process.
let launchGen = 0;
// device name (lowercase) -> uma truth value: once a real model run reads the authoritative uma: from stderr, cache it for later probe/recommend to use directly
// (more accurate than the name heuristic when --list-devices has no uma). See docs/vulkan-uma-windows.md.
const umaCache = new Map();
let umaScanned = false; // whether uma has already been captured from stderr within this launch (stop scanning once captured, to avoid re-parsing)

/** Current outward-facing status snapshot (structured-cloneable, for IPC to the renderer). */
export function status() {
  return {
    running: !!state.proc,
    ready: state.ready,
    phase: state.phase,
    pct: state.pct,
    port: state.port,
    model: state.model,
    endpoint: `http://127.0.0.1:${state.port}/v1/chat/completions`,
    installed: !!installedBin(state.installedVariant || undefined),
    installedVariant: state.installedVariant,
    version: LLAMA_VERSION,
    variant: state.variant,
    probe: state.probe,
    error: state.error,
    tail: state.log.slice(-12).join(""),
    logFile: logFilePath(), // full run-log file path (for the UI "run log" button to open)
  };
}

function emit() { const st = status(); for (const cb of listeners) { try { cb(st); } catch { /* ignore */ } } }
/** Main process registers a status listener (forwarded to the renderer). Returns an unsubscribe function. */
export function onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); }

function pushLog(s) { state.log.push(s); if (state.log.length > 300) state.log.shift(); ensureLog(); if (logStream) { try { logStream.write(s); } catch { /* ignore */ } } }

// ── Hardware / recommendation ──────────────────────────────────────────────
/** Coarse detection (before install, wizard step 0/1): hardware + available memory + CUDA availability + whether the minimum threshold is met. */
export function getHardware() {
  migrateLegacyLayout(); // on first launch with the new layout, move legacy models/bin/logs into the dedicated folder (same-disk rename, sub-second)
  ensureLogFile();       // ensure the "run log" button can always open the log file under the current folder
  const hw = detectHardware();
  return { hw, cuda: detectCuda(), supported: localSupported(hw), minMemGB: MIN_LOCAL_MEM_GB };
}

// ── Storage location (llama runtime + GGUF models; large, Windows C: drive is often tight, customizable) ─────────────
function freeGB(dir) {
  try {
    let p = dir;
    while (p && !fs.existsSync(p)) { const parent = path.dirname(p); if (parent === p) break; p = parent; } // new dir not yet created -> take the nearest existing ancestor
    const s = fs.statfsSync(p);
    return Math.round((s.bavail * s.bsize) / 1e9);
  } catch { return null; }
}

// Windows: when the C: drive is tight (<30GB) and a roomier fixed disk exists, suggest moving to that disk. Other platforms just use the default local data dir (no suggestion).
function suggestStorageDir() {
  if (process.platform !== "win32") return null;
  try {
    const drives = [];
    for (const L of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${L}:\\`;
      if (!fs.existsSync(root)) continue;
      try { const s = fs.statfsSync(root); drives.push({ drive: L, freeGB: Math.round((s.bavail * s.bsize) / 1e9) }); } catch { /* skip inaccessible drives */ }
    }
    const c = drives.find((d) => d.drive === "C");
    const best = drives.reduce((a, b) => (b.freeGB > a.freeGB ? b : a), { freeGB: -1 });
    if (c && c.freeGB < 30 && best.drive !== "C" && best.freeGB > c.freeGB) return { dir: `${best.drive}:\\Zeraix`, freeGB: best.freeGB, drive: best.drive };
    return null;
  } catch { return null; }
}

/** Local file storage location info (for the settings UI): current dir / whether custom / free space / Windows disk suggestion. */
export function storageInfo() {
  const base = localFilesBase();
  return { dir: base, custom: !!getAppConfig()?.local?.dir, freeGB: freeGB(base), suggestion: suggestStorageDir() };
}

/** Set the local file storage location (empty = restore default). Only changes config, does not move data (for programmatic use; for UI folder changes use migrateStorageTo). */
export function setStorageDir(dir) {
  setAppConfig("local", "dir", dir ? String(dir).trim() : "");
  return storageInfo();
}

/**
 * Migrate to a new folder: stop the service -> move the contents under the current folder (<version>/ runtime, models/, logs/) to newDir -> update config.
 * Same-disk uses rename (sub-second); cross-disk uses async cp + rm (slow, the UI must show "migrating"). Existing items with the same name are skipped (not overwritten).
 * Returns { ok, dir?, error? }.
 */
export async function migrateStorageTo(newDir) {
  const dst = String(newDir || "").trim();
  if (!dst) return { ok: false, error: "empty directory" };
  const src = localFilesBase();
  const rSrc = path.resolve(src), rDst = path.resolve(dst);
  if (rDst === rSrc) return { ok: true, dir: src }; // unchanged
  // Reject "nesting": the new folder is a subdirectory of the current folder (or vice versa) -- would move models into its own subdirectory, error midway, and leave bin/logs behind.
  if ((rDst + path.sep).startsWith(rSrc + path.sep) || (rSrc + path.sep).startsWith(rDst + path.sep)) {
    return { ok: false, error: "the new folder cannot be a subdirectory or a parent of the current folder" };
  }
  // Allowed only when idle: reject during runtime install / model download / model running or loading (to avoid moving files being written or in use).
  if (state.proc || state.dlAbort || ["downloading", "extracting", "fetching", "loading", "probing"].includes(state.phase)) {
    return { ok: false, error: "please stop the model and wait for the download/install to finish before changing the folder" };
  }
  try {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.existsSync(src) ? fs.readdirSync(src) : [];
    // Phase 1: move each item. Same-disk renameSync (atomic, source moved away instantly); cross-disk cp (copy only first, source kept until phase 2).
    // Key: cross-disk "never delete the source before the copy completes"; if a single cp fails, clean up the half-done copy and abort, leaving all sources intact (nothing lost or split).
    for (const name of entries) {
      const s = path.join(src, name), d = path.join(dst, name);
      if (fs.existsSync(d)) continue; // target already exists (including one fully copied by a prior interrupted run) -> skip, do not overwrite
      try {
        fs.renameSync(s, d);
      } catch (e) {
        if (e && e.code === "EXDEV") {
          try { await fs.promises.cp(s, d, { recursive: true }); }
          catch (ce) { try { await fs.promises.rm(d, { recursive: true, force: true }); } catch { /* ignore */ } throw ce; } // abort after cleaning up the half-done copy
        } else throw e;
      }
    }
    // Phase 2: delete each source that already has a complete copy at the destination (from the cross-disk copy; same-disk rename already moved the source away, so this finds nothing and skips). Runs only after all copies succeed.
    for (const name of entries) {
      const s = path.join(src, name);
      if (fs.existsSync(s) && fs.existsSync(path.join(dst, name))) { try { await fs.promises.rm(s, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    setAppConfig("local", "dir", dst); // switch to the new folder
    return { ok: true, dir: dst };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** GGUF model download directory (models/<repo_>/<quant>/). */
export function modelsDir() { return path.join(localFilesBase(), "models"); }

/** llama runtime info: version / installed versions / whether updatable (the llama version in versions.json differs from the installed one) / directory. */
export function llamaInfo() {
  const versions = installedLlamaVersions();
  const upToDate = versions.includes(LLAMA_VERSION);
  let variant = state.installedVariant || null;
  if (!variant && upToDate) { // when state is not yet populated, find the installed variant of the current version from disk
    try { variant = fs.readdirSync(path.join(llamaRootDir(), LLAMA_VERSION)).find((v) => !!installedBin(v)) || null; } catch { /* ignore */ }
  }
  return {
    version: LLAMA_VERSION,
    installedVersions: versions,
    installed: versions.length > 0,
    upToDate,
    updatable: !upToDate && versions.length > 0, // an old llama version is installed and the target is a newer one -> updatable
    variant,
    binDir: variant ? installDir(variant) : llamaRootDir(),
    root: llamaRootDir(),
  };
}

/** Estimate memory usage (GB) from "model + quantization + context + KV + vision", for the UI to display live as options change.
 *  Non-catalog models pass { repo, meta } (HF gguf header) instead of modelId — sized through the same computeFit via descriptorFromGguf. */
export function estimate(opts = {}) {
  const model = MODELS.find((m) => m.id === opts.modelId)
    || (opts.repo ? descriptorFromGguf(opts.repo, opts.meta || null, { vision: !!opts.vision, mtp: !!opts.mtp }) : null);
  if (!model) return null;
  const bpw = quantBpw(model, opts.quant);
  const ctx = Math.max(256, Number(opts.ctx || 16384));
  const kvBits = Number(opts.kvBits || 8);
  const vision = !!opts.vision && !!model.vision;
  const fit = computeFit(model, { bpw }, ctx, kvBits, vision);
  // MTP standalone drafter (Gemma, ~hundred MB resident); Qwen's built-in MTP head is already counted in the weights, so extra overhead is ignored.
  const mtpGB = opts.mtp !== false && model.mtp && !model.mtpEmbedded ? 0.2 : 0;
  return { totalGB: Math.round((fit.totalGB + mtpGB) * 10) / 10, weightGB: fit.weightGB, kvGB: fit.kvGB };
}

/** Auxiliary files (not counted as main weights): mmproj vision projector, MTP drafter (mtp-*.gguf or *-MTP.gguf). */
const isAuxFile = (f) => /mmproj/i.test(f) || /^mtp-/i.test(f) || /-mtp\.gguf$/i.test(f);
/** Classify the ready (final names, not .part) model files in a directory. */
function localModelFiles(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { weights: [], mmproj: null, mtp: null, hasPart: false }; }
  return {
    weights: files.filter((f) => /\.gguf$/i.test(f) && !isAuxFile(f)).sort(),
    mmproj: files.find((f) => /mmproj.*\.gguf$/i.test(f)) || null,
    mtp: files.find((f) => /^mtp-.*\.gguf$/i.test(f) || /-mtp\.gguf$/i.test(f)) || null,
    hasPart: files.some((f) => /\.part$/i.test(f)),
  };
}
/** Whether a model's quantization is "fully installed": main weights complete, no .part, and mmproj present when the model has vision.
 *  The MTP drafter is treated as an optional accelerator (not counted toward "complete"): when missing, fetch on demand before startup (~hundred MB), to avoid "un-installing" an already installed model. */
function isModelInstalled(model, quant) {
  const dir = path.join(modelsDir(), (model.hf || "").replace(/\//g, "_"), quant);
  const f = localModelFiles(dir);
  if (f.hasPart || !f.weights.length) return false;
  if (model.vision && !f.mmproj) return false; // vision projector required
  return true;
}

/**
 * Installed local model list: scans models/<repo_>/<quant>/ directories for complete downloads (weights final-named, no .part, mmproj present when required),
 * identified by the manifest.json written by hfDownload on completion; legacy catalog dirs without a manifest are matched back to MODELS by directory name.
 * Community entries carry custom:true + the persisted gguf header, so the UI can restart them across app restarts without re-querying HF.
 * Returns [{ modelId, name, repo, quant, dir, sizeBytes, running, custom, vision, mtp, gguf }] (running = the one currently being served).
 */
export function listDownloaded() {
  const running = state.model?.dir || "";
  const base = modelsDir();
  const out = [];
  let repoDirs = [];
  try { repoDirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const rd of repoDirs) {
    let quantDirs = [];
    try { quantDirs = fs.readdirSync(path.join(base, rd.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const qd of quantDirs) {
      const dir = path.join(base, rd.name, qd.name);
      const f = localModelFiles(dir);
      if (f.hasPart || !f.weights.length) continue; // in-progress or empty download
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { /* legacy dir (pre-manifest) */ }
      // Directory names flatten "/" to "_", which is ambiguous to reverse (repo names may contain "_") → prefer manifest, then catalog match, then first-underscore split.
      const catalogModel = MODELS.find((m) => m.hf && m.hf.replace(/\//g, "_") === rd.name)
        || (manifest?.modelId ? MODELS.find((m) => m.id === manifest.modelId) : null);
      const repo = manifest?.repo || catalogModel?.hf || rd.name.replace("_", "/");
      const needVision = manifest ? !!manifest.vision : !!catalogModel?.vision;
      if (needVision && !f.mmproj) continue; // vision projector required but missing → incomplete
      let sizeBytes = 0;
      try { for (const fn of fs.readdirSync(dir)) { if (/\.part$/i.test(fn)) continue; sizeBytes += fs.statSync(path.join(dir, fn)).size; } } catch { /* ignore */ }
      out.push({
        modelId: catalogModel?.id || manifest?.modelId || repo,
        name: catalogModel?.name || manifest?.name || repo.split("/").pop(),
        repo,
        quant: manifest?.quant || qd.name,
        dir,
        sizeBytes,
        running: dir === running,
        custom: !catalogModel,
        vision: needVision,
        mtp: manifest ? !!manifest.mtp : !!catalogModel?.mtp,
        gguf: manifest?.gguf || null,
        chatTemplate: manifest?.chatTemplate || null, // persisted built-in template override (from a prior auto-fallback or manual choice)
      });
    }
  }
  return out;
}

/** Delete a downloaded local model directory (dir must be under models/; a running one is refused). Returns { ok, error? }. */
export function deleteLocalModel(opts = {}) {
  const dir = String(opts.dir || "");
  const base = modelsDir();
  if (!dir || !path.resolve(dir).startsWith(path.resolve(base) + path.sep)) return { ok: false, error: "invalid dir" };
  if (state.model?.dir && path.resolve(state.model.dir) === path.resolve(dir)) return { ok: false, error: "running" };
  try { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** The build variant selected per useCuda and whether it is installed (wizard step 1: show "install / installed", to avoid re-downloading). */
export function installInfo(opts = {}) {
  const hw = detectHardware();
  const variant = llamaVariant(hw, { preferCuda: !!opts.useCuda });
  return { variant, installed: !!installedBin(variant), version: LLAMA_VERSION };
}

/** Install status of the two candidate variants, with / without CUDA, so the wizard defaults to the "installed" one (to avoid a redundant download). Version follows LLAMA_VERSION; an upgrade counts as not installed. */
export function installStatus() {
  const hw = detectHardware();
  const cuda = detectCuda();
  const noCuda = llamaVariant(hw, { preferCuda: false });
  const withCuda = cuda.available ? llamaVariant(hw, { preferCuda: true }) : null;
  const variants = [{ useCuda: false, variant: noCuda, installed: !!installedBin(noCuda) }];
  if (withCuda && withCuda !== noCuda) variants.push({ useCuda: true, variant: withCuda, installed: !!installedBin(withCuda) });
  return { version: LLAMA_VERSION, cuda, variants };
}

/** Recommend a model: merge the probed real VRAM (opts.vramGB) into hw to get a layer-offload-aware recommendation.
 *  Shared memory (integrated-GPU UMA): the GPU uses system memory itself -> treat it as unified memory (the budget counts system memory only, never adding this "VRAM" a second time),
 *  otherwise it would be double-counted, overestimating capacity and recommending a quantization that does not fit. When opts.shared is given explicitly it takes precedence, otherwise it is decided by uma/name.
 *  See docs/vulkan-uma-windows.md. */
export function recommend(opts = {}) {
  const hw = detectHardware();
  const shared = opts.shared != null
    ? !!opts.shared
    : (hw.backend === "vulkan" && opts.vramGB > 0 ? isSharedGpu(opts.device, opts.uma ?? null) : false);
  if (opts.vramGB && opts.vramGB > 0) {
    hw.gpu = { name: opts.device || (hw.gpu && hw.gpu.name) || "GPU", vramGB: opts.vramGB };
  }
  if (shared) { hw.unified = true; hw.shared = true; } // integrated GPU: VRAM is system memory, capacity/offload follow the Apple Silicon unified-memory approach
  const budget = usableModelMemoryGB(hw, opts.budgetGB);
  return recommendModels(hw, budget, { ctx: opts.ctx || 16384, vision: opts.vision !== false });
}

// ── Model browsing (Hub discovery for the Browse tab) ─────────────────
/** Search GGUF repos on the Hub (trusted authors by default; opts.trusted === false searches everything).
 *  Same mirror-aware endpoint as downloads (resolveHfEndpoint). Errors return { ok:false } rather than throwing — the Browse tab degrades, the catalog is unaffected. */
export async function hfSearch(opts = {}) {
  try {
    const endpoint = await resolveHfEndpoint();
    const items = await searchModels(endpoint, {
      query: String(opts.query || ""),
      authors: opts.trusted === false ? null : TRUSTED_AUTHORS,
      limit: Number(opts.limit || 30),
    });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), items: [] };
  }
}

/** One repo's detail for the Browse tab: quant offerings + gguf header + arch-compat verdict against the pinned llama.cpp build.
 *  compat: "supported" | "unsupported" (arch known but absent from SUPPORTED_ARCHS — advisory only, may lag upstream) | "unknown" (no gguf metadata). */
export async function hfRepo(opts = {}) {
  const repo = String(opts.repo || "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "invalid repo" };
  try {
    const endpoint = await resolveHfEndpoint();
    const d = await repoDetail(endpoint, repo);
    const arch = d.gguf?.architecture || null;
    return { ok: true, ...d, arch, compat: arch ? (SUPPORTED_ARCHS.has(arch) ? "supported" : "unsupported") : "unknown" };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Step 1: install the runtime bundle ────────────────────────────────
/** Install the selected variant (returns instantly if already installed); on download failure, fall back level by level CUDA->Vulkan->CPU. Returns the actually installed { variant, bin }. */
async function installVariant(variant, onProgress) {
  try {
    const bin = await ensureInstalled(onProgress, variant);
    return { variant, bin };
  } catch (e) {
    const fb = fallbackVariant(variant);
    if (fb) { pushLog(`[llama] install of ${variant} failed (${String(e?.message ?? e)}) -> falling back to ${fb}\n`); return installVariant(fb, onProgress); }
    throw e;
  }
}

/** Wizard step 1: ensure the runtime is installed (skip the download if already installed). Async; progress is pushed via onStatus. */
export async function install(opts = {}) {
  if (state.proc) return status(); // do not reinstall while running
  const hw = detectHardware();
  const variant = llamaVariant(hw, { preferCuda: !!opts.useCuda });
  state.variant = variant;
  state.error = null;
  if (installedBin(variant)) { // already installed: no download needed
    state.installedVariant = variant;
    if (state.phase !== "ready") state.phase = "idle";
    emit();
    return status();
  }
  state.phase = "downloading";
  state.pct = 0;
  emit();
  try {
    const res = await installVariant(variant, (phase, pct) => { state.phase = phase; state.pct = pct || 0; emit(); });
    state.installedVariant = res.variant;
    state.variant = res.variant;
    state.phase = "idle";
    state.pct = 0;
    emit();
  } catch (e) {
    state.phase = "error";
    state.error = `Failed to install llama: ${String(e?.message ?? e)}`;
    emit();
  }
  return status();
}

// ── Step 2: probe VRAM (--list-devices) ─────────────────────────
/** Wizard step 2: probe GPU VRAM/device with the installed binary. Returns { vramGB, device, gpuPresent }; vramGB=null if unreadable. */
export async function probe(opts = {}) {
  const variant = state.installedVariant || llamaVariant(detectHardware(), { preferCuda: !!opts.useCuda });
  const bin = installedBin(variant);
  if (!bin) { const p = { vramGB: null, device: null, gpuPresent: false, variant, error: "not installed" }; state.probe = p; emit(); return p; }
  state.phase = "probing";
  emit();
  const p = await probeDevices(bin);
  p.variant = variant;
  // UMA decision (integrated vs discrete GPU): prefer the authoritative uma cached from a prior real model run; otherwise use the one in --list-devices stderr (usually absent);
  // otherwise fall back to the device-name heuristic. Only meaningful for Vulkan; CUDA (discrete) / no GPU is always non-shared. See docs/vulkan-uma-windows.md.
  const hw = detectHardware();
  if (hw.backend === "vulkan" && p.gpuPresent) {
    const cached = p.device ? umaCache.get(p.device.toLowerCase()) : undefined;
    if (p.uma == null && cached != null) p.uma = cached;
    p.shared = isSharedGpu(p.device, p.uma ?? null);
  } else {
    p.shared = false;
  }
  state.probe = p;
  if (state.phase === "probing") state.phase = "idle";
  pushLog(`[llama] probe ${variant}: ${p.device || "no GPU"}${p.vramGB ? ` ${p.vramGB}GB` : ""}${p.shared ? " (shared memory/integrated GPU)" : ""}\n`);
  emit();
  return p;
}

/** Asynchronously run `llama-server --list-devices` (without blocking the main process; GPU backend init can take 1-3s), and parse the device with the most VRAM. */
function probeDevices(bin) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = () => { if (done) return; done = true; resolve(parseDevices(out)); };
    try {
      const p = spawn(bin, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"] }); // only enumerate devices, no download, no HF endpoint needed
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { out += d.toString(); });
      p.on("error", finish);
      p.on("close", finish);
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(); }, 15000);
    } catch { resolve({ vramGB: null, device: null, gpuPresent: false }); }
  });
}

/**
 * Parse --list-devices output, of the form:
 *   Available devices:
 *     Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)
 * Take the device with the most VRAM, preferring "free". If unreadable (old version lacks this option / no GPU), return gpuPresent:false.
 */
function parseDevices(out) {
  let bestMiB = 0, device = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\S.*?)\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB\s*free)?/i);
    if (!m) continue;
    const mib = Number(m[3] || m[2]); // use free if present, otherwise use the total
    if (mib > bestMiB) { bestMiB = mib; device = m[1].replace(/^[A-Za-z]+\d+:\s*/, "").trim(); }
  }
  const uma = parseUma(out); // --list-devices usually lacks this line -> null; only present in some builds / real model runs
  return bestMiB > 0
    ? { vramGB: Math.round((bestMiB / 1024) * 10) / 10, device, gpuPresent: true, uma }
    : { vramGB: null, device: null, gpuPresent: false, uma };
}

/**
 * Parse the uma flag from the ggml Vulkan init log (stderr): `ggml_vulkan: 0 = <name> | uma: X | fp16: ...`.
 * Returns true (uma:1, integrated GPU/shared system memory), false (uma:0, discrete GPU/dedicated VRAM), or null (no such line, e.g. a bare --list-devices).
 * See docs/vulkan-uma-windows.md.
 */
function parseUma(out) {
  const m = String(out).match(/ggml_vulkan:\s*\d+\s*=.*?\buma:\s*([01])/i);
  return m ? m[1] === "1" : null;
}

/** During a real model run, capture the authoritative uma from llama stderr: cache and backfill the current probe (calibrating the VRAM budget/offload). Captured once per launch, then stops. */
function maybeCaptureUma() {
  if (umaScanned) return;
  const uma = parseUma(state.log.slice(-80).join("")); // join recent logs across chunks, to avoid missing a ggml line split across chunks
  if (uma == null) return;
  umaScanned = true;
  const dev = state.probe && state.probe.device;
  if (dev) umaCache.set(dev.toLowerCase(), uma);
  if (state.probe) { state.probe.uma = uma; state.probe.shared = isSharedGpu(dev, uma); }
  pushLog(`[llama] uma=${uma ? 1 : 0} -> ${uma ? "shared memory (integrated GPU)" : "discrete GPU"} (calibrating the VRAM budget/offload from this)\n`);
  emit();
}

// ── Step 3: start llama-server ─────────────────────────────────
/** Parse opts -> { hf, repo, quant, label, vision, mtp, id, name, model, bpw }. When hf is not given, derive from the catalog by modelId + quantId.
 *  repo/quant are used by the self-download (hfDownload); vision = whether the model has vision-projection capability (whether it is actually enabled is decided by start together with the user toggle). */
function resolveHf(opts, hw) {
  if (opts.hf) {
    const i = opts.hf.lastIndexOf(":"); // custom "user/repo:QUANT"; without ":" there is only repo (no quant -> no self-download, fall back to -hf)
    const repo = i > 0 ? opts.hf.slice(0, i) : opts.hf;
    const quant = i > 0 ? opts.hf.slice(i + 1) : "";
    // Non-catalog repo: build a catalog-shaped descriptor from the HF gguf header (opts.meta, from llm:local:hfRepo; heuristic fallbacks
    // when absent) so ctx/KV auto-tiering and layer offload work exactly like catalog models instead of the blind 16K/full-offload fallback.
    const model = descriptorFromGguf(repo, opts.meta || null, { vision: !!opts.multimodal, mtp: !!opts.mtp });
    return { hf: opts.hf, repo, quant, label: opts.label || model.name, vision: !!opts.multimodal, mtp: !!opts.mtp, id: opts.model || repo, name: opts.label || model.name, model, bpw: quant ? quantBpw(model, quant) : null, meta: opts.meta || null, chatTemplate: opts.chatTemplate || null };
  }
  const model = MODELS.find((m) => m.id === opts.modelId);
  if (!model) return null;
  // Pass the quantization label through directly (may be a tiered model's UD label, not in the generic QUANTS -- do not filter with QUANTS); auto-select by memory when unspecified.
  const quantId = opts.quantId || autoQuantId(model, hw, Number(opts.ctx || 16384));
  return { hf: `${model.hf}:${quantId}`, repo: model.hf, quant: quantId, label: model.name, vision: !!model.vision, mtp: model.mtp, id: model.id, name: model.name, model, bpw: quantBpw(model, quantId), chatTemplate: opts.chatTemplate || null };
}

/** Decide -ngl: unified memory (Metal)/shared memory (integrated GPU)/unknown -> offload all; CPU build -> 0; discrete GPU -> layer offload per probed VRAM. */
function computeNgl(variant, r, ctx, kvBits, hw) {
  if (variant.includes("macos") || (hw && hw.unified)) return 999;
  if (state.probe && state.probe.shared) return 999; // integrated GPU shares system memory: just offload all, no "layer by dedicated VRAM" estimation
  if (!/cuda|vulkan/.test(variant)) return 0; // CPU build
  const vram = (state.probe && state.probe.vramGB) || (hw.gpu && hw.gpu.vramGB) || 0;
  return gpuLayers(r.model, r.bpw, ctx, kvBits, vram);
}

/**
 * Start a local model (async: install llama first if needed, then bring up llama-server). Returns the current status immediately;
 * subsequent downloading/loading/ready/error are pushed via onStatus.
 * opts: { modelId?, quantId?, hf?, ctx?, port?, useCuda?, vision?, mmproj? }
 *   vision (default true): whether to load the vision projector when the model has vision capability (off -> --no-mmproj, saving ~1GB memory).
 */
// Leftover cleanup: when the app is force-killed (skipping before-quit -> stop), llama-server becomes an orphan holding the port, and the next start exits with a bind failure.
// Record this process's PID in a pidfile; before the next start, if that PID is still llama-server, kill it (verify the command line contains llama-server, to avoid a PID-reuse mis-kill).
// Have the kernel allocate a free port (listen 0 -> take port -> close); a random port avoids a fixed 8080 conflict.
function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const pidFile = () => path.join(localFilesBase(), "llama-server.pid");
function killOrphanServer() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile(), "utf8").trim()); } catch { return; }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
  if (!(pid > 0)) return;
  try {
    const cmd = process.platform === "win32"
      ? execSync(`wmic process where processid=${pid} get commandline`, { stdio: ["ignore", "pipe", "ignore"] }).toString()
      : execSync(`ps -p ${pid} -o command=`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    if (/llama-server/i.test(cmd)) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  } catch { /* process no longer exists */ }
}

export function start(opts = {}) {
  stop();
  killOrphanServer(); // clean up the llama-server left over from a prior force-kill (otherwise it holds the port and causes this bind to fail)
  openLog(`Session start ${new Date().toISOString()} · model=${opts.modelId || opts.hf || "?"}`); // persist all output for this startup
  const hw = detectHardware();
  const r = resolveHf(opts, hw);
  if (!r) { state.phase = "error"; state.error = "unknown modelId"; emit(); return status(); }

  const visionOn = r.vision && opts.vision !== false; // true only when the model supports vision and the toggle is not off
  const mtpOn = !!r.mtp && opts.mtp !== false;  // MTP speculative decoding (model supports it and the toggle is not off, on by default)
  // Context / KV quantization auto-tiering: when not explicitly specified, pick the largest -c that fits per "model + quantization + device memory" (capped at the native window),
  // preferring KV q8, and automatically dropping to q4 when it does not fit to unlock a larger context (see localModels.pickCtxKv). Custom -hf (no catalog entry) falls back to 16K/q8.
  const pick = !opts.ctx && r.model ? pickCtxKv(r.model, r.bpw, hw, usableModelMemoryGB(hw), visionOn) : null;
  const ctx = Number(opts.ctx || (pick ? pick.ctx : 16384));
  const kvBits = Number(opts.kvBits || (pick ? pick.kvBits : 8));
  state.port = Number(opts.port || 0); // 0 = request a random free port from the kernel inside launch
  state.ctx = ctx;
  const modelDir = r.repo && r.quant ? path.join(localFilesBase(), "models", r.repo.replace(/\//g, "_"), r.quant) : null;
  state.model = { hf: r.hf, label: r.label, multimodal: visionOn, id: r.id, name: r.name, ctx, dir: modelDir, repo: r.repo || null, quant: r.quant || null, chatTemplate: r.chatTemplate || null }; // ctx = the -c at startup, used by the renderer as the model's real context window; dir/repo/quant let the model library match "running"; chatTemplate = optional built-in template override
  state.ready = false;
  state.error = null;
  state.log = [];
  state.pct = 0;
  try { fs.mkdirSync(KV_DIR, { recursive: true }); } catch { /* ignore */ }

  // Prefer reusing the variant installed in wizard step 1; otherwise choose now per useCuda (launch will ensure it is installed).
  const variant = state.installedVariant || llamaVariant(hw, { preferCuda: !!opts.useCuda });
  const gen = ++launchGen; // this startup's generation id; checked after awaits inside launch, abandon spawn if stale
  launch(variant, { r, hw, ctx, kvBits, visionOn, mtpOn, gen });
  emit();
  return status();
}

/** Install (download if needed) the given variant -> bring up llama-server; if a GPU build fails before ready, automatically fall back to the next level (the CPU variant has no fallback, so no infinite recursion). */
async function launch(variant, cfg) {
  const { r, hw, ctx, kvBits = 8, visionOn, mtpOn, gen } = cfg;
  const stale = () => gen != null && gen !== launchGen; // this startup has been superseded by a later start/stop
  const mtpSeparate = !!r.model?.mtp && !r.model?.mtpEmbedded; // Gemma: standalone MTP drafter file (needs download + -md)
  state.variant = variant;
  let bin;
  try {
    state.phase = installedBin(variant) ? "loading" : "downloading";
    state.pct = 0;
    emit();
    bin = await ensureInstalled((phase, pct) => { state.phase = phase; state.pct = pct || 0; emit(); }, variant);
    state.installedVariant = variant;
  } catch (e) {
    const fb = fallbackVariant(variant);
    if (fb) { pushLog(`[llama] install of ${variant} failed (${String(e?.message ?? e)}) -> falling back to ${fb}\n`); return launch(fb, cfg); }
    state.phase = "error"; state.error = `Failed to install llama: ${String(e?.message ?? e)}`; emit(); return;
  }

  // Self-download the model weights (with progress/resume/mirror); on success start with -m, on failure fall back to -hf and let llama fetch it itself, and if the user aborts, do not start.
  const hfEnd = await resolveHfEndpoint(); // test huggingface.co reachability before startup, use the mirror if unreachable
  const modelsDir = path.join(localFilesBase(), "models"); // GGUF weights directory (self-download lands here; also used as LLAMA_CACHE when falling back to -hf)
  try { fs.mkdirSync(modelsDir, { recursive: true }); } catch { /* ignore */ }
  let modelPath = null, mmprojPath = null, mtpPath = null;
  if (r.repo && r.quant) {
    const destDir = path.join(modelsDir, r.repo.replace(/\//g, "_"), r.quant);
    const local = localModelFiles(destDir);
    const drafterMissing = mtpSeparate && !local.mtp; // needs a standalone drafter but not present locally -> needs to be fetched (~hundred MB)
    if (r.model && isModelInstalled(r.model, r.quant) && !drafterMissing) {
      // Fully installed (and no missing drafter): use the local files directly, skipping the download phase (do not show "downloading").
      modelPath = path.join(destDir, local.weights[0]);
      mmprojPath = local.mmproj ? path.join(destDir, local.mmproj) : null;
      mtpPath = local.mtp ? path.join(destDir, local.mtp) : null;
      pushLog(`[llama] already installed, loading directly: ${path.basename(modelPath)}\n`);
    } else {
      const ac = new AbortController();
      state.dlAbort = ac;
      try {
        state.phase = "fetching"; state.pct = 0; emit();
        // Always download mmproj (when the model has vision) and the standalone MTP drafter (Gemma), so the runtime can freely toggle vision/MTP without re-downloading;
        // when an installed model is only missing the drafter, downloadModel skips the existing weights/vision projector and fetches only the drafter. Qwen has a built-in MTP (no standalone file).
        const out = await downloadModel(
          // manifest: identifies the directory for listDownloaded (community models keep their gguf header for restarts, see descriptorFromGguf).
          { endpoint: hfEnd, repo: r.repo, quant: r.quant, vision: !!r.vision, mtp: mtpSeparate, destDir, manifest: { name: r.name, modelId: r.id, gguf: r.meta || null } },
          (pct) => { if (pct !== state.pct) { state.pct = pct; emit(); } },
          ac.signal,
        );
        modelPath = out.modelPath; mmprojPath = out.mmprojPath; mtpPath = out.mtpPath || null;
        pushLog(`[llama] model ready: ${path.basename(modelPath)}${mmprojPath ? ` + ${path.basename(mmprojPath)}` : ""}${mtpPath ? ` + ${path.basename(mtpPath)}` : ""}\n`);
      } catch (e) {
        if (ac.signal.aborted) { pushLog("[llama] model download cancelled\n"); return; } // user stop: do not bring up the service
        // Do not fall back to -hf (would land in the HF cache layout, uncontrollable): a self-download failure is an error.
        state.phase = "error"; state.error = `Model download failed: ${String(e?.message ?? e)}`; pushLog(`[llama] model download failed: ${String(e?.message ?? e)}\n`); emit(); return;
      } finally {
        if (state.dlAbort === ac) state.dlAbort = null;
      }
    }
  }

  if (stale()) { pushLog("[llama] startup superseded by a new start/stop, abandoning this one\n"); return; } // the user pressed start or stop again during download/install
  state.phase = "loading";
  state.pct = 0;
  emit();
  if (!state.port) state.port = await findFreePort(); // random free port (to avoid a fixed 8080 conflict)
  if (stale()) { pushLog("[llama] startup superseded, abandoning spawn\n"); return; }
  const ngl = computeNgl(variant, r, ctx, kvBits, hw);
  pushLog(`[llama] ${variant} -ngl ${ngl} -c ${ctx} kv=q${kvBits} :${state.port}${state.probe && state.probe.vramGB ? ` (VRAM≈${state.probe.vramGB}GB)` : ""}\n`);
  // Catalog models always have a quant -> always self-download and get local weights; no -hf branch. When vision is off, do not pass --mmproj (the file remains, just not loaded).
  if (!modelPath) { state.phase = "error"; state.error = "model weights missing (self-download produced nothing)"; emit(); return; }
  // MTP: built-in head (Qwen) -> only --spec-type; standalone drafter (Gemma) -> -md + --spec-type, only when the drafter file is actually present.
  // When the drafter is missing (download failed), do not add the flag, degrading to no speculative decoding rather than erroring.
  const haveMtp = r.model?.mtpEmbedded ? true : (mtpSeparate && !!mtpPath);
  const useMtp = !!mtpOn && haveMtp;
  const mtpDraft = useMtp && mtpSeparate ? mtpPath : null;
  if (mtpOn && !haveMtp) pushLog("[llama] MTP is enabled but no drafter found, speculative decoding not enabled this time\n");
  const args = buildServerArgs({ modelPath, mmproj: visionOn ? mmprojPath : null, mtpDraft, specMtp: useMtp, hw, ctx, port: state.port, kvBits, kvCacheDir: KV_DIR, ngl, chatTemplate: r.chatTemplate });
  if (r.chatTemplate) pushLog(`[llama] chat template override: ${r.chatTemplate}\n`);
  pushLog(`[llama] argv: ${bin} ${args.join(" ")}\n`); // full startup command (for troubleshooting)
  let proc;
  try {
    proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HF_ENDPOINT: hfEnd, LLAMA_CACHE: modelsDir } });
  } catch (e) {
    const fb = fallbackVariant(variant);
    if (fb) { pushLog(`[llama] start of ${variant} failed (${String(e?.message ?? e)}) -> falling back to ${fb}\n`); return launch(fb, cfg); }
    state.phase = "error"; state.error = String(e?.message ?? e); emit(); return;
  }
  state.proc = proc;
  try { fs.writeFileSync(pidFile(), String(proc.pid)); } catch { /* ignore */ } // record the PID for the next start to clean up force-kill leftovers
  umaScanned = false; // rescan the authoritative uma: from stderr for this startup
  const onData = (b) => { pushLog(b.toString()); maybeCaptureUma(); };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  // "whether this proc is still the current service process": if a later start() has replaced it with a new proc, the old proc's error/exit
  // must not clear the global state (otherwise it would wrongly kill the new proc's health poll/proc reference, leaving the new service actually ready but perpetually showing "starting").
  const isCurrent = () => state.proc === proc;
  proc.on("error", (e) => { if (state.proc && !isCurrent()) return; state.error = String(e?.message ?? e); state.phase = "error"; state.proc = null; stopHealthPoll(); emit(); });
  proc.on("exit", (code) => {
    if (state.proc && !isCurrent()) { pushLog(`[llama] old process exited (code=${code}), superseded by a new startup, ignoring\n`); return; } // stale proc: leave global state untouched
    state.proc = null;
    pushLog(`[llama] process exited, code=${code}\n`); // persist the exit code to aid crash troubleshooting (the log stream stays open until stop/next start)
    try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
    const wasReady = state.ready;
    state.ready = false;
    const fb = fallbackVariant(variant);
    if (code && code !== 0 && !wasReady && fb) {
      stopHealthPoll();
      pushLog(`[llama] ${variant} exited before ready (code ${code}) -> falling back to ${fb}\n`);
      return launch(fb, cfg);
    }
    if (code && code !== 0 && !state.error) { state.error = `llama-server exited (code ${code})`; state.phase = "error"; }
    stopHealthPoll();
    emit();
  });
  startHealthPoll();
  emit();
}

function stopHealthPoll() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }
function startHealthPoll() {
  stopHealthPoll();
  healthTimer = setInterval(() => {
    const req = http.get({ host: "127.0.0.1", port: state.port, path: "/health", timeout: 1500 }, (res) => {
      const ok = res.statusCode === 200; res.resume();
      if (ok && !state.ready) { state.ready = true; state.phase = "ready"; state.error = null; emit(); stopHealthPoll(); }
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }, 1000);
}

export function stop() {
  stopHealthPoll();
  launchGen++; // make any in-progress launch stale (abandon before spawn)
  if (state.dlAbort) { try { state.dlAbort.abort(); } catch { /* ignore */ } state.dlAbort = null; } // abort an in-progress model download
  // SIGKILL rather than SIGTERM: llama-server ignores SIGTERM while loading weights (mmap/warmup),
  // so "starting again during loading" cannot kill the old process, which holds the port and leaks. A local inference service needs no graceful shutdown.
  if (state.proc) { const p = state.proc; try { p.kill("SIGKILL"); } catch { /* ignore */ } state.proc = null; }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
  closeLog();
  state.port = 0; // re-request a random port on the next start
  state.ready = false;
  state.phase = "idle";
  state.model = null; // clear the "running" association, otherwise the model library list still marks the model as running (its delete button would be wrongly disabled)
  emit();
  return status();
}

/** "Start over": stop the service + clear the probe/model results, returning to wizard step 1; keep the installed runtime (no re-download). */
export function reset() {
  stop();
  state.probe = null;
  state.model = null;
  state.error = null;
  state.pct = 0;
  emit();
  return status();
}
