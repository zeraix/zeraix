/**
 * Local model catalog + hardware-based recommendations + llama-server launch args (main process, pure logic, no side effects).
 *
 * Weights are estimated as `params × bpw / 8` (weightGB). Two DIFFERENT things are called bpw here, and they must not be swapped:
 *   QUANTS[].bpw      nominal bits per weight for a quant type (Q4_K_M 4.85, ...), for models with no measured tier.
 *   quantTiers[].bpw  CALIBRATED so that `params × bpw / 8` equals the shipped GGUF's tensor bytes. It is NOT the true bpw,
 *                     because `params` is the rounded marketing figure: 26B-A4B is really 25.23B weights at a true 4.51 bpw,
 *                     and 26 x 4.51/8 would over-count it by 0.44 GB. Measured: E4B 7.46B/4.50, 12B 11.91B/4.50,
 *                     26B-A4B 25.23B/4.51 (the three Gemmas share the UD-Q4_K_XL recipe), Qwen 35.51B/5.15.
 *                     So re-derive a tier bpw as tensor_bytes*8/NOMINAL params, never as the model's real bits per weight.
 * Neither is related to `kvBits`/kvBitsEffective(), which is bits per KV element.
 * KV is NOT estimated from the approximate arch dimensions any more: the four shipped models carry `arch.kvElems`, KV elements per
 * cell read from the GGUF, because Gemma 4 uses a different head count AND head dim on its full-attention vs window layers, which one
 * kvH/hd pair cannot express. `arch.L`/`kvH`/`hd` remain for the -ngl layer split and as the fallback for any model without kvElems.
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
/**
 * Models a resident seed is PUBLISHED for.
 *
 * A seed is a build artifact, not a capability: `scripts/gen-seed.mjs` runs each of these models against each mode and uploads the
 * result. A model is on this list only once its seed has been generated and pushed. Nothing else is gated on it — see
 * kvTierEnabled for the disk tier itself, which every model on mac gets.
 *
 * Every entry also needs a pinned `revision` below, because the seed is only valid for the exact GGUF it was built against (the
 * chat template ships inside the file and model_key does not cover it). seedAvailable enforces that.
 */
export const SEED_MODELS = new Set(["qwen3.6-35b-a3b", "gemma4-26b-a4b", "gemma4-e4b", "gemma4-12b"]);

/**
 * Models the MoE expert pool is enabled for.
 *
 * An allowlist because the pool needs a per-model ROUTING PROFILE (which experts to keep resident), so it applies only to
 * mixture-of-experts models, and only where a profile has been generated and shipped. E4B and 12B are dense (`moe: false`) —
 * there is nothing for a pool to do.
 *
 * Without a profile the fork's pool stays inert by design rather than pinning blind index-order experts, so a missing file
 * degrades to stock behaviour instead of degrading quality.
 */
export const MOE_POOL_MODELS = new Set(["gemma4-26b-a4b", "qwen3.6-35b-a3b"]);

/** macOS only, same reason as the KV tier: the pool exists only in the fork's build, and only its mac build is published. */
export function moePoolEnabled(modelId) {
  if (process.platform !== "darwin") return false;
  return !!modelId && MOE_POOL_MODELS.has(String(modelId));
}

/**
 * Whether the KV disk tier runs. macOS only, and no model gate.
 *
 * The tier lives in the fork's llama-server, and only the mac build of that is published — Windows installs the pinned upstream
 * binary from the CDN, which has none of these flags. Keeping the platform check here (rather than only relying on the binary
 * probe) means Windows never even creates a disk directory.
 *
 * It takes no model id because nothing about it is model-specific. The server content-addresses the KV layout itself into a
 * `model_key` (model geometry + KV quant + SWA + rotation flag), files units under `<dir>/<model_key>/`, and a mismatched layout
 * simply never matches — so an unknown GGUF gets prefix reuse across restarts with no way to collide with another model's units.
 * Seeds are a separate, optional accelerator on top: see seedAvailable.
 */
export function kvTierEnabled() {
  return process.platform === "darwin";
}

/**
 * Whether a published seed exists to download for this model.
 *
 * Strictly narrower than kvTierEnabled: the tier works with no seed at all — it just starts cold and warms up as the user talks.
 * A seed only removes the first prefill. So this gates the DOWNLOAD, never the tier.
 *
 * Requires the pinned revision as well as list membership: the seed key embeds `r<revision8>` (see seeds.seedKey), so a model with no
 * pin would request a URL that can never exist and 404 on every launch.
 */
export function seedAvailable(modelId) {
  if (!kvTierEnabled() || !modelId || !SEED_MODELS.has(String(modelId))) return false;
  return !!MODELS.find((m) => m.id === modelId)?.revision;
}

