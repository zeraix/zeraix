#!/usr/bin/env node
/**
 * DOWNLOAD 单个 Windows 二进制包（内含 qemu + llama 两个子目录）并铺到
 * resources/bin/win32-<arch>/{qemu,llama}/，供 dist:win 内置。
 *   - qemu：沙箱命令执行引擎；
 *   - llama：本地大模型推理（llama-server.exe，建议 Vulkan 后端：跨 NVIDIA/AMD/Intel）。
 * 一次下载一个 zip（bin/win32-<arch>.zip），解压后按子目录拆分。CDN 优先，失败回落鉴权 OSS。
 * 可在任意构建主机运行；仅在 Windows 上做 --version 自测。对应上传见 scripts/bundle-bin-win.mjs。
 *
 *   node scripts/download-bin-win.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import AdmZip from "adm-zip";
import OSS from "ali-oss";

const REPO = process.cwd();
const ARCH = process.arch;

function loadEnv() {
  const env = { ...process.env };
  for (const p of [path.join(REPO, "sandbox", "qemu", ".env"), path.join(REPO, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim();
    }
  }
  return env;
}
const env = loadEnv();
const bucket = env.OSS_BUCKET, endpoint = env.OSS_ENDPOINT;
const cdn = (env.OSS_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");
const key = env.OSS_BIN_WIN_KEY || `${env.OSS_PREFIX || ""}bin/win32-${ARCH}.zip`;
const encKey = key.split("/").map(encodeURIComponent).join("/");

const PAYLOADS = [
  { name: "qemu", selfTest: { exe: "qemu-system-x86_64.exe", hard: true } },
  // llama 不再随包分发（改为运行时动态安装，见 electron/llm/llamaInstaller.mjs）。
];

function fetchTo(url, dest, maxRedirs = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirs > 0) {
        res.resume(); return resolve(fetchTo(res.headers.location, dest, maxRedirs - 1));
      }
      if (res.statusCode !== 200) {
        let b = ""; res.on("data", (d) => (b += d));
        res.on("end", () => reject(Object.assign(new Error(`GET ${res.statusCode}: ${b.slice(0, 300)}`), { statusCode: res.statusCode })));
        return;
      }
      const total = Number(res.headers["content-length"] || 0); let got = 0, lastPct = -1;
      const ws = fs.createWriteStream(dest);
      res.on("data", (c) => { got += c.length; if (total) { const pct = Math.floor((got / total) * 100); if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r[download-win] ${pct}%   `); } } });
      res.pipe(ws);
      ws.on("finish", () => { if (total) process.stdout.write("\n"); ws.close(() => resolve()); });
      ws.on("error", reject);
    }).on("error", reject);
  });
}

const zip = path.join(os.tmpdir(), `bin-win32-${ARCH}.dl.zip`);
fs.rmSync(zip, { force: true });
const cdnUrl = `${cdn}/${encKey}`;
console.log(`[download-win] GET ${cdnUrl}`);
try {
  await fetchTo(cdnUrl, zip);
} catch (e) {
  if (env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET && bucket && endpoint) {
    console.warn(`[download-win] CDN GET failed (${e.statusCode || e.message}) — falling back to authenticated OSS`);
    const client = new OSS({ accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET, bucket, region: endpoint.replace(/\.aliyuncs\.com$/, ""), secure: true });
    await client.get(key, zip);
  } else throw e;
}
console.log(`[download-win] downloaded ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB`);

const base = path.join(os.tmpdir(), `bin-win32-${ARCH}.x`);
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
new AdmZip(zip).extractAllTo(base, true);
fs.rmSync(zip, { force: true });

for (const pl of PAYLOADS) {
  const src = path.join(base, pl.name);
  const OUT = path.join(REPO, "resources", "bin", `win32-${ARCH}`, pl.name);
  if (!fs.existsSync(src)) { fs.mkdirSync(OUT, { recursive: true }); console.log(`[download-win] ${pl.name}: not in bundle — skip`); continue; }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.cpSync(src, OUT, { recursive: true });
  if (process.platform === "win32") {
    try {
      const v = execFileSync(path.join(OUT, pl.selfTest.exe), ["--version"]).toString().split(/\r?\n/)[0];
      console.log(`[download-win] ${pl.name} ${v}`);
    } catch (e) {
      if (pl.selfTest.hard) { console.error(`[download-win] ${pl.name} FAILED self-test — ${pl.selfTest.exe} did not run: ${e.message}`); process.exit(1); }
      console.warn(`[download-win] ${pl.name} self-test note: ${e.message.split(/\r?\n/)[0]}`);
    }
  }
  console.log(`[download-win] ${pl.name} OK → ${path.relative(REPO, OUT)}`);
}
fs.rmSync(base, { recursive: true, force: true });
