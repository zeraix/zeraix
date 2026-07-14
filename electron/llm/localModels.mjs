/**
 * 本地模型目录 + 依硬件推荐 + llama-server 启动参数（主进程，纯逻辑无副作用）。
 *
 * 体积按「参数量 × 每权重比特(bpw)」估算；架构维度（层数/KV 头/头维）为近似值，仅用于估 KV 缓存。
 * 目录含 Qwen3.6 旗舰 + Gemma 4 QAT（E4B/12B/26B-A4B，面向低端→中端）；UI 也允许直接填任意 `user/repo:QUANT`，
 * 故此列表是推荐而非限制。GGUF 仓库名 / 量化可用性以 Hugging Face 为准，落地前请核对。
 */
import os from "node:os";
import { execSync } from "node:child_process";

const round = (n) => Math.round(n * 10) / 10;

// 量化档：质量高→体积小。bpw = 有效每权重比特。
export const QUANTS = [
  { id: "Q8_0", bpw: 8.5, quality: 99, label: "Q8_0 · 近无损" },
  { id: "Q6_K", bpw: 6.56, quality: 97, label: "Q6_K · 很高" },
  { id: "Q5_K_M", bpw: 5.67, quality: 95, label: "Q5_K_M · 高" },
  { id: "Q4_K_M", bpw: 4.85, quality: 90, label: "Q4_K_M · 均衡（默认）" },
  { id: "IQ4_XS", bpw: 4.25, quality: 87, label: "IQ4_XS · 紧凑 4-bit" },
  { id: "Q3_K_M", bpw: 3.91, quality: 80, label: "Q3_K_M · 小" },
  { id: "IQ3_M", bpw: 3.5, quality: 74, label: "IQ3_M · 很小" },
  { id: "IQ2_M", bpw: 2.7, quality: 58, label: "IQ2_M · 极小（明显掉质量）" },
];