export const MODELS = [
  {
    id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B", params: 35, active: 3, moe: true, vision: true, mtp: true, mtpEmbedded: true,
    // Share of the weights held in expert tensors (ffn_*_exps), measured from the UD-Q4_K_XL GGUF: 20.12 of 22.84 GB.
    // Only the pooled fraction of these is resident; see moeResidentGB. Absent => the model is sized as fully resident.
    expertFrac: 0.881,
    // Cap thinking at N tokens (--reasoning-budget). Qwen3.6's template FORCES thinking open - add_generation_prompt
    // emits a bare `<think>\n` - so every turn reasons whether or not it needs to. Measured across a session, 1242
    // of 2526 generated tokens were thinking that the template then discards at the next user turn: 49%, with
    // individual turns at 91-98%. Decode is ~56% of an agentic turn's wall clock and scales with tokens generated,
    // so this is the largest single lever on how the model feels.
    //
    // A sampler, not a prompt hint: it forces the closing tag at the budget, so it holds regardless of the model's
    // inclination. 1000 leaves the ordinary 100-500 token turns untouched and only truncates the runaways.
    // Gemma models are not capped - none of them showed this behaviour.
    reasoningBudget: 1000,
    // Injected immediately before the closing tag when the budget runs out, INSIDE the thinking stream - so it
    // reads as the model's own last thought. Without it the reasoning is severed mid-sentence and whatever comes
    // next starts from a broken train of thought.
    //
    // Deliberately neutral about WHAT happens next. An earlier wording ("let me answer with what I have") biased
    // the turn toward replying, which is wrong whenever the model was mid-plan on a tool call: the budget can run
    // out in a turn whose next act is a tool call, and telling it to answer talks it out of the call it needed to
    // make. "Move on to the next step" fits both.
    reasoningBudgetMessage: "\n\nI have enough to go on. Let me move on to the next step.\n",
    // vision:true = this GGUF repo ships a vision projector (mmproj). At launch, explicitly pass --mmproj to load the same repo's vision projector (vision on, default);
    // if vision is off, pass --no-mmproj to skip it (saves ~1GB of resident memory, see VISION_OVERHEAD_GB). Whether an mmproj actually exists follows the HF repo.
    // mtpEmbedded:true = use unsloth's "-MTP-GGUF" repo: the MTP (multi-token prediction) head is embedded in the weights themselves (self-speculative, no separate drafter file),
    // and it also ships UD quants + mmproj. At launch, --spec-type draft-mtp enables self-speculative decoding (turning off vision/MTP only affects loading/toggles; the weights still come from this repo).
    hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    // Read from the GGUF, not guessed: block_count 41, head_count_kv 2, key/value_length 256, and
    // full_attention_interval 4 - so only 1 layer in 4 holds KV cells at all. The other 3 in 4 are GDN-recurrent,
    // whose state is a fixed [S,S,H] blob per sequence with no per-token cells, hence window 0 rather than a
    // sliding window. The previous { L:48, kvH:4, hd:128 } over-stated KV by 4.4x (6.44 GB vs 1.48 GB at 256K),
    // which is what made the context ladder refuse rungs this machine can hold.
    // UNDER-counts by the recurrent state itself, which is real but not per-token and not modelled here.
    // kvElems = KV elements per cell (K+V, summed over the layers in that group), read from the GGUF.
    // full: 11 attention layers x head_count_kv 2 x (key_length 256 + value_length 256). 11 is not an
    // estimate: full_attention_interval=4 and models/qwen35moe.cpp marks layer i recurrent when
    // (i+1) % 4 != 0 for i < n_layer(), so the 40-layer trunk has 10 full-attention layers and the
    // nextn/MTP layer (index 40) is dense attention too. swa: 0 - the 30 GDN-recurrent layers hold no
    // growing KV; their fixed state is recurrentGB's job.
    arch: { L: 41, kvH: 2, hd: 256, swa: { every: 4, window: 0 }, kvElems: { full: 11264, swa: 0 } }, maxCtx: 262144,
    // The 30 GDN-recurrent layers the window-0 above excludes from KV. Their state is NOT per-token: a fixed
    // [state, state, heads] blob per layer per sequence, from the GGUF's ssm.state_size 128 and
    // ssm.inner_size 4096 (=> 4096/128 = 32 value heads), plus a conv_kernel 4 x 8192 window. F32.
    recurrent: { layers: 30, state: 128, heads: 32, conv: 4 * 8192 },
    // Pinned commit. Required for any model on SEED_MODELS: a resident seed is only valid for the exact GGUF it was built
    // against, because the chat template ships inside the file and model_key does not cover it. Leaving this on "main" means a
    // repo re-upload silently changes the rendered prefix and every published seed stops matching, with no error. Bump it and
    // regenerate seeds together. null = track main (fine for models with no seed).
    revision: "5bc3e238d916f48a861bac2f8a1990a0e9b7e98d",
    // unsloth ships only UD dynamic quants; pick a UD tag by device-memory tier (i.e. the :QUANT in -hf). memGB = total Mac unified memory / discrete-GPU VRAM.
    quantTiers: [
      // bpw measured from the shipped GGUF (22.85 GB / 35B params), not the nominal 4.5 of a plain Q4_K: unsloth's UD
      // quants keep selected tensors at higher precision, and at 4.5 the catalog under-estimated this model by 13.9%.
      // UD-Q3_K_XL below is still the nominal figure - that tier is not installed here, so there was nothing to measure.
      // minMemGB is where the quant measurably fits WITH the expert pool, not where the whole GGUF would.
      // At 256K context, q4 KV, vision on, and the native/pooled split moeNativePlan derives for that machine:
      //   UD-Q4_K_XL  fits from 20 GB (16.3 of a 16.3 GB budget on 24 GB, 12 layers native)
      //   UD-Q3_K_XL  fits from 16 GB (10.7 of 10.9)
      // Both figures moved with the budget factor (0.70 -> 0.68) and again when kvGB was corrected against the
      // GGUF geometry; q4's floor is 13.3 GB, so it now needs mem*0.68 >= 13.3, i.e. 20 GB rather than 18.
      // 24 GB gets q4 at the full 256K, 16/18 GB stays on q3. Note the q4 threshold below is now AT its fit
      // point rather than a config above it: an 18 GB Mac is excluded by 1.1 GB, not by a deliberate margin.
      // What margin remains is that moeResidentGB models the dirty allocation only - neither the GDN recurrent
      // state nor the page cache the pooled experts want is charged against this budget.
      // Was 31/23, sized when the model was counted as fully resident (22.84 GB rather than 8.5-13.3).
      { minMemGB: 20, quant: "UD-Q4_K_XL", bpw: 5.22 },
      { minMemGB: 16, quant: "UD-Q3_K_XL", bpw: 3.6 },
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
    // Measured from the UD-Q4_K_XL GGUF: 12.85 of 14.23 GB in expert tensors. See moeResidentGB.
    expertFrac: 0.903,
    revision: "7b92b5b28818151e8669af2e45e88d6086f490dd", // pinned: see the note on qwen above — required for seeded models
    // GGUF: block_count 30 (5 full-attention + 25 window), head_count_kv 2 on the full layers and 8 on the
    // window ones, key/value_length 512 full and 256 SWA. L stays 48 because it feeds the -ngl split, not KV.
    hf: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 }, kvElems: { full: 10240, swa: 102400 } }, maxCtx: 262144,
    quantTiers: [
      // 16, not 18: with the expert pool the weights are 7.3-8.6 GB resident rather than the whole 14.2 GB file,
      // and the model fits a 16 GB Mac at 64K (10.9 of a 10.9 GB budget, 7 layers native) or the full 256K with
      // vision off (7 native there too; 11 at 64K). 14 GB and below fits at no rung at all, so this is the real
      // floor. Vision on tops out at 192K. The reachable context grew when kvGB was corrected against the GGUF
      // geometry - this model's KV at 256K was over-counted by 2.6 GB, which had capped a 16 GB Mac at 128K.
      // Which CONTEXT is affordable is decided per rung by estimate(), not here - the tier only answers "can this
      // machine run the model at all". Gating the model on the memory a 256K context needs hid it from machines
      // that can run it perfectly well at 64K.
      { minMemGB: 16, quant: "UD-Q4_K_XL", bpw: 4.38 }, // 14.25 GB on disk / 26B params. Was 4.37, which is
      // 14.20 GB - a 47 MB under-count, and under-counting weights is the direction that overruns the budget.
    ],
    notes: "MoE ~4B active → fast decode, high quality. Multimodal (images only, no audio)."
  },
  {
    // mtp:true: dense 12B decoding is bandwidth-bound (reads ~6.7GB per token); speculative decoding gives ~1.5–2× speedup. The drafter (MTP/…-Q4_0-MTP.gguf,
    // ~254MB) is in the same repo as the main weights and is fetched alongside them during auto-download (hfDownload), then passed to llama-server via -md; not enabled on the -hf fallback path.
    id: "gemma4-12b", name: "Gemma 4 12B", params: 12, active: 12, moe: false, vision: true, mtp: true,
    revision: "980b060c40a8539ac159e0501a3e0f66a6365af3", // pinned: see the note on qwen above — required for seeded models
    // GGUF: block_count 48 (8 full-attention + 40 window), head_count_kv 1 on the full layers and 8 on the
    // window ones - the clearest case that one kvH/hd pair cannot describe both groups.
    hf: "unsloth/gemma-4-12B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 }, kvElems: { full: 8192, swa: 163840 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 12, quant: "UD-Q4_K_XL", bpw: 4.48 }, // 6.72 GB
    ],
    notes: "Dense 12B, quality close to 26B-A4B. Multimodal (image/audio)."
  },
  {
    id: "gemma4-e4b", name: "Gemma 4 E4B", params: 8, active: 8, moe: false, vision: true, mtp: true,
    revision: "8c5a9e4fd5482e2be20fe0bf013b4c262a8f4265", // pinned: see the note on qwen above — required for seeded models
    // ≈4.5B effective parameters (8B raw, MatFormer + Per-Layer Embeddings); top pick for low-end laptops (4–5GB is enough).
    // Native tool-calling tokens, well suited for agents. Q4_0 loses quality, so use UD-Q4_K_XL.
    // window 512, read from the GGUF (gemma4.attention.sliding_window); 26B and 12B are 1024. It was 1024
    // here, which double-counted every SWA layer — and kvGB now multiplies this by the slot count, so a
    // wrong window is amplified rather than absorbed.
    // GGUF: block_count 42 (7 full-attention + 35 window), head_count_kv 2 throughout, key/value_length
    // 512 full and 256 SWA. L stays 34 because it feeds the -ngl split, not KV.
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF", arch: { L: 34, kvH: 4, hd: 256, swa: { every: 6, window: 512 }, kvElems: { full: 14336, swa: 35840 } }, maxCtx: 131072,
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
    // 65% of unified memory, or "all but 3 GB" on a machine too small for that to leave a usable OS.
    //
    // Was min(8, max(3, T*0.22)) inside a min against T*0.7. Those two constants could never bind: reserve
    // exceeds 0.3*T only when the 3 GB floor does (T < 10), and the 8 GB cap only applies above 36 GB where
    // 8 is already below 0.3*T. Same shape, three numbers fewer.
    //
    // 0.68, and the margin here is expensive. Measured on a 36 GiB Mac, one factor step at a time:
    //
    //                 native  pooled  wired         compressor  decode      prefill @ ~223 tok
    //     0.70        36/41      5    27.60 (77%)   4.07        31.64 t/s   93 t/s
    //     0.68        34/41      7    26.36 (73%)   3.65        28.99 t/s   64 t/s
    //     0.65        32/41      9    25.48 (71%)   3.61        26.24 t/s   34 t/s
    //
    // Cost tracks the POOLED layers that remain, not the native layers gained: 36 -> 32 native is 5 -> 9 pooled,
    // nearly doubling the ring/pool work per forward, which is why four layers cost 17% of decode and half of
    // prefill rather than the few percent a diminishing-returns reading predicts. There is no flat region at the
    // top to shave.
    //
    // 0.68 is where the curve turns. It gives back 1.24 GiB and drops off the 77% ceiling for 8% of decode;
    // the next step down costs another 9% and buys only 0.88 GiB more. The margin is for the QEMU sandbox, which
    // was not running during any of these measurements and is the one unmodelled claim on this memory.
    //
    // Compare prefill at a MATCHED token count. Aggregated per-session means are worthless here: prefill speed
    // depends strongly on size (under ~120 tokens the fixed cost dominates and every setting converges near
    // 15 t/s), so a different mix of turn sizes swamps the setting being measured.
    //
    // NOT 0.8: a 24 GiB Mac would have ~0.1 GiB of page cache left after macOS (~2.65 GiB wired) and Electron
    // (~1.7 GiB), and the pool re-reads its file-backed experts on every ring forward without it.
    //
    // 0.68 -> 0.75, because the argument above prices only one side of the trade. A big ring genuinely
    // needs page cache - but how big the ring IS depends on how many pooled layers the budget leaves,
    // and buying native layers shrinks both the ring and the cache it needs. The two move together.
    //
    // Measured on a simulated 24 GB Mac at the settings the app actually launches - ctx 262144,
    // n_ubatch 512, n_batch 2048, corpus prompt, speculation on, ballast to 24 GB with 4 GB for the
    // OS and the app stack:
    //
    //     natives  pooled  wired     cache-avail   prefill   decode
    //        15      26    14.7 GB     3.9 GB       54.5      10.1     <- 0.68
    //        19      22    15.8 GB     2.7 GB       63.6      11.7     <- 0.75
    //
    // +17% prefill and +16% decode for 1.1 GB of the reserve. Modest, and it is the whole of the win:
    // it does not approach a usable target on this tier. Qwen3.6-35B at UD-Q4_K_XL is 22.8 GB of
    // weights against ~18 GB of budget here, so ~5 GB streams from disk on every pass no matter how
    // the layers are split. That gap caps the tier and no split closes it - the remedies are a leaner
    // quant or a lower context rung, both product decisions.
    //
    // Not higher than 0.75: at 0.83 a 24 GB Mac has ~0.1 GB of page cache left and the pooled layers
    // re-read their experts from disk on every ring forward.
    return round(Math.max(2, hw.totalMemGB < 10 ? hw.totalMemGB - 3 : hw.totalMemGB * 0.75));
  }
  // Discrete GPU: partial offload can use "available VRAM + available system memory" (layers that don't fit stay on CPU); if VRAM is unreadable, use system memory only.
  const usableVram = hw.gpu && hw.gpu.vramGB ? Math.max(0, hw.gpu.vramGB - 1.2) : 0;
  return round(Math.max(2, usableVram + hw.totalMemGB * 0.6));
}

