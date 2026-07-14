/**
 * 自主下载 Hugging Face 上的 GGUF 模型（替代 llama.cpp 的 `-hf` 黑盒下载），以便：
 *   ① 上报聚合下载进度（%）；② 断点续传；③ 走可达性探测选中的镜像端点；④ 完整可控的失败处理。
 * 下载完成后 localServer 用 `llama-server -m <首个分片>`（+ 视觉时 `--mmproj <文件>`）启动，不再让 llama 自己拉。
 *
 * 公开仓库（如 unsloth 的 GGUF）无需 token；gated/私有仓库或想提高匿名限流可设 HF_TOKEN 环境变量。
 * 端点由调用方传入（huggingface.co 或 hf-mirror.com）；两者都支持 /api/models/<repo>/tree 与 /<repo>/resolve。
 */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";

/** 带 token（可选）的请求头：公开仓库不需要，gated/限流时 HF_TOKEN 有用。 */
function authHeaders() {
  const tok = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

const isMmproj = (p) => /(^|\/)mmproj[^/]*\.gguf$/i.test(p);
// MTP / 投机解码 drafter 文件：unsloth 命名如 MTP/gemma-4-12B-it-Q4_0-MTP.gguf 或顶层 mtp-<name>.gguf。
const isMtp = (p) => /(^|\/)mtp-[^/]*\.gguf$/i.test(p) || /-mtp\.gguf$/i.test(p);

/**
 * 列出 repo 下匹配 quant 的 GGUF 权重分片（含真实字节大小），以及可选的视觉投影(mmproj)与 MTP drafter。
 * 走 HF tree API（recursive 覆盖子目录，如 unsloth 把某档放在 <QUANT>/ 子目录）。镜像同样支持该路径。
 * 返回 { weights:[{path,size}], mmproj:{path,size}|null, mtp:{path,size}|null }；无匹配抛错（上层回退 -hf）。
 */
async function listRepoFiles(endpoint, repo, quant, { vision, mtp } = {}) {
  const url = `${endpoint}/api/models/${repo}/tree/main?recursive=1`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HF tree ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("HF tree: unexpected payload");
  const files = list.filter((x) => x && x.type === "file" && typeof x.path === "string");
  const sizeOf = (x) => Number((x.lfs && x.lfs.size) || x.size || 0); // LFS 文件真实大小在 lfs.size
  const q = String(quant).toLowerCase();

  // 权重：名字含 quant 标签、以 .gguf 结尾、且非 mmproj / MTP（如 :Q4_0 会误匹配 *-Q4_0-MTP.gguf）。
  // 分片按路径自然排序（00001-of-000NN 有序）。
  const weights = files
    .filter((x) => x.path.toLowerCase().endsWith(".gguf") && x.path.toLowerCase().includes(q) && !isMmproj(x.path) && !isMtp(x.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((x) => ({ path: x.path, size: sizeOf(x) }));
  if (weights.length === 0) throw new Error(`未找到匹配 ${quant} 的 GGUF`);

  let mmproj = null;
  if (vision) {
    const cands = files.filter((x) => isMmproj(x.path));
    const pick = cands.find((x) => /f16/i.test(x.path)) || cands.find((x) => /bf16/i.test(x.path)) || cands[0] || null;
    if (pick) mmproj = { path: pick.path, size: sizeOf(pick) };
  }
  let mtpFile = null;
  if (mtp) {
    // drafter 每个草稿 token 都要整读一遍：优先最小的 Q4_0（读取量减半、起草更快），退 Q8_0，再退任意。
    const cands = files.filter((x) => isMtp(x.path));
    const pick = cands.find((x) => /q4_0/i.test(x.path)) || cands.find((x) => /q8_0/i.test(x.path)) || cands[0] || null;
    if (pick) mtpFile = { path: pick.path, size: sizeOf(pick) };
  }
  return { weights, mmproj, mtp: mtpFile };
}

/** 下载单个文件（断点续传 + 逐块进度）。写入 <dest>.part，完整后才原子改名为 dest——
 *  故「最终名存在」⇔「已完整下载」，中断只留 .part（不会被误判为已下载）。onBytes(delta) 报告新写入字节。 */
async function downloadFile(endpoint, repo, file, dest, onBytes, signal) {
  if (file.size && fs.existsSync(dest) && fs.statSync(dest).size === file.size) { onBytes(file.size); return; } // 最终名已完整：跳过
  const part = dest + ".part";
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (file.size && have > file.size) { fs.rmSync(part, { force: true }); have = 0; } // .part 异常偏大 → 重下
  if (file.size && have === file.size) { fs.renameSync(part, dest); onBytes(have); return; } // .part 已满 → 落地

  const url = `${endpoint}/${repo}/resolve/main/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { ...authHeaders() };
  if (have > 0 && file.size) headers.Range = `bytes=${have}-`;
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`GET ${file.path} → HTTP ${res.status}`);
  const resuming = res.status === 206; // 服务器接受续传；否则(200)从头覆盖
  if (resuming) onBytes(have);         // 已存在部分计入进度
  if (!res.body) throw new Error(`GET ${file.path} → 空响应体`);

  const ws = fs.createWriteStream(part, { flags: resuming ? "a" : "w" });
  try {
    for await (const chunk of Readable.fromWeb(res.body)) { // fetch 的 web 流 → Node 流（稳定支持 for-await）
      if (!ws.write(chunk)) await once(ws, "drain"); // 背压：等排空再继续
      onBytes(chunk.length);
    }
  } finally {
    await new Promise((resolve, reject) => { ws.on("error", reject); ws.end(resolve); });
  }
  fs.renameSync(part, dest); // for-await 正常结束（未 abort/报错）→ 原子落地为最终名
}

/**
 * 下载 repo:quant 的全部权重（+可选 mmproj / MTP drafter）到 destDir，聚合上报进度（0–100 整数，仅在变化时回调）。
 * 返回 { modelPath, mmprojPath, mtpPath }。已存在的文件自动续传/跳过。取消（signal.abort）会抛出，保留已下部分供下次续传。
 */
export async function downloadModel({ endpoint, repo, quant, vision, mtp, destDir }, onProgress = () => {}, signal) {
  const { weights, mmproj, mtp: mtpFile } = await listRepoFiles(endpoint, repo, quant, { vision, mtp });
  const all = [...weights, ...(mmproj ? [mmproj] : []), ...(mtpFile ? [mtpFile] : [])];
  const total = all.reduce((s, f) => s + (f.size || 0), 0);
  fs.mkdirSync(destDir, { recursive: true });

  let done = 0, lastPct = -1;
  const bump = (d) => {
    done += d;
    if (total > 0) { const p = Math.min(100, Math.floor((done / total) * 100)); if (p !== lastPct) { lastPct = p; onProgress(p); } }
  };
  for (const f of all) await downloadFile(endpoint, repo, f, path.join(destDir, path.basename(f.path)), bump, signal);
  if (lastPct !== 100) onProgress(100);

  return {
    modelPath: path.join(destDir, path.basename(weights[0].path)), // 分片首片；llama.cpp 依 -00001-of-000NN 自动补齐同目录其余片
    mmprojPath: mmproj ? path.join(destDir, path.basename(mmproj.path)) : null,
    mtpPath: mtpFile ? path.join(destDir, path.basename(mtpFile.path)) : null,
  };
}
