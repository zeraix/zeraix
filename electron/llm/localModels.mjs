/**
 * Local model catalog + hardware-based recommendations + llama-server launch args (main process, pure logic, no side effects).
 *
 * Size is estimated as "parameter count × bits-per-weight (bpw)"; architecture dimensions (layers / KV heads / head dim) are approximate, used only to estimate the KV cache.
 * The catalog includes the Qwen3.6 flagship + Gemma 4 QAT (E4B/12B/26B-A4B, targeting low-end → mid-range); the UI also allows entering any `user/repo:QUANT` directly,
 * so this list is a recommendation, not a restriction. GGUF repo names / quant availability follow Hugging Face; please verify before shipping.
 */
import os from "node:os";
import { execSync } from "node:child_process";

const round = (n) => Math.round(n * 10) / 10;

// Quantization tiers: higher quality → larger size. bpw = effective bits per weight.
export const QUANTS = [
  { id: "Q8_0", bpw: 8.5, quality: 99, label: "Q8_0 · near-lossless" },
  { id: "Q6_K", bpw: 6.56, quality: 97, label: "Q6_K · very high" },
  { id: "Q5_K_M", bpw: 5.67, quality: 95, label: "Q5_K_M · high" },
  { id: "Q4_K_M", bpw: 4.85, quality: 90, label: "Q4_K_M · balanced (default)" },
  { id: "IQ4_XS", bpw: 4.25, quality: 87, label: "IQ4_XS · compact 4-bit" },
  { id: "Q3_K_M", bpw: 3.91, quality: 80, label: "Q3_K_M · small" },
  { id: "IQ3_M", bpw: 3.5, quality: 74, label: "IQ3_M · very small" },
  { id: "IQ2_M", bpw: 2.7, quality: 58, label: "IQ2_M · tiny (noticeable quality loss)" },
];

