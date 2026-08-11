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
import https from "node:https";
import { spawn, execSync } from "node:child_process";
import { app } from "electron";
import {
  detectHardware, usableModelMemoryGB, recommend as recommendModels, buildServerArgs,
  MODELS, autoQuantId, quantBpw, gpuLayers, localSupported, MIN_LOCAL_MEM_GB, isSharedGpu, pickCtxKv, computeFit, descriptorFromGguf, MIN_CTX, kvTierEnabled, seedAvailable, moePoolEnabled, KV_BITS_OFFERED, moeNativePlan, moeFloorPool, CTX_LADDER,
} from "./localModels.mjs";
import { ensureInstalled, installedBin, llamaVariant, fallbackVariant, detectCuda, llamaVersionDir, localFilesBase, installDir, llamaRootDir, installedLlamaVersions, migrateLegacyLayout } from "./llamaInstaller.mjs";
import { downloadModel, searchModels, repoDetail, resolveRevision, TRUSTED_AUTHORS } from "./hfDownload.mjs";
import { SUPPORTED_ARCHS, SEED_PREFIX, SEED_KVD, MAC_LLAMA_TAG } from "../versions.mjs";
import { getAppConfig, setAppConfig } from "../appConfig.mjs";
import { ensureSeed, seedSize, seedInstalled, seedKey } from "./seeds.mjs";
// The renderer mirrors daily/dev into the sandbox engine, which is the main process's only view of the current mode.
import { getSandboxStatus } from "../tools/sandbox/engine.mjs";

const DEFAULT_PORT = Number(process.env.LLAMA_PORT || 8080);
// KV disk tier + resident seeds. Deliberately NOT under tmpdir: the point of the tier is to survive a restart,
// and downloaded seeds live here too (in a <model_key>/ sub-folder the server creates). Sibling of models/, so version pruning —
// which scans only bin/ — leaves it alone.
const kvDiskDir = () => path.join(localFilesBase(), "kv");

/**
 * Per-model MoE routing profiles, BUNDLED with the app rather than downloaded.
 *
 * 2 KB of JSON tuned per model by the sweep in the fork (kv-cache-disk-design-docs/moe-pool), so there is nothing to gain from a
 * CDN — unlike seeds, whose size is the only reason they are fetched at all. Packaged: resources/moe-profiles beside the asar;
 * dev: the repo folder.
 */
const moeProfileDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "moe-profiles")
    : path.join(app.getAppPath(), "resources", "moe-profiles");

/**
 * Ring buffer count, passed to the server as LLAMA_MOE_RING_LAYERS and used by the memory estimate.
 *
 * Named rather than written twice: the estimate has to model the same buffer the server actually allocates, and a literal in
 * the spawn env with a second literal in the sizing code is how the two silently drift apart.
 */
const MOE_RING_LAYERS = 4;

/** Concurrent sequences (the --parallel passed to buildServerArgs) and experts routed per token. Both feed the
 *  slot floor, so they are named here rather than repeated as literals at each call site. */
const MOE_PARALLEL = 2;
const MOE_EXPERT_USED = 8;

/**
 * Pass GGML_METAL_NO_RESIDENCY, disabling Metal residency sets. Flip this one constant to test it.
 *
 * OFF. Both directions are measured, and the choice is which memory gets compressed, not whether any does.
 *
 *                          residency ON (this)   residency OFF
 *   system wired               15.31 GiB            2.65 GiB
 *   llama phys_footprint        9.11 GiB            9.12 GiB     <- unchanged
 *   llama dirty anon            8.86 GiB            8.86 GiB     <- unchanged
 *
 * Turning it off reclaims ~12.7 GiB of wired memory without changing a single one of llama's own allocations,
 * which reads like a free win and is why it was briefly enabled. What it actually does is make those buffers
 * evictable - and Metal buffers are DIRTY ANONYMOUS, so eviction means the compressor or swap, not a clean
 * re-read. Pooled experts are file-backed and evict cheaply; native experts (slots == 0) sit in the Metal
 * buffer and do not, so every layer moved to native raises the exposure. On this 24 GiB machine the
 * compressor already holds 25 GiB of data with swap in use, so that exposure is not hypothetical.
 *
 * Left off because the risk is asymmetric: wiring costs page cache, which shows up as slower prefill and is
 * visible in an average; unwiring risks a GPU touch stalling on decompression, which shows up as decode
 * VARIANCE and hides in one. The measured decode gain seen while it was on (11.38 -> 15.33 t/s) arrived in
 * the same restart as the 5 -> 10 native-layer change, so it cannot be attributed to this.
 *
 * To evaluate: set true, restart Electron (main-process module), then watch decode variance rather than the
 * mean, and the Decompressions delta across a generation.
 *
 * ggml reads it by PRESENCE - `use_residency_sets = getenv(...) == nil` - so the value is irrelevant and the
 * variable must be absent entirely, not set to "0".
 */
const MOE_NO_RESIDENCY = false;

/**
 * Stage every expert through one ring forward during warmup (LLAMA_MOE_WARMUP_RING). OFF.
 *
 * The pool picks its path per graph on n_tokens, and a {bos, eos} warmup is 2 tokens - so it takes the slot pool,
 * filling only the few experts those two tokens route. The fork can widen the warmup past pool_ubatch to force
 * the ring path instead, which stages every expert of every pooled layer.
 *
 * Measured on Qwen3.6-35B-A3B, 235-token opening turn: prefill 12126 -> 9441 ms, load 8.3 -> 17.6 s. It moves
 * ~8.5 s onto the load to buy 2.7 s on the first message - a net loss in summed seconds, justified only by where
 * the time lands.
 *
 * Off, and the fork now defaults it off too - this passes LLAMA_MOE_WARMUP_RING=1 to opt IN. Kept as a flag
 * rather than deleted because a heavily pooled profile on a small machine is still the case it was written for.
 *
 * The split is derived per host now, and on a machine with room most layers are native (34 of 41 on a 36 GiB
 * Mac). Native experts are copied into the Metal device buffer at load and are already resident, so there are
 * few pooled layers left for the warmup to stage and the first prefill it protected is already fast. It also
 * fires on every model start, including the ones where the user switches away without sending anything.
 */
const MOE_WARMUP_RING = false;

/** Env the pool needs, or {} when it is not running. Built here rather than inline in spawn() so the set is
 *  readable and a flag like MOE_NO_RESIDENCY is one line rather than an edit inside a 300-character literal. */