// 能力高→小。active=激活参数（MoE）；arch 仅用于估 KV。
export const MODELS = [
  {
    id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B", params: 35, active: 3, moe: true, vision: true, mtp: true, mtpEmbedded: true,
    // vision:true = 该 GGUF 仓库带视觉投影（mmproj）。启动时显式 --mmproj 加载同仓库视觉投影（视觉开启，默认）；
    // 视觉关闭则传 --no-mmproj 跳过（省 ~1GB 常驻内存，见 VISION_OVERHEAD_GB）。是否真有 mmproj 以 HF 仓库为准。
    // mtpEmbedded:true = 用 unsloth 的「-MTP-GGUF」仓库：MTP（多 token 预测）头内置于权重本身（自投机，无独立 drafter 文件），
    // 同样发 UD 量化 + mmproj。启动时 --spec-type draft-mtp 启用自投机解码（关闭视觉/MTP 只影响加载/开关，权重仍来自该仓库）。
    hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", arch: { L: 48, kvH: 4, hd: 128 }, maxCtx: 262144,
    // unsloth 只发 UD 动态量化；按设备内存分档选 UD 标签（即 -hf 的 :QUANT）。memGB = Mac 统一内存总量 / 独显显存。
    quantTiers: [
      { minMemGB: 31, quant: "UD-Q4_K_XL", bpw: 4.5 },
      { minMemGB: 23, quant: "UD-Q3_K_XL", bpw: 3.6 },
      // UD-Q2_K_XL（约 14GB 权重）在 16G 机器上给 KV/上下文的余量过小，暂注释；如需在 16G 勉强跑 35B 再启用。
      // { minMemGB: 16, quant: "UD-Q2_K_XL", bpw: 2.6 },
    ],
    notes: "MoE，约 3B 激活 → 解码快、质量接近大模型。多模态 + 智能编码。"
  },
  // —— Gemma 4 QAT（量化感知训练）系列：4-bit 近 bf16，用官方 QAT 检查点做的 unsloth UD GGUF。
  // 只用 UD-Q4_K_XL（QAT 仓库仅发 Q2/Q4，Q2 掉质量明显故舍弃）。三者仓库都含独立 MTP drafter（MTP/mtp-*-Q4_0.gguf，约百 MB），
  // 随主权重自下载并经 -md + --spec-type draft-mtp 启用投机解码（默认开，UI 可关）。drafter 缺失时降级为无投机（不阻断启动）。
  // vision:true：三仓库均自带 mmproj（mmproj-F16.gguf 等），启动时显式 --mmproj 加载视觉投影；不需要视觉可在 UI 关闭（省 ~1GB 常驻）。
  {
    id: "gemma4-26b-a4b", name: "Gemma 4 26B-A4B", params: 26, active: 4, moe: true, vision: true, mtp: true,
    hf: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 18, quant: "UD-Q4_K_XL", bpw: 4.37 }, // 14.2 GB
    ],
    notes: "MoE 约 4B 激活 → 解码快、质量高。多模态（仅图像，无音频）。"
  },
  {
    // mtp:true：稠密 12B 解码受带宽限制（每 token 读 ~6.7GB），投机解码约 1.5–2× 提速。drafter（MTP/…-Q4_0-MTP.gguf，
    // ~254MB）与主权重同仓库，自下载时随权重一并拉取（hfDownload），启动经 -md 传给 llama-server；-hf 回退路径不启用。
    id: "gemma4-12b", name: "Gemma 4 12B", params: 12, active: 12, moe: false, vision: true, mtp: true,
    hf: "unsloth/gemma-4-12B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 12, quant: "UD-Q4_K_XL", bpw: 4.48 }, // 6.72 GB
    ],
    notes: "稠密 12B，质量接近 26B-A4B。多模态（图/音）。"
  },
  {
    id: "gemma4-e4b", name: "Gemma 4 E4B", params: 8, active: 8, moe: false, vision: true, mtp: true,
    // ≈4.5B 有效参数（8B 原始，MatFormer + Per-Layer Embeddings）；低端笔记本首选（4–5GB 即可）。
    // 原生工具调用 token，适合智能体。Q4_0 会掉质量，故用 UD-Q4_K_XL。
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF", arch: { L: 34, kvH: 4, hd: 256, swa: { every: 6, window: 1024 } }, maxCtx: 131072,
    quantTiers: [
      { minMemGB: 8, quant: "UD-Q4_K_XL", bpw: 4.22 }, // 4.22 GB
    ],
    notes: "≈4.5B 有效参数。原生工具调用，QAT 4-bit 近 bf16。多模态（图/音）。"
  },
  // { id: "qwen3.6-27b", name: "Qwen3.6-27B", params: 27, active: 27, moe: false, vision: true, mtp: false,
  //   hf: "unsloth/Qwen3.6-27B-GGUF", arch: { L: 64, kvH: 8, hd: 128 },
  //   notes: "稠密 27B，质量最高但算力更重（全参激活 → 解码慢于 A3B）。多模态。" },
  // { id: "qwen3-coder-30b-a3b", name: "Qwen3-Coder-30B-A3B", params: 30, active: 3, moe: true, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", arch: { L: 48, kvH: 4, hd: 128 },
  //   notes: "纯文本编码专精，MoE 约 3B 激活。适合代码智能体；比 3.6 更轻、无视觉开销。" },
  // { id: "qwen3-14b", name: "Qwen3-14B", params: 14, active: 14, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-14B-GGUF", arch: { L: 40, kvH: 8, hd: 128 }, notes: "稠密 14B，16GB 级机器的稳妥选择。" },
  // { id: "qwen3-8b", name: "Qwen3-8B", params: 8, active: 8, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-8B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "稠密 8B，12GB 机器 / 8GB 显卡的好默认。" },
  // { id: "qwen3-4b", name: "Qwen3-4B", params: 4, active: 4, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-4B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "稠密 4B，8GB 机器 / 老显卡可跑。" },
  // { id: "qwen3-1.7b", name: "Qwen3-1.7B", params: 1.7, active: 1.7, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-1.7B-GGUF", arch: { L: 28, kvH: 8, hd: 128 }, notes: "低内存 / 纯 CPU 可跑。快但推理力有限。" },
];

const OVERHEAD_BASE_GB = 0.6;
// 视觉投影（mmproj）常驻显存/内存的近似开销：Qwen-VL 级 ViT 视觉塔约 0.6–1.4GB，取 1GB。仅在视觉开启且模型支持时计入。
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
      backend = "vulkan"; // 有 GPU 但读不到显存；让用户在 UI 里手填
      gpu = null;
    }
  }
  return { platform, arch, backend, unified, totalMemGB, gpu, cores: os.cpus().length };
}