// Capability high → small. active = activated parameters (MoE); arch is only used to estimate KV.
export const MODELS = [
  {
    id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B", params: 35, active: 3, moe: true, vision: true, mtp: true, mtpEmbedded: true,
    // vision:true = this GGUF repo ships a vision projector (mmproj). At launch, explicitly pass --mmproj to load the same repo's vision projector (vision on, default);
    // if vision is off, pass --no-mmproj to skip it (saves ~1GB of resident memory, see VISION_OVERHEAD_GB). Whether an mmproj actually exists follows the HF repo.
    // mtpEmbedded:true = use unsloth's "-MTP-GGUF" repo: the MTP (multi-token prediction) head is embedded in the weights themselves (self-speculative, no separate drafter file),
    // and it also ships UD quants + mmproj. At launch, --spec-type draft-mtp enables self-speculative decoding (turning off vision/MTP only affects loading/toggles; the weights still come from this repo).
    hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", arch: { L: 48, kvH: 4, hd: 128 }, maxCtx: 262144,
    // unsloth ships only UD dynamic quants; pick a UD tag by device-memory tier (i.e. the :QUANT in -hf). memGB = total Mac unified memory / discrete-GPU VRAM.
    quantTiers: [
      { minMemGB: 31, quant: "UD-Q4_K_XL", bpw: 4.5 },
      { minMemGB: 23, quant: "UD-Q3_K_XL", bpw: 3.6 },
      // UD-Q2_K_XL (~14GB weights) leaves too little headroom for KV/context on a 16G machine, commented out for now; enable it if you need to barely run 35B on 16G.
      // { minMemGB: 16, quant: "UD-Q2_K_XL", bpw: 2.6 },
    ],
    notes: "MoE, ~3B active → fast decode, quality close to a large model. Multimodal + agentic coding."
  },
  // —— Gemma 4 QAT (quantization-aware training) series: 4-bit near bf16, unsloth UD GGUF built from the official QAT checkpoints.
  // Use only UD-Q4_K_XL (the QAT repos ship only Q2/Q4; Q2 loses quality noticeably so it is dropped). All three repos include a separate MTP drafter (MTP/mtp-*-Q4_0.gguf, ~hundreds of MB),
  // auto-downloaded alongside the main weights and enabling speculative decoding via -md + --spec-type draft-mtp (on by default, can be turned off in the UI). If the drafter is missing, it degrades to no speculation (does not block startup).
  // vision:true: all three repos bundle an mmproj (mmproj-F16.gguf etc.); at launch, explicitly pass --mmproj to load the vision projector; if you don't need vision, turn it off in the UI (saves ~1GB resident).
  {
    id: "gemma4-26b-a4b", name: "Gemma 4 26B-A4B", params: 26, active: 4, moe: true, vision: true, mtp: true,
    hf: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 18, quant: "UD-Q4_K_XL", bpw: 4.37 }, // 14.2 GB
    ],
    notes: "MoE ~4B active → fast decode, high quality. Multimodal (images only, no audio)."
  },
  {
    // mtp:true: dense 12B decoding is bandwidth-bound (reads ~6.7GB per token); speculative decoding gives ~1.5–2× speedup. The drafter (MTP/…-Q4_0-MTP.gguf,
    // ~254MB) is in the same repo as the main weights and is fetched alongside them during auto-download (hfDownload), then passed to llama-server via -md; not enabled on the -hf fallback path.
    id: "gemma4-12b", name: "Gemma 4 12B", params: 12, active: 12, moe: false, vision: true, mtp: true,
    hf: "unsloth/gemma-4-12B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 12, quant: "UD-Q4_K_XL", bpw: 4.48 }, // 6.72 GB
    ],
    notes: "Dense 12B, quality close to 26B-A4B. Multimodal (image/audio)."
  },
  {
    id: "gemma4-e4b", name: "Gemma 4 E4B", params: 8, active: 8, moe: false, vision: true, mtp: true,
    // ≈4.5B effective parameters (8B raw, MatFormer + Per-Layer Embeddings); top pick for low-end laptops (4–5GB is enough).
    // Native tool-calling tokens, well suited for agents. Q4_0 loses quality, so use UD-Q4_K_XL.
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF", arch: { L: 34, kvH: 4, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 131072,
    quantTiers: [
      { minMemGB: 8, quant: "UD-Q4_K_XL", bpw: 4.22 }, // 4.22 GB
    ],
    notes: "≈4.5B effective parameters. Native tool calling, QAT 4-bit near bf16. Multimodal (image/audio)."
  },
  // { id: "qwen3.6-27b", name: "Qwen3.6-27B", params: 27, active: 27, moe: false, vision: true, mtp: false,
  //   hf: "unsloth/Qwen3.6-27B-GGUF", arch: { L: 64, kvH: 8, hd: 128 },
  //   notes: "Dense 27B, highest quality but heavier compute (all params active → slower decode than A3B). Multimodal." },
  // { id: "qwen3-coder-30b-a3b", name: "Qwen3-Coder-30B-A3B", params: 30, active: 3, moe: true, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", arch: { L: 48, kvH: 4, hd: 128 },
  //   notes: "Text-only coding specialist, MoE ~3B active. Good for coding agents; lighter than 3.6, no vision overhead." },
  // { id: "qwen3-14b", name: "Qwen3-14B", params: 14, active: 14, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-14B-GGUF", arch: { L: 40, kvH: 8, hd: 128 }, notes: "Dense 14B, a solid choice for 16GB-class machines." },
  // { id: "qwen3-8b", name: "Qwen3-8B", params: 8, active: 8, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-8B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "Dense 8B, a good default for 12GB machines / 8GB GPUs." },
  // { id: "qwen3-4b", name: "Qwen3-4B", params: 4, active: 4, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-4B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "Dense 4B, runs on 8GB machines / older GPUs." },
  // { id: "qwen3-1.7b", name: "Qwen3-1.7B", params: 1.7, active: 1.7, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-1.7B-GGUF", arch: { L: 28, kvH: 8, hd: 128 }, notes: "Runs on low memory / pure CPU. Fast but limited reasoning." },
];

/**
 * Build a MODELS-entry-shaped descriptor for a non-catalog repo from HF's parsed GGUF header (hfDownload.repoDetail().gguf),
 * so the whole existing sizing/launch pipeline (computeFit / pickCtxKv / gpuLayers / isModelInstalled) runs unchanged on any Hub model.
 * HF's gguf field reliably carries { architecture, context_length, total = parameter count }; layer/KV-head dims are usually absent,
 * so those fall back to size-class heuristics — KV estimates are approximate by design (see the file header), this stays within that contract.
 * extras: { vision, mtp } from the repo's file listing (mmproj / drafter presence).
 */
