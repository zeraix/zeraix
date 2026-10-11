/**
 * QEMU engine — the VM image: which version boots, where it lives on disk, and the first-run download of the disk and
 * kernel (rootfs.qcow2 / Image / initrd.img), with resume, size and qcow2 integrity checks. Part of the qemu engine;
 * qemu.mjs is the public entry.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import https from "node:https";
import { app } from "electron";

import { createProgressReporter } from "../progress.mjs";
import { vmVersion, guestArch, localDataDir } from "../vmpaths.mjs";
import { resolveHfEndpoint } from "../../../llm/hfEndpoint.mjs";
import { isWin, cfg } from "./shared.mjs";
import { qemuBin } from "./args.mjs";

// VM disk/kernel are downloaded from a public CDN on first run (docker.zeraix.com fronts the public read-only entry of the zeraix-docker bucket).
// Not configurable, and no longer the download host: this is simply where images published before the
// move to Hugging Face still live, so an override could not relocate them. Point HF_ENDPOINT or
// ZERAIX_LLAMA_BUILDS_REPO instead — those steer the path that is actually used.
const VM_CDN = "https://docker.zeraix.com";
const VM_HF_REPO = process.env.ZERAIX_LLAMA_BUILDS_REPO || "Zeraix/llama-builds";

/**
 * Where to fetch this VM version from: Hugging Face, falling back to the old CDN.
 *
 * HF is where the vm-image workflow publishes, and it brings the hf-mirror.com fallback the CDN never
 * had. The fallback is for versions published BEFORE the move — they exist only on the CDN, and an
 * installed app whose pinned version predates it must still be able to fetch. Probed once per download
 * with a HEAD on the first file, so all three files come from the same host.
 *
 * Drop the fallback once no shipped versions.json names a CDN-only image.
 */
async function vmBase(arch, version) {
  const hf = `${await resolveHfEndpoint((l) => console.log(`[sandbox/qemu] ${l}`))}/${VM_HF_REPO}/resolve/main`;
  try {
    // Short budget on purpose: this is a "is the version published on HF" probe with a working fallback right below, so
    // spending the full HEAD timeout on it would just be dead time in front of a download that was going to the CDN anyway.
    await headSize(`${hf}/vm/${arch}/${version}/${VM_FILES[0]}`, 5, 8000);
    return hf;
  } catch {
    console.log(`[sandbox/qemu] ${version} not on Hugging Face — falling back to ${VM_CDN}`);
    return VM_CDN;
  }
}

// ── Paths / directories ───────────────────────────────────────────────────────────────
// VM image directory: see ./vmpaths.mjs (per-platform local app-data directory; shared by the runtime and the build/publish scripts).
// The app name is taken from the basename of userData, ensuring it matches llama/userData (dev=Zeraix, packaged=OperEase).
export const VM_FILES = ["rootfs.qcow2", "Image", "initrd.img"];
// Version directory root (.../vm): independent of the ZERAIX_VMDIR override, always points to the default layout, used for version enumeration/cleanup.
export function vmRoot() { return path.join(localDataDir(path.basename(app.getPath("userData"))), "vm"); }
function versionComplete(v) { return !!v && VM_FILES.every((f) => fs.existsSync(path.join(vmRoot(), v, f))); }
function installedVersions() {
  try { return fs.readdirSync(vmRoot()).filter((d) => !d.startsWith(".") && versionComplete(d)); } catch { return []; }
}
/**
 * Version used at boot:
 *   - configured (the versions.json target) is fully downloaded -> use it;
 *   - otherwise, if another downloaded version exists -> use the latest one (i.e. boot from the old image, do not auto-download the new version -- leave the update decision to the user);
 *   - none present -> configured (first run, triggers a download).
 * forceConfigured=true (user clicks "Update"): force use of configured (downloads the new version).
 */
export function bootVersion(forceConfigured = false) {
  const configured = vmVersion(guestArch());
  if (forceConfigured) return configured;
  if (versionComplete(configured)) return configured;
  const others = installedVersions().filter((v) => v !== configured);
  return others.length ? [...others].sort().slice(-1)[0] : configured;
}

