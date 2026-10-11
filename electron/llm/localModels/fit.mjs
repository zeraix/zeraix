/**
 * Hardware detection and memory-fit math for local models (main process, pure logic, no side effects): device detection, the
 * usable memory budget, weight / KV / recurrent-state sizing, the MoE expert-pool residency model and native/pooled split,
 * and computeFit, which every sizing path goes through.
 *
 * Part of localModels.mjs, which re-exports the public names here — import from that entry, not from this file.
 */
import os from "node:os";
import { execSync } from "node:child_process";
import { QUANTS, kvTierEnabled } from "./catalog.mjs";

export const round = (n) => Math.round(n * 10) / 10;

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
    //
    // 0.75 -> 0.70, UNDER TEST. Everything above was measured on a simulated 24 GB Mac, where the
    // budget is the binding constraint and a larger one always won. It says nothing about a machine
    // with room to spare: at 0.75 a 38.7 GB Mac budgets 29.0 GB and puts every layer native for both
    // models, so the reserve is the only thing the factor still controls there. 0.70 budgets 27.1 GB,
    // which is the first step that makes qwen3.6-35b pool again on this size of machine - gemma4-26b
    // stays 30/30 either way. Revert to 0.75 if decode or prefill regresses.
    return round(Math.max(2, hw.totalMemGB < 10 ? hw.totalMemGB - 3 : hw.totalMemGB * 0.70));
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
// The physical ubatch buildServerArgs launches with. It is HERE and not a literal at the push site
// because kvGB needs the same number: an SWA cache is sized
// slots * min(ctx, window*slots + n_ubatch), so a wrong ubatch under-counts the window cache by one
// ubatch per slot. That is exactly what happened - kvGB defaulted to 512 while the launcher passed
// 1536, and no caller ever passed the real value, so every SWA fit was low. Measured on gemma-4-26B
// at ctx 262144, --parallel 2:
//
//     ubatch 512  -> kvGB 1.805 GB     ubatch 2048 -> kvGB 1.982 GB
//     actual: 1440.00 MiB (262144 cells, 5 layers) + 450.00 MiB (8192 cells, 25 layers) = 1.982 GB
//
// One constant, two readers, so they cannot disagree again.
export const SERVER_UBATCH = 2048;

export const serverKvShape = () => ({
  slots: kvTierEnabled() ? 2 : 4,
  regions: process.platform === "darwin" && process.arch === "arm64",
  ubatch: SERVER_UBATCH,
});

export function kvGB(model, ctx, kvBits, opts = {}) {
  const { L, kvH, hd, swa, kvElems } = model.arch;
  const shape = serverKvShape();
  const { slots = shape.slots, regions = shape.regions, ubatch = shape.ubatch } = opts;
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
/**
 * Recurrent (GDN/SSM) state size. NOT per-token: a fixed blob per layer per SEQUENCE, so it does not
 * scale with ctx - only with how many sequences the server reserves.
 *
 * MEASURED per sequence, not derived, for the same reason kvElems is read from the GGUF rather than
 * computed from L/kvH/hd. The previous version derived it as
 *
 *     (state^2 * heads + conv) * 4 * layers * rsGroups * (seqs + slots)
 *
 * with rsGroups = 3 and seqs = 4 - two multipliers that appeared nowhere else in the codebase, had no
 * comment, and were never passed by a caller. It returned 1.203 GB against an actual 0.395 GB, 3.0x
 * over, by over-counting the multipliers ~9x and under-counting the per-layer term ~3x. Compensating
 * errors in an expression nobody could check.
 *
 * llama.cpp's own n_embd_s() (llama-hparams.cpp:207) is ssm_d_state * ssm_d_inner = 128 * 4096 for
 * this model, which predicts 160 MiB where 360 MiB is allocated - the remaining 2.25x is
 * architecture-specific head geometry. Rather than re-derive that and risk a third wrong guess, take
 * the number the server prints at startup:
 *
 *     llama_memory_recurrent: size = 376.88 MiB (2 cells, 40 layers, 2 seqs 2 rs_seq)
 *                             R (f32) 16.88 MiB, S (f32) 360.00 MiB
 *
 * qwen3.6-35b-a3b, --parallel 2. 376.88 MiB / 2 seqs = 188.44 MiB per sequence. To re-derive for
 * another model: launch it and read that line.
 */
export function recurrentGB(model, { seqs = 2 } = {}) {
  const r = model.recurrent;
  if (!r || !r.perSeqMiB) return 0;
  return (r.perSeqMiB * 1048576 * seqs) / 1e9;
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