export function descriptorFromGguf(repo, gguf = null, extras = {}) {
  const name = repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo;
  // Parameter count: HF gguf.total; fallback: the "NNB" size class in the repo name (e.g. Qwen3-8B-GGUF); last resort 7B.
  const nameB = name.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  const params = gguf && gguf.total > 0 ? gguf.total / 1e9 : nameB ? Number(nameB[1]) : 7;
  // MoE: "A3B"-style active-params tag in the name (30B-A3B), else assume dense (HF metadata has no expert count).
  const activeM = name.match(/[-_]a(\d+(?:\.\d+)?)b/i);
  // Layer count: gguf.block_count when present, else a dense-transformer size-class heuristic (only feeds the KV/offload estimate).
  const L = (gguf && gguf.block_count) || (params <= 2 ? 24 : params <= 4 ? 32 : params <= 9 ? 36 : params <= 16 ? 40 : params <= 40 ? 48 : params <= 80 ? 64 : 80);
  return {
    id: repo,
    name,
    hf: repo,
    params: Math.round(params * 10) / 10,
    active: activeM ? Number(activeM[1]) : Math.round(params * 10) / 10,
    moe: !!activeM,
    vision: !!extras.vision,
    mtp: !!extras.mtp,
    arch: { L, kvH: (gguf && gguf.head_count_kv) || 8, hd: (gguf && gguf.head_dim) || 128 },
    maxCtx: (gguf && gguf.context_length) || 32768,
    notes: "",
  };
}

const OVERHEAD_BASE_GB = 0.6;
// Approximate resident VRAM/memory overhead of the vision projector (mmproj): a Qwen-VL-class ViT vision tower is ~0.6–1.4GB, take 1GB. Counted only when vision is on and the model supports it.
const VISION_OVERHEAD_GB = 1.0;

