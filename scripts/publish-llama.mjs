#!/usr/bin/env node
/**
 * PUBLISH：把 llama.cpp 各平台/后端构建（仅运行时文件）发布到 OSS（docker.zeraix.com CDN 前置），
 * 供 app 运行时按平台动态下载安装（见 electron/llm/llamaInstaller.mjs）。
 *
 * 对每个 variant：从 GitHub release（LLAMA_VERSION）拉取资产 → 抽运行时文件（llama-server 等 + 后端库）
 * → 统一重打包为 `<variant>.tar.gz`（运行时用系统 tar 解压，客户端无需打包依赖）
 * → 上传 `llama/<version>/<variant>.tar.gz`。
 *
 *   node scripts/publish-llama.mjs [tag]
 *
 * 版本 tag 由首个 CLI 参数或 LLAMA_VERSION 环境变量指定，接受 bare tag 或 release 页 URL（默认 b9907）：
 *   node scripts/publish-llama.mjs b9912
 *   node scripts/publish-llama.mjs https://github.com/ggml-org/llama.cpp/releases/tag/b9912
 *   npm run publish:llama -- b9912
 * 发布后需把 electron/llm/llamaInstaller.mjs 的 LLAMA_VERSION 同步为该 tag，app 才会下载新版本。
 *
 * 需 OSS 凭据（.env / sandbox/qemu/.env：OSS_ACCESS_KEY_ID/_SECRET/_BUCKET/_ENDPOINT/OSS_PREFIX?/OSS_ACL?）。
 * SKIP_UPLOAD=1 只暂存打包不上传；只发某些平台：ONLY=macos-arm64,win-vulkan-x64。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import OSS from "ali-oss";
import { LLAMA_VERSION } from "../electron/versions.mjs";
import { writeLlamaVersion } from "./vmVersion.mjs";

const REPO = process.cwd();
// 版本 tag：CLI 参数 / LLAMA_VERSION 环境变量；接受 bare tag（b9912）或 release 页 URL（.../tag/b9912）。
const VERSION = (process.argv[2] || LLAMA_VERSION).replace(/^.*\/tag\//, "").replace(/\/+$/, "").trim();

// variant → GitHub release 资产名后缀（与 llamaInstaller.llamaVariant 的取值一一对应）。
// variant → { asset: GitHub 资产名后缀, extra?: 需合并进同一目录的额外资产（CUDA 的 cudart DLL 包） }
const VARIANTS = {
  "macos-arm64": { asset: "bin-macos-arm64.tar.gz" },
  "macos-x64": { asset: "bin-macos-x64.tar.gz" },
  "win-vulkan-x64": { asset: "bin-win-vulkan-x64.zip" },
  "win-cpu-x64": { asset: "bin-win-cpu-x64.zip" }, // 无 Vulkan 加载器时的回退
  "win-cpu-arm64": { asset: "bin-win-cpu-arm64.zip" },
  // CUDA（NVIDIA，opt-in）：llama 构建 + cudart 运行时 DLL 合并为一个自包含包。
  "win-cuda-12.4-x64": { asset: "bin-win-cuda-12.4-x64.zip", extra: "cudart-llama-bin-win-cuda-12.4-x64.zip" },
  "win-cuda-13.3-x64": { asset: "bin-win-cuda-13.3-x64.zip", extra: "cudart-llama-bin-win-cuda-13.3-x64.zip" },
  "ubuntu-vulkan-x64": { asset: "bin-ubuntu-vulkan-x64.tar.gz" },
  "ubuntu-x64": { asset: "bin-ubuntu-x64.tar.gz" }, // CPU 回退
  "ubuntu-vulkan-arm64": { asset: "bin-ubuntu-vulkan-arm64.tar.gz" },
  "ubuntu-arm64": { asset: "bin-ubuntu-arm64.tar.gz" }, // CPU 回退
};
const KEEP = /(^|[\\/])(llama-server|llama-cli|llama-mtmd-cli)(\.exe)?$|\.(dylib|dll|so|metal|metallib)$/i;

function loadEnv() {
  const env = { ...process.env };
  for (const p of [path.join(REPO, "sandbox", "qemu", ".env"), path.join(REPO, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !/^\s*#/.test(line) && env[m[1]] === undefined) env[m[1]] = m[2].trim();
    }
  }
  return env;
}
const env = loadEnv();

function get(url, json, redirs = 5, progress = false) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "zeraix-publish-llama" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(get(res.headers.location, json, redirs - 1, progress)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GET ${res.statusCode} ${url}`)); }
      const total = Number(res.headers["content-length"] || 0);
      const chunks = []; let got = 0, last = -1;
      res.on("data", (d) => {
        chunks.push(d); got += d.length;
        if (progress && total) { const p = Math.floor((got / total) * 100); if (p >= last + 5) { last = p; process.stdout.write(`\r    ${p}%  ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB   `); } }
      });
      res.on("end", () => { if (progress && total) process.stdout.write("\n"); const b = Buffer.concat(chunks); resolve(json ? JSON.parse(b.toString()) : b); });
    });
    req.setTimeout(120000, () => req.destroy(new Error(`超时（120s 无数据）：${url}`)));
    req.on("error", reject);
  });
}

// 拉取并解压一个 release 资产（.tar.gz 用系统 tar，.zip 用 adm-zip）到 destDir；返回资产名。
async function fetchExtract(rel, suffix, destDir) {
  // 注意：CUDA 的 cudart-llama-bin-...zip 与主构建 llama-<ver>-bin-...zip 都以 bin-...zip 结尾，
  // 且 cudart 在资产列表里靠前 —— 多个匹配时优先取 llama-* 主构建（cudart 由 extra 用其完整名匹配）。
  const matches = (rel.assets || []).filter((a) => a.name.endsWith(suffix));
  const asset = matches.find((a) => a.name.startsWith("llama-")) || matches[0];
  if (!asset) throw new Error(`资产缺失（*${suffix}）`);
  console.log(`[publish-llama]   ↓ ${asset.name}${asset.size ? ` (${(asset.size / 1048576).toFixed(0)} MB)` : ""}`);
  const buf = await get(asset.browser_download_url, false, 5, true);
  if (/\.tar\.gz$/i.test(suffix)) {
    const tf = path.join(os.tmpdir(), `pub-${asset.name}`);
    fs.writeFileSync(tf, buf); execFileSync("tar", ["-xzf", tf, "-C", destDir]); fs.rmSync(tf, { force: true });
  } else {
    new AdmZip(buf).extractAllTo(destDir, true);
  }
  return asset.name;
}

async function main() {
  const only = (env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const skip = /^(1|true|yes)$/i.test(env.SKIP_UPLOAD || "");
  const haveOss = env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET && env.OSS_BUCKET && env.OSS_ENDPOINT;
  const client = haveOss ? new OSS({ accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET, bucket: env.OSS_BUCKET, region: env.OSS_ENDPOINT.replace(/\.aliyuncs\.com$/, ""), secure: true }) : null;

  console.log(`[publish-llama] llama.cpp ${VERSION} → llama/${VERSION}/<variant>.tar.gz`);
  const rel = await get(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${VERSION}`, true);
  console.log(`[publish-llama] release ${rel.tag_name}: ${(rel.assets || []).length} 个资产`);

  for (const [variant, spec] of Object.entries(VARIANTS)) {
    if (only.length && !only.includes(variant)) continue;
    const src = path.join(os.tmpdir(), `llama-pub-src-${variant}`);
    fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(src, { recursive: true });
    let names;
    try {
      names = await fetchExtract(rel, spec.asset, src);
      if (spec.extra) names += " + " + await fetchExtract(rel, spec.extra, src); // CUDA：合并 cudart DLL
    } catch (e) {
      console.warn(`[publish-llama] ${variant}: ${e.message} — 跳过`);
      fs.rmSync(src, { recursive: true, force: true });
      continue;
    }
    console.log(`[publish-llama] ${variant} ← ${names}`);

    // 抽运行时文件打平到 stage/
    const stage = path.join(os.tmpdir(), `llama-pub-stage-${variant}`);
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    let kept = 0;
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (KEEP.test(p)) { fs.copyFileSync(p, path.join(stage, e.name)); kept++; } } })(src);
    fs.rmSync(src, { recursive: true, force: true });

    const serverName = variant.startsWith("win") ? "llama-server.exe" : "llama-server";
    if (!fs.existsSync(path.join(stage, serverName))) { console.warn(`[publish-llama] ${variant}: 未找到 ${serverName} — 跳过`); continue; }

    // 统一重打包为 tar.gz（运行时用系统 tar 解压）。
    const outTar = path.join(os.tmpdir(), `${variant}.tar.gz`);
    fs.rmSync(outTar, { force: true });
    execFileSync("tar", ["-czf", outTar, "-C", stage, "."]);
    console.log(`[publish-llama] ${variant} staged ${kept} 文件 → ${(fs.statSync(outTar).size / 1048576).toFixed(0)} MB`);

    const key = `${env.OSS_PREFIX || ""}llama/${VERSION}/${variant}.tar.gz`;
    if (skip || !client) { console.log(`[publish-llama] ${variant} 未上传（SKIP_UPLOAD/无凭据）→ ${outTar}  (key: ${key})`); continue; }
    console.log(`[publish-llama] ${variant} uploading → oss://${env.OSS_BUCKET}/${key} …`);
    // 分片上传：CUDA 包 ~600MB，单次 put 会撞 ali-oss 的 60s 超时；分片每片 10MB，远低于超时。
    await client.multipartUpload(key, outTar, {
      partSize: 10 * 1024 * 1024,
      headers: env.OSS_ACL ? { "x-oss-object-acl": env.OSS_ACL } : {},
      progress: (p) => { process.stdout.write(`\r    上传 ${Math.floor(p * 100)}%   `); },
    });
    process.stdout.write("\n");
    console.log(`[publish-llama] ${variant} OK → ${key}`);
  }
  if (!skip && client && writeLlamaVersion(VERSION))
    console.log(`[publish-llama] LLAMA_VERSION → ${VERSION}（已写入 electron/versions.json，请提交）`);
  console.log("[publish-llama] done.");
}

main().catch((e) => { console.error(`[publish-llama] FAILED: ${e.message}`); process.exit(1); });
