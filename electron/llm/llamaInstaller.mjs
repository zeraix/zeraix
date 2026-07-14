/**
 * llama.cpp 运行时动态安装（主进程）。
 *
 * llama 二进制不再随包分发（构建变体多：Metal/CUDA/Vulkan/CPU × 架构，且体积大）。
 * 首次启动本地模型时，按平台/架构选择对应构建，从 docker.zeraix.com（公共 CDN，只读、无凭据）
 * 下载 `llama/<version>/<variant>.tar.gz`，解压到 <本地应用数据>/llama/<version>/<variant>/（Windows %LOCALAPPDATA%），
 * localServer 从此处启动 llama-server。发布见 scripts/publish-llama.mjs。
 * （qemu 仍随包分发：其 HVF 需构建期签名+权限，见 scripts/bundle-bin-mac.mjs +
 *   electron-builder.yml 的 entitlementsInherit（含 com.apple.security.hypervisor）。）
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

// llama.cpp release 版本移至单一来源 electron/versions.mjs（与 VM_VERSION 同处）；此处透传。升级：改那里并重跑 publish:llama。
export { LLAMA_VERSION };
// 公共 CDN 基址 + 前缀（与 bundle/publish 用的 OSS_CDN / OSS_PREFIX 对应；CDN 对象为只读，无需凭据）。
const CDN_BASE = (process.env.LLAMA_CDN_BASE || "https://docker.zeraix.com").replace(/\/+$/, "");
const CDN_PREFIX = process.env.LLAMA_CDN_PREFIX || ""; // 若 OSS 桶用了前缀，这里与之保持一致

/** Windows：vulkan-1.dll 由 GPU 驱动装入 System32；存在 ⇔ 有 Vulkan 加载器（几乎所有现代笔记本都有）。 */
function hasVulkanWindows() {
  if (process.platform !== "win32") return true;
  const sysroot = process.env.SystemRoot || "C:\\Windows";
  return fs.existsSync(path.join(sysroot, "System32", "vulkan-1.dll"));
}