export function detectHardware() {
  const platform = process.platform;
  const arch = process.arch;
  const totalMemGB = round(os.totalmem() / 1e9);
  let backend = "cpu";
  let gpu = null;
  let unified = false;

  if (platform === "darwin" && arch === "arm64") {
    backend = "metal";
    unified = true;
    gpu = { name: "Apple Silicon", vramGB: totalMemGB };
  } else {
    try {
      const out = execSync(
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
        { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      ).toString().trim();
      const [name, memMiB] = out.split("\n")[0].split(",").map((s) => s.trim());
      backend = "cuda";
      gpu = { name, vramGB: round(Number(memMiB) / 1024) };
    } catch {
      backend = "vulkan"; // GPU present but VRAM unreadable; let the user fill it in manually in the UI
      gpu = null;
    }
  }
  return { platform, arch, backend, unified, totalMemGB, gpu, cores: os.cpus().length };
}

/**
 * Vulkan GPU: distinguish "integrated GPU (shared system memory, UMA)" from "discrete GPU (dedicated VRAM)". See docs/vulkan-uma-windows.md.
 * The authoritative signal is ggml's `uma:` flag (uma:1 = integrated / uma:0 = discrete), parsed from llama stderr (--list-devices does not print it,
 * it only appears once a model is actually loaded). When uma is unknown, fall back to a device-name heuristic and default to "shared" — this is the conservative choice: better to treat it as integrated (budgeting only
 * system memory) than to double-count a slice of system memory as dedicated VRAM, overestimate capacity, and recommend a quant that won't fit.
 * @param {string|null} name device name from --list-devices
 * @param {boolean|null} uma the parsed ggml uma flag, null if unknown
 * @returns {boolean} true = shared/UMA (treated as unified memory), false = discrete GPU (dedicated VRAM)
 */
export function isSharedGpu(name, uma) {
  if (uma === true) return true;
  if (uma === false) return false;
  const n = (name || "").toLowerCase();
  // Clear discrete-GPU signals take priority and are classified as discrete.
  if (/\b(rtx|gtx|geforce|quadro|tesla|instinct)\b/.test(n)) return false; // NVIDIA / AMD Instinct
  if (/\barc\b/.test(n)) return false; // Intel Arc (discrete)
  if (/radeon\s+(rx|pro|vii)\b/.test(n) || /\brx\s?\d{3,}\b/.test(n)) return false; // AMD discrete
  // Everything else is treated as shared: integrated-GPU names ("Radeon(TM) Graphics" / "UHD·Iris·Xe·HD Graphics" / "Vega") and anything undetermined.
  // Actually running a model once yields the authoritative uma: flag and self-corrects.
  return true;
}

export function usableModelMemoryGB(hw, overrideGB) {
  if (typeof overrideGB === "number" && overrideGB > 0) return round(overrideGB);
  if (hw.unified) {
    const reserve = Math.min(8, Math.max(3, hw.totalMemGB * 0.22));
    return round(Math.max(2, Math.min(hw.totalMemGB * 0.7, hw.totalMemGB - reserve)));
  }
  // Discrete GPU: partial offload can use "available VRAM + available system memory" (layers that don't fit stay on CPU); if VRAM is unreadable, use system memory only.
  const usableVram = hw.gpu && hw.gpu.vramGB ? Math.max(0, hw.gpu.vramGB - 1.2) : 0;
  return round(Math.max(2, usableVram + hw.totalMemGB * 0.6));
}

export function weightGB(model, quant) {
  return (model.params * quant.bpw) / 8;
}

export function kvGB(model, ctx, kvBits) {
  const { L, kvH, hd, swa } = model.arch;
  const per = (layers, len) => (layers * kvH * hd * 2 * len * (kvBits / 8)) / 1e9;
  if (!swa) return per(L, ctx);
  // Sliding-window attention (e.g. Gemma 4's 5:1): out of every `every` layers only 1 is full attention counted at ctx, the rest hold only a window's worth of KV
  // (llama.cpp iSWA cache is allocated per window). Counting everything at full length would overestimate Gemma's KV by ~5–6×, making the context tier too small.
  const gL = Math.ceil(L / swa.every);
  return per(gL, ctx) + per(L - gL, Math.min(ctx, swa.window));
}

export function computeFit(model, quant, ctx, kvBits, vision = false) {
  const w = weightGB(model, quant);
  const kv = kvGB(model, ctx, kvBits);
  const overhead = OVERHEAD_BASE_GB + (model.moe ? 0.4 : 0) + (vision && model.vision ? VISION_OVERHEAD_GB : 0);
  return { weightGB: round(w), kvGB: round(kv), overheadGB: round(overhead), totalGB: round(w + kv + overhead) };
}

export function bestQuant(model, budgetGB, ctx, kvBits) {
  for (const q of QUANTS) if (computeFit(model, q, ctx, kvBits).totalGB <= budgetGB) return q;
  return null;
}

// Automatic context tiering (largest to smallest): pick "the largest -c that fits" by device memory, capped at the model's native window (maxCtx).
// 16K is too small for real use (the system prompt alone is ~6K), so probe upward as much as possible; within a tier prefer KV q8 (near-lossless), and only drop to q4 (half the size) when it doesn't fit, to unlock a larger context.
export const CTX_LADDER = [262144, 131072, 65536, 32768, 16384];

/**
 * Pick context length and KV quantization for a "model + quant": { ctx, kvBits }.
 * cap is the larger of the usable budget and deviceMem*0.78 (a compromise with the device-memory "fits" criterion used for tiered models).
 * 0.78 rather than 0.75: the KV estimate is already conservative (q4 is actually 4.5bpw, i.e. +12%; the SWA window uses the upper bound), so loosening it lets 26B-A4B reach
 * 128K on 24G (18.4GB ≈ 77%, close to the macOS Metal wired ceiling of ~75–80%; if an extreme combo fails on first launch, turn off vision / drop a tier).
 * When nothing fits, fall back to { 16K, q4 } (the leanest combo, behavior close to the old default).
 */
export function pickCtxKv(model, bpw, hw, budgetGB, vision = false) {
  const cap = Math.max(budgetGB || 0, deviceMemGB(hw) * 0.78);
  const maxCtx = model.maxCtx || 32768;
  for (const ctx of CTX_LADDER) {
    if (ctx > maxCtx) continue;
    for (const kvBits of [8, 4]) {
      if (computeFit(model, { bpw }, ctx, kvBits, vision).totalGB <= cap) return { ctx, kvBits };
    }
  }
  return { ctx: 16384, kvBits: 4 };
}

// Device capacity available to a model: unified memory (Mac) uses the total; a discrete GPU can span VRAM + system memory via "partial offload", so take the sum of both;
// CPU / unreadable VRAM uses system memory only. Used for quantTiers tiering and support checks.
export function deviceMemGB(hw) {
  if (hw.unified) return hw.totalMemGB;
  const vram = hw.gpu && hw.gpu.vramGB ? hw.gpu.vramGB : 0;
  return round(vram + hw.totalMemGB);
}

// Minimum bar for running local models: below this (deviceMem = Mac unified memory / discrete-GPU VRAM), even the smallest quant of the smallest model won't fit → disable local models entirely.
// Consistent with the lowest tier in the catalog: Gemma 4 E4B's UD-Q4_K_XL (minMemGB=8). The flagship 35B now starts at 23GB (the Q2 tier is commented out, see its quantTiers).
export const MIN_LOCAL_MEM_GB = 8;
export function localSupported(hw) {
  return deviceMemGB(hw) >= MIN_LOCAL_MEM_GB;
}

// Pick a model's quant: if it has quantTiers (e.g. the flagship uses unsloth UD tiers), pick a UD tag by device memory; otherwise use the generic QUANTS.
function selectQuant(model, hw, budgetGB, ctx, kvBits) {
  if (model.quantTiers) {
    const mem = deviceMemGB(hw);
    const t = model.quantTiers.find((x) => mem >= x.minMemGB);
    return t ? { id: t.quant, bpw: t.bpw, quality: 90, label: t.quant } : null;
  }
  return bestQuant(model, budgetGB, ctx, kvBits);
}

// The quant tags this model offers in the UI quant dropdown, each one's size, and whether it fits: quants with fits=false are disabled (not selectable) in the UI.
// Tiered models (quantTiers) judge fits by deviceMem ≥ minMemGB (same criterion as selectQuant); the rest use the generic QUANTS with totalGB ≤ budget.
// Each quant runs pickCtxKv on its own: size is estimated from "the ctx/kv auto-selected for that quant", and ctx is returned alongside for the UI to display.
// When vision is on and the model supports vision, the size includes the vision-projector overhead (matching the actual launch).
function modelQuants(model, hw, budgetGB, vision = false) {
  const mem = deviceMemGB(hw);
  const list = model.quantTiers
    ? model.quantTiers.map((t) => ({ id: t.quant, bpw: t.bpw, fitsByMem: mem >= t.minMemGB }))
    : QUANTS.map((q) => ({ id: q.id, bpw: q.bpw, fitsByMem: null }));
  return list.map((q) => {
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, vision);
    const totalGB = computeFit(model, { bpw: q.bpw }, pick.ctx, pick.kvBits, vision).totalGB;
    return { id: q.id, totalGB, ctx: pick.ctx, kvBits: pick.kvBits, fits: q.fitsByMem ?? totalGB <= budgetGB };
  });
}

