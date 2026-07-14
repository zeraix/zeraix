#!/usr/bin/env node
/**
 * PUBLISH a self-contained Windows QEMU to Aliyun OSS.
 *
 * Stages qemu (x86_64 emulator + qemu-img + DLLs + the x86 SeaBIOS/option-ROM firmware) into
 * resources/bin/win32-<arch>/qemu/, self-tests it, zips it (adm-zip), and uploads the zip to OSS
 * (ali-oss) so build machines can fetch it with scripts/download-bin-win.mjs instead of needing
 * a local qemu install. The staged dir is left in place for an immediate local `dist:win`.
 *
 * OSS config from sandbox/qemu/.env (or process.env): OSS_BUCKET, OSS_ENDPOINT,
 * OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_PREFIX?, OSS_QEMU_KEY?, OSS_ACL? (this bucket
 * blocks public object ACLs, so the object is private and download needs the OSS creds). Source
 * qemu: ZERAIX_QEMU_SRC, else %ProgramFiles%\qemu, else `where`. SKIP_UPLOAD=1 = stage+zip only.
 *
 *   winget install --id SoftwareFreedomConservancy.QEMU   # once, on the publisher
 *   node scripts/bundle-bin-win.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import OSS from "ali-oss";

if (process.platform !== "win32") { console.log("[bundle-bin] not Windows — skip"); process.exit(0); }

const REPO = process.cwd();
const OUT = path.join(REPO, "resources", "bin", `win32-${process.arch}`, "qemu");
const SYS = "qemu-system-x86_64.exe";
const IMG = "qemu-img.exe";

// ── .env loader (process.env wins, then sandbox/qemu/.env, then repo .env) ─────
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

// ── locate an installed qemu to harvest ──────────────────────────────────────
function findSrc() {
  if (env.ZERAIX_QEMU_SRC) return env.ZERAIX_QEMU_SRC;
  for (const c of [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "qemu"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "qemu"),
  ]) if (fs.existsSync(path.join(c, SYS))) return c;
  try {
    const p = execFileSync("where", [SYS]).toString().split(/\r?\n/)[0].trim();
    if (p) return path.dirname(p);
  } catch { /* not on PATH */ }
  throw new Error("QEMU not found — `winget install --id SoftwareFreedomConservancy.QEMU` first, or set ZERAIX_QEMU_SRC");
}
const SRC = findSrc();
if (!fs.existsSync(path.join(SRC, SYS))) throw new Error(`${SYS} not found in ${SRC}`);

