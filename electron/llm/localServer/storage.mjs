/**
 * Local model storage (main process): the storage folder (location, free space, migration), the GGUF model directories under
 * it (layout, classification, installed list, delete), and the housekeeping that reclaims superseded model versions and seeds.
 *
 * Part of localServer.mjs, which re-exports the public names here.
 */
import path from "node:path";
import fs from "node:fs";
import { MODELS, MIN_CTX, seedAvailable, KV_BITS_OFFERED } from "../localModels.mjs";
import { localFilesBase } from "../llamaInstaller.mjs";
import { SEED_PREFIX, SEED_KVD } from "../../versions.mjs";
import { getAppConfig, setAppConfig } from "../../appConfig.mjs";
import { seedKey } from "../seeds.mjs";
import { state, kvDiskDir, pushLog } from "./state.mjs";

/**
 * Bring on-disk state in line with the current pins. Runs once per launch, before anything reads the model list.
 *
 * Two steps: drop pre-versioning installs, whose revision is unknown and unknowable, then reclaim the model versions the current
 * pins have superseded. Both concern the MODELS directory, which is what the caller is about to read.
 *
 * Seeds are deliberately not swept here. Retiring a seed removes a directory this launch may be about to install into, so it has
 * to run in the launch path immediately before the install — see sweepStaleSeeds.
 *
 * Both delete without asking, for the same reason: what they remove can never be loaded again. A superseded version directory
 * names a revision the catalog no longer points at, and an unversioned directory has no revision at all, so neither can satisfy
 * the pinned path the launcher builds. Keeping them costs tens of gigabytes to no end; the cost of removing them is one
 * re-download.
 *
 * Never throws: storage housekeeping must not be able to stop the app from launching.
 */
export function runStorageMaintenance() {
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
export function localModelFiles(dir, prefer = null) {
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

/** Remove `dir`, recording the outcome. Shared by both sweeps so a dry run reports identically. */
function rmRecording(removed, dryRun, dir, why, extra) {
  const rec = { dir, why, ...extra, removed: false, error: null };
  if (!dryRun) {
    try { fs.rmSync(dir, { recursive: true, force: true }); rec.removed = true; } catch (e) { rec.error = e.message; }
  }
  removed.push(rec);
}

/**
 * Reclaim model versions the catalog no longer pins: any `<repo_>/<rev8>/` that is not the current
 * revision. Safe to delete outright — unlike the legacy layout, a version dir says exactly which
 * revision it is, so there is no ambiguity about what is being removed.
 *
 * Seeds are NOT swept here; see sweepStaleSeeds and the note on where it has to run.
 */
export function sweepSuperseded({ dryRun = false } = {}) {
  const removed = [];
  const rm = (dir, why, extra) => rmRecording(removed, dryRun, dir, why, extra);

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

  return removed;
}

/**
 * Retire seeds the current pins can no longer use: a marker whose key names a prefix, revision or KV
 * quantisation we would not install today. The marker's body is the model_key directory it unpacked
 * into, and that whole directory goes.
 *
 * Nothing in it survives the change that retired the seed. A manifest is a restore candidate only if
 * one of its checkpoints sits at or before the shared prefix (kv_disk_find_prefix_match in the fork),
 * and a prompt change diverges inside the tool block — before any turn boundary — so every
 * conversation's checkpoints, and the retired seed's own, fall past it. It is dead weight, not cache.
 *
 * CALLED FROM THE LAUNCH PATH, IMMEDIATELY BEFORE INSTALLING THIS LAUNCH'S SEEDS, and from nowhere
 * else. Both constraints matter:
 *
 *   - Before the install, because model_key covers KV geometry and not the prefix: a seed update
 *     changes only the marker NAME and leaves the directory identical. Sweeping afterwards deletes the
 *     seed just unpacked while its marker survives, so seedInstalled() reports true forever and it is
 *     never fetched again.
 *   - Not from getHardware(), which fires whenever the model library mounts — including mid-session,
 *     with a server running and holding this directory. At launch the previous server has already been
 *     stopped.
 */
export function sweepStaleSeeds({ dryRun = false } = {}) {
  const removed = [];
  const rm = (dir, why, extra) => rmRecording(removed, dryRun, dir, why, extra);

  const kv = kvDiskDir();
  let entries = [];
  try { entries = fs.readdirSync(kv); } catch { entries = []; }
  const liveKeys = new Set();
  // Every seed we would install today is live; anything else in the directory belongs to a prefix, revision or KV quantisation
  // that is no longer used. Iterating KV_BITS_OFFERED rather than the running launch's setting matters — a user who switches
  // quantisation and back must not have the first seed swept while the second is in use.
  for (const m of MODELS) {
    if (!seedAvailable(m.id)) continue;
    // Driven by whatever versions.json publishes rather than a literal list. It used to be ["daily", "dev"]; daily merged
    // into dev, and a hardcoded list would have kept the retired seed in liveKeys forever — never swept, never used.
    for (const mode of Object.keys(SEED_PREFIX ?? {})) {
      if (!SEED_PREFIX?.[mode]) continue;
      for (const kvBits of KV_BITS_OFFERED) {
        liveKeys.add(`.seed-${m.id}-${mode}-${seedKey({ prefixHash: SEED_PREFIX[mode], revision: m.revision, kvdVersion: SEED_KVD, kvBits })}`);
      }
    }
  }
  for (const e of entries) {
    if (!e.startsWith(".seed-") || liveKeys.has(e)) continue;
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

export function isModelInstalled(model, quant) {
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
