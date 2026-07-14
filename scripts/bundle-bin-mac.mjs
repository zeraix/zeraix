#!/usr/bin/env node
/**
 * Stage a self-contained QEMU for macOS into resources/bin/darwin-<arch>/qemu/ so it ships in
 * the app (electron-builder extraResources) and qemu.mjs finds it at
 * process.resourcesPath/qemu/darwin-<arch>/qemu-system-aarch64 (+ qemu-img).
 *
 * Copies qemu-system-aarch64 + qemu-img and their non-system dylib closure into libs/,
 * rewrites every load command to @loader_path / @executable_path (no /opt/homebrew leakage),
 * then ad-hoc codesigns everything — the qemu-system binary with the com.apple.security.
 * hypervisor entitlement HVF requires (matches homebrew's own signing). No qemu data dir is
 * bundled: our kernel-boot invocation needs none (verified with `-L /nonexistent`).
 *
 * Sandbox is Apple-Silicon-only (HVF); on Intel macs the app stays native, so nothing is
 * bundled for darwin-x64 (an empty dir is left so electron-builder's extraResources glob
 * doesn't fail on that arch).
 *
 * RELEASE NOTE: electron-builder re-signs nested code with the app's Developer ID and applies
 * entitlementsInherit (resources/entitlements.mac.inherit.plist, which includes
 * com.apple.security.hypervisor) — so the notarized build keeps HVF without any afterSign step.
 * The ad-hoc signing + qemu-entitlements.plist here is enough for `dist:dir` / local runs
 * (where electron-builder does not re-sign).
 *
 *   node scripts/bundle-bin-mac.mjs
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import OSS from "ali-oss";

if (process.platform !== "darwin") { console.log("[bundle-bin] not macOS — skip"); process.exit(0); }

const REPO = process.cwd();
const ARCH = process.arch; // arm64 on Apple Silicon
const ENT = path.join(REPO, "resources", "qemu", "qemu-entitlements.plist");

// OSS config loader (process.env wins, then sandbox/qemu/.env, then repo .env).
function loadEnv() {
  const e = { ...process.env };
  for (const p of [path.join(REPO, "sandbox", "qemu", ".env"), path.join(REPO, ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && e[m[1]] === undefined) e[m[1]] = m[2].trim();
    }
  }
  return e;
}

// Intel mac: sandbox stays native (HVF is arm64-only here) — leave an empty dir and exit.
if (ARCH !== "arm64") {
  const dir = path.join(REPO, "resources", "bin", `darwin-${ARCH}`, "qemu");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.txt"), "Intel mac uses native execution; no qemu bundled.\n");
  console.log(`[bundle-bin] arch ${ARCH}: sandbox is native, nothing to bundle`);
  process.exit(0);
}

const OUT = path.join(REPO, "resources", "bin", `darwin-${ARCH}`, "qemu");
const LIBS = path.join(OUT, "libs");

const which = (name) => {
  for (const c of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`])
    if (fs.existsSync(c)) return c;
  try { return execSync(`command -v ${name}`).toString().trim(); }
  catch { throw new Error(`${name} not found on host — \`brew install qemu\` first`); }
};
const otoolL = (f) => execFileSync("otool", ["-L", f]).toString().split("\n").slice(1)
  .map((l) => l.trim().split(" ")[0]).filter(Boolean);
const idOf = (f) => { try { return execFileSync("otool", ["-D", f]).toString().split("\n")[1]?.trim() || null; } catch { return null; } };
const rpathsOf = (f) => {
  const lines = execFileSync("otool", ["-l", f]).toString().split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].includes("cmd LC_RPATH")) {
      const m = lines.slice(i, i + 3).join("\n").match(/path (\S+)/);
      if (m) out.push(m[1]);
    }
  return out;
};
const isSystem = (p) => p.startsWith("/usr/lib/") || p.startsWith("/System/");
const resolve = (ref, referrer) => {
  const dir = path.dirname(referrer);
  if (ref.startsWith("@loader_path/")) return path.join(dir, ref.slice(13));
  if (ref.startsWith("@executable_path/")) return path.join(dir, ref.slice(17));
  if (ref.startsWith("@rpath/")) {
    const base = ref.slice(7);
    for (const rp of rpathsOf(referrer)) {
      const cand = path.join(rp.replace("@loader_path", dir).replace("@executable_path", dir), base);
      if (fs.existsSync(cand)) return cand;
    }
    return null;
  }
  return ref; // absolute
};

console.log(`[bundle-bin] staging → ${path.relative(REPO, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(LIBS, { recursive: true });

const binOut = ["qemu-system-aarch64", "qemu-img"].map((n) => {
  const dst = path.join(OUT, n);
  fs.copyFileSync(which(n), dst); fs.chmodSync(dst, 0o755); return dst;
});

// BFS the dylib closure; copy each non-system dep into libs/ by basename.
const collected = new Map(); // basename → true
const refsOf = new Map();    // file → [{ ref, base } | { ref, base:null }]
const queue = [...binOut];
while (queue.length) {
  const f = queue.shift();
  const id = idOf(f);
  const refs = [];
  for (const ref of otoolL(f)) {
    if (ref === f || ref === id || isSystem(ref)) continue;
    const real = resolve(ref, f);
    if (!real || !fs.existsSync(real)) { refs.push({ ref, base: null }); continue; }
    const base = path.basename(real);
    refs.push({ ref, base });
    if (!collected.has(base)) {
      collected.set(base, true);
      const dst = path.join(LIBS, base);
      fs.copyFileSync(real, dst); fs.chmodSync(dst, 0o644);
      queue.push(dst);
    }
  }
  refsOf.set(f, refs);
}
console.log(`[bundle-bin] bundled ${collected.size} dylibs`);

// Relocate: dylib ids → @loader_path/<base>; every reference → @loader_path (libs) /
// @executable_path/libs (binaries).
for (const base of collected.keys())
  execFileSync("install_name_tool", ["-id", `@loader_path/${base}`, path.join(LIBS, base)]);
for (const [f, refs] of refsOf) {
  const isBin = binOut.includes(f);
  for (const { ref, base } of refs) {
    if (!base) { console.warn(`[bundle-bin]   unresolved ref left as-is: ${ref} (in ${path.basename(f)})`); continue; }
    const nref = isBin ? `@executable_path/libs/${base}` : `@loader_path/${base}`;
    if (ref !== nref) execFileSync("install_name_tool", ["-change", ref, nref, f]);
  }
}

// install_name_tool invalidates signatures — re-sign (arm64 refuses unsigned/altered code).
for (const base of collected.keys())
  execSync(`codesign --force --sign - "${path.join(LIBS, base)}"`);
execSync(`codesign --force --sign - "${path.join(OUT, "qemu-img")}"`);
execSync(`codesign --force --sign - --entitlements "${ENT}" "${path.join(OUT, "qemu-system-aarch64")}"`);

// Self-test: run the bundled binary with a stripped env (no homebrew) to prove it's
// self-contained, and confirm the hypervisor entitlement is present.
const sys = path.join(OUT, "qemu-system-aarch64");
const ver = execFileSync(sys, ["--version"], { env: { PATH: "/usr/bin:/bin", DYLD_LIBRARY_PATH: "", DYLD_FALLBACK_LIBRARY_PATH: "" } }).toString().split("\n")[0];
const ent = execFileSync("codesign", ["-d", "--entitlements", ":-", sys]).toString();
const leaks = execFileSync("bash", ["-c", `otool -L "${sys}" "${LIBS}"/*.dylib | grep -c /opt/homebrew || true`]).toString().trim();
const size = execSync(`du -sh "${OUT}" | cut -f1`).toString().trim();
console.log(`[bundle-bin] ${ver}`);
console.log(`[bundle-bin] hypervisor entitlement: ${/com\.apple\.security\.hypervisor/.test(ent) ? "present ✓" : "MISSING ✗"}`);
console.log(`[bundle-bin] /opt/homebrew references remaining: ${leaks} (want 0)`);
console.log(`[bundle-bin] bundle size: ${size}   → ${path.relative(REPO, OUT)}`);
if (leaks !== "0") { console.error("[bundle-bin] FAILED: homebrew paths leaked"); process.exit(1); }
console.log("[bundle-bin] OK — self-contained");

// ── 打包 qemu 为单包 bin/darwin-<arch>.zip（zip 内 qemu/ 子目录）并上传；SKIP_UPLOAD=1 只暂存。
//    llama 不再随包分发，改为运行时动态安装（见 electron/llm/llamaInstaller.mjs、scripts/publish-llama.mjs）。──
const oss = loadEnv();
const zipPath = path.join(os.tmpdir(), `bin-darwin-${ARCH}.zip`);
fs.rmSync(zipPath, { force: true });
const az = new AdmZip();
az.addLocalFolder(OUT, "qemu"); // qemu-system-aarch64 + qemu-img + libs/ → zip 内 qemu/
az.writeZip(zipPath);
console.log(`[publish] zip: ${(fs.statSync(zipPath).size / 1048576).toFixed(0)} MB → ${zipPath}`);
if (/^(1|true|yes)$/i.test(oss.SKIP_UPLOAD || "")) { console.log("[publish] SKIP_UPLOAD set — staged+zipped only."); process.exit(0); }
const { OSS_BUCKET: bucket, OSS_ENDPOINT: endpoint, OSS_ACCESS_KEY_ID: keyId, OSS_ACCESS_KEY_SECRET: keySecret } = oss;
if (!bucket || !endpoint || !keyId || !keySecret) { console.error("[publish] missing OSS config in sandbox/qemu/.env — staged+zipped only."); process.exit(1); }
const ossKey = oss.OSS_BIN_MAC_KEY || `${oss.OSS_PREFIX || ""}bin/darwin-${ARCH}.zip`;
const client = new OSS({ accessKeyId: keyId, accessKeySecret: keySecret, bucket, region: endpoint.replace(/\.aliyuncs\.com$/, ""), secure: true });
console.log(`[publish] uploading ${(fs.statSync(zipPath).size / 1048576).toFixed(0)} MB → oss://${bucket}/${ossKey} …`);
// Bucket blocks public object ACLs (download uses the CDN); set OSS_ACL only if the bucket permits.
await client.put(ossKey, zipPath, oss.OSS_ACL ? { headers: { "x-oss-object-acl": oss.OSS_ACL } } : {});
console.log(`[publish] OK — published (private): oss://${bucket}/${ossKey}`);