export function weightGB(model, quant) {
  return (model.params * quant.bpw) / 8;
}

/**
 * KV cache size. Two caches, sized independently by llama.cpp:
 *
 *   base (full attention)   n_ctx_seq cells                                    = ctx
 *   window (SWA)            GGML_PAD(min(n_ctx_seq, n_swa*n_seq_max + n_ubatch), 256) cells,
 *                           and the mac fork gives each slot its OWN region of that size,
 *                           so the buffer is `slots` times it
 *
 * Both SWA factors used to be missing: the term was one window's worth, which at slots=2 was low by
 * 3x on E4B and 5x on 26B-A4B. The `ubatch = 512` default below is now only a FALLBACK for callers
 * that pass nothing — buildServerArgs launches with `-ub 1024`, so a caller sizing an SWA model must
 * pass the real value or this under-counts by one ubatch per slot. It does not bite the MoE models
 * here, which have no SWA window and so never reach the term. slots is 2 because that is what
 * buildServerArgs passes whenever the KV disk tier is on. The regions are vm_allocate with the boot clear skipped, so pages commit only as a
 * slot's window is touched — a fully warm server is the worst case this counts, not the steady state.
 *
 * `arch.kvElems` is KV elements per cell (K + V, summed over every layer in that group), read from
 * the GGUF. It replaces the old uniform `kvH * hd * 2 * L` shape, which CANNOT express these models:
 * Gemma 4 uses a different head count AND a different head dim on its two layer kinds (12B: 1 head x
 * 512 on full attention, 8 x 256 on the window layers), so no single kvH/hd pair is right for both.
 * `swa: 0` means the non-attention layers hold no growing KV at all (Qwen's GDN-recurrent layers -
 * their fixed state is recurrentGB's job, not this).
 */