/**
 * Vulkan GPU：区分「集显（共享系统内存 UMA）」与「独显（专用显存）」。见 docs/vulkan-uma-windows.md。
 * 权威信号是 ggml 的 `uma:` 标志（uma:1=集显 / uma:0=独显），由 llama stderr 解析（--list-devices 不打印，
 * 需真正加载模型时才有）。uma 未知时退回按设备名启发式，并默认「共享」——这是保守选择：宁可当集显（预算只算
 * 系统内存）也不把一段系统内存重复计成独立显存而高估容量、推荐放不下的量化。
 * @param {string|null} name --list-devices 的设备名
 * @param {boolean|null} uma 解析到的 ggml uma 标志，未知为 null
 * @returns {boolean} true=共享/UMA（按统一内存对待），false=独显（专用显存）
 */
export function isSharedGpu(name, uma) {
  if (uma === true) return true;
  if (uma === false) return false;
  const n = (name || "").toLowerCase();
  // 明确的独显信号优先判定为独显。
  if (/\b(rtx|gtx|geforce|quadro|tesla|instinct)\b/.test(n)) return false; // NVIDIA / AMD Instinct
  if (/\barc\b/.test(n)) return false; // Intel Arc（独显）
  if (/radeon\s+(rx|pro|vii)\b/.test(n) || /\brx\s?\d{3,}\b/.test(n)) return false; // AMD 独显
  // 其余一律按共享：集显名（"Radeon(TM) Graphics" / "UHD·Iris·Xe·HD Graphics" / "Vega"）以及无法判定者。
  // 真正跑一次模型即可拿到权威 uma: 并自我校正。
  return true;
}

export function usableModelMemoryGB(hw, overrideGB) {
  if (typeof overrideGB === "number" && overrideGB > 0) return round(overrideGB);
  if (hw.unified) {
    const reserve = Math.min(8, Math.max(3, hw.totalMemGB * 0.22));
    return round(Math.max(2, Math.min(hw.totalMemGB * 0.7, hw.totalMemGB - reserve)));
  }
  // 独显：部分卸载可用「可用显存 + 可用系统内存」（放不下的层留 CPU）；读不到显存则仅系统内存。
  const usableVram = hw.gpu && hw.gpu.vramGB ? Math.max(0, hw.gpu.vramGB - 1.2) : 0;
  return round(Math.max(2, usableVram + hw.totalMemGB * 0.6));
}

export function weightGB(model, quant) {
  return (model.params * quant.bpw) / 8;
}

export function kvGB(model, ctx, kvBits) {
  const { L, kvH, hd, swa } = model.arch;
  const per = (layers, len) => (layers * kvH * hd * 2 * len * (kvBits / 8)) / 1e9;
  if (!swa) return per(L, ctx);
  // 滑窗注意力（如 Gemma 4 的 5:1）：每 every 层仅 1 层全注意力按 ctx 计，其余层 KV 只占窗口大小
  // （llama.cpp iSWA 缓存按窗口分配）。全量口径会把 Gemma 的 KV 高估 ~5–6×，导致上下文分档过小。
  const gL = Math.ceil(L / swa.every);
  return per(gL, ctx) + per(L - gL, Math.min(ctx, swa.window));
}

export function computeFit(model, quant, ctx, kvBits, vision = false) {
  const w = weightGB(model, quant);
  const kv = kvGB(model, ctx, kvBits);
  const overhead = OVERHEAD_BASE_GB + (model.moe ? 0.4 : 0) + (vision && model.vision ? VISION_OVERHEAD_GB : 0);
  return { weightGB: round(w), kvGB: round(kv), overheadGB: round(overhead), totalGB: round(w + kv + overhead) };
}

export function bestQuant(model, budgetGB, ctx, kvBits) {
  for (const q of QUANTS) if (computeFit(model, q, ctx, kvBits).totalGB <= budgetGB) return q;
  return null;
}

// 上下文自动分档（由大到小）：按设备内存选「放得下的最大 -c」，封顶该模型原生窗口（maxCtx）。
// 16K 对真实使用太小（系统提示即 ~6K），故尽量往上探；同档优先 KV q8（近无损），放不下再降 q4（省一半）解锁更大上下文。
export const CTX_LADDER = [262144, 131072, 65536, 32768, 16384];

