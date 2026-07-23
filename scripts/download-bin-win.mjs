#!/usr/bin/env node
/**
 * DOWNLOAD a single Windows binary bundle (containing the qemu + llama subdirectories) and lay it
 * out under resources/bin/win32-<arch>/{qemu,llama}/ for dist:win to embed.
 *   - qemu: the sandbox command-execution engine;
 *   - llama: local large-model inference (llama-server.exe, Vulkan backend recommended: works across NVIDIA/AMD/Intel).
 * Downloads one zip at a time (bin/win32-<arch>.zip) and splits it by subdirectory after extraction. CDN first, falling back to authenticated OSS on failure.
 * Can run on any build host; only runs the --version self-test on Windows. For the matching upload see scripts/bundle-bin-win.mjs.
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
  // llama is no longer distributed with the bundle (it is now installed dynamically at runtime, see electron/llm/llamaInstaller.mjs).
];

/** Windows file-lock errors: something still holds a handle, or a scanner briefly grabbed the file. */
const LOCKED = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);

/**
 * Delete a directory, retrying through transient Windows locks.
 *
 * Node's plain rmSync gives up on the first EPERM, which is the wrong default here: on Windows an
 * antivirus scanner or the file indexer routinely holds a DLL open for a moment right after it is
 * written. maxRetries/retryDelay is exactly what those options exist for.
 */
function removeDir(dir, { maxRetries = 10, retryDelay = 200 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay });
}

/**
 * Explain a lock failure in terms of what the developer can actually do about it.
 *
 * The bare Node stack ("EPERM: operation not permitted, unlink … brlapi-0.8.dll") names the symptom
 * and none of the cause. In practice the cause is almost always the app: the sandbox engine starts a
 * QEMU VM in the background on launch (electron/tools/sandbox/engine.mjs), which loads these very DLLs
 * out of resources/bin — so refreshing the bundle while Zeraix is running cannot work, and no amount of
 * retrying will change that.
 */
function lockedError(dir, e) {
  return new Error(
    `[download-win] cannot replace ${path.relative(REPO, dir)} — a file inside it is in use (${e.code}: ${path.basename(e.path || "")}).\n` +
      `  The Zeraix app is almost certainly running: it starts the QEMU sandbox VM in the background, which loads these binaries.\n` +
      `  Quit Zeraix (tray icon → Quit, not just closing the window) and run this again.\n` +
      `  If it is not running, close anything browsing that folder (Explorer, a terminal, an editor) and retry.`,
  );
}

/**
 * Swap a freshly extracted payload into place without destroying the old one first.
 *
 * The previous order — remove, then copy — meant a lock that surfaced midway through the removal left
 * the installed bundle half-deleted, so the next `dist:win` would package a broken sandbox. Renaming
 * the old directory aside is all-or-nothing: on Windows it fails outright if anything inside is open,
 * before a single file has been touched, so a locked run leaves the working copy exactly as it was.
 */
function replaceDir(src, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let parked = null;
  if (fs.existsSync(out)) {
    parked = path.join(path.dirname(out), `.${path.basename(out)}.old-${process.pid}`);
    try {
      fs.renameSync(out, parked); // same parent, so this stays a rename and never a cross-volume copy
    } catch (e) {
      if (LOCKED.has(e.code)) throw lockedError(out, e);
      throw e;
    }
  }
  try {
    fs.cpSync(src, out, { recursive: true });
  } catch (e) {
    // Put the working copy back rather than leaving nothing installed.
    if (parked) { try { removeDir(out); fs.renameSync(parked, out); } catch { /* best effort */ } }
    throw e;
  }
  if (parked) {
    // The new copy is already in place, so failing to delete the old one is cosmetic, not fatal.
    try {
      removeDir(parked);
    } catch {
      console.warn(`[download-win] note: could not remove ${path.relative(REPO, parked)} — delete it manually`);
    }
  }
}

/** Clear `.qemu.old-*` leftovers from an earlier run that could not finish its cleanup. */
function sweepParked(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\..+\.old-\d+$/.test(name)) continue;
    try { removeDir(path.join(dir, name)); } catch { /* still locked; harmless */ }
  }
}

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
removeDir(base);
fs.mkdirSync(base, { recursive: true });
new AdmZip(zip).extractAllTo(base, true);
fs.rmSync(zip, { force: true });

try {
for (const pl of PAYLOADS) {
  const src = path.join(base, pl.name);
  const OUT = path.join(REPO, "resources", "bin", `win32-${ARCH}`, pl.name);
  if (!fs.existsSync(src)) { fs.mkdirSync(OUT, { recursive: true }); console.log(`[download-win] ${pl.name}: not in bundle — skip`); continue; }
  sweepParked(path.dirname(OUT));
  replaceDir(src, OUT);
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
} catch (e) {
  // A lock failure already carries the actionable explanation; a raw Node stack on top of it just
  // buries the one line the developer needs to read.
  if (LOCKED.has(e.code) || String(e.message).startsWith("[download-win]")) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
  throw e;
} finally {
  try { removeDir(base); } catch { /* temp dir; leaving it behind is harmless */ }
}
