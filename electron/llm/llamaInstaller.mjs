/**
 * Dynamic installation of the llama.cpp runtime (main process).
 *
 * The llama binary is no longer shipped in the bundle (many build variants: Metal/CUDA/Vulkan/CPU × architecture, and large in size).
 * On first launch of a local model, pick the matching build by platform/architecture and download
 * `llama/<version>/<variant>.tar.gz` from docker.zeraix.com (public CDN, read-only, no credentials),
 * extract it to <local app data>/llama/<version>/<variant>/ (Windows %LOCALAPPDATA%),
 * and localServer starts llama-server from there. For publishing, see scripts/publish-llama.mjs.
 * (qemu is still bundled: its HVF needs build-time signing + entitlements, see scripts/bundle-bin-mac.mjs +
 *   entitlementsInherit in electron-builder.yml (including com.apple.security.hypervisor).)
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { app } from "electron";
import { detectHardware } from "./localModels.mjs";
import { localDataDir } from "../tools/sandbox/vmpaths.mjs";
import { LLAMA_VERSION } from "../versions.mjs";
import { getAppConfig } from "../appConfig.mjs";

// The llama.cpp release version was moved to the single source electron/versions.mjs (alongside VM_VERSION); re-exported here. To upgrade: change it there and re-run publish:llama.
export { LLAMA_VERSION };
// Public CDN base + prefix (corresponds to OSS_CDN / OSS_PREFIX used by bundle/publish; CDN objects are read-only, no credentials needed).
const CDN_BASE = (process.env.LLAMA_CDN_BASE || "https://docker.zeraix.com").replace(/\/+$/, "");
const CDN_PREFIX = process.env.LLAMA_CDN_PREFIX || ""; // If the OSS bucket uses a prefix, keep this consistent with it

/** Windows: vulkan-1.dll is installed into System32 by the GPU driver; present ⇔ a Vulkan loader exists (almost every modern laptop has one). */
function hasVulkanWindows() {
  if (process.platform !== "win32") return true;
  const sysroot = process.env.SystemRoot || "C:\\Windows";
  return fs.existsSync(path.join(sysroot, "System32", "vulkan-1.dll"));
}