function moeEnv(moeProfile) {
  return {
    LLAMA_MOE_POOL_PROFILE: moeProfile,
    LLAMA_MOE_RING: "1",
    GGML_METAL_SEG_ASYNC: "1",
    // 0 = OFF. See the note at buildServerArgs below: the split can only route a prefill through the pool
    // by cutting it into pool_ubatch-wide (6) graphs, and a different batch shape regroups the attention
    // reduction, so the answer stops matching upstream's. That is not tunable - the pool cannot serve a
    // wide graph by construction - so it is byte-identity OR the speed-up, and correctness wins.
    LLAMA_MOE_SMALL_PREFILL: "0",
    LLAMA_MOE_POOL_FILL_THREADS: "16",
    // LLAMA_MTP_HEAD_AUTO: let the MTP drafter read only the first N rows of the LM head, N sized from
    // the token ids the drafter has actually seen. This model ships no nextn.shared_head_head, so the
    // drafter falls back to model.output and re-reads the whole q8_0 [2048 x 248320] head — 515 MiB —
    // once per drafted token, which a mat-vec must touch in full and no cache can hold. Three drafts
    // per cycle plus the target's own read is 4 x 515 MiB, as many bytes as all 40 layers of experts.
    //
    // Safe in a way capping the TARGET's head would not be: the target verifies every drafted token,
    // so a row the drafter cannot express costs one wasted draft position and never changes the
    // output. Verified byte-identical on english/chinese/python output.
    //
    // Adaptive rather than a constant because no constant works on this vocabulary: 99.5% coverage
    // needs ~131072 rows for english but ~196608 for chinese, so any fixed value is either unsafe for
    // CJK or useless for latin text. Below 256 observed ids it leaves the head whole.
    // Measured, 24 GB simulation: draft call -33%, decode 19.98 -> 20.10 on an adjacent-run pair.
    LLAMA_MTP_HEAD_AUTO: "1",
    LLAMA_MOE_RING_LAYERS: String(MOE_RING_LAYERS),
    ...(MOE_NO_RESIDENCY ? { GGML_METAL_NO_RESIDENCY: "1" } : {}),
    ...(MOE_WARMUP_RING ? { LLAMA_MOE_WARMUP_RING: "1" } : {}),
  };
}

/**
 * The pool profile for a model, as the memory estimate needs it: { layers, n_expert, ringLayers }.
 *
 * Read here rather than in localModels because that module is deliberately free of filesystem access. Cached per model - this
 * is called once per model per recommend(), and the file never changes within a run. A missing or unparseable profile returns
 * null, which sizes the model as fully resident: the same answer as before the pool existed, and the safe direction to be
 * wrong in, since the server also leaves the pool inert when the profile is absent.
 */
const moeProfileCache = new Map();

/** The shipped profile object for a model, or null. Parsed once - the file does not change within a run. */
const moeRawCache = new Map();
function moeShippedProfile(modelId) {
  if (!moePoolEnabled(modelId)) return null;
  if (moeRawCache.has(modelId)) return moeRawCache.get(modelId);
  let prof = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(moeProfileDir(), `${modelId}.json`), "utf8"));
    if (Array.isArray(p.layers) && p.n_expert > 0) { prof = p; }
  } catch { /* not shipped, or malformed */ }
  moeRawCache.set(modelId, prof);
  return prof;
}

function moePoolInfo(modelId) {
  if (!moePoolEnabled(modelId)) return null;
  if (moeProfileCache.has(modelId)) return moeProfileCache.get(modelId);
  let info = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(moeProfileDir(), `${modelId}.json`), "utf8"));
    // The FLOOR shape, not the file's own slots. Sizing decides the context rung and the quant, and the launch
    // plan only ever spends MORE than the floor - so sizing against the floor is what makes "it fits" true. The
    // file's slots were chosen for the profiling machine and are not this machine's answer to anything.
    info = moeFloorPool(p, { parallel: MOE_PARALLEL, nExpertUsed: MOE_EXPERT_USED, ringLayers: MOE_RING_LAYERS });
  } catch { /* no profile shipped for this model, or it is malformed */ }
  moeProfileCache.set(modelId, info);
  return info;
}

/**
 * The profile path to hand llama-server, with the native/pooled split derived for THIS machine.
 *
 * The shipped file is a measurement (per-layer miss rates from one reference machine) and its `slots` are that
 * machine's answer. moeNativePlan re-decides the split against this host's memory budget, and the result is
 * written beside the models as `<localFilesBase>/moe-derived/<modelId>.json`. Derived rather than edited in place
 * so the shipped measurement stays pristine and a bad plan is one file deletion away from the original.
 *
 * Falls back to the shipped file whenever the plan cannot be formed (no expertFrac for the model, unreadable
 * profile, write failure): the pool then runs the reference split, which is what shipped before this existed.
 * Returns null when there is no profile at all - the fork leaves the pool inert rather than pinning blind
 * index-order experts, so that degrades to stock speed, not to wrong output.
 */