/**
 * 为「模型 + 量化」选上下文与 KV 量化：{ ctx, kvBits }。
 * cap 取 usable 预算与 deviceMem*0.78 的较大者（与分档模型按设备内存判 fits 的口径折中）。
 * 0.78 而非 0.75：KV 估算本就偏保守（q4 实际 4.5bpw 已+12%、SWA 窗口取上限），放宽让 26B-A4B 在
 * 24G 到达 128K（18.4GB≈77%，贴近 macOS Metal wired 上限 ~75–80%，极限组合首启失败可关视觉/降档）。
 * 全档放不下时回退 { 16K, q4 }（最省组合，行为接近旧默认）。
 */
export function pickCtxKv(model, bpw, hw, budgetGB, vision = false) {
  const cap = Math.max(budgetGB || 0, deviceMemGB(hw) * 0.78);
  const maxCtx = model.maxCtx || 32768;
  for (const ctx of CTX_LADDER) {
    if (ctx > maxCtx) continue;
    for (const kvBits of [8, 4]) {
      if (computeFit(model, { bpw }, ctx, kvBits, vision).totalGB <= cap) return { ctx, kvBits };
    }
  }
  return { ctx: 16384, kvBits: 4 };
}

// 设备可用于模型的容量：统一内存(Mac)用总量；独显因「部分卸载」可横跨显存 + 系统内存，故取两者之和；
// CPU / 读不到显存则仅系统内存。用于 quantTiers 分档与是否支持的判断。
export function deviceMemGB(hw) {
  if (hw.unified) return hw.totalMemGB;
  const vram = hw.gpu && hw.gpu.vramGB ? hw.gpu.vramGB : 0;
  return round(vram + hw.totalMemGB);
}

// 运行本地模型的最低门槛：低于此（deviceMem = Mac 统一内存 / 独显显存）连最小模型的最小量化都放不下 → 整体停用本地模型。
// 与目录里最低分档一致：Gemma 4 E4B 的 UD-Q4_K_XL（minMemGB=8）。旗舰 35B 现从 23GB 起（Q2 档已注释，见其 quantTiers）。
export const MIN_LOCAL_MEM_GB = 8;
export function localSupported(hw) {
  return deviceMemGB(hw) >= MIN_LOCAL_MEM_GB;
}

// 选模型的量化：有 quantTiers（如 flagship 用 unsloth UD 分档）按设备内存选 UD 标签；否则走通用 QUANTS。
function selectQuant(model, hw, budgetGB, ctx, kvBits) {
  if (model.quantTiers) {
    const mem = deviceMemGB(hw);
    const t = model.quantTiers.find((x) => mem >= x.minMemGB);
    return t ? { id: t.quant, bpw: t.bpw, quality: 90, label: t.quant } : null;
  }
  return bestQuant(model, budgetGB, ctx, kvBits);
}

// 该模型在 UI 量化下拉里可选的标签、各自体积、以及是否放得下（fits）：fits=false 的量化在 UI 里禁用（不可选）。
// 分档模型（quantTiers）按 deviceMem≥minMemGB 判 fits（与 selectQuant 同口径）；其余用通用 QUANTS 按 totalGB≤budget 判。
// 每个量化各自跑 pickCtxKv：体积按「该量化下自动选出的 ctx/kv」估算，并把 ctx 一并返回供 UI 显示。
// vision 开启且模型支持视觉时，体积含视觉投影开销（与实际启动一致）。
function modelQuants(model, hw, budgetGB, vision = false) {
  const mem = deviceMemGB(hw);
  const list = model.quantTiers
    ? model.quantTiers.map((t) => ({ id: t.quant, bpw: t.bpw, fitsByMem: mem >= t.minMemGB }))
    : QUANTS.map((q) => ({ id: q.id, bpw: q.bpw, fitsByMem: null }));
  return list.map((q) => {
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, vision);
    const totalGB = computeFit(model, { bpw: q.bpw }, pick.ctx, pick.kvBits, vision).totalGB;
    return { id: q.id, totalGB, ctx: pick.ctx, kvBits: pick.kvBits, fits: q.fitsByMem ?? totalGB <= budgetGB };
  });
}

/** 为某模型自动选量化标签（分档模型走 quantTiers 的 UD 标签，其余走通用 QUANTS）；供启动时未显式指定 quant 的回退。 */
export function autoQuantId(model, hw, ctx = 16384, kvBits = 8) {
  const q = selectQuant(model, hw, usableModelMemoryGB(hw), ctx, kvBits);
  return q ? q.id : "Q4_K_M";
}