export function dirs(forceConfigured = false) {
  const override = process.env.ZERAIX_VMDIR; // Custom directory override: use it directly, no version layout applied
  const vd = override ? override : path.join(vmRoot(), bootVersion(forceConfigured));
  return { vd, rootfs: cfg?.rootfs || process.env.ZERAIX_ROOTFS || path.join(vd, "rootfs.qcow2") };
}

/** VM image directory (where rootfs.qcow2 / Image / initrd.img live). Static path, for UI display / opening the folder, no running VM required. */
export function vmImageDir() { return dirs().vd; }

/**
 * VM image version / install info, for the sandbox dialog display and the "update" decision.
 *   version      = version currently used at boot (may be an old version)
 *   targetVersion= versions.json target version
 *   complete     = target version is fully downloaded
 *   updatable    = currently using an old version and the target version is not yet downloaded -> user can trigger an update
 */
export function sandboxVmInfo() {
  const arch = guestArch();
  const targetVersion = vmVersion(arch);
  const version = bootVersion();
  const complete = versionComplete(targetVersion);
  return {
    dir: dirs().vd,
    version,
    targetVersion,
    complete,
    updatable: !!targetVersion && !complete && version !== targetVersion,
    otherVersions: installedVersions().filter((v) => v !== version),
  };
}

/** qemu-img, derived from the qemu-system path so both come from the same (possibly relocated, bundled) directory. */
export function qemuImgBin() {
  return qemuBin().replace(/qemu-system-[^/\\]+(\.exe)?$/, isWin ? "qemu-img.exe" : "qemu-img");
}

/**
 * Structural check of a qcow2 file. Resolves null when it is sound, else a description of what is wrong.
 *
 * qemu-img exit codes: 0 = clean, 1 = check unsupported/could not run, 2 = corruption found, 3 = leaked clusters.
 * Only 2 counts as broken. Leaks (3) waste space and boot fine, and 1 must not condemn an image just because the
 * bundled qemu-img could not be run — a check that fails open is the right direction for a cache we would otherwise
 * delete and re-download over a false positive.
 *
 * Asynchronous, and that is not a nicety. This runs on the first-run path right after the multi-GB image has landed,
 * and it used to be `spawnSync`: for as long as qemu-img walked the file — up to the 120 s timeout — the main process
 * event loop was stopped, every IPC call from the window stalled, and the app was frozen at the one moment a new user
 * was first trying it. The check itself is unchanged; only the waiting moved off the event loop.
 */
function qcow2Corruption(file) {
  return new Promise((resolve) => {
    try {
      execFile(
        qemuImgBin(),
        ["check", "-f", "qcow2", file],
        { encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 4 * 1048576 },
        (err, stdout, stderr) => {
          // Could not run, or timed out (killed by the timeout): fail open, as above.
          if (err && (err.killed || err.signal || typeof err.code !== "number")) return resolve(null);
          const status = err ? err.code : 0;
          if (status !== 2) return resolve(null);
          resolve(`${stdout ?? ""}${stderr ?? ""}`.trim().split("\n").slice(0, 4).join("; ") || "qemu-img reported corruption");
        },
      );
    } catch {
      resolve(null);
    }
  });
}

// Clean up unused old-version VM directories (free disk). Keep both "the current boot version keepVersion" and "the target version configured":
// when booting from an old version keep the old version (otherwise no image is available), keep the target version (used right after a user update); prune the rest.
// Skipped when ZERAIX_VMDIR overrides (to avoid accidentally deleting siblings of the custom directory).
function pruneOldVmVersions(keepVersion) {
  if (process.env.ZERAIX_VMDIR) return;
  const keep = new Set([keepVersion, vmVersion()].filter(Boolean));
  try {
    for (const name of fs.readdirSync(vmRoot())) {
      if (!keep.has(name) && !name.startsWith(".")) fs.rmSync(path.join(vmRoot(), name), { recursive: true, force: true }); // skip .build-<arch> build staging
    }
  } catch { /* ignore */ }
}