/**
 * Bits per stored KV value. q4_0 and q8_0 are BLOCK quantized: 32 values share one ggml_half scale
 * (ggml-common.h block_q4_0 = 2 + 16 bytes, block_q8_0 = 2 + 32), so the real width is
 * nominal + 16/32 = nominal + 0.5 bits. f16 has no block overhead.
 *
 * This was previously left out. Nothing was absorbing it: the budget factor (0.68, memBudgetGB) is tuned
 * against native/pooled layer counts and its margin is reserved for the QEMU sandbox, not for KV error.
 * While the layer geometry over-counted, the omission was masked — the net estimate still came out high.
 * With the geometry exact it would make every model read 11% LOW, which is the direction that causes an
 * OOM rather than a refused rung.
 */
export const kvBitsEffective = (kvBits) => (kvBits === 4 || kvBits === 8 ? kvBits + 0.5 : 16);

/**
 * How the running server will be configured, because the window cache depends on both and they are NOT
 * the same everywhere:
 *
 *   slots    macOS gets `--parallel 2` (buildServerArgs, whenever the KV tier is on, i.e. darwin).
 *            Everywhere else no --parallel is passed and the server auto-resolves to 4.
 *   regions  Only the mac fork gives each slot its OWN window region, so only there is the buffer
 *            slots x size_swa. Windows and Intel macs run the CDN's upstream binary (llamaInstaller
 *            macForkAsset: arm64 darwin only), where the window cache is ONE cache of size_swa.
 *
 * Assuming regions everywhere would over-count Windows by ~0.8 GB on 26B-A4B at 4 slots; assuming 2
 * slots everywhere would under-count it. Both are wrong in a way that moves the native/pooled split.
 */
export const serverKvShape = () => ({
  slots: kvTierEnabled() ? 2 : 4,
  regions: process.platform === "darwin" && process.arch === "arm64",
});

export function kvGB(model, ctx, kvBits, opts = {}) {
  const { L, kvH, hd, swa, kvElems } = model.arch;
  const shape = serverKvShape();
  const { slots = shape.slots, regions = shape.regions, ubatch = 512 } = opts;
  const bytesPer = kvBitsEffective(kvBits) / 8;
  if (!kvElems) {
    // fallback for any model without measured geometry: the old uniform approximation
    const per = (layers, len) => (layers * kvH * hd * 2 * len * bytesPer) / 1e9;
    if (!swa) return per(L, ctx);
    const gL = Math.ceil(L / swa.every);
    return per(gL, ctx) + per(L - gL, Math.min(ctx, swa.window));
  }
  // one window cache of size_swa upstream; one region of that size PER SLOT on the mac fork
  const sized = swa && swa.window ? Math.min(ctx, swa.window * slots + ubatch) : 0;
  const swaCells = regions ? slots * sized : sized;
  return ((kvElems.full * ctx + kvElems.swa * swaCells) * bytesPer) / 1e9;
}

/**
 * Resident weight bytes when the MoE expert pool is driving this model.
 *
 * Without a pool every byte of the GGUF is resident, which is what weightGB assumes. With one, the pooled experts stay
 * file-backed (CPU_Mapped mmap) and only a slice is held on the device:
 *
 *   non-expert weights          always resident (attention, embeddings, norms)
 *   native layers (slots = 0)   all n_expert experts resident - these are the layers the profile excluded from pooling
 *   pooled layers               slots of n_expert experts resident
 *   ring buffers                n_ring whole layers
 *
 * The last two do NOT add up. The fork places the ring and the pool at the same offsets in one buffer and allocates
 * max(ring_bytes, pool_bytes) - legal because a graph uses one or the other, never both, and the switch invalidates the
 * other's residency. Summing them overstates a 24 GB machine's usage by a whole ring.
 *
 * Sizing a pooled model as fully resident is not conservative, it is wrong in the direction that hurts: on Qwen3.6-35B it
 * reads 19.7 GB against an actual 8.5 GB, so the context ladder drops rungs and the quant tier steps down for memory that
 * was never going to be used.
 *
 * `remap_bytes` (the per-layer expert index tables) is ignored - tens of MB against a budget quoted in whole GB.
 */
export function moeResidentGB(model, quant, pool) {
  const total = weightGB(model, quant);
  if (!pool || !model.expertFrac) return total;
  const layers = pool.layers || [];
  if (!layers.length || !pool.n_expert) return total;
  const expertsGB = total * model.expertFrac;
  const perLayer = expertsGB / layers.length;
  const nativeGB = layers.filter((l) => !(l.slots > 0)).length * perLayer;
  const poolGB = layers.reduce((a, l) => a + (l.slots > 0 ? perLayer * (l.slots / pool.n_expert) : 0), 0);
  // The ring exists to stage POOLED layers. With none, there is no ring and charging for it hides
  // most of what streaming gives back: on qwen3.6-35B that is ~1.9 GB, which is four more layers
  // that could have been native instead.
  const anyPooled = layers.some((l) => l.slots > 0);
  const ringGB = anyPooled ? (pool.ringLayers || 0) * perLayer : 0;
  return total - expertsGB + nativeGB + Math.max(poolGB, ringGB);
}

/**
 * Minimum slots a pooled layer needs, and the floor every sizing path must agree on.
 *
 * One ubatch of routing has to fit or the layer thrashes on every forward. pool_ubatch is (draft + 1) x parallel -
 * the draft tokens of every concurrent sequence land in one graph - and each token routes n_expert_used experts.
 *
 * Reproduces every shipped profile: qwen 6 x 8 = 48, gemma 6 x 8 = 48, and the 9 GB gemma reference 5 x 8 = 40.
 * Derived rather than read from the file's slot_floor, because that value was computed for whatever --parallel and
 * draft depth the profiling run used; changing either here would silently leave the floor too low.
 *
 * Exported so the estimate and the launch plan cannot drift: sizing must model the SAME floor the server gets.
 */