/** Auto-select a quant tag for a model (tiered models use the UD tag from quantTiers, the rest use the generic QUANTS); a fallback for when quant isn't explicitly specified at launch. */
export function autoQuantId(model, hw, ctx = 16384, kvBits = 8) {
  const q = selectQuant(model, hw, usableModelMemoryGB(hw), ctx, kvBits);
  return q ? q.id : "Q4_K_M";
}

/** Bits-per-weight (bpw) for a quant tag: tiered models read from quantTiers, the rest from QUANTS, and unknown tags are roughly estimated from the tag name. */
export function quantBpw(model, quantId) {
  if (model && model.quantTiers) { const t = model.quantTiers.find((x) => x.quant === quantId); if (t) return t.bpw; }
  const q = QUANTS.find((x) => x.id === quantId); if (q) return q.bpw;
  if (/Q2/i.test(quantId)) return 2.6;
  if (/Q3/i.test(quantId)) return 3.6;
  if (/Q5/i.test(quantId)) return 5.6;
  if (/Q6/i.test(quantId)) return 6.5;
  if (/Q8/i.test(quantId)) return 8.5;
  return 4.5; // Q4 and unknown
}

/**
 * Compute -ngl (number of layers to offload to the GPU). For a discrete GPU, estimate how many layers fit in available VRAM and leave the rest on CPU (partial offload).
 * vramGB is best probed at launch via `llama-server --list-devices` (more accurate than a preinstalled rough estimate).
 *   999 = offload all; 0 = all on CPU; N = first N layers on GPU. Incomplete info / unreadable VRAM → optimistically offload all (failures are caught by the fallback).
 */