/** Detect NVIDIA CUDA: the nvidia-smi header contains "CUDA Version: 13.3" (= the highest CUDA version the driver supports). CUDA builds are provided only on Windows. */
export function detectCuda() {
  if (process.platform !== "win32") return { available: false, version: null };
  try {
    const out = execFileSync("nvidia-smi", [], { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString();
    const m = out.match(/CUDA Version:\s*([0-9]+\.[0-9]+)/i);
    return m ? { available: true, version: m[1] } : { available: false, version: null };
  } catch { return { available: false, version: null }; }
}

// Pick the build by CUDA major version, relying on CUDA "minor-version compatibility" — a 13.x driver can run cu13.3, a 12.x driver can run cu12.4
// (a driver reporting CUDA 12.x/13.x already meets that major version's minimum driver requirement). For the rare mismatch there is a CUDA→Vulkan→CPU fallback.
// Too old (< 12) returns null and uses Vulkan directly.
function cudaVariant(driverVer) {
  const major = parseInt(driverVer, 10);
  if (major >= 13) return "win-cuda-13.3-x64";
  if (major >= 12) return "win-cuda-12.4-x64";
  return null;
}

/**
 * Platform/architecture → llama.cpp build variant.
 * Windows x64: opts.preferCuda and NVIDIA detected → use the matching CUDA build (fastest); otherwise use Vulkan when available
 * (across NVIDIA/AMD/Intel); otherwise pure CPU. mac uses Metal (by architecture), Linux uses Vulkan.
 */
export function llamaVariant(hw = detectHardware(), opts = {}) {
  const { platform, arch } = hw;
  if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x64";
  if (platform === "win32") {
    if (arch === "arm64") return "win-cpu-arm64";
    if (opts.preferCuda) {
      const cu = detectCuda();
      if (cu.available) { const v = cudaVariant(cu.version); if (v) return v; }
    }
    return hasVulkanWindows() ? "win-vulkan-x64" : "win-cpu-x64";
  }
  if (platform === "linux") return arch === "arm64" ? "ubuntu-vulkan-arm64" : "ubuntu-vulkan-x64";
  return null;
}

/** Fallback chain when a GPU build fails to start: CUDA → Vulkan → CPU (retry step by step); returns null when there is no fallback. */
export function fallbackVariant(variant) {
  const map = {
    "win-cuda-13.3-x64": "win-vulkan-x64",
    "win-cuda-12.4-x64": "win-vulkan-x64",
    "win-vulkan-x64": "win-cpu-x64",
    "ubuntu-vulkan-x64": "ubuntu-x64",
    "ubuntu-vulkan-arm64": "ubuntu-arm64",
  };
  return map[variant] || null;
}

const exeName = () => (process.platform === "win32" ? "llama-server.exe" : "llama-server");

// "Local models folder": a dedicated folder holding the llama runtime + GGUF models + runtime logs together. Users can customize/relocate it.
//   <folder>/bin/<llama-version>/<variant>   runtime binaries (a separate bin/ subdirectory, for easy cleanup of old versions)
//   <folder>/models                           GGUF models (LLAMA_CACHE, see localServer.mjs)
//   <folder>/logs                             runtime logs
// Default = <local app data>/llama (Windows %LOCALAPPDATA%\<App>\llama, large files do not roam); the setting is stored in app.config [local] dir.
export function localFilesBase() {
  const dir = getAppConfig()?.local?.dir;
  return dir && String(dir).trim() ? String(dir).trim() : path.join(localDataDir(path.basename(app.getPath("userData"))), "llama");
}
// Runtime binary root = <folder>/bin (version directories live under it: <folder>/bin/<version>/<variant>). The separate subdirectory makes
// "cleanup of old versions" scan only within bin/, never touching sibling models/ logs/ (which were once wrongly deleted when siblings, see pruneOldVersions).
function llamaRoot() {
  return path.join(localFilesBase(), "bin");
}

// One-time migration from old layout → new layout (same-disk rename, sub-second). Only moved on the first launch with the new code:
//   Default (dir not customized): old models at <userData>/models → moved into <userData>/llama/models (bin already at <userData>/llama/<version>, untouched).
//   Custom dir: old bin at <dir>/llama/<version> → moved up to <dir>/<version> (models/logs already under <dir>, untouched).
/** Whether a directory is a "llama version directory" (one of its variant subdirectories contains the llama-server executable). */
function isVersionDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((v) => fs.existsSync(path.join(p, v, exeName()))); }
  catch { return false; }
}
// One-time migration from old layout → new layout (<folder>/bin/<version>): all same-disk rename (sub-second), idempotent, moving only what needs moving:
//   Models: old default <userData>/models → <folder>/models (with a custom dir it is already at <folder>/models, untouched).
//   Logs: move only llama-server.log (the old logs/ directory may contain other logs, not moved wholesale).
//   bin : gather "version directories" scattered around into <folder>/bin/<version> — possibly at <folder>/<v> (earlier version/default)
//         or <folder>/llama/<v> (an even older custom layout). isVersionDir decides, never mistakenly moving models/logs.
let _layoutMigrated = false;
export function migrateLegacyLayout() {
  if (_layoutMigrated) return;
  _layoutMigrated = true;
  try {
    const folder = localFilesBase();
    const binDir = path.join(folder, "bin");
    const hasCustom = !!(getAppConfig()?.local?.dir && String(getAppConfig().local.dir).trim());
    if (!hasCustom) {
      const legacyBase = localDataDir(path.basename(app.getPath("userData"))); // old default base = userData
      const mSrc = path.join(legacyBase, "models"), mDst = path.join(folder, "models");
      if (fs.existsSync(mSrc)) {
        // If new models already exists but is empty (possibly created earlier by other code), remove the empty directory so old models can move in, avoiding old models being blocked by an "empty directory" and orphaned.
        let blocked = fs.existsSync(mDst);
        if (blocked) { try { if (fs.readdirSync(mDst).length === 0) { fs.rmdirSync(mDst); blocked = false; } } catch { /* ignore */ } }
        if (!blocked) { try { fs.mkdirSync(folder, { recursive: true }); fs.renameSync(mSrc, mDst); } catch { /* ignore */ } }
      }
      const lSrc = path.join(legacyBase, "logs", "llama-server.log"), lDst = path.join(folder, "logs", "llama-server.log");
      if (fs.existsSync(lSrc) && !fs.existsSync(lDst)) { try { fs.mkdirSync(path.join(folder, "logs"), { recursive: true }); fs.renameSync(lSrc, lDst); } catch { /* ignore */ } }
    }
    // Version directories → <folder>/bin/. Two possible sources: <folder>/<v> and <folder>/llama/<v>.
    for (const srcRoot of [folder, path.join(folder, "llama")]) {
      if (!fs.existsSync(srcRoot) || path.resolve(srcRoot) === path.resolve(binDir)) continue;
      let names = []; try { names = fs.readdirSync(srcRoot); } catch { continue; }
      for (const name of names) {
        const src = path.join(srcRoot, name);
        if (!isVersionDir(src)) continue;
        const dst = path.join(binDir, name);
        if (!fs.existsSync(dst)) { try { fs.mkdirSync(binDir, { recursive: true }); fs.renameSync(src, dst); } catch { /* ignore */ } }
      }
    }
    try { const oldLlama = path.join(folder, "llama"); if (fs.existsSync(oldLlama) && fs.readdirSync(oldLlama).length === 0) fs.rmdirSync(oldLlama); } catch { /* ignore */ }
  } catch { /* best effort */ }
}
export function installDir(variant = llamaVariant()) {
  return path.join(llamaRoot(), LLAMA_VERSION, variant);
}
/** Returns the executable path if installed, otherwise null. */
export function installedBin(variant = llamaVariant()) {
  if (!variant) return null;
  const p = path.join(installDir(variant), exeName());
  return fs.existsSync(p) ? p : null;
}