function moeProfileFor(model, { hw, bpw, ctx, kvBits, vision = false, log = () => {} } = {}) {
  if (!moePoolEnabled(model?.id) || !bpw) return null;
  const shipped = path.join(moeProfileDir(), `${model.id}.json`);
  if (!fs.existsSync(shipped)) { log(`[llama] MoE pool profile missing (${model.id}.json) — pool inert\n`); return null; }
  try {
    const prof = JSON.parse(fs.readFileSync(shipped, "utf8"));
    const plan = moeNativePlan(model, prof, {
      // bpw of the quant ACTUALLY being launched, not autoQuantId's re-derivation - those disagree (a 24 GB Mac
      // auto-picks UD-Q3_K_XL while the installed weights are UD-Q4_K_XL), and sizing against the smaller one
      // models the model as ~30% lighter and over-promotes layers to native.
      bpw, budgetGB: usableModelMemoryGB(hw), ctx, kvBits, vision,
      ringLayers: MOE_RING_LAYERS, parallel: MOE_PARALLEL, nExpertUsed: MOE_EXPERT_USED,
    });
    if (!plan) throw new Error("no plan");
    // Not fatal: the floor is the minimum a pooled layer can run at, so there is nothing to trim. Ship it and say
    // so - the alternative is no pool at all, which is strictly worse. Sizing normally prevents this by choosing
    // the context rung against the same floor; reaching here means something overrode that.
    if (!plan.fits) {
      log(`[llama] MoE pool: plan needs ~${plan.totalGB} GB against a ${usableModelMemoryGB(hw)} GB budget `
        + `— running at the routing floor anyway; expect memory pressure\n`);
    }
    const dir = path.join(localFilesBase(), "moe-derived");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${model.id}.json`);
    fs.writeFileSync(out, JSON.stringify({ ...prof, layers: plan.layers }, null, 1));
    log(`[llama] MoE pool: ${plan.native.length}/${plan.layers.length} layers native for ${hw.totalMemGB}GB `
      + `(~${plan.residentGB.toFixed(1)} GB resident) — ${JSON.stringify(plan.native)}\n`);
    return out;
  } catch (e) {
    log(`[llama] MoE pool: could not derive a split (${String(e?.message ?? e)}) — using the shipped profile\n`);
    return shipped;
  }
}

/** Pool info for every catalog model that has one, keyed by id - the shape localModels.recommend expects. */
function moePools() {
  const out = {};
  for (const m of MODELS) {
    const info = moePoolInfo(m.id);
    if (info) out[m.id] = info;
  }
  return out;
}

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
/**
 * Tell the running server to forget a conversation's persisted KV.
 *
 * The server keeps a conversation's KV on disk for as long as its tip manifest exists, and nothing else ever removes one —
 * so without this call, deleting a conversation in the UI left its KV behind permanently and the kv directory only grew.
 * The server also detaches any slot still holding it, otherwise an eviction spill would write the tip straight back.
 *
 * Best-effort and never throws: the server may not be running, may be an older build without the route, or may be mid-restart.
 * None of those should make deleting a conversation fail — the worst case is the KV lingering until the byte budget evicts it.
 */
export async function eraseConversationKv(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id || !state.port || !state.proc) return { ok: false, reason: "server not running" };
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/kv/conversation/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    if (body?.erased) pushLog(`[llama] forgot KV for deleted conversation ${id}\n`);
    return { ok: true, erased: !!body?.erased };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

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
    version: llamaVersionDir(),
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

/**
 * Bring on-disk state in line with the current pins. Runs once per launch, before anything reads the model list.
 *
 * Two steps: drop pre-versioning installs, whose revision is unknown and unknowable, then reclaim what the current pins have
 * superseded — old model versions and the seeds keyed to them.
 *
 * Both delete without asking, for the same reason: what they remove can never be loaded again. A superseded version directory
 * names a revision the catalog no longer points at, and an unversioned directory has no revision at all, so neither can satisfy
 * the pinned path the launcher builds. Keeping them costs tens of gigabytes to no end; the cost of removing them is one
 * re-download.
 *
 * Never throws: storage housekeeping must not be able to stop the app from launching.
 */
function runStorageMaintenance() {
  try {
    for (const r of deleteUnversionedModelDirs()) {
      if (r.removed) pushLog(`[llama] removed unversioned ${r.modelId} ${r.quant} (${(r.bytes / 1e9).toFixed(1)} GB) — revision unknown, it will be re-downloaded\n`);
      else if (r.error) pushLog(`[llama] could not remove unversioned ${r.modelId} ${r.quant}: ${r.error}\n`);
    }
    let freed = 0;
    for (const r of sweepSuperseded()) {
      if (r.removed) { freed++; pushLog(`[llama] reclaimed (${r.why}): ${path.basename(r.dir)}\n`); }
    }
    if (freed) pushLog(`[llama] storage maintenance: ${freed} superseded item(s) removed\n`);
  } catch (e) {
    pushLog(`[llama] storage maintenance skipped: ${e?.message ?? e}\n`);
  }
}

// ── Hardware / recommendation ──────────────────────────────────────────────
/** Coarse detection (before install, wizard step 0/1): hardware + available memory + CUDA availability + whether the minimum threshold is met. */
export function getHardware() {
  migrateLegacyLayout(); // on first launch with the new layout, move legacy models/bin/logs into the dedicated folder (same-disk rename, sub-second)
  runStorageMaintenance();
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

/**
 * llama runtime info: version / installed versions / whether updatable / directory.
 *
 * "The version" is llamaVersionDir(), NOT LLAMA_VERSION. They differ on macOS, which runs the fork tag (mac-v1) while
 * LLAMA_VERSION is the upstream build the CDN serves to Windows. Comparing the installed directory against LLAMA_VERSION there
 * meant `["mac-v1"].includes("b9946")` — false forever, so the UI showed a permanent "new version b9946 available (mac-v1
 * installed)" badge offering to replace the fork with a build that has none of the KV disk, seed or MoE-pool flags.
 */
export function llamaInfo() {
  const versions = installedLlamaVersions();
  const want = llamaVersionDir();
  const upToDate = versions.includes(want);
  let variant = state.installedVariant || null;
  if (!variant && upToDate) { // when state is not yet populated, find the installed variant of the current version from disk
    try { variant = fs.readdirSync(path.join(llamaRootDir(), want)).find((v) => !!installedBin(v)) || null; } catch { /* ignore */ }
  }
  return {
    version: want,
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
  const hw = detectHardware();
  const fit = computeFit(model, { bpw }, ctx, kvBits, vision, moePoolInfo(model.id));
  // MTP standalone drafter (Gemma, ~hundred MB resident); Qwen's built-in MTP head is already counted in the weights, so extra overhead is ignored.
  const mtpGB = opts.mtp !== false && model.mtp && !model.mtpEmbedded ? 0.2 : 0;
  const round1 = (n) => Math.round(n * 10) / 10;
  // Which context rungs this machine can actually hold, decided HERE rather than in the renderer. The UI used to
  // filter on `ctx <= maxCtx` alone, which offers 256K on a model+machine where it overruns the memory budget -
  // and picking it produced a launch that thrashed rather than an error. Sized against the pool FLOOR, the
  // cheapest configuration moeNativePlan can emit, so a rung marked fits is one the planner can always deliver.
  const budgetGB = usableModelMemoryGB(hw);
  // Rung eligibility is decided at the pool FLOOR - the cheapest split moeNativePlan can emit - so a rung marked
  // fits is one the planner can always deliver. totalGB on each rung is that same floor cost, which is the useful
  // number for a DISABLED rung: "even at its minimum this needs X".
  const rungs = CTX_LADDER.filter((c) => c <= (model.maxCtx || MIN_CTX)).sort((a, b) => a - b).map((c) => {
    const t = computeFit(model, { bpw }, c, kvBits, vision, moePoolInfo(model.id)).totalGB + mtpGB;
    return { ctx: c, totalGB: round1(t), fits: t <= budgetGB };
  });
  // The headline figure is what will ACTUALLY be allocated, not the floor. The planner spends its way up to the
  // budget - promoting layers to native and then widening slots - so on a 36 GB host the floor reads 13.2 GB
  // while the launch allocates 25.1 GB with 32 of 41 layers native. Reporting the floor here understated the
  // real footprint by ~12 GB and made the pool look far cheaper than it is.
  const prof = moeShippedProfile(model.id);
  const plan = prof && moeNativePlan(model, prof, {
    bpw, budgetGB, ctx, kvBits, vision,
    ringLayers: MOE_RING_LAYERS, parallel: MOE_PARALLEL, nExpertUsed: MOE_EXPERT_USED,
  });
  const totalGB = round1((plan ? plan.totalGB : fit.totalGB) + mtpGB);
  return { totalGB, floorGB: round1(fit.totalGB + mtpGB), weightGB: fit.weightGB, kvGB: fit.kvGB, budgetGB, rungs };
}

/** Auxiliary files (not counted as main weights): mmproj vision projector, MTP drafter (mtp-*.gguf or *-MTP.gguf). */
const isAuxFile = (f) => /mmproj/i.test(f) || /^mtp-/i.test(f) || /-mtp\.gguf$/i.test(f);
/**
 * Standalone chat-template file in a model directory, in priority order (mirrors hfDownload's repo-side matcher):
 * chat_template.jinja, then any *.jinja, then a bare `template`. Detected on every launch rather than trusted from the
 * manifest, so dropping a corrected template into the model folder by hand takes effect on the next start — the
 * intended escape hatch for a GGUF whose embedded template breaks --jinja's tool-parser generation.
 */
const TEMPLATE_MATCHERS = [
  (f) => /^chat_template\.jinja$/i.test(f),
  (f) => /^.+\.jinja$/i.test(f),
  (f) => /^template$/i.test(f),
];
const findTemplateFile = (files) => {
  for (const match of TEMPLATE_MATCHERS) { const hit = files.find(match); if (hit) return hit; }
  return null;
};

/** Classify the ready (final names, not .part) model files in a directory. */
function localModelFiles(dir, prefer = null) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { weights: [], mmproj: null, mtp: null, template: null, hasPart: false }; }
  return {
    weights: files.filter((f) => /\.gguf$/i.test(f) && !isAuxFile(f)).sort(),
    // `prefer` (MODELS[].mmprojFile) wins when the repo ships more than one projector, because
    // find() returns whichever readdir happened to list first - a silent choice between files that
    // differ in size and precision. prism-ml/Ternary-Bonsai-27B-gguf ships mmproj-BF16 (931 MB) and
    // mmproj-Q8_0 (629 MB); its README recommends the Q8_0, and 300 MB is real on a 16 GB machine.
    // Falls back to the scan, so a repo with one projector needs no descriptor field.
    mmproj: (prefer && files.includes(prefer) ? prefer : files.find((f) => /mmproj.*\.gguf$/i.test(f))) || null,
    mtp: files.find((f) => /^mtp-.*\.gguf$/i.test(f) || /-mtp\.gguf$/i.test(f)) || null,
    template: findTemplateFile(files),
    hasPart: files.some((f) => /\.part$/i.test(f)),
  };
}
/** Whether a model's quantization is "fully installed": main weights complete, no .part, and mmproj present when the model has vision.
 *  The MTP drafter is treated as an optional accelerator (not counted toward "complete"): when missing, fetch on demand before startup (~hundred MB), to avoid "un-installing" an already installed model. */
/**
 * Where a model's weights live: `models/<repo_>/<revision8>/<quant>/`.
 *
 * Version is the OUTER directory on purpose — retiring a model version is then one `rm -rf` covering every quant of it, rather
 * than hunting a version folder under each quant separately. Revision and quant are independent axes: one repo revision ships
 * many quants, so the revision does not tell you which file you took.
 *
 * Models with no pinned revision (community downloads) keep the flat `<repo_>/<quant>/` layout — there is no version to key on.
 */

/**
 * Delete pre-versioning installs: `<repo_>/<quant>/` with weights directly inside.
 *
 * Deleted, not moved. A flat directory was downloaded tracking `main`, and what `main` pointed at that day is recorded nowhere —
 * so its revision is unknown, and there is no cheap way to find out. Renaming it into `<rev8>/` would be a claim about the bytes
 * that nothing checked, and the directory name would then become the only evidence for it. That was the previous behaviour and it
 * was wrong: on a real install it labelled three of four models with a revision they were not.
 *
 * So the choice is between an unverified label and a re-download, and the re-download wins. It costs bandwidth once; a wrong
 * label costs a model that silently never matches its published seed, with nothing anywhere to say why.
 *
 * Only catalog models with a pinned revision — a community download has no pin to be wrong about, so it keeps its flat path.
 *
 * `dryRun` returns the plan without touching anything. Returns [{ modelId, quant, dir, bytes, removed, error }].
 */
export function deleteUnversionedModelDirs({ dryRun = false } = {}) {
  const base = modelsDir();
  const out = [];
  let repoDirs = [];
  try { repoDirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const rd of repoDirs) {
    const model = MODELS.find((m) => m.hf && m.hf.replace(/\//g, "_") === rd.name);
    if (!model?.revision) continue;
    let children = [];
    try { children = fs.readdirSync(path.join(base, rd.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const c of children) {
      if (/^[0-9a-f]{8}$/.test(c.name)) continue; // a version dir, not the old layout
      const dir = path.join(base, rd.name, c.name);
      if (!localModelFiles(dir).weights.length) continue; // not a quant dir holding weights
      const rec = { modelId: model.id, quant: c.name, dir, bytes: dirBytes(dir), removed: false, error: null };
      if (!dryRun) {
        try { fs.rmSync(dir, { recursive: true, force: true }); rec.removed = true; } catch (e) { rec.error = e.message; }
      }
      out.push(rec);
    }
  }
  return out;
}

/** Total size of the files directly inside a directory. Used only to report how much a delete reclaims. */
function dirBytes(dir) {
  try {
    return fs.readdirSync(dir).reduce((n, f) => {
      try { const s = fs.statSync(path.join(dir, f)); return n + (s.isFile() ? s.size : 0); } catch { return n; }
    }, 0);
  } catch { return 0; }
}

/**
 * Reclaim what a version bump superseded: old model versions, and the seeds that belonged to them.
 *
 * Run after the catalog's pins change. Two sweeps, kept together because they retire for the same reason — a model version bump
 * invalidates both the weights directory AND every seed keyed on that revision.
 *
 * Models: any `<repo_>/<rev8>/` that is not the current pin. Safe to delete outright — unlike the legacy layout, a version dir
 * says exactly which revision it is, so there is no ambiguity about what is being removed.
 *
 * Seeds: the marker files record `<model>-<mode>` and the key they installed, and the key embeds `r<rev8>`. A marker whose
 * revision is not the current pin means those KV units can never be borrowed again. The unit directory is keyed by model_key
 * rather than revision, so it is removed via the marker rather than by name.
 */
export function sweepSuperseded({ dryRun = false } = {}) {
  const removed = [];
  const rm = (dir, why, extra) => {
    const rec = { dir, why, ...extra, removed: false, error: null };
    if (!dryRun) {
      try { fs.rmSync(dir, { recursive: true, force: true }); rec.removed = true; } catch (e) { rec.error = e.message; }
    }
    removed.push(rec);
  };

  const base = modelsDir();
  let repoDirs = [];
  try { repoDirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { repoDirs = []; }
  for (const rd of repoDirs) {
    const model = MODELS.find((m) => m.hf && m.hf.replace(/\//g, "_") === rd.name);
    if (!model?.revision) continue;
    const want = String(model.revision).slice(0, 8);
    let vers = [];
    try { vers = fs.readdirSync(path.join(base, rd.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const v of vers) {
      if (!/^[0-9a-f]{8}$/.test(v.name) || v.name === want) continue;
      rm(path.join(base, rd.name, v.name), "superseded model version", { modelId: model.id, version: v.name, wanted: want });
    }
  }

  const kv = kvDiskDir();
  let entries = [];
  try { entries = fs.readdirSync(kv); } catch { entries = []; }
  const liveKeys = new Set();
  // Every seed we would install today is live; anything else in the directory belongs to a prefix, revision or KV quantisation
  // that is no longer used. Iterating KV_BITS_OFFERED rather than the running launch's setting matters — a user who switches
  // quantisation and back must not have the first seed swept while the second is in use.
  for (const m of MODELS) {
    if (!seedAvailable(m.id)) continue;
    for (const mode of ["daily", "dev"]) {
      if (!SEED_PREFIX?.[mode]) continue;
      for (const kvBits of KV_BITS_OFFERED) {
        liveKeys.add(`.seed-${m.id}-${mode}-${seedKey({ prefixHash: SEED_PREFIX[mode], revision: m.revision, kvdVersion: SEED_KVD, kvBits })}`);
      }
    }
  }
  for (const e of entries) {
    if (!e.startsWith(".seed-") || liveKeys.has(e)) continue;
    // The marker's body is the model_key directory it installed; remove that, then the marker.
    let unitDir = null;
    try { unitDir = fs.readFileSync(path.join(kv, e), "utf8").trim(); } catch { /* unreadable marker */ }
    if (unitDir && /^\d+$/.test(unitDir)) rm(path.join(kv, unitDir), "seed for a superseded prefix or model version", { marker: e });
    rm(path.join(kv, e), "stale seed marker", { marker: e });
  }
  return removed;
}

export function modelQuantDir(model, quant) {
  const repo = (model.hf || model.repo || "").replace(/\//g, "_");
  const rev = model.revision ? String(model.revision).slice(0, 8) : null;
  return rev ? path.join(modelsDir(), repo, rev, quant) : path.join(modelsDir(), repo, quant);
}

function isModelInstalled(model, quant) {
  const dir = modelQuantDir(model, quant);
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
    // A catalog model's repo dir now holds <revision8>/<quant>/; the flat <quant>/ shape is a pre-versioning install. Expand one
    // level where a version dir is present so both layouts list correctly during the transition.
    const expanded = [];
    for (const d of quantDirs) {
      const inner = path.join(base, rd.name, d.name);
      const sub = (() => { try { return fs.readdirSync(inner, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch { return []; } })();
      const isVersionDir = /^[0-9a-f]{8}$/.test(d.name) && sub.length > 0;
      if (isVersionDir) for (const q of sub) expanded.push({ name: q.name, rel: path.join(d.name, q.name), version: d.name });
      else expanded.push({ name: d.name, rel: d.name, version: null });
    }
    for (const qd of expanded) {
      const dir = path.join(base, rd.name, qd.rel);
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
        // Native window of an already-installed model (persisted GGUF header, else the catalog entry). Models downloaded
        // before the 32K floor existed can still be sitting on disk, so the Installed tab must refuse to start them too.
        // Unknown window => not flagged, same fail-open rule as search.
        belowMinCtx: (() => { const c = manifest?.gguf?.context_length || catalogModel?.maxCtx || 0; return !!c && c < MIN_CTX; })(),
        chatTemplate: manifest?.chatTemplate || null, // persisted built-in template override (from a prior auto-fallback or manual choice)
        // Standalone Jinja template present on disk; when set it outranks the built-in override above at launch.
        chatTemplateFile: f.template ? path.join(dir, f.template) : null,
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
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // Then the now-empty `<rev8>/`, and the `<repo_>/` above it. NOT the version directory outright: one version can hold
    // several quants, they are separate rows in the model list, and deleting one must not take the others. A `.DS_Store` does
    // not count as content — macOS writes one the moment Finder looks at the folder, which would keep every husk alive.
    for (let p = path.dirname(path.resolve(dir)); p.startsWith(path.resolve(base) + path.sep); p = path.dirname(p)) {
      if (fs.readdirSync(p).some((e) => e !== ".DS_Store")) break;
      fs.rmSync(p, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** The build variant selected per useCuda and whether it is installed (wizard step 1: show "install / installed", to avoid re-downloading). */
export function installInfo(opts = {}) {
  const hw = detectHardware();
  const variant = llamaVariant(hw, { preferCuda: !!opts.useCuda });
  return { variant, installed: !!installedBin(variant), version: llamaVersionDir() };
}

/** Install status of the two candidate variants, with / without CUDA, so the wizard defaults to the "installed" one (to avoid a redundant download). Version follows llamaVersionDir() (the mac fork tag on darwin, the CDN pin elsewhere); an upgrade counts as not installed. */
export function installStatus() {
  const hw = detectHardware();
  const cuda = detectCuda();
  const noCuda = llamaVariant(hw, { preferCuda: false });
  const withCuda = cuda.available ? llamaVariant(hw, { preferCuda: true }) : null;
  const variants = [{ useCuda: false, variant: noCuda, installed: !!installedBin(noCuda) }];
  if (withCuda && withCuda !== noCuda) variants.push({ useCuda: true, variant: withCuda, installed: !!installedBin(withCuda) });
  return { version: llamaVersionDir(), cuda, variants };
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
  return recommendModels(hw, budget, { ctx: opts.ctx || 16384, vision: opts.vision !== false, pools: moePools() });
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
    // Sub-32K models are filtered out of search, but a repo can still be opened directly (or its header may only be
    // parsed at detail time) — flag it so the dialog can refuse the download. Unknown window => not flagged (fail open).
    const ctx = d.gguf?.context_length || null;
    return { ok: true, ...d, arch, compat: arch ? (SUPPORTED_ARCHS.has(arch) ? "supported" : "unsupported") : "unknown", belowMinCtx: !!ctx && ctx < MIN_CTX, minCtx: MIN_CTX };
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
  const quantId = opts.quantId || autoQuantId(model, hw, Number(opts.ctx || MIN_CTX));
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
  // Authoritative 32K floor: this is the one chokepoint every start flows through (Recommended / Installed / Browse /
  // restore-on-restart), so a model whose native window is too small can never be *used*, not merely not downloaded.
  // maxCtx is the model's own window (catalog entry, or descriptorFromGguf for community repos, which defaults to
  // MIN_CTX when HF has no header) — so an unknown window passes, matching the fail-open rule used in search.
  if (r.model && r.model.maxCtx && r.model.maxCtx < MIN_CTX) {
    state.phase = "error";
    state.error = `Model context window (${r.model.maxCtx}) is below the ${MIN_CTX} minimum`;
    emit();
    return status();
  }

  const visionOn = r.vision && opts.vision !== false; // true only when the model supports vision and the toggle is not off
  // What the SIZING should charge for vision, which is no longer the same question as whether vision
  // is on. The mac fork releases the projector at startup and reloads it only around an actual image
  // (see MMPROJ-LAZY in tools/server/server-context.cpp), so its ~1.1 GB is not resident during the
  // text turns that are almost all of them - charging VISION_OVERHEAD_GB permanently would reserve
  // memory nothing is holding, and on a 24 GB Mac that reservation costs five native MoE layers.
  //
  // Measured on a simulated 24 GB Mac, qwen3.6-35B UD-Q4_K_XL, interleaved arms:
  //     charged   (16 native, projector resident)   prefill 225.8   decode 14.75
  //     released  (21 native, projector released)   prefill 260.9   decode 18.75
  //
  // The honest cost: an image request brings the projector back on top of a plan sized without it, so
  // the peak while encoding is ~1.1 GB above the steady state - about 20.0 GB of 24, leaving ~4 GB for
  // the OS and the app. That is the bottom of the 4-8 GB reserve, not a breach of it, and it lasts
  // only for the encode. Set this to visionOn to go back to charging for it permanently.
  //
  // Gated on running the fork, using the same test llamaVersionDir does: every other platform is on
  // the CDN's upstream build, which holds the projector for the whole session and must still be
  // charged for it.
  const forkLlama = process.platform === "darwin" && !!MAC_LLAMA_TAG;
  const visionCharged = visionOn && !forkLlama;
  const mtpOn = !!r.mtp && opts.mtp !== false;  // MTP speculative decoding (model supports it and the toggle is not off, on by default)
  // Context / KV quantization auto-tiering: when not explicitly specified, pick the largest -c that fits per "model + quantization + device memory"
  // (capped at the native window), at one of the offered KV quantizations (see localModels.pickCtxKv).
  // The fallback for a custom -hf model with no catalog entry is 16K at the first offered quantization, NOT a hardcoded one — a
  // launch that quietly runs at a quantization we publish no seed for would take a cold prefill with nothing to explain it.
  const pick = !opts.ctx && r.model ? pickCtxKv(r.model, r.bpw, hw, usableModelMemoryGB(hw), visionCharged, moePoolInfo(r.model.id)) : null;
  const ctx = Number(opts.ctx || (pick ? pick.ctx : 16384));
  const kvBits = Number(opts.kvBits || (pick ? pick.kvBits : KV_BITS_OFFERED[0]));
  state.port = Number(opts.port || 0); // 0 = request a random free port from the kernel inside launch
  state.ctx = ctx;
  // Uniform layout: <repo_>/<rev8>/<quant>/. A catalog model uses its pinned revision; a community model uses whatever `main`
  // resolved to when it was fetched, so its provenance is recoverable too. Resolution is async, so it is filled in below.
  let modelRevision = MODELS.find((m) => m.id === r.id)?.revision || null;
  let modelDir = r.repo && r.quant ? modelQuantDir({ hf: r.repo, revision: modelRevision }, r.quant) : null;
  state.model = { hf: r.hf, label: r.label, multimodal: visionOn, id: r.id, name: r.name, ctx, dir: modelDir, repo: r.repo || null, quant: r.quant || null, chatTemplate: r.chatTemplate || null }; // ctx = the -c at startup, used by the renderer as the model's real context window; dir/repo/quant let the model library match "running"; chatTemplate = optional built-in template override
  state.ready = false;
  state.error = null;
  state.log = [];
  state.pct = 0;
  // mac only — the Windows binary has no --kv-disk-path, so it should never even get a directory.
  try { if (kvTierEnabled()) fs.mkdirSync(kvDiskDir(), { recursive: true }); } catch { /* ignore */ }

  // Prefer reusing the variant installed in wizard step 1; otherwise choose now per useCuda (launch will ensure it is installed).
  const variant = state.installedVariant || llamaVariant(hw, { preferCuda: !!opts.useCuda });
  const gen = ++launchGen; // this startup's generation id; checked after awaits inside launch, abandon spawn if stale
  launch(variant, { r, hw, ctx, kvBits, visionOn, visionCharged, mtpOn, gen, modelDir, modelRevision });
  emit();
  return status();
}

/** Install (download if needed) the given variant -> bring up llama-server; if a GPU build fails before ready, automatically fall back to the next level (the CPU variant has no fallback, so no infinite recursion). */
async function launch(variant, cfg) {
  // visionOn decides what the SERVER does (whether --mmproj is passed at all); visionCharged decides
  // what the memory plan RESERVES. They differ on the mac fork, which releases the projector between
  // images - see where visionCharged is derived.
  const { r, hw, ctx, kvBits = KV_BITS_OFFERED[0], visionOn, visionCharged = visionOn, mtpOn, gen } = cfg;
  // Computed in start() from the catalog pin, and carried in cfg — NOT closed over, because start() and launch() are separate
  // functions and a fallback retry re-enters launch() with the same cfg. `let`: a community model has no pin, so the branch
  // below resolves `main` and reassigns both. The reassignment does not need to travel back to start(); what the UI reads is
  // state.model.dir, which that branch updates directly.
  let { modelDir = null, modelRevision = null } = cfg;
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
  let modelPath = null, mmprojPath = null, mtpPath = null, templatePath = null;
  if (r.repo && r.quant) {
    // Versioned path, matching isModelInstalled. Reassigned after the revision is resolved for a community model, which is why
    // it is `let` — a flat destDir here would write the download to the pre-migration location.
    let destDir = modelDir || path.join(modelsDir, r.repo.replace(/\//g, "_"), r.quant);
    const local = localModelFiles(destDir, r.model?.mmprojFile || null);
    // Seed planning sits OUTSIDE the download branch on purpose. A seed download that was paused leaves a .part with the weights
    // already complete, so the next launch takes the "already installed" path — and if the seed work lived only in the download
    // branch, that partial could never resume. Weights complete does not mean seeds complete.
    //
    // Sizes come from a HEAD up front so the bar can be weighted by total bytes rather than sweeping 0-100 per file; a seed that
    // is already installed, or whose size is unknown, contributes 0 and the bar simply reflects the rest.
    //
    // Seeds are optional. The disk tier runs for every model on mac with or without one — a model with no published seed just
    // starts cold and warms up as the user talks. seedAvailable is therefore only about whether there is an asset to fetch.
    const seedPlan = [];
    for (const sm of seedAvailable(r.id) ? ["daily", "dev"] : []) {
      if (!SEED_PREFIX?.[sm]) continue;
      // kvBits is part of the seed's identity, so the seed fetched is the one for the quantisation THIS launch will run at.
      const spec = { endpoint: hfEnd, modelId: r.id, mode: sm, prefixHash: SEED_PREFIX[sm],
        revision: MODELS.find((m) => m.id === r.id)?.revision, kvdVersion: SEED_KVD, kvBits };
      if (seedInstalled(kvDiskDir(), `${r.id}-${sm}`, seedKey(spec))) continue;
      seedPlan.push({ spec, bytes: await seedSize(spec) });
    }
    // Its own controller: the download's is scoped to the branch below and cleared when that finishes, but a seed pass can run
    // with no download at all (weights already present) and still has to be stoppable.
    const ac0 = new AbortController();
    state.dlAbort = ac0;
    const seedTotal = seedPlan.reduce((n, x) => n + x.bytes, 0);
    let seedDone = 0, comboLast = -1, modelBytes = 0;
    const combo = (modelDone, modelTotal, thisSeedDone) => {
      const total = modelTotal + seedTotal;
      if (!total) return;
      const p = Math.min(100, Math.floor(((modelDone + seedDone + thisSeedDone) / total) * 100));
      if (p !== comboLast) { comboLast = p; state.pct = p; emit(); }
    };
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
        // A community model has no pin, so resolve the ref it is about to fetch and use that as its version directory. Failure
        // just means the flat path, which is what it had before — not worth blocking a download over.
        if (!modelRevision && r.repo) {
          modelRevision = await resolveRevision(hfEnd, r.repo, "main");
          if (modelRevision) { modelDir = modelQuantDir({ hf: r.repo, revision: modelRevision }, r.quant); destDir = modelDir; state.model.dir = modelDir; }
        }
        state.phase = "fetching"; state.pct = 0; emit();
        // Always download mmproj (when the model has vision) and the standalone MTP drafter (Gemma), so the runtime can freely toggle vision/MTP without re-downloading;
        // when an installed model is only missing the drafter, downloadModel skips the existing weights/vision projector and fetches only the drafter. Qwen has a built-in MTP (no standalone file).
        const out = await downloadModel(
          // manifest: identifies the directory for listDownloaded (community models keep their gguf header for restarts, see descriptorFromGguf).
          // revision: catalog models on the KV tier pin an exact commit — a seed is only valid for the GGUF it was built against,
          // and the chat template lives inside that file. Community/non-catalog downloads keep tracking main.
          // draft: a speculative drafter kept in a repo of ours rather than the model's (bonsai). Fetched
          // on the same pass and counted in the same progress total, for the same reason the MTP drafter
          // is: toggling speculation off and on must not trigger a second download.
          { endpoint: hfEnd, repo: r.repo, quant: r.quant, vision: !!r.vision, mtp: mtpSeparate, destDir,
            draft: MODELS.find((m) => m.id === r.id)?.draft || null,
            revision: modelRevision || "main",
            manifest: { name: r.name, modelId: r.id, gguf: r.meta || null, revision: MODELS.find((m) => m.id === r.id)?.revision || null } },
          (pct, b) => { if (b) { modelBytes = b.total; combo(b.done, b.total, 0); } },
          ac.signal,
        );
        modelPath = out.modelPath; mmprojPath = out.mmprojPath; mtpPath = out.mtpPath || null;
        const draftDl = out.draftPath || null;
        pushLog(`[llama] model ready: ${path.basename(modelPath)}${mmprojPath ? ` + ${path.basename(mmprojPath)}` : ""}${mtpPath ? ` + ${path.basename(mtpPath)}` : ""}${draftDl ? ` + ${path.basename(draftDl)}` : ""}\n`);
      } catch (e) {
        if (ac.signal.aborted) { pushLog("[llama] model download cancelled\n"); return; } // user stop: do not bring up the service
        // Do not fall back to -hf (would land in the HF cache layout, uncontrollable): a self-download failure is an error.
        state.phase = "error"; state.error = `Model download failed: ${String(e?.message ?? e)}`; pushLog(`[llama] model download failed: ${String(e?.message ?? e)}\n`); emit(); return;
      } finally {
        if (state.dlAbort === ac) state.dlAbort = null;
      }
    }

    // Seeds, after the branch above so they run whether or not the weights were fetched this launch. Must land before
    // llama-server starts: the startup scan is what makes a seed resident, so one installed afterwards does nothing until the
    // next restart. Aborting is a pause, not a failure — the .part survives and the next attempt resumes from it.
    //
    // The phase has to be announced here, not only in the download branch above. "fetching" is what makes the model card show a
    // percentage and a progress bar; when the weights are already present the launch is otherwise still in "loading", which
    // renders as a bare spinner — so a few hundred MB of seed would download with nothing on screen moving. The spawn below
    // sets the phase back to "loading".
    // Phase only — never the percentage. combo() spans weights AND seeds as ONE bar, so the model download already left it at
    // ~97% (the seeds are the remaining few percent). Zeroing here sent it 97 -> 0 -> 97 -> 100. On the already-installed path
    // there is nothing to preserve: pct is still 0 from the top of launch(), and combo() then drives 0 -> 100 over the seeds.
    if (seedPlan.length) { state.phase = "fetching"; emit(); }
    for (const { spec, bytes } of seedPlan) {
      if (ac0.signal.aborted) break;
      const status = await ensureSeed({
        ...spec, kvDiskDir: kvDiskDir(), onLog: pushLog, signal: ac0.signal,
        onProgress: (pct) => combo(modelBytes, modelBytes, Math.floor((pct / 100) * bytes)),
      });
      seedDone += bytes;
      pushLog(`[seed] ${spec.mode}: ${status}\n`);
    }
    if (state.dlAbort === ac0) state.dlAbort = null;
    // Resolved after both branches by re-scanning the directory, so it picks up a template that was just downloaded and
    // one the user dropped in by hand since the last launch alike (see findTemplateFile for the priority order).
    const tpl = localModelFiles(destDir).template;
    templatePath = tpl ? path.join(destDir, tpl) : null;
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
  // DSpark drafter: a separate file like Gemma's MTP one, but from a repo of ours and with its own
  // --spec-type. It rides the same UI toggle as MTP - to a user "speculative decoding" is one switch,
  // and a model has at most one drafter - and degrades the same way: file missing => no flags, stock
  // decode, never a startup error. The path is resolved from the model directory rather than kept from
  // the download, so an already-installed model gets it on a later launch without re-downloading.
  const draftSpec = r.model?.draft || null;
  let specDraft = null;
  if (draftSpec && mtpOn) {
    const p = path.join(path.dirname(modelPath), path.basename(draftSpec.path));
    if (fs.existsSync(p)) specDraft = { ...draftSpec, path: p };
    else pushLog(`[llama] ${draftSpec.type} drafter not found (${path.basename(draftSpec.path)}), speculative decoding not enabled this time\n`);
  }
  if (specDraft) pushLog(`[llama] ${specDraft.type} drafter: ${path.basename(specDraft.path)} (n_max ${specDraft.nMax}, p_min ${specDraft.pMin})\n`);
  // macOS installs the fork build from GitHub (see llamaInstaller.macForkAsset), so these flags are always supported there;
  // kvTierEnabled is exactly the darwin check. Every model gets the tier — the server content-addresses the KV layout into its
  // own model_key and files units under <dir>/<model_key>/, so an unknown GGUF cannot collide with another model's units.
  const kvTier = kvTierEnabled();
  // MoE expert pool: enabled by pointing LLAMA_MOE_POOL_PROFILE at a per-model routing profile. MoE models on mac only, and only
  // when the profile is actually present — without one the fork leaves the pool inert by design rather than pinning blind
  // index-order experts, so a missing file degrades to stock speed instead of degrading output.
  const moeProfile = moeProfileFor(r.model, { hw, bpw: r.bpw, ctx, kvBits, vision: visionCharged, log: pushLog });
  const moeOn = !!moeProfile;
  const args = buildServerArgs({ modelPath, mmproj: visionOn ? mmprojPath : null, mtpDraft, specMtp: useMtp, specDraft, hw, ctx, port: state.port, kvBits, kvDiskDir: kvTier ? kvDiskDir() : null, parallel: kvTier ? 2 : 0, ngl, chatTemplate: r.chatTemplate, chatTemplateFile: templatePath, reasoningBudget: r.model?.reasoningBudget ?? null, reasoningBudgetMessage: r.model?.reasoningBudgetMessage ?? null });
  if (templatePath) pushLog(`[llama] chat template file: ${path.basename(templatePath)}${r.chatTemplate ? ` (overrides the "${r.chatTemplate}" built-in)` : ""}\n`);
  else if (r.chatTemplate) pushLog(`[llama] chat template override: ${r.chatTemplate}\n`);
  pushLog(`[llama] argv: ${bin} ${args.join(" ")}\n`); // full startup command (for troubleshooting)
  let proc;
  try {
    // LLAMA_MOE_RING travels WITH the profile, never without it. The pool keeps expert weights file-backed instead of wiring
    // the whole GGUF, which is what makes a 22 GB model fit next to everything else — but it fills the pool on demand, and
    // with nothing streaming the prefill path that first fill is enormous. The ring streams whole layers through rotating
    // buffers and is the prefill half of the same design; the fork ships it off by default, so the app was running the pool's
    // memory cost with none of its prefill mitigation.
    //
    // Measured cold (purged page cache), Qwen3.6-35B-A3B, 8373-token prompt, first request after start:
    //
    //     pool only     227.9 s / 184.6 s      36.9 / 45.5 t/s     <- what shipped
    //     pool + ring    21.0 s                406.4 t/s
    //     no pool        16.9 s                502.7 t/s           (but wires all ~22 GB)
    //
    // The ring recovers ~81% of the fully-wired prefill speed and costs one slow request per server start instead of a
    // pathological one. Only the FIRST request is affected either way — later ones hit a warm pool and were always fast.
    //
    // GGML_METAL_SEG_ASYNC and GGML_METAL_NO_RESIDENCY travel with the pool for the same reason the ring does — every
    // published pool measurement, and every byte-identity run against upstream, set all four. Both are read by PRESENCE
    // and both are OFF by default, so omitting them silently ran a configuration that was never benchmarked:
    //   SEG_ASYNC     encode+commit all segments up front, gated on an MTLSharedEvent, instead of commit+wait per
    //                 segment. Qwen3.6-35B-A3B is 41 segments per forward, so without it every token pays 41 GPU
    //                 round trips.
    //   NO_RESIDENCY  see MOE_NO_RESIDENCY - a one-line toggle, currently off.
    // LLAMA_MOE_SMALL_PREFILL: feed a prefill of <= N tokens through the pool in decode-shaped graphs instead of
    // handing it to the ring. The ring stages EVERY expert of a layer per forward — a flat cost that a short
    // prefill cannot amortise — so a 30-token follow-up paid the same as a 500-token one. Measured in this app,
    // Qwen3.6-35B-A3B, 30-token turn: 23831 ms -> 2222 ms.
    //
    // 64 rather than the fork's default of 32. The default was measured on a WARM standalone server, where a ring
    // forward costs ~1-4 s and break-even sits near 32; under the app the weights do not stay in page cache, a ring
    // forward costs ~8-12 s, and the pool wins far further out. Measured here, same conversation, same prompts:
    //
    //   prefill    pool (this path)        ring
    //     27 tok     2215 ms  (82 ms/tok)    23831 ms      <- pool wins by 10x
    //     31 tok     2342 ms  (76 ms/tok)
    //    235 tok    26229 ms (112 ms/tok)    12149 ms      <- ring wins by 2.2x
    //    297 tok         -                    6873 ms
    //
    // The pool's per-token cost RISES with N here (76 -> 112 ms), so break-even lands at ~98-143 tokens. 256 was
    // tried and made the 235-token first turn 2.2x slower. 96 sits below the bottom of that range: being under
    // break-even only forgoes a little, being over it costs double.
    //
    // SET TO 0 - OFF. The table above is kept because it was true when measured, and it is now OBSOLETE: it was
    // taken on a profile with 1 native layer and 40 pooled. The ring's cost is flat PER POOLED LAYER, so once
    // host-ptr aliasing (the model file is mapped, not copied) and the corrected kvGB freed memory for native
    // layers, that cost collapsed. Re-measured on Qwen3.6-35B-A3B, 32-token turn, profiles derived by
    // moeNativePlan for each machine, prefill t/s:
    //
    //   pooled layers    split OFF (ring)    split ON (pool)
    //     40 (old)             6.9               17.7      <- the table above: pool wins 2.6x
    //     27 (16 GB)          57.4               23.7      <- pool now LOSES 2.4x
    //     23 (24 GB)          71.7               25.5      <- loses 2.8x
    //      2 (39 GB)         121.2               30.9      <- loses 3.9x
    //
    // The ring tracks pooled-layer count (6.9 -> 121 t/s); the pool barely moves (17.7 -> 30.9). The crossover is
    // above 27 pooled layers, which moeNativePlan no longer produces on any machine the app supports.
    //
    // So 0 is both the correct and the fast setting. Correctness matters independently, because the split cannot
    // be byte-identical by construction: the pool only serves graphs up to pool_ubatch = (draft+1) x parallel = 6,
    // so routing a prefill through it means cutting it into 6-token graphs, and a different batch shape regroups
    // the attention reduction - on gemma-4-26B-A4B at q4_0 a 42-token prompt answers 816 bytes split against 790
    // unsplit, where 790 is upstream's. Widening the pool is no escape: the slot floor is
    // pool_ubatch x n_expert_used, so a pool wide enough for a 42-token graph needs 336 slots against n_expert
    // 128 - every expert resident, which is the pool's purpose gone.
    //
    // Revisit only if pooled-layer counts rise again (a much larger model, or a much smaller machine).
    // LLAMA_MOE_RING_LAYERS: ring buffers, and therefore prefetch depth — the fork derives depth as slots - 2,
    // since layer il-1 may still be executing while the host stages il+depth. 4 slots stages two layers ahead
    // instead of one, at the cost of one more full-expert buffer.
    //
    // Measured back to back on the 1658-token harness case (all byte-identical to upstream):
    //     native 5, slots 4   prefill 421.12   decode 23.98   wired 12113 MiB
    //     native 4, slots 4   prefill 424.82   decode 23.20   wired 11886 MiB
    //     native 4, slots 3   prefill 414.94   decode 22.99   wired 10341 MiB
    //     native 3, slots 3   prefill 413.05   decode 23.18   wired 10438 MiB
    // The spread between them is inside this machine's noise floor (2-4x on repeated identical requests), so
    // none of it separates the configurations - only the wired column is measured reliably, and slots 4 costs
    // ~1.5 GB over slots 3. Chosen deliberately rather than derived from those numbers.
    //
    // LLAMA_MOE_POOL_FILL_THREADS: expert-fill misses issued concurrently (fork default is now 16). A miss is
    // a page fault plus a memcpy through a file-backed mapping — latency, not bandwidth — so width hides it.
    // These threads BLOCK on I/O rather than compute, so an idle one costs a stack and a condvar wait; there
    // is no reason to be frugal with them.
    //
    // 8 -> 16. Swept on a simulated 24 GB Mac (19 native/22 pooled, 69 GiB of fill traffic per run):
    //
    //     threads     decode        fill time
    //        3       13.5 / 13.7   34.8 / 35.7 s
    //        4       16.7          29.3 s
    //        8       17.1 / 16.9   27.8 / 28.0 s
    //       16       17.7          29.5 s
    //
    // 16 is the ceiling the work can use: misses per dispatch top out at 16 (5% of dispatches have 0,
    // 83% have 1-8, 13% have 9-16, none more), so no dispatch can occupy more threads than that.
    //
    // 8 helps DECODE, not prefill, and that is the half that governs how the app feels: a prefill misses once
    // in a burst, but every decoded token routes fresh experts, so misses are continuous. Mean decode across
    // consecutive app runs: 14.8 -> 15.2 -> 16.0 -> 17.3 t/s, the last being this setting (with a 23.1 peak).
    // Small prefill was unchanged (27 tok 1946 -> 2091 ms, 31 tok 2198 -> 2167 ms, both inside a ~+-30% noise
    // floor), which is why judging this knob on prefill alone said "no effect" and was the wrong measurement.
    //
    // Confounded, not proven: those runs also differ in cache warmth and other env, so the trend is suggestive
    // rather than isolated. Kept because it costs NO memory — slot count and pool footprint are untouched, so
    // the 24 GB target is unaffected — and the evidence points one way.
    proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_ENDPOINT: hfEnd, LLAMA_CACHE: modelsDir, ...(moeOn ? moeEnv(moeProfile) : {}) },
    });
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
