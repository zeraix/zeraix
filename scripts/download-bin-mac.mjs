#!/usr/bin/env node
/**
 * DOWNLOAD 单个 macOS 二进制包（内含 qemu + llama 两个子目录）并铺到
 * resources/bin/darwin-<arch>/{qemu,llama}/，供 dist:mac 内置。
 *   - qemu：沙箱命令执行引擎（Apple Silicon 才需要）；
 *   - llama：本地大模型推理（llama-server，Metal 后端）。
 * 一次下载一个 zip（bin/darwin-<arch>.zip），解压后按子目录拆分到各自 resources 目录。
 * CDN 优先（docker.zeraix.com，无凭据），失败回落鉴权 OSS。对应上传见 scripts/bundle-bin-mac.mjs。
 *
 *   node scripts/download-bin-mac.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import AdmZip from "adm-zip";
import OSS from "ali-oss";

if (process.platform !== "darwin") { console.log("[download-mac] not macOS — skip"); process.exit(0); }
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
const cdn = (env.OSS_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");
const key = env.OSS_BIN_MAC_KEY || `${env.OSS_PREFIX || ""}bin/darwin-${ARCH}.zip`;
const encKey = key.split("/").map(encodeURIComponent).join("/");

// zip 内两个子目录 → 各自 resources 目录；自测方式不同。
const PAYLOADS = [
  { name: "qemu", exes: ["qemu-system-aarch64", "qemu-img"], selfTest: { exe: "qemu-system-aarch64", stripDyld: true, hard: true } },
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
      res.on("data", (c) => { got += c.length; if (total) { const pct = Math.floor((got / total) * 100); if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r[download-mac] ${pct}%   `); } } });
      res.pipe(ws);
      ws.on("finish", () => { if (total) process.stdout.write("\n"); ws.close(() => resolve()); });
      ws.on("error", reject);
    }).on("error", reject);
  });
}

const zip = path.join(os.tmpdir(), `bin-darwin-${ARCH}.dl.zip`);
fs.rmSync(zip, { force: true });
const cdnUrl = `${cdn}/${encKey}`;
console.log(`[download-mac] GET ${cdnUrl}`);
try {
  await fetchTo(cdnUrl, zip);
} catch (e) {
  if (env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET && env.OSS_BUCKET && env.OSS_ENDPOINT) {
    console.warn(`[download-mac] CDN GET failed (${e.statusCode || e.message}) — falling back to authenticated OSS`);
    const client = new OSS({ accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET, bucket: env.OSS_BUCKET, region: env.OSS_ENDPOINT.replace(/\.aliyuncs\.com$/, ""), secure: true });
    await client.get(key, zip);
  } else throw e;
}
console.log(`[download-mac] downloaded ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB`);

// 解压到临时目录，再按 qemu/ 与 llama/ 子目录铺到各自 resources 目录。
const base = path.join(os.tmpdir(), `bin-darwin-${ARCH}.x`);
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
new AdmZip(zip).extractAllTo(base, true);
fs.rmSync(zip, { force: true });

for (const pl of PAYLOADS) {
  const src = path.join(base, pl.name);
  const OUT = path.join(REPO, "resources", "bin", `darwin-${ARCH}`, pl.name);
  if (!fs.existsSync(src)) { // 该 arch 未内置此载荷（如 Intel mac 无 qemu）
    fs.mkdirSync(OUT, { recursive: true });
    console.log(`[download-mac] ${pl.name}: not in bundle for darwin-${ARCH} — skip`);
    continue;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.cpSync(src, OUT, { recursive: true });
  for (const exe of pl.exes) { const p = path.join(OUT, exe); if (fs.existsSync(p)) fs.chmodSync(p, 0o755); }
  try {
    const st = pl.selfTest;
    const tEnv = st.stripDyld
      ? { PATH: "/usr/bin:/bin", DYLD_LIBRARY_PATH: "", DYLD_FALLBACK_LIBRARY_PATH: "" }
      : { PATH: "/usr/bin:/bin", DYLD_LIBRARY_PATH: OUT, DYLD_FALLBACK_LIBRARY_PATH: OUT };
    const v = execFileSync(path.join(OUT, st.exe), ["--version"], { env: tEnv }).toString().split("\n")[0];
    console.log(`[download-mac] ${pl.name} ${v}`);
  } catch (e) {
    if (pl.selfTest.hard) { console.error(`[download-mac] ${pl.name} FAILED self-test: ${e.message}`); process.exit(1); }
    console.warn(`[download-mac] ${pl.name} self-test note: ${e.message.split("\n")[0]}`);
  }
  console.log(`[download-mac] ${pl.name} OK → ${path.relative(REPO, OUT)}`);
}
fs.rmSync(base, { recursive: true, force: true });