/** llama runtime root directory (.../llama, containing all versions/variants). For UI display / opening the folder. */
export function llamaRootDir() { return llamaRoot(); }

/** Names of installed llama version directories (containing any variant's executable). Used to distinguish "not installed" from "an old version is installed and can be updated". */
export function installedLlamaVersions() {
  try {
    return fs.readdirSync(llamaRoot()).filter((d) => {
      const vdir = path.join(llamaRoot(), d);
      try { return fs.statSync(vdir).isDirectory() && fs.readdirSync(vdir).some((variant) => fs.existsSync(path.join(vdir, variant, exeName()))); }
      catch { return false; }
    });
  } catch { return []; }
}

/** Clean up "old llama version directories" (an app upgrade bumps LLAMA_VERSION): keep only the current version, free disk, avoid stale binaries.
 *  Scope is the isolated <folder>/bin/ (contains only version directories, isolated from sibling models/ logs/); still adds an isVersionDir guard as a double safeguard. */
export function pruneOldVersions() {
  try {
    const root = llamaRoot(); // <folder>/bin
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
      if (name === LLAMA_VERSION) continue; // keep the current version
      const vdir = path.join(root, name);
      if (isVersionDir(vdir)) { try { fs.rmSync(vdir, { recursive: true, force: true }); } catch { /* ignore */ } } // only delete genuine old-version bin directories
    }
  } catch { /* ignore */ }
}

function fetchTo(url, dest, onPct, maxRedirs = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirs > 0) {
        res.resume(); return resolve(fetchTo(res.headers.location, dest, onPct, maxRedirs - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GET ${res.statusCode} ${url}`)); }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0, last = -1;
      const ws = fs.createWriteStream(dest);
      res.on("data", (c) => { got += c.length; if (total && onPct) { const p = Math.floor((got / total) * 100); if (p >= last + 2) { last = p; onPct(p); } } });
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => resolve()));
      ws.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Ensure llama-server is installed on this machine; if missing, download and extract it from the CDN. Returns the absolute executable path.
 * onProgress(phase, pct): phase ∈ "downloading" | "extracting".
 * Extraction uses the system tar (bsdtar on mac/win, GNU tar on Linux can all unpack .tar.gz), so no bundled dependency is needed at runtime.
 */
export async function ensureInstalled(onProgress = () => {}, variant = llamaVariant()) {
  if (!variant) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  pruneOldVersions(); // clean up old-version directories after upgrade (the current version directory holds all variants, unaffected)
  const existing = installedBin(variant);
  if (existing) return existing;

  const dir = installDir(variant);
  fs.mkdirSync(dir, { recursive: true });
  const key = `${CDN_PREFIX}llama/${LLAMA_VERSION}/${variant}.tar.gz`;
  const url = `${CDN_BASE}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const tmp = path.join(app.getPath("temp"), `llama-${LLAMA_VERSION}-${variant}.tar.gz`);
  fs.rmSync(tmp, { force: true });

  onProgress("downloading", 0);
  await fetchTo(url, tmp, (p) => onProgress("downloading", p));

  onProgress("extracting", 100);
  execFileSync("tar", ["-xzf", tmp, "-C", dir]);
  fs.rmSync(tmp, { force: true });

  const bin = installedBin(variant);
  if (!bin) throw new Error("llama-server not found in the downloaded llama package");
  if (process.platform !== "win32") { try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ } }
  return bin;
}