export function gpuLayers(model, bpw, ctx, kvBits, vramGB) {
  const L = model && model.arch ? model.arch.L : 0;
  if (!L || !bpw || !vramGB || vramGB <= 0) return 999;
  const perLayer = (model.params * bpw / 8) / L + kvGB(model, ctx, kvBits) / L; // weights/layer + KV/layer (KV of offloaded layers is also in VRAM)
  const usable = Math.max(0, vramGB - 1.2); // reserve for compute buffers / desktop usage
  const n = Math.max(0, Math.min(L, Math.floor(usable / perLayer)));
  return n >= L ? 999 : n;
}

// Returns a language-agnostic speed code (fast|medium|slow), which the render layer localizes for display via i18n.
function speedHint(model, hw) {
  const a = model.moe ? model.active : model.params;
  let base = a <= 4 ? "fast" : a <= 16 ? "medium" : "slow";
  if (hw && hw.backend === "cpu") base = base === "fast" ? "medium" : "slow";
  return base;
}

/** List all models that fit within the hardware budget (each with its best quant) and highlight the primary. Each entry includes ngl (GPU-offloaded layers) and layers (total layers) for the UI to display.
 *  vision (the vision toggle, normally passed in by the UI): when on and the model supports vision, the size estimate includes the vision-projector overhead. */
export function recommend(hw, budgetGB, { ctx = 16384, kvBits = 8, vision = false } = {}) {
  const vram = hw.unified ? 0 : (hw.gpu && hw.gpu.vramGB) || 0;
  const options = [];
  for (const model of MODELS) {
    const q = selectQuant(model, hw, budgetGB, ctx, kvBits);
    if (!q) continue;
    const v = vision && !!model.vision;
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, v); // each model auto-selects ctx / KV quant (overriding the 16K baseline argument)
    const ngl = hw.unified ? 999 : hw.backend === "cpu" ? 0 : gpuLayers(model, q.bpw, pick.ctx, pick.kvBits, vram);
    options.push({ model, quant: q, fit: computeFit(model, q, pick.ctx, pick.kvBits, v), speed: speedHint(model, hw), ctx: pick.ctx, kvBits: pick.kvBits, quants: modelQuants(model, hw, budgetGB, v), ngl, layers: model.arch.L });
  }
  // primary: quality first, and larger context is better — first look for ≥128K (the heavy-use target), then fall back to ≥32K (16K is tight even for the ~6K system prompt), then a final fallback.
  // No YaRN needed: every model in the catalog has a native window ≥128K (E4B 128K, the rest 256K), so the cost of long context is only in KV (already estimated with sliding-window/quant tiering).
  // On low-bandwidth devices (pure CPU / integrated-GPU shared memory; non-Apple-Silicon, no discrete GPU), decode speed ≈ bandwidth / activated-weight size: within a tier prefer the one with fewer activated parameters
  // (16G pure CPU: dense 12B is only ~6–10 tok/s, E4B/MoE is more than twice as fast). Mac (Metal) and discrete-GPU machines still go by quality first.
  const dedicatedGpu = !hw.unified && !!(hw.gpu && hw.gpu.vramGB);
  const lowBw = hw.backend !== "metal" && !dedicatedGpu;
  const activeOf = (o) => (o.model.moe ? o.model.active : o.model.params);
  const pickFrom = (list) => (list.length === 0 ? null : lowBw && list.length > 1 ? [...list].sort((a, b) => activeOf(a) - activeOf(b))[0] : list[0]);
  const primary =
    pickFrom(options.filter((o) => o.quant.quality >= 85 && o.ctx >= 131072)) ||
    pickFrom(options.filter((o) => o.quant.quality >= 85 && o.ctx >= 32768)) ||
    options.find((o) => o.quant.quality >= 85) ||
    options[0] || null;
  return { budgetGB: round(budgetGB), ctx, kvBits, primary, options };
}