// On first run, download the VM disk + kernel (rootfs.qcow2 / Image / initrd.img) from the CDN into vd (versioned vm/<id>/, no arch segment); skipped if already present.
// Version = short hash of the docker image ID for this machine's arch; changing the ID changes the directory -> triggers a re-download and prunes old versions (version invalidated).
// Progress is reported to engine.mjs via onProgress(pct, msg) (broadcast to the UI). .part -> rename for atomic write, so an interruption leaves no half-finished file.
export async function ensureRootfs(onProgress, forceConfigured = false) {
  const arch = guestArch();
  const configured = vmVersion(arch);
  if (!configured) throw new Error("VM_VERSION has no entry for this machine's arch (run build:rootfs + publish:rootfs first)");
  const version = bootVersion(forceConfigured); // booting from the old image does not download; first run/update = configured (triggers download)
  const vd = path.join(vmRoot(), version);
  const missing = VM_FILES.filter((f) => !fs.existsSync(path.join(vd, f)));
  if (!missing.length) { pruneOldVmVersions(version); onProgress?.(100, "Runtime environment ready (no download needed)"); return; } // already downloaded: prune stale then notify the UI
  // Download needed: only happens on "first run (no image at all)" or "user clicks update (forceConfigured)", where version === configured.
  //
  // Logged step by step, to the terminal, because this stretch is invisible in the UI: no progress is reported until the
  // sizes are known, so the dialog shows its generic "checking runtime environment" for the whole of endpoint resolution
  // and three HEAD requests. When any of that is slow or blocked, "stuck on checking" is the only symptom the user has,
  // and it does not distinguish a hung probe from a 404 from a download that never started. These lines do.
  fs.mkdirSync(vd, { recursive: true });
  console.log(`[sandbox/qemu] need ${missing.join(", ")} for ${version} (${arch}) — resolving download endpoint`);
  const base = await vmBase(arch, version);
  console.log(`[sandbox/qemu] download base: ${base}`);
  // Per-file, not just the sum: the size is the only integrity signal the CDN gives us (no checksum is published
  // alongside these files), and it is needed per file to tell a finished download from a truncated one.
  const expected = new Map();
  let total = 0;
  for (const f of missing) {
    const url = `${base}/vm/${arch}/${version}/${f}`;
    let n;
    try {
      n = await headSize(url);
    } catch (e) {
      // Named rather than propagated bare: the two failures that land here need opposite responses — a timeout means the
      // endpoint is unreachable from this network, a 404 means this version was never published where we are looking —
      // and the raw error alone does not say which the user is looking at.
      console.warn(`[sandbox/qemu] HEAD failed for ${url}: ${e?.message ?? e}`);
      throw new Error(`cannot reach the runtime download for ${f} (${url}): ${e?.message ?? e}`);
    }
    console.log(`[sandbox/qemu] ${f}: ${(n / 1048576).toFixed(0)} MB`);
    expected.set(f, n);
    total += n;
  }
  // Resumable download: an existing .part counts toward completed progress (the server's 206 only returns the remaining bytes, no longer reported via onChunk).
  // Progress is rationed, not counted approximately: every byte is added, and the reporter decides when a broadcast is
  // worth making (see progress.mjs — one per chunk was what made a fresh install sluggish for the whole download).
  const progress = createProgressReporter({ total, onProgress });
  for (const f of missing) {
    const p = path.join(vd, f + ".part");
    if (!fs.existsSync(p)) continue;
    // A .part at or beyond the full size cannot be resumed from — Range would ask for nothing, or for bytes past the
    // end, and the rename would publish whatever the previous attempt left behind. It is a leftover from an earlier
    // version or a botched write; start it again rather than weld onto it.
    const size = fs.statSync(p).size;
    const want = expected.get(f) || 0;
    if (want && size >= want) { fs.rmSync(p, { force: true }); continue; }
    progress.add(size);
  }
  progress.milestone(); // initial progress (including any already-resumed part)
  for (const f of missing) {
    const tmp = path.join(vd, f + ".part");
    console.log(`[sandbox/qemu] downloading ${f} -> ${tmp}`);
    await httpDownload(`${base}/vm/${arch}/${version}/${f}`, tmp, (n) => progress.add(n));
    progress.milestone(); // the exact final number for this file, whatever the throttle dropped
    // Verify BEFORE publishing. `ws.on("finish")` fires when the response ends, and a connection dropped mid-body ends
    // the response just the same — so a truncated file used to be renamed into place as if complete, and from then on
    // `versionComplete()` (an existsSync test) called it downloaded for ever. That is how an unbootable image becomes
    // permanent: every later start reuses it, and "Update" resolves to the same version directory and downloads nothing.
    const want = expected.get(f) || 0;
    const got = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (want && got !== want) {
      fs.rmSync(tmp, { force: true }); // the prefix is not trustworthy, so it must not seed the next resume either
      throw new Error(
        `download of ${f} is incomplete (${got} of ${want} bytes) — the connection dropped. Start the sandbox again to retry.`,
      );
    }
    // Structural check for the disk image specifically: the right number of corrupt bytes is still the right SIZE, so
    // the length test above cannot see a body that arrived damaged (or was resumed onto a damaged prefix). qemu-img
    // reads the qcow2 metadata and says so directly — which is the failure this whole path exists to stop shipping.
    if (f.endsWith(".qcow2")) {
      const bad = await qcow2Corruption(tmp);
      if (bad) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`downloaded ${f} is corrupt (${bad}) — discarded. Start the sandbox again to re-download it.`);
      }
    }
    fs.renameSync(tmp, path.join(vd, f));
  }
  pruneOldVmVersions(version); // prune old images after the download completes (on update version=configured -> delete the old version, free disk)
  onProgress?.(100, "Runtime environment ready");
}
/**
 * Size of a remote file, by HEAD.
 *
 * `timeout` is not optional detail. Without it this hangs for ever against a host that completes the TCP connection and
 * then says nothing — the ordinary shape of a blackholing firewall or proxy, and the reason the sandbox dialog could sit
 * on "checking runtime environment" indefinitely with no download, no progress and no error. `.on("error")` does not
 * cover it: a silent stall is not a socket error. The option is a socket-INACTIVITY timeout, and the handler has to
 * destroy the request itself — Node only emits the event. hfEndpoint.mjs's reachability probe already does exactly this.
 */