export function moeSlotFloor(profile, { parallel = 2, nExpertUsed = 8 } = {}) {
  if (!profile?.n_expert) return 0;
  return Math.min(profile.n_expert, Math.max(1, ((profile.draft ?? 0) + 1) * parallel * nExpertUsed));
}

/**
 * The cheapest configuration the planner can produce: always-native layers native, every other layer at the floor.
 *
 * This is what the context ladder and quant choice must be sized against - the plan only ever spends MORE than
 * this, so anything the floor cannot afford is genuinely unaffordable. Reading the file's own `slots` instead
 * would size against whatever split the profiling machine happened to use.
 */
export function moeFloorPool(profile, { parallel = 2, nExpertUsed = 8, ringLayers = 0 } = {}) {
  if (!profile?.layers?.length || !profile?.n_expert) return null;
  const floor = moeSlotFloor(profile, { parallel, nExpertUsed });
  return {
    layers: profile.layers.map((l) => ({ ...l, slots: l.miss == null ? 0 : floor })),
    n_expert: profile.n_expert,
    ringLayers,
  };
}

/**
 * Choose which layers run NATIVE (experts on the GPU, stock FFN, pool skipped) for THIS machine.
 *
 * The shipped profile is a measurement, not a decision: it carries a per-layer miss rate taken on one reference
 * machine. How many layers to keep native is a property of the host, so baking it into the file gives a 16 GB Mac
 * the split that suited a 64 GB one. This derives it instead.
 *
 * Two inputs decide it:
 *
 *   miss == null   never pooled during profiling, so unmeasurable and always native. The generator excluded these
 *                  deliberately (layers 0-3 and the last); treat that as the floor, not something to re-litigate.
 *   miss present   rank descending and promote while the budget holds. Highest miss first because a native layer
 *                  does not make its misses cheaper, it deletes them.
 *
 * Why more native is the right direction when memory allows: promoting a layer costs its full expert set on the
 * device but frees BOTH its pool slots and the page cache its file-backed copy wanted, so total demand falls
 * slightly while wired rises. The binding limit is therefore what can be wired, which is exactly what
 * usableModelMemoryGB already answers - so this reuses it rather than inventing a second budget.
 *
 * Marginal cost per layer is `per - per*slots/n_expert` until the pool shrinks to the ring's size, after which
 * max() pins and each further layer costs the full `per`. That knee (~N=19 on Qwen3.6/24 GB) falls out of the
 * loop naturally because the fit is recomputed each step; it does not need special-casing.
 */
export function moeNativePlan(model, profile, {
  bpw, budgetGB, ctx, kvBits, vision = false, ringLayers = 0, parallel = 2, nExpertUsed = 8,
} = {}) {
  const src = profile?.layers || [];
  if (!src.length || !profile?.n_expert) return null;
  const NE = profile.n_expert;
  const quant = { bpw };
  const floor = moeSlotFloor(profile, { parallel, nExpertUsed });
  const ranked = src.filter((l) => l.miss != null).sort((a, b) => (b.miss ?? 0) - (a.miss ?? 0));
  const native = new Set(src.filter((l) => l.miss == null).map((l) => l.il));
  const extra = new Map();                       // il -> slots above the floor

  const build = () => src.map((l) => ({ ...l, slots: native.has(l.il) ? 0 : Math.min(NE, floor + (extra.get(l.il) || 0)) }));
  const fitOf = (layers) => computeFit(model, quant, ctx, kvBits, vision, { layers, n_expert: NE, ringLayers }).totalGB;
  const fits = (layers) => fitOf(layers) <= budgetGB;
  // Pass 1 - promote to native by miss, highest first. A native layer does not make its misses cheaper, it
  // deletes them, so this is the best use of memory until the budget runs out.
  for (const cand of ranked) {
    native.add(cand.il);
    if (!fits(build())) { native.delete(cand.il); break; }
  }
  // Pass 2 - waterfill whatever is left over onto the remaining pooled layers, proportional to miss rate. The
  // leftover is real: pass 1 stops at the first layer that does not fit, and a native layer costs ~5x a slot
  // granule, so the gap below the budget is usually big enough to matter. Slots above the floor do not remove
  // misses but do reduce them, which is the only lever left once no further layer can go native.
  const pooled = src.filter((l) => !native.has(l.il) && (l.miss ?? 0) > 0);
  const headroom = budgetGB - fitOf(build());
  if (pooled.length && model.expertFrac) {
    const perSlotGB = (weightGB(model, quant) * model.expertFrac / src.length) / NE;
    // Slots below the ring's size are FREE. moeResidentGB charges max(poolGB, ringGB) because the two share one
    // buffer (llama-moe-pool.cpp: "Place the ring and the pool at the SAME offsets ... a graph uses one or the
    // other, never both"), so while poolGB < ringGB the buffer is already paid for by the ring and every extra
    // slot costs nothing. Charging perSlotGB for those was leaving the pool far smaller than the allocation it
    // is living in: on qwen3.6-35B with 7 pooled layers the pool held 53 slots/layer (757 MB) inside a 2072 MB
    // ring buffer, when 146/layer fits at zero cost. More slots is a strictly higher decode hit rate.
    const ringGB  = ringLayers * (weightGB(model, quant) * model.expertFrac / src.length);
    const poolGB0 = pooled.length ? build().reduce((a, l) => a + (l.slots > 0 ? perSlotGB * l.slots : 0), 0) : 0;
    const freeSlots = Math.max(0, Math.floor((ringGB - poolGB0) / perSlotGB));
    let budgetSlots = freeSlots + Math.max(0, Math.floor(headroom / perSlotGB));
    if (budgetSlots <= 0) { budgetSlots = 0; }
    const totalMiss = pooled.reduce((a, l) => a + l.miss, 0);
    for (const l of pooled.sort((a, b) => b.miss - a.miss)) {
      if (budgetSlots <= 0) break;
      const want = Math.min(NE - floor, Math.floor(budgetSlots * (l.miss / totalMiss)) + 1, budgetSlots);
      if (want > 0) { extra.set(l.il, want); budgetSlots -= want; }
    }
    // Trim if the proportional pass overshot - fit is the authority, not the estimate that drove it.
    while (extra.size && !fits(build())) {
      const worst = [...extra.entries()].sort((a, b) => b[1] - a[1])[0];
      if (worst[1] <= 1) { extra.delete(worst[0]); } else { extra.set(worst[0], worst[1] - Math.ceil(worst[1] / 4)); }
    }
  }
  const layers = build();
  const pool = { layers, n_expert: NE, ringLayers };
  return {
    layers,
    native: layers.filter((l) => !l.slots).map((l) => l.il).sort((a, b) => a - b),
    residentGB: moeResidentGB(model, quant, pool),
    // False when even the floor configuration overruns the budget - the routing floor is not negotiable (below it
    // a layer thrashes every forward), so the caller must give something else up: a smaller ctx, fewer parallel
    // slots, or a leaner quant. Reported rather than silently returning a plan that does not fit.
    fits: fitOf(layers) <= budgetGB,
    totalGB: fitOf(layers),
  };
}