console.log(`[bundle-bin] source: ${SRC}`);
console.log(`[bundle-bin] staging → ${path.relative(REPO, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "share"), { recursive: true });

// ── binaries: only the x86_64 emulator + qemu-img (skip the other ~60 target emulators) ──
for (const n of [SYS, IMG]) {
  if (!fs.existsSync(path.join(SRC, n))) throw new Error(`missing ${n} in ${SRC}`);
  fs.copyFileSync(path.join(SRC, n), path.join(OUT, n));
}

// ── DLLs: copy the whole shared-library set next to the exe (Windows loads DLLs from the exe's
// dir first). The set is shared across all targets; copy all for correctness. ──
let dllCount = 0;
for (const n of fs.readdirSync(SRC))
  if (n.toLowerCase().endsWith(".dll")) { fs.copyFileSync(path.join(SRC, n), path.join(OUT, n)); dllCount++; }

// ── firmware: loose x86 blobs in <src>/share (SeaBIOS + option ROMs) + keymaps/. Skip UEFI
// images (edk2-*, ~300 MB) + other-arch firmware — our q35 `-kernel` boot never loads them. ──
const SKIP_FW = /^(edk2-|openbios|skiboot|u-boot|opensbi|palcode|hppa-firmware|s390x?-|npcm[78]xx_|vof|slof|qemu_vga\.ndrv)/i;
const srcShare = path.join(SRC, "share");
let blobCount = 0, skipped = 0;
if (fs.existsSync(srcShare)) {
  for (const d of fs.readdirSync(srcShare, { withFileTypes: true })) {
    if (d.isFile()) {
      if (SKIP_FW.test(d.name)) { skipped++; continue; }
      fs.copyFileSync(path.join(srcShare, d.name), path.join(OUT, "share", d.name)); blobCount++;
    } else if (d.isDirectory() && d.name === "keymaps")
      fs.cpSync(path.join(srcShare, d.name), path.join(OUT, "share", d.name), { recursive: true });
  }
}

// ── self-test: run the STAGED exe with the source qemu dir removed from PATH (proves the DLL set
// is self-contained — Windows resolves DLLs from the exe's own dir). ──
const cleanPath = (process.env.PATH || "").split(";")
  .filter((p) => { try { return path.resolve(p || ".") !== path.resolve(SRC); } catch { return true; } }).join(";");
let ver = "";
try {
  ver = execFileSync(path.join(OUT, SYS), ["--version"], { env: { ...process.env, PATH: cleanPath } }).toString().split(/\r?\n/)[0];
} catch (e) {
  console.error(`[bundle-bin] FAILED self-test — staged ${SYS} did not run (missing DLL?): ${e.message}`);
  process.exit(1);
}
const du = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, d) => {
  const p = path.join(dir, d.name); return s + (d.isDirectory() ? du(p) : fs.statSync(p).size);
}, 0);
console.log(`[bundle-bin] ${ver}`);
console.log(`[bundle-bin] staged: ${SYS} + ${IMG} + ${dllCount} DLLs + ${blobCount} firmware blobs (+keymaps); skipped ${skipped}; ${(du(OUT) / 1048576).toFixed(0)} MB`);

// ── 打包 qemu 为单包 bin/win32-<arch>.zip（zip 内 qemu/ 子目录）并上传；SKIP_UPLOAD=1 只暂存。
//    llama 不再随包分发，改为运行时动态安装（见 electron/llm/llamaInstaller.mjs、scripts/publish-llama.mjs）。──
const zip = path.join(os.tmpdir(), `bin-win32-${process.arch}.zip`);
fs.rmSync(zip, { force: true });
const az = new AdmZip();
az.addLocalFolder(OUT, "qemu"); // qemu-system + qemu-img + DLLs + share/ → zip 内 qemu/
az.writeZip(zip);
console.log(`[publish] zip: ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB → ${zip}`);

if (/^(1|true|yes)$/i.test(env.SKIP_UPLOAD || "")) { console.log("[publish] SKIP_UPLOAD set — staged+zipped only."); process.exit(0); }
const { OSS_BUCKET: bucket, OSS_ENDPOINT: endpoint, OSS_ACCESS_KEY_ID: keyId, OSS_ACCESS_KEY_SECRET: keySecret } = env;
if (!bucket || !endpoint || !keyId || !keySecret) {
  console.error("[publish] missing OSS config (OSS_BUCKET/OSS_ENDPOINT/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET in sandbox/qemu/.env). Staged+zipped only.");
  process.exit(1);
}
const key = env.OSS_BIN_WIN_KEY || `${env.OSS_PREFIX || ""}bin/win32-${process.arch}.zip`;
const client = new OSS({ accessKeyId: keyId, accessKeySecret: keySecret, bucket, region: endpoint.replace(/\.aliyuncs\.com$/, ""), secure: true });
console.log(`[publish] uploading ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB → oss://${bucket}/${key} …`);
// This bucket blocks public object ACLs, so upload private (download authenticates). Only set
// OSS_ACL (e.g. public-read) if the bucket actually permits it.
await client.put(key, zip, env.OSS_ACL ? { headers: { "x-oss-object-acl": env.OSS_ACL } } : {});
console.log(`[publish] OK — published (private): oss://${bucket}/${key}`);