/** 该量化标签的每权重比特（bpw）：分档模型取 quantTiers，其余取 QUANTS，未知按标签名粗估。 */
export function quantBpw(model, quantId) {
  if (model && model.quantTiers) { const t = model.quantTiers.find((x) => x.quant === quantId); if (t) return t.bpw; }
  const q = QUANTS.find((x) => x.id === quantId); if (q) return q.bpw;
  if (/Q2/i.test(quantId)) return 2.6;
  if (/Q3/i.test(quantId)) return 3.6;
  if (/Q5/i.test(quantId)) return 5.6;
  if (/Q6/i.test(quantId)) return 6.5;
  if (/Q8/i.test(quantId)) return 8.5;
  return 4.5; // Q4 及未知
}

/**
 * 计算 -ngl（卸载到 GPU 的层数）。独显按可用显存估算能放下多少层，放不下的留在 CPU（部分卸载 partial offload）。
 * vramGB 建议由启动时 `llama-server --list-devices` 探测得到（比预装粗估更准）。
 *   999 = 全部卸载；0 = 全在 CPU；N = 前 N 层在 GPU。信息不全 / 读不到显存 → 乐观全卸载（失败由回退兜底）。
 */
export function gpuLayers(model, bpw, ctx, kvBits, vramGB) {
  const L = model && model.arch ? model.arch.L : 0;
  if (!L || !bpw || !vramGB || vramGB <= 0) return 999;
  const perLayer = (model.params * bpw / 8) / L + kvGB(model, ctx, kvBits) / L; // 权重/层 + KV/层（卸载层的 KV 也在显存）
  const usable = Math.max(0, vramGB - 1.2); // 预留计算缓冲 / 桌面占用
  const n = Math.max(0, Math.min(L, Math.floor(usable / perLayer)));
  return n >= L ? 999 : n;
}

// 返回语言无关的速度码（fast|medium|slow），由渲染层按 i18n 本地化显示。
function speedHint(model, hw) {
  const a = model.moe ? model.active : model.params;
  let base = a <= 4 ? "fast" : a <= 16 ? "medium" : "slow";
  if (hw && hw.backend === "cpu") base = base === "fast" ? "medium" : "slow";
  return base;
}

/** 依硬件预算列出所有放得下的模型（各取最佳量化）并高亮 primary。每项含 ngl（GPU 卸载层数）与 layers（总层数）供 UI 显示。
 *  vision（视觉开关，默认 UI 传入）：开启且模型支持视觉时，体积估算含视觉投影开销。 */
export function recommend(hw, budgetGB, { ctx = 16384, kvBits = 8, vision = false } = {}) {
  const vram = hw.unified ? 0 : (hw.gpu && hw.gpu.vramGB) || 0;
  const options = [];
  for (const model of MODELS) {
    const q = selectQuant(model, hw, budgetGB, ctx, kvBits);
    if (!q) continue;
    const v = vision && !!model.vision;
    const pick = pickCtxKv(model, q.bpw, hw, budgetGB, v); // 每模型自动选 ctx / KV 量化（覆盖入参 16K 基线）
    const ngl = hw.unified ? 999 : hw.backend === "cpu" ? 0 : gpuLayers(model, q.bpw, pick.ctx, pick.kvBits, vram);
    options.push({ model, quant: q, fit: computeFit(model, q, pick.ctx, pick.kvBits, v), speed: speedHint(model, hw), ctx: pick.ctx, kvBits: pick.kvBits, quants: modelQuants(model, hw, budgetGB, v), ngl, layers: model.arch.L });
  }
  // primary：质量优先，且上下文越大越好——先找 ≥128K（重度使用目标），再退 ≥32K（16K 连系统提示 ~6K 都吃紧），最后兜底。
  // 无需 YaRN：目录内模型原生窗口均 ≥128K（E4B 128K，其余 256K），长上下文的代价只在 KV（已按滑窗/量化分档估算）。
  // 低带宽设备（纯 CPU / 集显共享内存；非 Apple Silicon、无独显）解码≈带宽/激活权重体积：同档优先激活参数小者
  //（16G 纯 CPU：稠密 12B 仅 ~6–10 tok/s，E4B/MoE 快一倍以上）。Mac(Metal) 与独显机器仍按质量优先。
  const dedicatedGpu = !hw.unified && !!(hw.gpu && hw.gpu.vramGB);
  const lowBw = hw.backend !== "metal" && !dedicatedGpu;
  const activeOf = (o) => (o.model.moe ? o.model.active : o.model.params);
  const pickFrom = (list) => (list.length === 0 ? null : lowBw && list.length > 1 ? [...list].sort((a, b) => activeOf(a) - activeOf(b))[0] : list[0]);
  const primary =
    pickFrom(options.filter((o) => o.quant.quality >= 85 && o.ctx >= 131072)) ||
    pickFrom(options.filter((o) => o.quant.quality >= 85 && o.ctx >= 32768)) ||
    options.find((o) => o.quant.quality >= 85) ||
    options[0] || null;
  return { budgetGB: round(budgetGB), ctx, kvBits, primary, options };
}

