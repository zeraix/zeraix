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
 *
 * This file is the public entry and owns the server lifecycle (start / launch / stop / reset and the health poll). The rest lives
 * in localServer/, re-exported below so importers keep using this path: state.mjs (status, listeners, run log),
 * kvErase.mjs (forgetting deleted conversations' KV), storage.mjs (storage folder + model files on disk),
 * moe.mjs (MoE pool profiles and env), setup.mjs (hardware, install, probe, sizing, Hub browsing).
 * The parts import from each other, never from this file.
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import {
  detectHardware, usableModelMemoryGB, buildServerArgs,
  MODELS, autoQuantId, quantBpw, gpuLayers, isSharedGpu, pickCtxKv, descriptorFromGguf, MIN_CTX, kvTierEnabled, seedAvailable, KV_BITS_OFFERED,
} from "./localModels.mjs";
import { ensureInstalled, installedBin, llamaVariant, fallbackVariant, localFilesBase } from "./llamaInstaller.mjs";
import { downloadModel, resolveRevision } from "./hfDownload.mjs";
import { SEED_PREFIX, SEED_KVD, MAC_LLAMA_TAG } from "../versions.mjs";
import { ensureSeed, seedSize, seedInstalled, seedKey } from "./seeds.mjs";
import { state, kvDiskDir, resolveHfEndpoint, umaCache, openLog, closeLog, status, emit, pushLog } from "./localServer/state.mjs";
import { flushPendingErase } from "./localServer/kvErase.mjs";
import { modelQuantDir, localModelFiles, isModelInstalled, sweepStaleSeeds } from "./localServer/storage.mjs";
import { moePoolInfo, moeProfileFor, moeEnv } from "./localServer/moe.mjs";
import { parseUma } from "./localServer/setup.mjs";

export { status, onStatus } from "./localServer/state.mjs";
export { eraseConversationKv, eraseConversationsKv, flushPendingErase } from "./localServer/kvErase.mjs";
export {
  storageInfo, setStorageDir, migrateStorageTo, modelsDir, deleteUnversionedModelDirs, sweepSuperseded, sweepStaleSeeds,
  modelQuantDir, listDownloaded, deleteLocalModel,
} from "./localServer/storage.mjs";
export {
  getHardware, llamaInfo, estimate, installInfo, installStatus, recommend, hfSearch, hfRepo, install, probe,
} from "./localServer/setup.mjs";

let healthTimer = null;
// Incremented on each start()/stop(): an in-progress launch() checks after every await point, and if stale (the user
// restarted or stopped during "downloading/loading") it no longer spawns, avoiding leaking a second llama-server process.
let launchGen = 0;
let umaScanned = false; // whether uma has already been captured from stderr within this launch (stop scanning once captured, to avoid re-parsing)

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
  // One user-facing switch ("speculative decoding", on unless turned off) resolved against whichever
  // drafter the model actually has. Keeping these separate matters: a model with a DSpark drafter
  // declares mtp:false, so folding the two into mtpOn made the draft branch unreachable by
  // construction rather than merely unused - it launched without -md and looked like a race.
  const specOn  = opts.mtp !== false;
  const mtpOn   = !!r.mtp && specOn;              // MTP head (embedded, or a sidecar in the model's repo)
  const draftOn = !!r.model?.draft && specOn;     // a separate drafter model (DSpark)
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
  launch(variant, { r, hw, ctx, kvBits, visionOn, visionCharged, mtpOn, draftOn, gen, modelDir, modelRevision });
  emit();
  return status();
}

/** Install (download if needed) the given variant -> bring up llama-server; if a GPU build fails before ready, automatically fall back to the next level (the CPU variant has no fallback, so no infinite recursion). */
async function launch(variant, cfg) {
  // visionOn decides what the SERVER does (whether --mmproj is passed at all); visionCharged decides
  // what the memory plan RESERVES. They differ on the mac fork, which releases the projector between
  // images - see where visionCharged is derived.
  const { r, hw, ctx, kvBits = KV_BITS_OFFERED[0], visionOn, visionCharged = visionOn, mtpOn, draftOn, gen } = cfg;
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
    for (const sm of seedAvailable(r.id) ? Object.keys(SEED_PREFIX ?? {}) : []) {
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
    // A standalone drafter that is not on disk has to be fetched even when the weights are fully
    // installed, or the model launches without speculative decoding forever: the drafter rides
    // downloadModel, and downloadModel only runs on this branch. Two kinds qualify - the MTP
    // sidecar from the model's own repo (Gemma) and a `draft` descriptor pointing at a repo of
    // ours (bonsai). Sending it through the same branch is what puts it on the existing progress
    // bar; downloadFile skips any file already complete, so only the drafter actually transfers.
    const draftSpec = r.model?.draft || null;
    const draftMissing = !!draftSpec && !fs.existsSync(path.join(destDir, path.basename(draftSpec.path)));
    const drafterMissing = (mtpSeparate && !local.mtp) || draftMissing; // needs a standalone drafter but not present locally -> needs to be fetched (~hundred MB)
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

    // Retire superseded seeds here, before installing this launch's, and nowhere else. Sweeping after the install deletes the
    // seed just unpacked; sweeping from getHardware() can run against a live server. sweepStaleSeeds explains both.
    if (seedPlan.length) {
      try {
        for (const r of sweepStaleSeeds()) {
          if (r.removed) pushLog(`[seed] reclaimed (${r.why}): ${path.basename(r.dir)}\n`);
        }
      } catch (e) {
        pushLog(`[seed] sweep skipped: ${e?.message ?? e}\n`); // never throw into the launch path
      }
    }

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
  if (draftSpec && draftOn) {
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
  const args = buildServerArgs({ modelPath, mmproj: visionOn ? mmprojPath : null, mtpDraft, specMtp: useMtp, specDraft, hw, ctx, port: state.port, kvBits, kvDiskDir: kvTier ? kvDiskDir() : null, parallel: kvTier ? 2 : 0, ngl, chatTemplate: r.chatTemplate, chatTemplateFile: templatePath, reasoningBudget: r.model?.reasoningBudget ?? null, reasoningBudgetMessage: r.model?.reasoningBudgetMessage ?? null, sampling: r.model?.sampling ?? null });
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
      if (ok && !state.ready) {
        state.ready = true; state.phase = "ready"; state.error = null; emit(); stopHealthPoll();
        // Conversations deleted while no server was running left their ids queued; this is the first moment
        // anything can act on them.
        void flushPendingErase();
      }
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