/**
 * Per-sequence state that is NOT the attention KV cache, and the checkpoint memory on top of it.
 *
 * Two terms kvGB cannot express, because neither scales with context the way a KV cache does:
 *
 *   live recurrent state   a fixed blob per recurrent layer per sequence, held (1 + n_rs_seq) times over for
 *                          speculative rollback. n_rs_seq is the draft depth (2 with the pool profile), and the
 *                          sequence count is the slots plus any resident seed sequences.
 *   checkpoint             one more copy per slot. Qwen has no sliding window on its attention layers, so
 *                          n_swa == 0 and checkpoints are "whole-state" - but that means the whole RECURRENT
 *                          state, not the sequence: they are taken with LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY,
 *                          "work only with partial states, such as SWA KV cache or recurrent cache", while the
 *                          full-attention KV is the inverse flag (BASE_ONLY) and is not in them. With the disk
 *                          tier on only the newest stays resident, so it is one per slot.
 *
 * Both terms are therefore FIXED - no ctx anywhere. On Qwen3.6-35B: 0.80 GB live + 0.40 GB checkpoint = 1.20 GB
 * flat, at any context length.
 */
export function recurrentGB(model, { seqs = 4, rsGroups = 3, slots = 2 } = {}) {
  const r = model.recurrent;
  if (!r) return 0;
  const perLayerSeq = (r.state * r.state * r.heads + r.conv) * 4; // F32
  const stateBytes = perLayerSeq * r.layers * rsGroups;
  return (stateBytes * (seqs + slots)) / 1e9;
}

export function computeFit(model, quant, ctx, kvBits, vision = false, pool = null) {
  const w = moeResidentGB(model, quant, pool);
  const kv = kvGB(model, ctx, kvBits) + recurrentGB(model);
  const overhead = OVERHEAD_BASE_GB + (model.moe ? 0.4 : 0) + (vision && model.vision ? VISION_OVERHEAD_GB : 0);
  return { weightGB: round(w), kvGB: round(kv), overheadGB: round(overhead), totalGB: round(w + kv + overhead) };
}

export function bestQuant(model, budgetGB, ctx, kvBits, pool = null) {
  for (const q of QUANTS) if (computeFit(model, q, ctx, kvBits, false, pool).totalGB <= budgetGB) return q;
  return null;
}

/**
 * Minimum usable context window for a local model. The agent system prompt alone already approaches 8K, so anything
 * below this leaves no room for tools, history, or a real answer — a model that cannot reach 64K is not worth listing.
 * Enforced in three places: Hub search results (hfDownload.searchModels), the selectable context rungs (CTX_LADDER +
 * the UI presets/input), and the recommender's per-model cap. Models whose window is *unknown* are kept (fail open),
 * since HF metadata is frequently incomplete and a wrong exclusion is worse than a wrong inclusion.
 */
export const MIN_CTX = 65536;

// Automatic context tiering (largest to smallest): pick "the largest -c that fits" by device memory, capped at the model's native window (maxCtx).
// The ladder bottoms out at MIN_CTX (64K): below that the system prompt alone eats the window, so those rungs are never offered.
// 256K / 192K / 128K / 96K / 64K, descending - pickCtxKv walks it down and takes the first rung that fits.
// Finer than powers of two on purpose: the gap between 128K and 256K is 2.15 GB of KV on a 26B-class model,
// which is several native layers' worth, so a machine that just misses 256K should not fall all the way to 128K.
export const CTX_LADDER = [262144, 196608, 131072, 98304, 65536];

/**
 * KV cache quantisations offered for catalog models, best first.
 *
 * ONE list, and everything follows from it: the model library's picker lists exactly these, pickCtxKv chooses from exactly these,
 * and gen-seed builds a seed for each. Adding a quantisation later is an edit here plus a seed regeneration — not a hunt through
 * a UI array, a fit ladder and a build script that must be kept in agreement by hand.
 *
 * Just q4 today. The server mixes the KV cache types into the model_key it files disk units under, so a seed built at one
 * quantisation is invisible to a server running at another — offering a choice we do not publish a seed for means some users
 * silently get a cold prefill. q4 rather than q8 because it is what most Macs end up on anyway: the KV cache is the part that
 * scales with context, and halving it is what lets a 24-32 GB machine hold a long conversation at all.
 */
export const KV_BITS_OFFERED = [4];

/** KV cache type for a kvBits value: the -ctk/-ctv argument, and part of the server's model_key. */
export const kvTypeName = (kvBits) => (kvBits === 8 ? "q8_0" : kvBits === 4 ? "q4_0" : "f16");

/**
 * Pick context length and KV quantization for a "model + quant": { ctx, kvBits }.
 * cap is the usable budget, and only that — see the note in the body on why the old deviceMem*0.78 loosening was dropped.
 * Neither of the reasons that loosening cited still holds: q4_0's true 4.5 bits per KV element is now in kvBitsEffective(), and the SWA
 * term is measured from the GGUF rather than taken as an upper bound, so the KV estimate is no longer "conservative" —
 * it reproduces llama.cpp's allocation exactly (verified on 26B: 45.00 + 281.25 MiB base + window, to the decimal).
 * Context is traded before KV precision: the outer loop walks the ladder down, and each rung tries every offered quantisation.
 * When not even the 32K rung fits, fall back to 16K at the leanest offered quantisation. That is deliberately *below* MIN_CTX:
 * a last resort for low-memory devices that would otherwise be unable to launch anything at all, and never user-selectable —
 * the 32K floor governs what can be browsed and chosen, not this internal rescue path.
 */
