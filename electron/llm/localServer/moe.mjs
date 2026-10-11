/**
 * MoE expert-pool profiles for the local llama-server (main process): the bundled per-model routing profiles, the pool shape
 * the memory estimate sizes against, the native/pooled split derived for this machine at launch, and the env the pool needs.
 *
 * Part of localServer.mjs; internal — nothing here is re-exported from that entry.
 */
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { usableModelMemoryGB, MODELS, moePoolEnabled, moeNativePlan, moeFloorPool } from "../localModels.mjs";
import { localFilesBase } from "../llamaInstaller.mjs";

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
export const MOE_RING_LAYERS = 4;

/** Concurrent sequences (the --parallel passed to buildServerArgs) and experts routed per token. Both feed the
 *  slot floor, so they are named here rather than repeated as literals at each call site. */
export const MOE_PARALLEL = 2;
export const MOE_EXPERT_USED = 8;

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
export function moeEnv(moeProfile) {
  return {
    LLAMA_MOE_POOL_PROFILE: moeProfile,
    LLAMA_MOE_RING: "1",
    GGML_METAL_SEG_ASYNC: "1",
    // 0 = OFF. See the note at the buildServerArgs call in localServer.launch(): the split can only route a prefill through the pool
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
export function moeShippedProfile(modelId) {
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

export function moePoolInfo(modelId) {
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
export function moeProfileFor(model, { hw, bpw, ctx, kvBits, vision = false, log = () => {} } = {}) {
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
export function moePools() {
  const out = {};
  for (const m of MODELS) {
    const info = moePoolInfo(m.id);
    if (info) out[m.id] = info;
  }
  return out;
}