function headSize(url, redirs = 5, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(headSize(res.headers.location, redirs - 1, timeoutMs)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HEAD ${url} → ${res.statusCode}`)); }
      resolve(Number(res.headers["content-length"] || 0));
    });
    req.on("timeout", () => { req.destroy(new Error(`HEAD ${url} timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.end();
  });
}
// Resumable download: existing .part -> send Range: bytes=<have>-; 206 appends, 200 (server ignores Range) overwrites from the start.
//
// `timeoutMs` is an INACTIVITY timeout, not a deadline for the transfer: Node resets it on every socket read, so a slow
// but progressing download of a multi-GB image is never cut off, while a connection that dies mid-body — which otherwise
// leaves this promise pending for ever, the progress bar frozen and no error anywhere — fails in a minute. The partial
// .part is deliberately left on disk: it is what the next attempt resumes from.
function httpDownload(url, dest, onChunk, redirs = 5, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const opts = have > 0 ? { timeout: timeoutMs, headers: { Range: `bytes=${have}-` } } : { timeout: timeoutMs };
    let ws = null;
    // One-shot, and it closes the write stream on the way out. Without that a failed download leaks the file handle,
    // and on Windows an open handle is also what stops the retry from replacing the file it was writing.
    const fail = (err) => {
      if (ws) { try { ws.destroy(); } catch { /* ignore */ } ws = null; }
      reject(err);
    };
    const req = https.get(url, opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(httpDownload(res.headers.location, dest, onChunk, redirs - 1, timeoutMs)); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return fail(new Error(`GET ${url} → ${res.statusCode}`)); }
      const resuming = res.statusCode === 206; // server accepts resume; 200 means it ignored Range and overwrites from the start
      ws = fs.createWriteStream(dest, { flags: resuming ? "a" : "w" });
      res.on("data", (c) => onChunk?.(c.length));
      res.on("error", fail); // a body that dies mid-stream is not reported on the request object
      res.pipe(ws);
      ws.on("finish", () => ws?.close(() => resolve()));
      ws.on("error", fail);
    });
    req.on("timeout", () => { req.destroy(new Error(`download of ${url} stalled for ${timeoutMs}ms`)); });
    req.on("error", fail);
  });
}
