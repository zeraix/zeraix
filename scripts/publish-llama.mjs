#!/usr/bin/env node
/**
 * PUBLISH: publishes the llama.cpp builds for each platform/backend (runtime files only) to OSS
 * (fronted by the docker.zeraix.com CDN), for the app to dynamically download and install per-platform
 * at runtime (see electron/llm/llamaInstaller.mjs).
 *
 * For each variant: pull assets from the GitHub release (LLAMA_VERSION) → extract runtime files
 * (llama-server etc. + backend libraries)
 * → repackage uniformly into `<variant>.tar.gz` (unpacked at runtime with the system tar, so the client
 *   needs no bundled dependency)
 * → upload `llama/<version>/<variant>.tar.gz`.
 *
 *   node scripts/publish-llama.mjs [tag]
 *
 * The version tag is given by the first CLI argument or the LLAMA_VERSION env var, and accepts a bare
 * tag or a release-page URL (default b9907):
 *   node scripts/publish-llama.mjs b9912
 *   node scripts/publish-llama.mjs https://github.com/ggml-org/llama.cpp/releases/tag/b9912
 *   npm run publish:llama -- b9912
 * After publishing, sync LLAMA_VERSION in electron/llm/llamaInstaller.mjs to this tag so the app will
 * download the new version.
 *
 * Requires OSS credentials (.env / sandbox/qemu/.env: OSS_ACCESS_KEY_ID/_SECRET/_BUCKET/_ENDPOINT/OSS_PREFIX?/OSS_ACL?).
 * SKIP_UPLOAD=1 only stages the package without uploading; to publish only some platforms: ONLY=macos-arm64,win-vulkan-x64.
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
// Version tag: CLI argument / LLAMA_VERSION env var; accepts a bare tag (b9912) or a release-page URL (.../tag/b9912).
const VERSION = (process.argv[2] || LLAMA_VERSION).replace(/^.*\/tag\//, "").replace(/\/+$/, "").trim();

// variant → GitHub release asset-name suffix (one-to-one with the values of llamaInstaller.llamaVariant).
// variant → { asset: GitHub asset-name suffix, extra?: extra asset to merge into the same directory (CUDA's cudart DLL package) }
const VARIANTS = {
  "macos-arm64": { asset: "bin-macos-arm64.tar.gz" },
  "macos-x64": { asset: "bin-macos-x64.tar.gz" },
  "win-vulkan-x64": { asset: "bin-win-vulkan-x64.zip" },
  "win-cpu-x64": { asset: "bin-win-cpu-x64.zip" }, // fallback when there is no Vulkan loader
  "win-cpu-arm64": { asset: "bin-win-cpu-arm64.zip" },
  // CUDA (NVIDIA, opt-in): llama build + cudart runtime DLLs merged into one self-contained package.
  "win-cuda-12.4-x64": { asset: "bin-win-cuda-12.4-x64.zip", extra: "cudart-llama-bin-win-cuda-12.4-x64.zip" },
  "win-cuda-13.3-x64": { asset: "bin-win-cuda-13.3-x64.zip", extra: "cudart-llama-bin-win-cuda-13.3-x64.zip" },
  "ubuntu-vulkan-x64": { asset: "bin-ubuntu-vulkan-x64.tar.gz" },
  "ubuntu-x64": { asset: "bin-ubuntu-x64.tar.gz" }, // CPU fallback
  "ubuntu-vulkan-arm64": { asset: "bin-ubuntu-vulkan-arm64.tar.gz" },
  "ubuntu-arm64": { asset: "bin-ubuntu-arm64.tar.gz" }, // CPU fallback
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
    req.setTimeout(120000, () => req.destroy(new Error(`timed out (120s with no data): ${url}`)));
    req.on("error", reject);
  });
}

// Fetch and extract one release asset (.tar.gz via the system tar, .zip via adm-zip) into destDir; returns the asset name.
async function fetchExtract(rel, suffix, destDir) {
  // Note: CUDA's cudart-llama-bin-...zip and the main build llama-<ver>-bin-...zip both end in bin-...zip,
  // and cudart comes earlier in the asset list — when several match, prefer the llama-* main build (cudart is matched by extra using its full name).
  const matches = (rel.assets || []).filter((a) => a.name.endsWith(suffix));
  const asset = matches.find((a) => a.name.startsWith("llama-")) || matches[0];
  if (!asset) throw new Error(`asset missing (*${suffix})`);
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
  console.log(`[publish-llama] release ${rel.tag_name}: ${(rel.assets || []).length} assets`);

  for (const [variant, spec] of Object.entries(VARIANTS)) {
    if (only.length && !only.includes(variant)) continue;
    const src = path.join(os.tmpdir(), `llama-pub-src-${variant}`);
    fs.rmSync(src, { recursive: true, force: true }); fs.mkdirSync(src, { recursive: true });
    let names;
    try {
      names = await fetchExtract(rel, spec.asset, src);
      if (spec.extra) names += " + " + await fetchExtract(rel, spec.extra, src); // CUDA: merge cudart DLLs
    } catch (e) {
      console.warn(`[publish-llama] ${variant}: ${e.message} — skipped`);
      fs.rmSync(src, { recursive: true, force: true });
      continue;
    }
    console.log(`[publish-llama] ${variant} ← ${names}`);

    // Extract the runtime files, flattened into stage/
    const stage = path.join(os.tmpdir(), `llama-pub-stage-${variant}`);
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    let kept = 0;
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (KEEP.test(p)) { fs.copyFileSync(p, path.join(stage, e.name)); kept++; } } })(src);
    fs.rmSync(src, { recursive: true, force: true });

    const serverName = variant.startsWith("win") ? "llama-server.exe" : "llama-server";
    if (!fs.existsSync(path.join(stage, serverName))) { console.warn(`[publish-llama] ${variant}: ${serverName} not found — skipped`); continue; }

    // Repackage uniformly into tar.gz (unpacked at runtime with the system tar).
    const outTar = path.join(os.tmpdir(), `${variant}.tar.gz`);
    fs.rmSync(outTar, { force: true });
    execFileSync("tar", ["-czf", outTar, "-C", stage, "."]);
    console.log(`[publish-llama] ${variant} staged ${kept} files → ${(fs.statSync(outTar).size / 1048576).toFixed(0)} MB`);

    const key = `${env.OSS_PREFIX || ""}llama/${VERSION}/${variant}.tar.gz`;
    if (skip || !client) { console.log(`[publish-llama] ${variant} not uploaded (SKIP_UPLOAD/no credentials) → ${outTar}  (key: ${key})`); continue; }
    console.log(`[publish-llama] ${variant} uploading → oss://${env.OSS_BUCKET}/${key} …`);
    // Multipart upload: the CUDA package is ~600MB and a single put would hit ali-oss's 60s timeout; multipart uses 10MB per part, well under the timeout.
    await client.multipartUpload(key, outTar, {
      partSize: 10 * 1024 * 1024,
      headers: env.OSS_ACL ? { "x-oss-object-acl": env.OSS_ACL } : {},
      progress: (p) => { process.stdout.write(`\r    upload ${Math.floor(p * 100)}%   `); },
    });
    process.stdout.write("\n");
    console.log(`[publish-llama] ${variant} OK → ${key}`);
  }
  if (!skip && client && writeLlamaVersion(VERSION))
    console.log(`[publish-llama] LLAMA_VERSION → ${VERSION} (written to electron/versions.json, please commit)`);
  console.log("[publish-llama] done.");
}

main().catch((e) => { console.error(`[publish-llama] FAILED: ${e.message}`); process.exit(1); });
