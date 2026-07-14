/**
 * 本地 llama.cpp（llama-server）子进程管理（主进程）。
 *
 * 多步流程（设置页向导驱动，避免「预装前猜显存」）：
 *   1) 探测后端（CUDA/Vulkan/CPU/Metal）→ 安装对应运行时 bundle（已装则跳过下载）；
 *   2) 用已装二进制 `--list-devices` 探测真实显存 → 依此推荐模型 + 计算分层卸载(-ngl)；
 *   3) 启动 llama-server（下载 GGUF 权重）→ 轮询 /health 就绪。
 * 就绪后对渲染层暴露 endpoint = http://127.0.0.1:<port>/v1/chat/completions，渲染层据此注册「本地」模型。
 *
 * status.phase：idle | downloading | extracting | probing | loading | ready | error（pct 为下载百分比）。
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { spawn, execSync } from "node:child_process";
import {
  detectHardware, usableModelMemoryGB, recommend as recommendModels, buildServerArgs,
  MODELS, autoQuantId, quantBpw, gpuLayers, localSupported, MIN_LOCAL_MEM_GB, isSharedGpu, pickCtxKv, computeFit,
} from "./localModels.mjs";
import { ensureInstalled, installedBin, llamaVariant, fallbackVariant, detectCuda, LLAMA_VERSION, localFilesBase, installDir, llamaRootDir, installedLlamaVersions, migrateLegacyLayout } from "./llamaInstaller.mjs";
import { downloadModel } from "./hfDownload.mjs";
import { getAppConfig, setAppConfig } from "../appConfig.mjs";

const DEFAULT_PORT = Number(process.env.LLAMA_PORT || 8080);
const KV_DIR = path.join(os.tmpdir(), "zeraix-llama-kv");

// -hf 拉取 GGUF 的 Hugging Face 端点。启动前实测 huggingface.co 可达性：直连不通（被墙 / DNS 污染 / 超时）
// 则改用镜像 hf-mirror.com，否则直连 huggingface.co。HF_ENDPOINT 环境变量可强制覆盖。结果缓存至本进程。
let _hfEndpoint = null;
function reachable(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => { res.resume(); finish(true); }); // 收到任意响应 = 可达
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}
async function resolveHfEndpoint() {
  if (_hfEndpoint) return _hfEndpoint;
  if (process.env.HF_ENDPOINT) { _hfEndpoint = process.env.HF_ENDPOINT; return _hfEndpoint; }
  const ok = await reachable("https://huggingface.co/");
  _hfEndpoint = ok ? "https://huggingface.co" : "https://hf-mirror.com";
  pushLog(`[llama] HF 端点：${_hfEndpoint}（huggingface.co ${ok ? "可达，直连" : "不可达 → 用镜像"}）\n`);
  return _hfEndpoint;
}

const state = {
  proc: null,
  ready: false,
  phase: "idle", // idle | downloading | extracting | fetching | probing | loading | ready | error
  pct: 0, // 下载进度百分比（downloading = llama 运行时；fetching = 模型权重）
  port: DEFAULT_PORT,
  model: null, // { hf, label, multimodal, id, name }
  variant: null, // 当前安装/启动的 llama 构建变体
  installedVariant: null, // 已安装的变体（供探测/启动复用，避免重复下载）
  probe: null, // { vramGB, device, gpuPresent } —— --list-devices 结果
  ctx: 16384,
  error: null,
  log: [],
  dlAbort: null, // 模型自下载的 AbortController（stop/reset 时中止）
};

const listeners = new Set();
let healthTimer = null;
// 运行日志文件：把安装/探测/下载/llama-server 全部输出落盘，供用户排查（内存里只留最近 300 行，见 pushLog）。
// start() 开新会话写入表头，pushLog 同步追加，stop()/退出时关闭；超 5MB 自动清空重来。
let logStream = null;
function logFilePath() { return path.join(localFilesBase(), "logs", "llama-server.log"); }
// 惰性打开追加流：首次 pushLog 即建，使「安装 / 探测 / 下载」阶段（start 之前）的输出也落盘。超 5MB 清空重来。
function ensureLog() {
  if (logStream) return;
  try {
    const p = logFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    logStream = fs.createWriteStream(p, { flags: "a" });
  } catch { logStream = null; }
}
function openLog(header) { ensureLog(); if (logStream) { try { logStream.write(`\n===== ${header} =====\n`); } catch { /* ignore */ } } }
function closeLog() { if (logStream) { try { logStream.end(); } catch { /* ignore */ } logStream = null; } }
// 保证日志文件存在（哪怕还没跑过模型），使「运行日志」按钮总能打开（打开的是当前文件夹下的日志）。
function ensureLogFile() {
  try { const p = logFilePath(); fs.mkdirSync(path.dirname(p), { recursive: true }); if (!fs.existsSync(p)) fs.writeFileSync(p, ""); } catch { /* ignore */ }
  return logFilePath();
}
// 每次 start()/stop() 自增：进行中的 launch() 在每个 await 点后核对，若已过期（用户在
// 「下载中/加载中」重新启动或停止）则不再 spawn，避免泄漏出第二个 llama-server 进程。
let launchGen = 0;
// 设备名(小写) → uma 真伪：一旦某次真跑模型从 stderr 读到权威 uma:，即缓存，供后续探测/推荐直接采用
// （比 --list-devices 无 uma 时的名字启发式更准）。见 docs/vulkan-uma-windows.md。
const umaCache = new Map();
let umaScanned = false; // 每次 launch 内是否已从 stderr 抓到 uma（抓到即停扫，避免重复解析）