export function pickCtxKv(model, bpw, hw, budgetGB, vision = false, pool = null) {
  // The budget, and only the budget. This used to be max(budgetGB, deviceMem * 0.78) - a deliberate loosening
  // from when weights were counted at their whole-GGUF size and the honest budget refused rungs the machine
  // could actually hold. Now that pooled models are sized by what they make resident, the fudge only makes this
  // disagree with estimate()'s per-rung verdict: it would default a 16 GB Mac to 128K on 26B while the UI showed
  // that same rung disabled. One budget, one answer.
  const cap = budgetGB || 0;
  const maxCtx = model.maxCtx || MIN_CTX;
  for (const ctx of CTX_LADDER) {
    if (ctx > maxCtx) continue;
    for (const kvBits of KV_BITS_OFFERED) {
      if (computeFit(model, { bpw }, ctx, kvBits, vision, pool).totalGB <= cap) return { ctx, kvBits };
    }
  }
  return { ctx: 16384, kvBits: KV_BITS_OFFERED[KV_BITS_OFFERED.length - 1] };
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
function selectQuant(model, hw, budgetGB, ctx, kvBits, pool = null) {
  if (model.quantTiers) {
    const mem = deviceMemGB(hw);
    const t = model.quantTiers.find((x) => mem >= x.minMemGB);
    return t ? { id: t.quant, bpw: t.bpw, quality: 90, label: t.quant } : null;
  }
  return bestQuant(model, budgetGB, ctx, kvBits, pool);
}

// The quant tags this model offers in the UI quant dropdown, each one's size, and whether it fits: quants with fits=false are disabled (not selectable) in the UI.
// Tiered models (quantTiers) judge fits by deviceMem ≥ minMemGB (same criterion as selectQuant); the rest use the generic QUANTS with totalGB ≤ budget.
// Each quant runs pickCtxKv on its own: size is estimated from "the ctx/kv auto-selected for that quant", and ctx is returned alongside for the UI to display.
// When vision is on and the model supports vision, the size includes the vision-projector overhead (matching the actual launch).
function modelQuants(model, hw, budgetGB, vision = false, pool = null) {
  const mem = deviceMemGB(hw);
  const list = model.quantTiers
    ? model.quantTiers.map((t) => ({ id: t.quant, bpw: t.bpw, fitsByMem: mem >= t.minMemGB }))
    : QUANTS.map((q) => ({ id: q.id, bpw: q.bpw, fitsByMem: null }));
  return list.map((q) => {
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, vision, pool);
    const totalGB = computeFit(model, { bpw: q.bpw }, pick.ctx, pick.kvBits, vision, pool).totalGB;
    return { id: q.id, totalGB, ctx: pick.ctx, kvBits: pick.kvBits, fits: q.fitsByMem ?? totalGB <= budgetGB };
  });
}