/** 探测 NVIDIA CUDA：nvidia-smi 头部含 "CUDA Version: 13.3"（= 驱动支持的最高 CUDA 版本）。仅 Windows 提供 CUDA 构建。 */
export function detectCuda() {
  if (process.platform !== "win32") return { available: false, version: null };
  try {
    const out = execFileSync("nvidia-smi", [], { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString();
    const m = out.match(/CUDA Version:\s*([0-9]+\.[0-9]+)/i);
    return m ? { available: true, version: m[1] } : { available: false, version: null };
  } catch { return { available: false, version: null }; }
}

// 按 CUDA 大版本选构建：依赖 CUDA「小版本兼容」——13.x 驱动可跑 cu13.3、12.x 驱动可跑 cu12.4
// （驱动报告 CUDA 12.x/13.x 即已满足该大版本的最低驱动要求）。极少数失配时有 CUDA→Vulkan→CPU 回退兜底。
// 太旧（< 12）返回 null，直接用 Vulkan。
function cudaVariant(driverVer) {
  const major = parseInt(driverVer, 10);
  if (major >= 13) return "win-cuda-13.3-x64";
  if (major >= 12) return "win-cuda-12.4-x64";
  return null;
}

/**
 * 平台/架构 → llama.cpp 构建变体。
 * Windows x64：opts.preferCuda 且检测到 NVIDIA → 用匹配的 CUDA 构建（最快）；否则有 Vulkan 用 Vulkan
 * （跨 NVIDIA/AMD/Intel）；再否则纯 CPU。mac 用 Metal（按架构），Linux 用 Vulkan。
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

/** GPU 构建启动失败时的回退链：CUDA → Vulkan → CPU（逐级重试）；无回退返回 null。 */
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

// 「本地模型文件夹」：一个专用文件夹，同时放 llama 运行时 + GGUF 模型 + 运行日志。用户可自定义/迁移。
//   <folder>/bin/<llama-version>/<variant>   运行时二进制（独立 bin/ 子目录，便于清理旧版本）
//   <folder>/models                           GGUF 模型（LLAMA_CACHE，见 localServer.mjs）
//   <folder>/logs                             运行日志
// 默认 = <本地应用数据>/llama（Windows %LOCALAPPDATA%\<App>\llama，大文件不随漫游）；配置存 app.config [local] dir。
export function localFilesBase() {
  const dir = getAppConfig()?.local?.dir;
  return dir && String(dir).trim() ? String(dir).trim() : path.join(localDataDir(path.basename(app.getPath("userData"))), "llama");
}
// 运行时二进制根 = <folder>/bin（版本目录在其下：<folder>/bin/<version>/<variant>）。独立子目录使
// 「清理旧版本」只在 bin/ 里扫描，绝不会波及同级的 models/ logs/（曾因二者同级被误删，见 pruneOldVersions）。
function llamaRoot() {
  return path.join(localFilesBase(), "bin");
}

// 旧布局 → 新布局的一次性迁移（同盘 rename，秒级）。仅在首次以新代码启动时搬动：
//   默认（未自定义 dir）：旧模型在 <userData>/models → 移进 <userData>/llama/models（bin 本就在 <userData>/llama/<version>，不动）。
//   自定义 dir：旧 bin 在 <dir>/llama/<version> → 上移到 <dir>/<version>（模型/日志本就在 <dir> 下，不动）。
/** 某目录是否为「llama 版本目录」（其下某变体子目录含 llama-server 可执行文件）。 */
function isVersionDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((v) => fs.existsSync(path.join(p, v, exeName()))); }
  catch { return false; }
}
// 旧布局 → 新布局（<folder>/bin/<version>）的一次性迁移，全程同盘 rename（秒级）、幂等、只搬需要搬的：
//   模型：旧默认 <userData>/models → <folder>/models（自定义 dir 时本就在 <folder>/models，不动）。
//   日志：只搬 llama-server.log（旧 logs/ 目录可能含其它日志，不整体搬）。
//   bin ：把散落各处的「版本目录」归入 <folder>/bin/<version>——可能在 <folder>/<v>（早前版本/默认）
//         或 <folder>/llama/<v>（更早的自定义布局）。isVersionDir 判定，绝不误搬 models/logs。
let _layoutMigrated = false;
export function migrateLegacyLayout() {
  if (_layoutMigrated) return;
  _layoutMigrated = true;
  try {
    const folder = localFilesBase();
    const binDir = path.join(folder, "bin");
    const hasCustom = !!(getAppConfig()?.local?.dir && String(getAppConfig().local.dir).trim());
    if (!hasCustom) {
      const legacyBase = localDataDir(path.basename(app.getPath("userData"))); // 旧默认 base = userData
      const mSrc = path.join(legacyBase, "models"), mDst = path.join(folder, "models");
      if (fs.existsSync(mSrc)) {
        // 若新 models 已存在但为空（可能被其它代码先建），删掉空目录让旧 models 搬入，避免旧模型被「空目录」挡住而孤立。
        let blocked = fs.existsSync(mDst);
        if (blocked) { try { if (fs.readdirSync(mDst).length === 0) { fs.rmdirSync(mDst); blocked = false; } } catch { /* ignore */ } }
        if (!blocked) { try { fs.mkdirSync(folder, { recursive: true }); fs.renameSync(mSrc, mDst); } catch { /* ignore */ } }
      }
      const lSrc = path.join(legacyBase, "logs", "llama-server.log"), lDst = path.join(folder, "logs", "llama-server.log");
      if (fs.existsSync(lSrc) && !fs.existsSync(lDst)) { try { fs.mkdirSync(path.join(folder, "logs"), { recursive: true }); fs.renameSync(lSrc, lDst); } catch { /* ignore */ } }
    }
    // 版本目录 → <folder>/bin/。两处可能来源：<folder>/<v> 与 <folder>/llama/<v>。
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
/** 已安装则返回可执行路径，否则 null。 */
export function installedBin(variant = llamaVariant()) {
  if (!variant) return null;
  const p = path.join(installDir(variant), exeName());
  return fs.existsSync(p) ? p : null;
}

/** llama 运行时根目录（.../llama，含各版本/变体）。供 UI 展示 / 打开文件夹。 */
export function llamaRootDir() { return llamaRoot(); }

/** 已安装的 llama 版本目录名（含任一变体可执行文件）。用于区分「未安装」与「装了旧版可更新」。 */
export function installedLlamaVersions() {
  try {
    return fs.readdirSync(llamaRoot()).filter((d) => {
      const vdir = path.join(llamaRoot(), d);
      try { return fs.statSync(vdir).isDirectory() && fs.readdirSync(vdir).some((variant) => fs.existsSync(path.join(vdir, variant, exeName()))); }
      catch { return false; }
    });
  } catch { return []; }
}

/** 清理「旧的 llama 版本目录」（app 升级会 bump LLAMA_VERSION）：仅保留当前版本，释放磁盘、避免陈旧二进制。
 *  作用域是独立的 <folder>/bin/（只含版本目录，与 models/ logs/ 同级隔离）；仍加 isVersionDir 兜底，双保险。 */
export function pruneOldVersions() {
  try {
    const root = llamaRoot(); // <folder>/bin
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
      if (name === LLAMA_VERSION) continue; // 保留当前版本
      const vdir = path.join(root, name);
      if (isVersionDir(vdir)) { try { fs.rmSync(vdir, { recursive: true, force: true }); } catch { /* ignore */ } } // 仅删真正的旧版本 bin 目录
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
 * 确保本机 llama-server 已安装；缺失则从 CDN 下载解压。返回可执行绝对路径。
 * onProgress(phase, pct)：phase ∈ "downloading" | "extracting"。
 * 解压用系统 tar（mac/win 的 bsdtar、Linux 的 GNU tar 均可解 .tar.gz），运行时无需打包依赖。
 */
export async function ensureInstalled(onProgress = () => {}, variant = llamaVariant()) {
  if (!variant) throw new Error(`不支持的平台：${process.platform}/${process.arch}`);
  pruneOldVersions(); // 升级后清理旧版本目录（当前版本目录含所有变体，不受影响）
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
  if (!bin) throw new Error("下载的 llama 包中未找到 llama-server");
  if (process.platform !== "win32") { try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ } }
  return bin;
}