/** 当前对外状态快照（可结构化克隆，供 IPC 传给渲染层）。 */
export function status() {
  return {
    running: !!state.proc,
    ready: state.ready,
    phase: state.phase,
    pct: state.pct,
    port: state.port,
    model: state.model,
    endpoint: `http://127.0.0.1:${state.port}/v1/chat/completions`,
    installed: !!installedBin(state.installedVariant || undefined),
    installedVariant: state.installedVariant,
    version: LLAMA_VERSION,
    variant: state.variant,
    probe: state.probe,
    error: state.error,
    tail: state.log.slice(-12).join(""),
    logFile: logFilePath(), // 完整运行日志文件路径（供 UI「运行日志」按钮打开）
  };
}

function emit() { const st = status(); for (const cb of listeners) { try { cb(st); } catch { /* ignore */ } } }
/** 主进程注册一个状态监听（转发给渲染层）。返回取消订阅。 */
export function onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); }

function pushLog(s) { state.log.push(s); if (state.log.length > 300) state.log.shift(); ensureLog(); if (logStream) { try { logStream.write(s); } catch { /* ignore */ } } }

// ── 硬件 / 推荐 ──────────────────────────────────────────────
/** 粗探测（预装前，向导第 0/1 步）：硬件 + 可用内存 + CUDA 可用性 + 是否满足最低门槛。 */
export function getHardware() {
  migrateLegacyLayout(); // 首次以新布局启动时把旧 models/bin/logs 归入专用文件夹（同盘 rename，秒级）
  ensureLogFile();       // 保证「运行日志」按钮总能打开当前文件夹下的日志文件
  const hw = detectHardware();
  return { hw, cuda: detectCuda(), supported: localSupported(hw), minMemGB: MIN_LOCAL_MEM_GB };
}

// ── 存储位置（llama 运行时 + GGUF 模型；体积大，Windows C 盘常紧张，可自定义） ─────────────
function freeGB(dir) {
  try {
    let p = dir;
    while (p && !fs.existsSync(p)) { const parent = path.dirname(p); if (parent === p) break; p = parent; } // 新目录未建 → 取最近已存在祖先
    const s = fs.statfsSync(p);
    return Math.round((s.bavail * s.bsize) / 1e9);
  } catch { return null; }
}

