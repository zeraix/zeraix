#!/usr/bin/env node
/**
 * DOWNLOAD the macOS binary package from Hugging Face and lay it out into resources/bin/darwin-<arch>/qemu/, to be bundled by dist:mac.
 *   - qemu: the sandbox command-execution engine (only needed on Apple Silicon). Bundled rather than fetched at runtime
 *     because HVF needs build-time signing and the com.apple.security.hypervisor entitlement.
 * llama is NOT in here. It is installed at runtime from Hugging Face (electron/llm/llamaInstaller.mjs), which is why
 * PAYLOADS below has a single entry; an older zip may still carry a llama/ directory, and nothing lays it out.
 * Downloads one zip (qemu/darwin-<arch>.zip) and copies the qemu subdirectory out of it.
 * Public on Hugging Face, so no credentials are needed. For the corresponding upload see scripts/bundle-bin-mac.mjs.
 *
 *   node scripts/download-bin-mac.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import AdmZip from "adm-zip";
import { resolveHfEndpoint } from "../electron/llm/hfEndpoint.mjs";

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
// Hugging Face, not the OSS bucket behind docker.zeraix.com. The bundle is public there, so a build machine needs no
// credentials at all — the Windows object in OSS was private, which made OSS_ACCESS_KEY_ID/_SECRET a build prerequisite
// whenever the CDN missed. Same repo and the same resolve URL the app already uses for the llama runtime.
const HF_REPO = env.ZERAIX_LLAMA_BUILDS_REPO || "Zeraix/llama-builds";
const key = env.ZERAIX_BIN_MAC_KEY || `qemu/darwin-${ARCH}.zip`;

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
// The endpoint probe is the app's own (hfEndpoint.mjs): a build machine behind the Great Firewall gets hf-mirror.com
// automatically, which is what the OSS bucket was there to provide.
const endpoint = await resolveHfEndpoint((l) => console.log(`[download-mac] ${l}`));
const url = `${endpoint}/${HF_REPO}/resolve/main/${key}`;
console.log(`[download-mac] GET ${url}`);
await fetchTo(url, zip);
console.log(`[download-mac] downloaded ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB`);

// Extract into a temp directory, then copy each PAYLOADS subdirectory (qemu only) into its resources directory.
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
