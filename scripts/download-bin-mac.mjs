#!/usr/bin/env node
/**
 * DOWNLOAD a single macOS binary package (containing the two subdirectories qemu + llama) and lay it out into
 * resources/bin/darwin-<arch>/{qemu,llama}/, to be bundled by dist:mac.
 *   - qemu: the sandbox command-execution engine (only needed on Apple Silicon);
 *   - llama: local large-model inference (llama-server, Metal backend).
 * Downloads one zip at a time (bin/darwin-<arch>.zip), then splits it by subdirectory into the respective resources directories.
 * CDN first (docker.zeraix.com, no credentials), falling back to authenticated OSS on failure. For the corresponding upload see scripts/bundle-bin-mac.mjs.
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

// The two subdirectories inside the zip → their respective resources directories; the self-test differs for each.
const PAYLOADS = [
  { name: "qemu", exes: ["qemu-system-aarch64", "qemu-img"], selfTest: { exe: "qemu-system-aarch64", stripDyld: true, hard: true } },
  // llama no longer ships with the package (now installed dynamically at runtime, see electron/llm/llamaInstaller.mjs).
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

// Extract into a temp directory, then lay out the qemu/ and llama/ subdirectories into their respective resources directories.
const base = path.join(os.tmpdir(), `bin-darwin-${ARCH}.x`);
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
new AdmZip(zip).extractAllTo(base, true);
fs.rmSync(zip, { force: true });

for (const pl of PAYLOADS) {
  const src = path.join(base, pl.name);
  const OUT = path.join(REPO, "resources", "bin", `darwin-${ARCH}`, pl.name);
  if (!fs.existsSync(src)) { // this arch does not bundle this payload (e.g. Intel mac has no qemu)
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