/**
 * 构造 llama-server 启动参数。这些开关对应我们对 rapid-mlx/oMLX/vmlx 评估的「必备项」，
 * 且都是 llama.cpp 现成功能（非源码改动）：
 *   -ngl N          卸载 N 层到 GPU（Metal/CUDA/Vulkan）；独显按显存部分卸载，其余留 CPU
 *   -fa on          flash attention（提速 + 长上下文省 KV 显存）
 *   -ctk/-ctv q8_0  KV 缓存量化
 *   --cache-reuse   跨请求复用前缀（prefix sharing）
 *   --slot-save-path 落盘 KV（当下的「SSD KV」，整槽粒度，非 vmlx 的分块 paged-SSD）
 *   -md FILE        投机解码 drafter 文件（Gemma：独立 MTP drafter；配合 --spec-type draft-mtp 生效）
 *   --spec-type draft-mtp  启用 MTP 投机解码（b9936）。Gemma 用 -md 指向独立 drafter；
 *                   Qwen「-MTP-GGUF」权重内置 MTP 头 → 只需本开关、无需 -md（自投机）。缺 -md 且非内置则不加此开关。
 *   -m FILE         本地权重文件（我们自下载后用它启动，见 hfDownload.mjs）；给了 modelPath 就不用 -hf
 *   --mmproj FILE   显式指定多模态视觉投影文件（自下载视觉模型时传入）
 *   --no-mmproj     视觉关闭：跳过 -hf 自动加载的同仓库视觉投影（省 ~1GB 常驻内存）
 *   --jinja         聊天模板 + 工具调用解析（智能体必需）
 * 优先本地：给 modelPath → `-m FILE`（+ 视觉时显式 `--mmproj FILE`），权重已由我们自主下载（带进度/续传）；
 * 未自下载（回退路径）→ `-hf repo:quant` 由 llama 自己拉，此时 noMmproj=true 才用 --no-mmproj 关掉自动视觉投影。
 */
export function buildServerArgs({ hf, modelPath = null, hw, ctx = 16384, port = 8080, kvBits = 8, mtpDraft = null, specMtp = false, mmproj = null, noMmproj = false, kvCacheDir = null, ngl = null, extraArgs = [] }) {
  const args = modelPath ? ["-m", modelPath] : ["-hf", hf];
  args.push(
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(ctx),
    "-ngl", String(ngl != null ? ngl : (hw && hw.backend === "cpu" ? 0 : 999)),
    "-fa", "on",
    "--jinja",
    "--cache-reuse", "256",
  );
  const kvType = kvBits === 8 ? "q8_0" : kvBits === 4 ? "q4_0" : "f16";
  if (kvType !== "f16") args.push("-ctk", kvType, "-ctv", kvType);
  if (kvCacheDir) args.push("--slot-save-path", kvCacheDir);
  if (mtpDraft) args.push("-md", mtpDraft); // Gemma：独立 MTP drafter 文件
  // MTP 投机解码开关（b9936）：Gemma 需配 -md drafter；Qwen 权重内置 MTP 头 → 仅开关即可自投机。
  // 无独立 drafter 且非内置（specMtp=false）时不加，避免 draft-mtp 找不到 MTP 头而报错。
  if (specMtp) args.push("--spec-type", "draft-mtp");
  if (mmproj) args.push("--mmproj", mmproj); // 显式文件覆盖（一般不用）
  else if (noMmproj) args.push("--no-mmproj"); // 视觉关闭：不加载 -hf 自动带来的视觉投影
  return args.concat(extraArgs);
}