/**
 * Build the llama-server launch args. These flags correspond to the "must-haves" from our evaluation of rapid-mlx/oMLX/vmlx,
 * and are all off-the-shelf llama.cpp features (no source changes):
 *   -ngl N          offload N layers to the GPU (Metal/CUDA/Vulkan); for a discrete GPU, partial-offload by VRAM and leave the rest on CPU
 *   -fa on          flash attention (faster + saves KV VRAM on long contexts)
 *   -ctk/-ctv q8_0  KV cache quantization
 *   --cache-reuse   reuse prefixes across requests (prefix sharing)
 *   --slot-save-path persist KV to disk (today's "SSD KV", whole-slot granularity, not vmlx's chunked paged-SSD)
 *   -md FILE        speculative-decoding drafter file (Gemma: separate MTP drafter; takes effect with --spec-type draft-mtp)
 *   --spec-type draft-mtp  enable MTP speculative decoding (b9936). Gemma points -md at a separate drafter;
 *                   Qwen "-MTP-GGUF" weights embed the MTP head → only this flag is needed, no -md (self-speculative). Without -md and not embedded, this flag is omitted.
 *   -m FILE         local weight file (we launch with it after downloading ourselves, see hfDownload.mjs); when modelPath is given, -hf is not used
 *   --mmproj FILE   explicitly specify the multimodal vision-projector file (passed when we auto-download the vision model)
 *   --no-mmproj     vision off: skip the same-repo vision projector that -hf loads automatically (saves ~1GB resident memory)
 *   --jinja         chat template + tool-call parsing (required for agents)
 *   --chat-template NAME  override the model's embedded chat template with a llama.cpp built-in (chatml / qwen / gemma / llama3 …).
 *                   Rescues community GGUFs whose embedded Jinja template breaks --jinja's tool-parser generation ("Unable to generate parser for this template");
 *                   omitted (null) → use the template baked into the GGUF (the default, correct for catalog models).
 * Local first: given modelPath → `-m FILE` (+ explicit `--mmproj FILE` when vision), the weights already downloaded by us (with progress/resume);
 * if not auto-downloaded (fallback path) → `-hf repo:quant` is fetched by llama itself, and only then, when noMmproj=true, is --no-mmproj used to turn off the automatic vision projector.
 */
export function buildServerArgs({ hf, modelPath = null, hw, ctx = 16384, port = 8080, kvBits = 8, mtpDraft = null, specMtp = false, mmproj = null, noMmproj = false, kvCacheDir = null, ngl = null, chatTemplate = null, extraArgs = [] }) {
  const args = modelPath ? ["-m", modelPath] : ["-hf", hf];
  args.push(
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(ctx),
    "-ngl", String(ngl != null ? ngl : (hw && hw.backend === "cpu" ? 0 : 999)),
    "-fa", "on",
    "--jinja",
    "--cache-reuse", "256",
  );
  if (chatTemplate) args.push("--chat-template", String(chatTemplate)); // override a broken embedded template with a built-in
  const kvType = kvBits === 8 ? "q8_0" : kvBits === 4 ? "q4_0" : "f16";
  if (kvType !== "f16") args.push("-ctk", kvType, "-ctv", kvType);
  if (kvCacheDir) args.push("--slot-save-path", kvCacheDir);
  if (mtpDraft) args.push("-md", mtpDraft); // Gemma: separate MTP drafter file
  // MTP speculative-decoding flag (b9936): Gemma needs an -md drafter; Qwen weights embed the MTP head → the flag alone enables self-speculation.
  // Omitted when there's no separate drafter and it's not embedded (specMtp=false), to avoid draft-mtp erroring out when it can't find an MTP head.
  if (specMtp) args.push("--spec-type", "draft-mtp");
  if (mmproj) args.push("--mmproj", mmproj); // explicit file override (usually unused)
  else if (noMmproj) args.push("--no-mmproj"); // vision off: don't load the vision projector that -hf brings in automatically
  return args.concat(extraArgs);
}
