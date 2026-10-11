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
 *
 * This file is the public entry. The catalog (QUANTS, MODELS, seed / MoE-pool allowlists, descriptorFromGguf) lives in
 * localModels/catalog.mjs and the hardware + memory-fit math (detectHardware, usableModelMemoryGB, kvGB, computeFit, the MoE
 * pool model) in localModels/fit.mjs; both are re-exported below, so importers keep using this path. Context / KV tiering,
 * quant selection, recommend() and buildServerArgs() stay here.
 */
import { QUANTS, MODELS } from "./localModels/catalog.mjs";
import { round, usableModelMemoryGB, kvGB, computeFit, bestQuant, SERVER_UBATCH } from "./localModels/fit.mjs";

export {
  QUANTS, SEED_MODELS, MOE_POOL_MODELS, moePoolEnabled, kvTierEnabled, seedAvailable, MODELS, descriptorFromGguf,
} from "./localModels/catalog.mjs";
export {
  detectHardware, isSharedGpu, usableModelMemoryGB, weightGB, kvBitsEffective, SERVER_UBATCH, serverKvShape, kvGB,
  moeResidentGB, moeSlotFloor, moeFloorPool, moeNativePlan, recurrentGB, computeFit, bestQuant,
} from "./localModels/fit.mjs";

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
 * The rungs for ONE model, largest first: the shared ladder capped at its native window, with that window
 * itself on top whenever it is not already a rung.
 *
 * The ladder is powers-of-two-ish, and a native window that is not costs the model everything between the
 * two: LFM2.5's is 128000, so ladder-only rungs stop at 98304 and 30K of usable context disappears for no
 * reason — the fit at 128000 is 4.1 GB against a 5.00 GB budget on the machine it targets.
 *
 * The renderer already worked this way (ctxPresets in ModelLibrary.tsx: "always ending at the window
 * itself, so a non-power-of-2 max like 40960 gets its exact value as the top button"). The main process
 * did not, so the UI offered a rung the recommender would never pick and estimate() never priced. This is
 * the same rule on both sides rather than a new one.
 */
export function ctxLadder(model) {
  const maxCtx = model?.maxCtx || MIN_CTX;
  if (maxCtx < MIN_CTX) return [];
  // A model may state its own rungs. Worth doing only when the ladder has nothing to offer: the rungs
  // exist to trade context for memory, and on a model whose whole KV at the native window is a fraction
  // of a gigabyte there is no trade to make - see ctxRungs on lfm2.5-2.6b.
  if (model?.ctxRungs?.length) {
    return model.ctxRungs.filter((c) => c <= maxCtx).sort((a, b) => b - a);
  }
  const rungs = CTX_LADDER.filter((c) => c <= maxCtx);
  return rungs[0] === maxCtx ? rungs : [maxCtx, ...rungs];
}

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
  for (const ctx of ctxLadder(model)) {
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
    // A model may be restricted to certain platforms when its weights need a ggml type only some
    // builds carry (ternary-bonsai-27b is PQ2_0, macOS only). Absent = available everywhere, so
    // every existing entry is unaffected. Filtered here rather than at the MODELS literal because
    // this is the one place that knows the host, and because the catalog must stay complete for
    // localServer's by-id lookups - a model already downloaded still has to resolve.
    if (model.platforms && !model.platforms.includes(hw.platform)) continue;
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
export function buildServerArgs({ hf, modelPath = null, hw, ctx = MIN_CTX, port = 8080, kvBits = 8, mtpDraft = null, specMtp = false, specDraft = null, mmproj = null, noMmproj = false, kvDiskDir = null, parallel = 0, ngl = null, chatTemplate = null, chatTemplateFile = null, reasoningBudget = null, reasoningBudgetMessage = null, sampling = null, extraArgs = [] }) {
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
  // -ub 2048: the MoE ring stages every expert of every pooled layer ONCE PER FORWARD, a cost that is
  // flat in the ubatch, so halving the number of forwards halves that staging. n_batch is deliberately
  // left at llama.cpp's 2048 default - it governs how a prompt splits across server batches, not how
  // many forwards a batch becomes, and tying the two shrinks the server batch for no benefit.
  //
  // This USED to be a trade. The original table, on a build where the compute buffers were reserved
  // for n_ubatch and held for the context's life:
  //
  //     ub    prefill   decode   wired      ring fill
  //      512    112.9    24.08   +17.5 GB   61.1 GiB
  //     1024    172.8    23.84   +17.9 GB   47.7 GiB
  //     2048    266.3    21.63   +19.0 GB   39.7 GiB
  //
  // Prefill rose because staged volume fell; decode fell because the activation buffers grew ~1 GB per
  // doubling and that GB came out of the page cache the pooled experts are read from. 1536 was picked
  // as a midpoint to split that difference - it was never measured, only interpolated.
  //
  // The decode half of the trade is GONE. The fork now sizes those buffers for the batch actually
  // running and releases them between turns, so a wide ubatch no longer costs standing memory:
  // measured at 15.85 GB wired for ub 2048 against 15.80 GB for ub 1536, i.e. nothing. What is left is
  // the prefill half, and at 1536 the ring stages 22% MORE bytes for the same prompt (49.25 GiB against
  // 40.33 GiB) - which is why 1536 now loses on both axes. Same host, same profile, same binary:
  //
  //     ub    prefill   decode   ring fill
  //     1536    186.2    22.61   49.25 GiB
  //     2048    332.1    20.92   40.33 GiB
  //
  // Decode at 1536 still reads higher in that pair, but those runs predate the MoE warm-path and pool
  // layout fixes; at 2048 on the current build decode is 20.9-21.2 and prefill is 332, so 2048 is ahead
  // on prefill by 78% and within noise on decode. 1536 also failed the 200 tok/s prefill floor outright.
  args.push("-ub", String(SERVER_UBATCH));
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
  if (specMtp) {
    args.push("--spec-type", "draft-mtp");
    // Quantize the DRAFTER's KV cache too. It defaults to f16 independently of -ctk/-ctv (common.h:
    // speculative.draft.cache_type_k = GGML_TYPE_F16), so the drafter was running an f16 cache beside
    // a q4_0 target. On qwen3.6 that one nextn layer at ctx 262144 is 512 MiB; at q4_0 it is 144 MiB.
    //
    // Output-safe for the same reason the draft-head row cap is: the target verifies every drafted
    // token, so a coarser draft cache can cost acceptance rate but never correctness. Verified rather
    // than assumed - identical output hash (135fde6b6aa2d51e) and decode 34.17 vs 34.04 tok/s, f16
    // against q4_0, same prompt.
    args.push("-ctkd", "q4_0", "-ctvd", "q4_0");
  }
  // DSpark drafter (ternary-bonsai-27b). A different --spec-type from MTP, and it needs its two tuning
  // flags passed explicitly because the server's defaults are wrong for it:
  //
  //   --spec-draft-n-max 7   the drafter is TRAINED at block_size 4, so 7 looks wrong. It is not: the
  //                          target verifies 1 + n_draft tokens in ONE batch, and that batch costs the
  //                          same at 4 as at 8 (pp4 148.4ms, pp5 147.2, pp8 149.4 - flat, because the
  //                          8-wide tile's dequantise-and-stage half does not depend on the column
  //                          count). The surplus over the trained block is therefore free, and the
  //                          drafter fills it from token history. Dropping to 4 measured 1.227x
  //                          against 1.262x - the three spare columns are worth 3.5%.
  //   --spec-draft-p-min 0.7 truncate the block at the first position the confidence head puts below
  //                          this. The width chooser prices each width against its measured cost, so
  //                          this only bounds it; it is not what picks the width.
  //
  // NOT passed: -ctkd/-ctvd. Quantising the DRAFTER's cache is measured and safe for MTP above, but
  // this drafter carries a recurrent state as well as KV and that combination was never measured. An
  // unmeasured flag on a path that only costs acceptance is not worth the silent risk.
  if (specDraft && specDraft.path) {
    args.push("-md", specDraft.path, "--spec-type", "draft-dspark");
    if (specDraft.nMax != null) args.push("--spec-draft-n-max", String(specDraft.nMax));
    if (specDraft.pMin != null) args.push("--spec-draft-p-min", String(specDraft.pMin));
  }
  // Sampling, when the catalog entry declares it. Nothing is emitted otherwise, so every model that
  // shipped before this keeps the server defaults it was measured with.
  //
  // It belongs on the LAUNCH, not in the request body: the app sends no sampling fields at all (see
  // openai-adapter.ts, which builds model/messages/max_tokens and nothing else), so a per-model value
  // put in the request would have to travel from the catalog, through the main process, into the
  // renderer's chat path. The server takes the same numbers as flags and applies them to every
  // request, including ones the app does not originate.
  //
  // Flag names are the ones this build prints in --help; the map exists so a typo is a missing flag
  // at review time rather than an argument llama-server silently rejects at launch.
  const SAMPLING_FLAGS = {
    temp: "--temp", topK: "--top-k", topP: "--top-p", minP: "--min-p",
    presencePenalty: "--presence-penalty", frequencyPenalty: "--frequency-penalty",
    repeatPenalty: "--repeat-penalty", repeatLastN: "--repeat-last-n",
    dryMultiplier: "--dry-multiplier", dryBase: "--dry-base",
    dryAllowedLength: "--dry-allowed-length", dryPenaltyLastN: "--dry-penalty-last-n",
    // Repeatable: llama.cpp clears its default list on the FIRST --dry-sequence-breaker and appends
    // each one after that (common/arg.cpp), so an array here replaces the defaults wholesale.
    drySequenceBreakers: "--dry-sequence-breaker",
  };
  if (sampling) {
    for (const [key, flag] of Object.entries(SAMPLING_FLAGS)) {
      const v = sampling[key];
      if (v == null) continue;
      if (Array.isArray(v)) for (const one of v) args.push(flag, String(one));
      else args.push(flag, String(v));
    }
  }
  if (mmproj) args.push("--mmproj", mmproj); // explicit file override (usually unused)
  else if (noMmproj) args.push("--no-mmproj"); // vision off: don't load the vision projector that -hf brings in automatically
  return args.concat(extraArgs);
}