// Windows：C 盘紧张（<30GB）且有更空的固定盘时，建议改到那张盘。其余平台默认本地数据目录即可（无建议）。
function suggestStorageDir() {
  if (process.platform !== "win32") return null;
  try {
    const drives = [];
    for (const L of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${L}:\\`;
      if (!fs.existsSync(root)) continue;
      try { const s = fs.statfsSync(root); drives.push({ drive: L, freeGB: Math.round((s.bavail * s.bsize) / 1e9) }); } catch { /* 跳过不可访问盘 */ }
    }
    const c = drives.find((d) => d.drive === "C");
    const best = drives.reduce((a, b) => (b.freeGB > a.freeGB ? b : a), { freeGB: -1 });
    if (c && c.freeGB < 30 && best.drive !== "C" && best.freeGB > c.freeGB) return { dir: `${best.drive}:\\Zeraix`, freeGB: best.freeGB, drive: best.drive };
    return null;
  } catch { return null; }
}

/** 本地文件存储位置信息（设置 UI 用）：当前目录 / 是否自定义 / 剩余空间 / Windows 磁盘建议。 */
export function storageInfo() {
  const base = localFilesBase();
  return { dir: base, custom: !!getAppConfig()?.local?.dir, freeGB: freeGB(base), suggestion: suggestStorageDir() };
}

/** 设置本地文件存储位置（空 = 恢复默认）。仅改配置、不搬数据（供程序化调用；UI 改文件夹请用 migrateStorageTo）。 */
export function setStorageDir(dir) {
  setAppConfig("local", "dir", dir ? String(dir).trim() : "");
  return storageInfo();
}

/**
 * 迁移到新文件夹：停服 → 把当前文件夹下的内容（<version>/ 运行时、models/、logs/）搬到 newDir → 更新配置。
 * 同盘走 rename（秒级）；跨盘走异步 cp + rm（会耗时，UI 需显示迁移中）。已存在的同名项跳过（不覆盖）。
 * 返回 { ok, dir?, error? }。
 */
export async function migrateStorageTo(newDir) {
  const dst = String(newDir || "").trim();
  if (!dst) return { ok: false, error: "空目录" };
  const src = localFilesBase();
  const rSrc = path.resolve(src), rDst = path.resolve(dst);
  if (rDst === rSrc) return { ok: true, dir: src }; // 未变
  // 拒绝「嵌套」：新文件夹是当前文件夹的子目录（或反之）——会把 models 自搬进自身子目录、中途报错，遗留 bin/logs。
  if ((rDst + path.sep).startsWith(rSrc + path.sep) || (rSrc + path.sep).startsWith(rDst + path.sep)) {
    return { ok: false, error: "新文件夹不能是当前文件夹的子目录或其父目录" };
  }
  // 仅空闲时允许：运行时安装 / 模型下载 / 模型在跑或加载 时拒绝（避免搬动正被写入/占用的文件）。
  if (state.proc || state.dlAbort || ["downloading", "extracting", "fetching", "loading", "probing"].includes(state.phase)) {
    return { ok: false, error: "请先停止模型并等待下载/安装完成，再更改文件夹" };
  }
  try {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.existsSync(src) ? fs.readdirSync(src) : [];
    // 阶段 1：搬动每一项。同盘 renameSync（原子，源即刻移走）；跨盘 cp（先只拷贝，源保留到阶段 2）。
    // 关键：跨盘时「拷贝完成前绝不删源」；单项 cp 失败即清掉半成品并中止，源全部完好（不会丢/劈半）。
    for (const name of entries) {
      const s = path.join(src, name), d = path.join(dst, name);
      if (fs.existsSync(d)) continue; // 目标已有（含上次中断已拷好的）→ 跳过，不覆盖
      try {
        fs.renameSync(s, d);
      } catch (e) {
        if (e && e.code === "EXDEV") {
          try { await fs.promises.cp(s, d, { recursive: true }); }
          catch (ce) { try { await fs.promises.rm(d, { recursive: true, force: true }); } catch { /* ignore */ } throw ce; } // 清半成品后中止
        } else throw e;
      }
    }
    // 阶段 2：源里凡在目标已有完整副本者删除（跨盘拷贝所致；同盘 rename 已把源移走，此处判空跳过）。全部拷贝成功后才执行。
    for (const name of entries) {
      const s = path.join(src, name);
      if (fs.existsSync(s) && fs.existsSync(path.join(dst, name))) { try { await fs.promises.rm(s, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    setAppConfig("local", "dir", dst); // 切到新文件夹
    return { ok: true, dir: dst };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** GGUF 模型下载目录（models/<repo_>/<quant>/）。 */
export function modelsDir() { return path.join(localFilesBase(), "models"); }

/** llama 运行时信息：版本 / 已安装版本 / 是否可更新（versions.json 的 llama 版本与已装不一致）/ 目录。 */
export function llamaInfo() {
  const versions = installedLlamaVersions();
  const upToDate = versions.includes(LLAMA_VERSION);
  let variant = state.installedVariant || null;
  if (!variant && upToDate) { // state 尚未 populate 时从磁盘找当前版本已装的变体
    try { variant = fs.readdirSync(path.join(llamaRootDir(), LLAMA_VERSION)).find((v) => !!installedBin(v)) || null; } catch { /* ignore */ }
  }
  return {
    version: LLAMA_VERSION,
    installedVersions: versions,
    installed: versions.length > 0,
    upToDate,
    updatable: !upToDate && versions.length > 0, // 装了旧版本 llama，目标是新版 → 可更新
    variant,
    binDir: variant ? installDir(variant) : llamaRootDir(),
    root: llamaRootDir(),
  };
}

/** 依「模型 + 量化 + 上下文 + KV + 视觉」估算内存占用（GB），供 UI 随选项实时显示。 */
export function estimate(opts = {}) {
  const model = MODELS.find((m) => m.id === opts.modelId);
  if (!model) return null;
  const bpw = quantBpw(model, opts.quant);
  const ctx = Math.max(256, Number(opts.ctx || 16384));
  const kvBits = Number(opts.kvBits || 8);
  const vision = !!opts.vision && !!model.vision;
  const fit = computeFit(model, { bpw }, ctx, kvBits, vision);
  // MTP 独立 drafter（Gemma，约百 MB 常驻）；Qwen 内置 MTP 头已计入权重，额外开销忽略。
  const mtpGB = opts.mtp !== false && model.mtp && !model.mtpEmbedded ? 0.2 : 0;
  return { totalGB: Math.round((fit.totalGB + mtpGB) * 10) / 10, weightGB: fit.weightGB, kvGB: fit.kvGB };
}

/** 附属文件（不算主权重）：mmproj 视觉投影、MTP drafter（mtp-*.gguf 或 *-MTP.gguf）。 */
const isAuxFile = (f) => /mmproj/i.test(f) || /^mtp-/i.test(f) || /-mtp\.gguf$/i.test(f);
/** 某目录里已就绪（最终名，非 .part）的模型文件分类。 */
function localModelFiles(dir) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { weights: [], mmproj: null, mtp: null, hasPart: false }; }
  return {
    weights: files.filter((f) => /\.gguf$/i.test(f) && !isAuxFile(f)).sort(),
    mmproj: files.find((f) => /mmproj.*\.gguf$/i.test(f)) || null,
    mtp: files.find((f) => /^mtp-.*\.gguf$/i.test(f) || /-mtp\.gguf$/i.test(f)) || null,
    hasPart: files.some((f) => /\.part$/i.test(f)),
  };
}
/** 模型某量化是否「完整安装」：主权重齐全、无 .part，且模型具备视觉时 mmproj 也在。
 *  MTP drafter 视作可选加速件（不计入「完整」）：缺失时启动前按需补拉（约百 MB），避免给已装模型「反安装」。 */
function isModelInstalled(model, quant) {
  const dir = path.join(modelsDir(), (model.hf || "").replace(/\//g, "_"), quant);
  const f = localModelFiles(dir);
  if (f.hasPart || !f.weights.length) return false;
  if (model.vision && !f.mmproj) return false; // 需视觉投影
  return true;
}

/**
 * 已安装的本地模型列表（按目录版）：只列「完整安装」的目录（含 mmproj/mtp），逐条对应目录的 catalog 模型。
 * 返回 [{ modelId, name, repo, quant, dir, sizeBytes, running }]（running=当前正在服务的那个）。
 */
export function listDownloaded() {
  const running = state.model?.dir || "";
  const out = [];
  for (const model of MODELS) {
    for (const t of model.quantTiers || []) {
      if (!isModelInstalled(model, t.quant)) continue;
      const dir = path.join(modelsDir(), model.hf.replace(/\//g, "_"), t.quant);
      let sizeBytes = 0;
      try { for (const fn of fs.readdirSync(dir)) { if (/\.part$/i.test(fn)) continue; sizeBytes += fs.statSync(path.join(dir, fn)).size; } } catch { /* ignore */ }
      out.push({ modelId: model.id, name: model.name, repo: model.hf, quant: t.quant, dir, sizeBytes, running: dir === running });
    }
  }
  return out;
}

/** 删除一个已下载的本地模型目录（dir 必须在 models/ 下；正在运行的拒绝删除）。返回 { ok, error? }。 */
export function deleteLocalModel(opts = {}) {
  const dir = String(opts.dir || "");
  const base = modelsDir();
  if (!dir || !path.resolve(dir).startsWith(path.resolve(base) + path.sep)) return { ok: false, error: "invalid dir" };
  if (state.model?.dir && path.resolve(state.model.dir) === path.resolve(dir)) return { ok: false, error: "running" };
  try { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** 依 useCuda 选定的构建变体及是否已安装（向导第 1 步：显示「安装 / 已安装」，避免重复下载）。 */
export function installInfo(opts = {}) {
  const hw = detectHardware();
  const variant = llamaVariant(hw, { preferCuda: !!opts.useCuda });
  return { variant, installed: !!installedBin(variant), version: LLAMA_VERSION };
}

/** 含 / 不含 CUDA 两个候选变体的安装状态，供向导默认选中「已安装」的那个（避免多余下载）。版本随 LLAMA_VERSION，升级即视为未装。 */
export function installStatus() {
  const hw = detectHardware();
  const cuda = detectCuda();
  const noCuda = llamaVariant(hw, { preferCuda: false });
  const withCuda = cuda.available ? llamaVariant(hw, { preferCuda: true }) : null;
  const variants = [{ useCuda: false, variant: noCuda, installed: !!installedBin(noCuda) }];
  if (withCuda && withCuda !== noCuda) variants.push({ useCuda: true, variant: withCuda, installed: !!installedBin(withCuda) });
  return { version: LLAMA_VERSION, cuda, variants };
}

/** 推荐模型：把探测到的真实显存（opts.vramGB）并入 hw，得到分层卸载感知的推荐。
 *  共享内存(集显 UMA)：GPU 用的就是系统内存 → 按统一内存对待（预算只算系统内存，绝不把这段「显存」再加一遍），
 *  否则会重复计入而高估容量、推荐放不下的量化。opts.shared 显式给出时以其为准，否则据 uma/名字判定。
 *  见 docs/vulkan-uma-windows.md。 */
export function recommend(opts = {}) {
  const hw = detectHardware();
  const shared = opts.shared != null
    ? !!opts.shared
    : (hw.backend === "vulkan" && opts.vramGB > 0 ? isSharedGpu(opts.device, opts.uma ?? null) : false);
  if (opts.vramGB && opts.vramGB > 0) {
    hw.gpu = { name: opts.device || (hw.gpu && hw.gpu.name) || "GPU", vramGB: opts.vramGB };
  }
  if (shared) { hw.unified = true; hw.shared = true; } // 集显：显存即系统内存，容量/卸载按 Apple Silicon 统一内存那套走
  const budget = usableModelMemoryGB(hw, opts.budgetGB);
  return recommendModels(hw, budget, { ctx: opts.ctx || 16384, vision: opts.vision !== false });
}

// ── 第 1 步：安装运行时 bundle ────────────────────────────────
/** 安装选定变体（已装秒回）；下载失败逐级回退 CUDA→Vulkan→CPU。返回实际安装的 { variant, bin }。 */
async function installVariant(variant, onProgress) {
  try {
    const bin = await ensureInstalled(onProgress, variant);
    return { variant, bin };
  } catch (e) {
    const fb = fallbackVariant(variant);
    if (fb) { pushLog(`[llama] 安装 ${variant} 失败（${String(e?.message ?? e)}）→ 回退 ${fb}\n`); return installVariant(fb, onProgress); }
    throw e;
  }
}

/** 向导第 1 步：确保运行时已安装（已装跳过下载）。异步；进度经 onStatus 推送。 */
export async function install(opts = {}) {
  if (state.proc) return status(); // 运行中不重装
  const hw = detectHardware();
  const variant = llamaVariant(hw, { preferCuda: !!opts.useCuda });
  state.variant = variant;
  state.error = null;
  if (installedBin(variant)) { // 已安装：无需下载
    state.installedVariant = variant;
    if (state.phase !== "ready") state.phase = "idle";
    emit();
    return status();
  }
  state.phase = "downloading";
  state.pct = 0;
  emit();
  try {
    const res = await installVariant(variant, (phase, pct) => { state.phase = phase; state.pct = pct || 0; emit(); });
    state.installedVariant = res.variant;
    state.variant = res.variant;
    state.phase = "idle";
    state.pct = 0;
    emit();
  } catch (e) {
    state.phase = "error";
    state.error = `安装 llama 失败：${String(e?.message ?? e)}`;
    emit();
  }
  return status();
}

// ── 第 2 步：探测显存（--list-devices）─────────────────────────
/** 向导第 2 步：用已安装二进制探测 GPU 显存/设备。返回 { vramGB, device, gpuPresent }；读不到则 vramGB=null。 */
export async function probe(opts = {}) {
  const variant = state.installedVariant || llamaVariant(detectHardware(), { preferCuda: !!opts.useCuda });
  const bin = installedBin(variant);
  if (!bin) { const p = { vramGB: null, device: null, gpuPresent: false, variant, error: "未安装" }; state.probe = p; emit(); return p; }
  state.phase = "probing";
  emit();
  const p = await probeDevices(bin);
  p.variant = variant;
  // UMA 判定（集显 vs 独显）：优先此前真跑模型缓存到的权威 uma；否则用 --list-devices stderr 里的（通常没有）；
  // 再否则按设备名启发式。仅对 Vulkan 有意义；CUDA(独显)/无 GPU 恒为非共享。见 docs/vulkan-uma-windows.md。
  const hw = detectHardware();
  if (hw.backend === "vulkan" && p.gpuPresent) {
    const cached = p.device ? umaCache.get(p.device.toLowerCase()) : undefined;
    if (p.uma == null && cached != null) p.uma = cached;
    p.shared = isSharedGpu(p.device, p.uma ?? null);
  } else {
    p.shared = false;
  }
  state.probe = p;
  if (state.phase === "probing") state.phase = "idle";
  pushLog(`[llama] probe ${variant}: ${p.device || "无 GPU"}${p.vramGB ? ` ${p.vramGB}GB` : ""}${p.shared ? "（共享内存/集显）" : ""}\n`);
  emit();
  return p;
}

/** 异步跑 `llama-server --list-devices`（不阻塞主进程；GPU 后端初始化可能耗时 1-3s），解析显存最大的设备。 */
function probeDevices(bin) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = () => { if (done) return; done = true; resolve(parseDevices(out)); };
    try {
      const p = spawn(bin, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"] }); // 仅枚举设备，不下载，无需 HF 端点
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { out += d.toString(); });
      p.on("error", finish);
      p.on("close", finish);
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(); }, 15000);
    } catch { resolve({ vramGB: null, device: null, gpuPresent: false }); }
  });
}

/**
 * 解析 --list-devices 输出，形如：
 *   Available devices:
 *     Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)
 * 取显存最大的设备，优先「free」。读不到（旧版无此选项 / 无 GPU）返回 gpuPresent:false。
 */
function parseDevices(out) {
  let bestMiB = 0, device = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\S.*?)\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB\s*free)?/i);
    if (!m) continue;
    const mib = Number(m[3] || m[2]); // 有 free 用 free，否则用总量
    if (mib > bestMiB) { bestMiB = mib; device = m[1].replace(/^[A-Za-z]+\d+:\s*/, "").trim(); }
  }
  const uma = parseUma(out); // --list-devices 通常不含此行 → null；个别构建/真跑模型时才有
  return bestMiB > 0
    ? { vramGB: Math.round((bestMiB / 1024) * 10) / 10, device, gpuPresent: true, uma }
    : { vramGB: null, device: null, gpuPresent: false, uma };
}

/**
 * 从 ggml Vulkan 初始化日志解析 uma 标志（stderr）：`ggml_vulkan: 0 = <name> | uma: X | fp16: ...`。
 * 返回 true（uma:1，集显/共享系统内存）、false（uma:0，独显/专用显存）、或 null（无此行，如裸 --list-devices）。
 * 见 docs/vulkan-uma-windows.md。
 */
function parseUma(out) {
  const m = String(out).match(/ggml_vulkan:\s*\d+\s*=.*?\buma:\s*([01])/i);
  return m ? m[1] === "1" : null;
}

/** 真跑模型时从 llama stderr 抓权威 uma：缓存并回填当前 probe（校准显存预算/卸载）。每次 launch 抓到一次即止。 */
function maybeCaptureUma() {
  if (umaScanned) return;
  const uma = parseUma(state.log.slice(-80).join("")); // 跨块拼接近期日志，避免 ggml 行被切分漏读
  if (uma == null) return;
  umaScanned = true;
  const dev = state.probe && state.probe.device;
  if (dev) umaCache.set(dev.toLowerCase(), uma);
  if (state.probe) { state.probe.uma = uma; state.probe.shared = isSharedGpu(dev, uma); }
  pushLog(`[llama] uma=${uma ? 1 : 0} → ${uma ? "共享内存(集显)" : "独显"}（依此校准显存预算/卸载）\n`);
  emit();
}

// ── 第 3 步：启动 llama-server ─────────────────────────────────
/** 解析 opts → { hf, repo, quant, label, vision, mtp, id, name, model, bpw }。未给 hf 时按 modelId + quantId 从目录取。
 *  repo/quant 供自主下载（hfDownload）用；vision = 该模型是否具备视觉投影能力（是否真正开启由 start 结合用户开关决定）。 */
function resolveHf(opts, hw) {
  if (opts.hf) {
    const i = opts.hf.lastIndexOf(":"); // 自定义 "user/repo:QUANT"；无 ":" 则只有 repo（无 quant → 不自下载，回退 -hf）
    const repo = i > 0 ? opts.hf.slice(0, i) : opts.hf;
    const quant = i > 0 ? opts.hf.slice(i + 1) : "";
    return { hf: opts.hf, repo, quant, label: opts.label || opts.hf, vision: !!opts.multimodal, mtp: !!opts.mtp, id: opts.model || opts.hf, name: opts.label || opts.hf, model: null, bpw: null };
  }
  const model = MODELS.find((m) => m.id === opts.modelId);
  if (!model) return null;
  // 量化标签直接透传（可能是分档模型的 UD 标签，不在通用 QUANTS 里 —— 不要用 QUANTS 过滤）；未指定时按内存自动选。
  const quantId = opts.quantId || autoQuantId(model, hw, Number(opts.ctx || 16384));
  return { hf: `${model.hf}:${quantId}`, repo: model.hf, quant: quantId, label: model.name, vision: !!model.vision, mtp: model.mtp, id: model.id, name: model.name, model, bpw: quantBpw(model, quantId) };
}

/** 决定 -ngl：统一内存(Metal)/共享内存(集显)/未知 → 全卸载；CPU 构建 → 0；独显 → 按探测显存分层卸载。 */
function computeNgl(variant, r, ctx, kvBits, hw) {
  if (variant.includes("macos") || (hw && hw.unified)) return 999;
  if (state.probe && state.probe.shared) return 999; // 集显共享系统内存：全卸载即可，不做「按专用显存分层」估算
  if (!/cuda|vulkan/.test(variant)) return 0; // CPU 构建
  const vram = (state.probe && state.probe.vramGB) || (hw.gpu && hw.gpu.vramGB) || 0;
  return gpuLayers(r.model, r.bpw, ctx, kvBits, vram);
}

/**
 * 启动本地模型（异步：必要时先安装 llama，再拉起 llama-server）。立即返回当前状态；
 * 后续 downloading/loading/ready/error 经 onStatus 推送。
 * opts: { modelId?, quantId?, hf?, ctx?, port?, useCuda?, vision?, mmproj? }
 *   vision（默认 true）：模型具备视觉能力时是否加载视觉投影（关闭则 --no-mmproj，省 ~1GB 内存）。
 */
// 残留清理：应用被强杀（未走 before-quit → stop）时 llama-server 会成孤儿并占住端口，下次启动 bind 失败退出。
// 用 pidfile 记录本进程 PID；下次启动前若该 PID 仍是 llama-server 就杀掉（校验命令行含 llama-server，避免 PID 复用误杀）。
// 让内核分配一个空闲端口（listen 0 → 取端口 → 关闭），随机端口避免固定 8080 冲突。
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
  } catch { /* 进程已不在 */ }
}

export function start(opts = {}) {
  stop();
  killOrphanServer(); // 清理上次强杀残留的 llama-server（否则占住端口导致本次 bind 失败）
  openLog(`会话开始 ${new Date().toISOString()} · model=${opts.modelId || opts.hf || "?"}`); // 本次启动全程输出落盘
  const hw = detectHardware();
  const r = resolveHf(opts, hw);
  if (!r) { state.phase = "error"; state.error = "unknown modelId"; emit(); return status(); }

  const visionOn = r.vision && opts.vision !== false; // 仅在模型支持视觉且开关未关时为真
  const mtpOn = !!r.mtp && opts.mtp !== false;  // MTP 投机解码（模型支持且开关未关，默认开）
  // 上下文 / KV 量化自动分档：未显式指定时按「模型 + 量化 + 设备内存」选放得下的最大 -c（封顶原生窗口），
  // 优先 KV q8，放不下自动降 q4 解锁更大上下文（见 localModels.pickCtxKv）。自定义 -hf（无目录条目）回退 16K/q8。
  const pick = !opts.ctx && r.model ? pickCtxKv(r.model, r.bpw, hw, usableModelMemoryGB(hw), visionOn) : null;
  const ctx = Number(opts.ctx || (pick ? pick.ctx : 16384));
  const kvBits = Number(opts.kvBits || (pick ? pick.kvBits : 8));
  state.port = Number(opts.port || 0); // 0 = launch 里向内核申请随机空闲端口
  state.ctx = ctx;
  const modelDir = r.repo && r.quant ? path.join(localFilesBase(), "models", r.repo.replace(/\//g, "_"), r.quant) : null;
  state.model = { hf: r.hf, label: r.label, multimodal: visionOn, id: r.id, name: r.name, ctx, dir: modelDir, repo: r.repo || null, quant: r.quant || null }; // ctx = 启动时 -c，渲染层用作该模型的真实上下文窗口；dir/repo/quant 供模型库匹配「运行中」
  state.ready = false;
  state.error = null;
  state.log = [];
  state.pct = 0;
  try { fs.mkdirSync(KV_DIR, { recursive: true }); } catch { /* ignore */ }

  // 优先复用向导第 1 步已安装的变体；否则按 useCuda 现选（launch 内再确保安装）。
  const variant = state.installedVariant || llamaVariant(hw, { preferCuda: !!opts.useCuda });
  const gen = ++launchGen; // 本次启动代号；launch 内 await 后核对，过期即放弃 spawn
  launch(variant, { r, hw, ctx, kvBits, visionOn, mtpOn, gen });
  emit();
  return status();
}

/** 安装（必要时下载）指定变体 → 拉起 llama-server；GPU 构建就绪前失败自动回退下一级（CPU 变体无回退，不会无限递归）。 */
async function launch(variant, cfg) {
  const { r, hw, ctx, kvBits = 8, visionOn, mtpOn, gen } = cfg;
  const stale = () => gen != null && gen !== launchGen; // 本次启动已被后续 start/stop 取代
  const mtpSeparate = !!r.model?.mtp && !r.model?.mtpEmbedded; // Gemma：独立 MTP drafter 文件（需下载 + -md）
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
    if (fb) { pushLog(`[llama] 安装 ${variant} 失败（${String(e?.message ?? e)}）→ 回退 ${fb}\n`); return launch(fb, cfg); }
    state.phase = "error"; state.error = `安装 llama 失败：${String(e?.message ?? e)}`; emit(); return;
  }

  // 自主下载模型权重（带进度/断点续传/镜像）；成功用 -m 启动，失败回退 -hf 让 llama 自己拉，用户中止则不再启动。
  const hfEnd = await resolveHfEndpoint(); // 启动前实测 huggingface.co 可达性，不通则用镜像
  const modelsDir = path.join(localFilesBase(), "models"); // GGUF 权重目录（自下载落地于此；回退 -hf 时也用作 LLAMA_CACHE）
  try { fs.mkdirSync(modelsDir, { recursive: true }); } catch { /* ignore */ }
  let modelPath = null, mmprojPath = null, mtpPath = null;
  if (r.repo && r.quant) {
    const destDir = path.join(modelsDir, r.repo.replace(/\//g, "_"), r.quant);
    const local = localModelFiles(destDir);
    const drafterMissing = mtpSeparate && !local.mtp; // 需独立 drafter 但本地没有 → 需补拉（约百 MB）
    if (r.model && isModelInstalled(r.model, r.quant) && !drafterMissing) {
      // 已完整安装（且不缺 drafter）：直接用本地文件，跳过下载阶段（不显示「下载中」）。
      modelPath = path.join(destDir, local.weights[0]);
      mmprojPath = local.mmproj ? path.join(destDir, local.mmproj) : null;
      mtpPath = local.mtp ? path.join(destDir, local.mtp) : null;
      pushLog(`[llama] 已安装，直接加载：${path.basename(modelPath)}\n`);
    } else {
      const ac = new AbortController();
      state.dlAbort = ac;
      try {
        state.phase = "fetching"; state.pct = 0; emit();
        // 始终下载 mmproj（模型具备视觉时）与独立 MTP drafter（Gemma），使运行时可自由切换视觉/MTP 而无需重下；
        // 已装模型只缺 drafter 时，downloadModel 会跳过已有权重/视觉投影、仅补拉 drafter。Qwen 为内置 MTP（无独立文件）。
        const out = await downloadModel(
          { endpoint: hfEnd, repo: r.repo, quant: r.quant, vision: !!r.vision, mtp: mtpSeparate, destDir },
          (pct) => { if (pct !== state.pct) { state.pct = pct; emit(); } },
          ac.signal,
        );
        modelPath = out.modelPath; mmprojPath = out.mmprojPath; mtpPath = out.mtpPath || null;
        pushLog(`[llama] 模型就绪：${path.basename(modelPath)}${mmprojPath ? ` + ${path.basename(mmprojPath)}` : ""}${mtpPath ? ` + ${path.basename(mtpPath)}` : ""}\n`);
      } catch (e) {
        if (ac.signal.aborted) { pushLog("[llama] 已取消模型下载\n"); return; } // 用户 stop：不再拉起服务
        // 不回退 -hf（会落到 HF 缓存布局、不可控）：自下载失败即报错。
        state.phase = "error"; state.error = `模型下载失败：${String(e?.message ?? e)}`; pushLog(`[llama] 模型下载失败：${String(e?.message ?? e)}\n`); emit(); return;
      } finally {
        if (state.dlAbort === ac) state.dlAbort = null;
      }
    }
  }

  if (stale()) { pushLog("[llama] 启动已被新的启动/停止取代，放弃本次\n"); return; } // 下载/安装期间用户又点了启动或停止
  state.phase = "loading";
  state.pct = 0;
  emit();
  if (!state.port) state.port = await findFreePort(); // 随机空闲端口（避免固定 8080 冲突）
  if (stale()) { pushLog("[llama] 启动已被取代，放弃 spawn\n"); return; }
  const ngl = computeNgl(variant, r, ctx, kvBits, hw);
  pushLog(`[llama] ${variant} -ngl ${ngl} -c ${ctx} kv=q${kvBits} :${state.port}${state.probe && state.probe.vramGB ? `（显存≈${state.probe.vramGB}GB）` : ""}\n`);
  // 目录模型必有 quant → 一定走自下载并得到本地权重；无 -hf 分支。视觉关闭则不传 --mmproj（文件仍在，仅不加载）。
  if (!modelPath) { state.phase = "error"; state.error = "模型权重缺失（自下载未产出）"; emit(); return; }
  // MTP：内置头（Qwen）→ 仅 --spec-type；独立 drafter（Gemma）→ -md + --spec-type，仅当 drafter 文件确实在。
  // drafter 缺失（下载失败）时不加开关，降级为无投机解码而非报错。
  const haveMtp = r.model?.mtpEmbedded ? true : (mtpSeparate && !!mtpPath);
  const useMtp = !!mtpOn && haveMtp;
  const mtpDraft = useMtp && mtpSeparate ? mtpPath : null;
  if (mtpOn && !haveMtp) pushLog("[llama] MTP 已开启但未找到 drafter，本次不启用投机解码\n");
  const args = buildServerArgs({ modelPath, mmproj: visionOn ? mmprojPath : null, mtpDraft, specMtp: useMtp, hw, ctx, port: state.port, kvBits, kvCacheDir: KV_DIR, ngl });
  pushLog(`[llama] argv: ${bin} ${args.join(" ")}\n`); // 完整启动命令（便于排查）
  let proc;
  try {
    proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HF_ENDPOINT: hfEnd, LLAMA_CACHE: modelsDir } });
  } catch (e) {
    const fb = fallbackVariant(variant);
    if (fb) { pushLog(`[llama] 启动 ${variant} 失败（${String(e?.message ?? e)}）→ 回退 ${fb}\n`); return launch(fb, cfg); }
    state.phase = "error"; state.error = String(e?.message ?? e); emit(); return;
  }
  state.proc = proc;
  try { fs.writeFileSync(pidFile(), String(proc.pid)); } catch { /* ignore */ } // 记录 PID，供下次启动清理强杀残留
  umaScanned = false; // 本次启动重新扫描 stderr 里的权威 uma:
  const onData = (b) => { pushLog(b.toString()); maybeCaptureUma(); };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  // 「本 proc 是否仍是当前服务进程」：若已被后续 start() 换成新 proc，则旧 proc 的 error/exit
  // 不得清空全局状态（否则会误杀新 proc 的健康轮询/proc 引用，导致新服务实际就绪却一直显示「启动中」）。
  const isCurrent = () => state.proc === proc;
  proc.on("error", (e) => { if (state.proc && !isCurrent()) return; state.error = String(e?.message ?? e); state.phase = "error"; state.proc = null; stopHealthPoll(); emit(); });
  proc.on("exit", (code) => {
    if (state.proc && !isCurrent()) { pushLog(`[llama] 旧进程退出（code=${code}），已被新启动取代，忽略\n`); return; } // 陈旧 proc：不动全局状态
    state.proc = null;
    pushLog(`[llama] 进程退出，code=${code}\n`); // 落盘退出码，便于排查崩溃（日志流留到 stop/下次启动才关闭）
    try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
    const wasReady = state.ready;
    state.ready = false;
    const fb = fallbackVariant(variant);
    if (code && code !== 0 && !wasReady && fb) {
      stopHealthPoll();
      pushLog(`[llama] ${variant} 未就绪即退出（code ${code}）→ 回退 ${fb}\n`);
      return launch(fb, cfg);
    }
    if (code && code !== 0 && !state.error) { state.error = `llama-server 退出（code ${code}）`; state.phase = "error"; }
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
      if (ok && !state.ready) { state.ready = true; state.phase = "ready"; state.error = null; emit(); stopHealthPoll(); }
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }, 1000);
}

export function stop() {
  stopHealthPoll();
  launchGen++; // 使任何进行中的 launch 过期（在 spawn 前放弃）
  if (state.dlAbort) { try { state.dlAbort.abort(); } catch { /* ignore */ } state.dlAbort = null; } // 中止进行中的模型下载
  // SIGKILL 而非 SIGTERM：llama-server 在加载权重（mmap/warmup）期间会忽略 SIGTERM，
  // 导致「加载中再次启动」时旧进程杀不掉、占住端口并泄漏。本地推理服务无需优雅退出。
  if (state.proc) { const p = state.proc; try { p.kill("SIGKILL"); } catch { /* ignore */ } state.proc = null; }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
  closeLog();
  state.port = 0; // 下次启动重新申请随机端口
  state.ready = false;
  state.phase = "idle";
  state.model = null; // 清除「运行中」关联，否则模型库列表仍把该模型标为 running（删除按钮会被误禁用）
  emit();
  return status();
}

/** 「重新开始」：停止服务 + 清除探测/模型结果，回到向导第 1 步；保留已安装运行时（不重复下载）。 */
export function reset() {
  stop();
  state.probe = null;
  state.model = null;
  state.error = null;
  state.pct = 0;
  emit();
  return status();
}
