/**
 * Wizard-side operations of the local llama-server (main process): hardware detection, runtime install (step 1), VRAM probe
 * (step 2), model sizing (estimate / recommend), runtime info, and Hub browsing for the Browse tab.
 *
 * Part of localServer.mjs, which re-exports the public names here.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  detectHardware, usableModelMemoryGB, recommend as recommendModels,
  MODELS, quantBpw, localSupported, MIN_LOCAL_MEM_GB, isSharedGpu, computeFit, descriptorFromGguf, MIN_CTX, moeNativePlan, ctxLadder,
} from "../localModels.mjs";
import { ensureInstalled, installedBin, llamaVariant, fallbackVariant, detectCuda, llamaVersionDir, installDir, llamaRootDir, installedLlamaVersions, migrateLegacyLayout } from "../llamaInstaller.mjs";
import { searchModels, repoDetail, TRUSTED_AUTHORS } from "../hfDownload.mjs";
import { SUPPORTED_ARCHS } from "../../versions.mjs";
import { state, umaCache, emit, status, pushLog, ensureLogFile, resolveHfEndpoint } from "./state.mjs";
import { runStorageMaintenance } from "./storage.mjs";
import { MOE_RING_LAYERS, MOE_PARALLEL, MOE_EXPERT_USED, moeShippedProfile, moePoolInfo, moePools } from "./moe.mjs";

// ── Hardware / recommendation ──────────────────────────────────────────────
/** Coarse detection (before install, wizard step 0/1): hardware + available memory + CUDA availability + whether the minimum threshold is met. */
export function getHardware() {
  migrateLegacyLayout(); // on first launch with the new layout, move legacy models/bin/logs into the dedicated folder (same-disk rename, sub-second)
  runStorageMaintenance();
  ensureLogFile();       // ensure the "run log" button can always open the log file under the current folder
  const hw = detectHardware();
  return { hw, cuda: detectCuda(), supported: localSupported(hw), minMemGB: MIN_LOCAL_MEM_GB };
}

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
  const rungs = ctxLadder(model).sort((a, b) => a - b).map((c) => {
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
export function parseUma(out) {
  const m = String(out).match(/ggml_vulkan:\s*\d+\s*=.*?\buma:\s*([01])/i);
  return m ? m[1] === "1" : null;
}