/** Auto-select a quant tag for a model (tiered models use the UD tag from quantTiers, the rest use the generic QUANTS); a fallback for when quant isn't explicitly specified at launch. */
export function autoQuantId(model, hw, ctx = MIN_CTX, kvBits = 8) {
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
export function recommend(hw, budgetGB, { ctx = MIN_CTX, kvBits = 8, vision = false, pools = null } = {}) {
  const vram = hw.unified ? 0 : (hw.gpu && hw.gpu.vramGB) || 0;
  const options = [];
  for (const model of MODELS) {
    // The MoE pool changes what "fits": pooled experts stay file-backed, so a pooled model is sized by moeResidentGB
    // rather than by its whole GGUF. Supplied by the caller (localServer owns the profile directory) so this module stays
    // free of filesystem access; absent => every model is sized as fully resident, which is the pre-pool behaviour.
    const pool = pools?.[model.id] || null;
    const q = selectQuant(model, hw, budgetGB, ctx, kvBits, pool);
    if (!q) continue;
    const v = vision && !!model.vision;
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, v, pool); // each model auto-selects ctx / KV quant (overriding the 16K baseline argument)
    const ngl = hw.unified ? 999 : hw.backend === "cpu" ? 0 : gpuLayers(model, q.bpw, pick.ctx, pick.kvBits, vram);
    options.push({ model, quant: q, fit: computeFit(model, q, pick.ctx, pick.kvBits, v, pool), speed: speedHint(model, hw), ctx: pick.ctx, kvBits: pick.kvBits, quants: modelQuants(model, hw, budgetGB, v, pool), ngl, layers: model.arch.L });
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
    pickFrom(options.filter((o) => o.quant.quality >= 85 && o.ctx >= MIN_CTX)) ||
    options.find((o) => o.quant.quality >= 85) ||
    options[0] || null;
  // kvBitsOffered travels with the recommendation so the renderer lists what this process actually supports, instead of holding
  // its own copy that has to be remembered when a quantisation is added. KV_BITS_OFFERED stays the single source.
  return { budgetGB: round(budgetGB), ctx, kvBits, kvBitsOffered: [...KV_BITS_OFFERED], primary, options };
}

/**
 * Build the llama-server launch args. These flags correspond to the "must-haves" from our evaluation of rapid-mlx/oMLX/vmlx,
 * and are all off-the-shelf llama.cpp features (no source changes):
 *   -ngl N          offload N layers to the GPU (Metal/CUDA/Vulkan); for a discrete GPU, partial-offload by VRAM and leave the rest on CPU
 *   -fa on          flash attention (faster + saves KV VRAM on long contexts)
 *   -ctk/-ctv q8_0  KV cache quantization
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
 *   --chat-template-file F  load the chat template from a Jinja file shipped alongside the weights. Takes priority over both
 *                   the embedded GGUF template and --chat-template NAME: a repo that ships an explicit template file is
 *                   stating the authoritative template, and it is also the escape hatch for fixing a broken embedded one
 *                   by dropping a file into the model directory. Only one of the two flags is ever passed (file wins).
 * Local first: given modelPath → `-m FILE` (+ explicit `--mmproj FILE` when vision), the weights already downloaded by us (with progress/resume);
 * if not auto-downloaded (fallback path) → `-hf repo:quant` is fetched by llama itself, and only then, when noMmproj=true, is --no-mmproj used to turn off the automatic vision projector.
 */
export function buildServerArgs({ hf, modelPath = null, hw, ctx = MIN_CTX, port = 8080, kvBits = 8, mtpDraft = null, specMtp = false, mmproj = null, noMmproj = false, kvDiskDir = null, parallel = 0, ngl = null, chatTemplate = null, chatTemplateFile = null, reasoningBudget = null, reasoningBudgetMessage = null, extraArgs = [] }) {
  const args = modelPath ? ["-m", modelPath] : ["-hf", hf];
  args.push(
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(ctx),
    "-ngl", String(ngl != null ? ngl : (hw && hw.backend === "cpu" ? 0 : 999)),
    // Not optional while the KV cache is quantized: llama_init_from_model rejects a quantized V cache
    // without it ("V cache quantization requires flash_attn"), so -ctv q4_0 below forces -fa on.
    "-fa", "on",
    "--jinja",
  );
  // An explicit template file outranks a built-in name, which in turn outranks the GGUF's embedded template.
  if (chatTemplateFile) args.push("--chat-template-file", String(chatTemplateFile));
  else if (chatTemplate) args.push("--chat-template", String(chatTemplate)); // override a broken embedded template with a built-in
  const kvType = kvTypeName(kvBits);
  if (kvType !== "f16") args.push("-ctk", kvType, "-ctv", kvType);
  // NO --cache-reuse. What it would do: salvage the one prefix break a reasoning model creates every
  // turn. The model generates `assistant\n<think>…</think>VISIBLE`, the template strips the think block
  // when replaying that turn, so the cached prefix dies at the first token of the reply and VISIBLE is
  // recomputed; cache-reuse slides past the gap, finds VISIBLE still in the cache, and SHIFTS it into
  // position instead. (Not the old prompt cache, and not something the unified KV pool replaced - the
  // pool decides where cells LIVE, this decides whether a diverged tail can be moved rather than redone.)
  //
  // Not passed, because it cannot activate on anything we ship. The server drops it to 0 at startup
  // unless llama_memory_can_shift() is true, and every catalog model fails that test:
  //
  //     llama_kv_cache::get_can_shift()       false when n_pos_per_embd() > 1   <- Qwen3.6 (IMROPE)
  //     llama_kv_cache_iswa::get_can_shift()  requires base size == SWA size    <- every Gemma
  //
  // Confirmed live, not just read: a 24 GB simulation run logs "cache_reuse is not supported by this
  // context, it will be disabled" at startup. Passing it only bought that warning line.
  //
  // What removing it gives up: it would have switched itself on the moment a model qualified. If a
  // future model has n_pos_per_embd() == 1 and, for Gemma-likes, base size == SWA size, put it back -
  // the measured spans it needs to catch are 33 (a tool-call message), 185 (a short reply) and 418
  // (parallel tool calls), so the value is 32, not the 256 that caught only the largest of the three.
  //
  // (It is NOT disabled by multimodal any more; the fork made that decision per request instead.)
  //
  // --swa-full would clear the Gemma row, but it is NOT the cheap flag it looks like - the server's
  // effective n_swa becomes 0, which feeds derive_model_key (so every seed and pool unit is orphaned
  // under a new model_key) and switches context checkpoints from windowed to whole-state. Nothing
  // clears the Qwen row.
  // -ub 1536: the MoE ring stages every expert of every pooled layer ONCE PER FORWARD, a cost that is
  // flat in the ubatch, so halving the number of forwards halves that staging. n_batch is deliberately
  // left at llama.cpp's 2048 default - it governs how a prompt splits across server batches, not how
  // many forwards a batch becomes, and tying the two shrinks the server batch for no benefit.
  //
  // This buys prefill WITH decode - it is a trade, not a free win. Three consecutive runs on one host,
  // simulated 24 GB Mac (qwen3.6-35B UD-Q4_K_XL, ctx 262144, corpus prompt, nat23/draft3):
  //
  //     ub    prefill   decode   wired      ring fill
  //      512    112.9    24.08   +17.5 GB   61.1 GiB
  //     1024    172.8    23.84   +17.9 GB   47.7 GiB
  //     2048    266.3    21.63   +19.0 GB   39.7 GiB
  //
  // Prefill rises because the staged volume falls. Decode falls because the activation buffers grow
  // ~1 GB per doubling (325 -> 1300 MiB of GPU compute across 512 -> 2048) and that GB comes out of
  // the page cache the pooled experts are read from, so the decode-side miss traffic gets slower.
  //
  // 1536 is a chosen midpoint between the 1024 and 2048 rows, NOT a measured one - the table above has
  // no entry for it. It is not a power of two, which nothing here requires: n_ubatch only has to divide
  // the work, and a MoE forward's cost is set by the layers it stages, not by the batch being a power
  // of two. Measure before quoting a number for it.
  args.push("-ub", "1536");
  // Per-model, from the catalog - see MODELS[].reasoningBudget. Absent means unrestricted, which is llama's default.
  if (reasoningBudget > 0) {
    args.push("--reasoning-budget", String(reasoningBudget));
    if (reasoningBudgetMessage) args.push("--reasoning-budget-message", String(reasoningBudgetMessage));
  }
  // Two slots so a second conversation can stay warm alongside the active one, instead of evicting it. Naming the count is what
  // keeps it CHEAPER than leaving it unset: unset means auto = 4 slots, and n_seq_max drives the iSWA cache
  // (min(size_base, n_swa * n_seq_max + n_ubatch) — the multiplier is on n_swa, not n_ubatch), and the mac fork
  // then gives each slot its own region of that size. So SWA memory grows with the SQUARE of the slot count on a
  // Gemma-class model: 4 slots costs 4x what this comment used to imply, not 2x. kvGB() models both factors.
  //
  // `--kv-unified` states the requirement in the argv rather than leaning on a default. Without a unified pool llama-context
  // derives `n_ctx_seq = n_ctx / n_seq_max` (src/llama-context.cpp) instead of `n_ctx_seq = n_ctx`, which would halve every
  // conversation's usable context and shard the KV into private lanes with no prefix sharing — the opposite of what the disk
  // tier below is built around. The mac fork already resolves an explicit --parallel to unified unless --no-kv-unified is
  // passed, so this is belt-and-braces, not a workaround.
  if (parallel > 0) args.push("--parallel", String(parallel), "--kv-unified");
  // KV disk tier: spill/restore prompt prefixes across restarts, and the folder resident seeds are installed into
  // (<dir>/<model_key>/). Must be durable: unlike a temp-dir cache, these files are meant to survive a reboot.
  if (kvDiskDir) args.push("--kv-disk-path", kvDiskDir);
  // A byte budget, because without one the directory only ever grows. The server's GC treats a conversation as live while
  // its committed tip manifest exists, and deleting a conversation in the app does not remove that tip — so at the default
  // 0 the GC does an orphan-sweep only (crash leftovers), the LRU-by-mtime eviction it implements never runs, and every
  // conversation ever held keeps its KV forever. Measured at 1.6 GB across four models before this was set.
  //
  // 10 GiB: large enough that an active conversation is never evicted mid-use (a 256K-context spill is well under 1 GiB),
  // small enough to bound the directory on a laptop. Eviction is by tip mtime and resident conversations rewrite their tip
  // every turn, so the LRU victim is always something untouched — and anything evicted in error is simply re-spilled.
  if (kvDiskDir) args.push("--kv-disk-mib", "10240");
  if (mtpDraft) args.push("-md", mtpDraft); // Gemma: separate MTP drafter file
  // MTP speculative-decoding flag (b9936): Gemma needs an -md drafter; Qwen weights embed the MTP head → the flag alone enables self-speculation.
  // Omitted when there's no separate drafter and it's not embedded (specMtp=false), to avoid draft-mtp erroring out when it can't find an MTP head.
  if (specMtp) args.push("--spec-type", "draft-mtp");
  if (mmproj) args.push("--mmproj", mmproj); // explicit file override (usually unused)
  else if (noMmproj) args.push("--no-mmproj"); // vision off: don't load the vision projector that -hf brings in automatically
  return args.concat(extraArgs);
}
