#!/usr/bin/env node
/**
 * PUBLISH the VM disk image + kernel to Aliyun OSS so the Electron app downloads them on first
 * run (see electron/tools/sandbox/qemu.mjs → ensureRootfs). Uploads rootfs.qcow2 + Image +
 * initrd.img from the local app-data VM dir (built by build-rootfs) to vm/<vmArch>/<file>.
 * The big qcow2 goes via resumable multipartUpload. Downloads happen through the public CDN
 * (docker.zeraix.com), so no client creds are needed.
 *
 * OSS config from sandbox/qemu/.env. Keyed by GUEST arch (amd64 for Windows/Linux-x64, arm64 for
 * Apple Silicon): default amd64; override with VMARCH. Source dir: vmpaths.mjs (ZERAIX_VMDIR overrides).
 *
 *   node scripts/publish-rootfs.mjs
 *   VMARCH=arm64 node scripts/publish-rootfs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";
import { vmDir, appNameFromPackage, guestArch, VM_VERSION } from "../electron/tools/sandbox/vmpaths.mjs";

const REPO = process.cwd();
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
const { OSS_BUCKET: bucket, OSS_ENDPOINT: endpoint, OSS_ACCESS_KEY_ID: keyId, OSS_ACCESS_KEY_SECRET: keySecret } = env;
if (!bucket || !endpoint || !keyId || !keySecret) throw new Error("missing OSS config (OSS_BUCKET/OSS_ENDPOINT/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET in sandbox/qemu/.env)");
const vmArch = env.VMARCH || guestArch(); // defaults to following the host (mac=arm64 / win=amd64 / linux follows the arch), consistent with build/runtime
const version = VM_VERSION[vmArch];
if (!version) throw new Error(`VM_VERSION.${vmArch} is empty — run npm run build:rootfs first (it writes the version from the docker image ID)`);
const vd = vmDir(appNameFromPackage(), vmArch, env.ZERAIX_VMDIR); // same location as the dev runtime / build scripts (local app-data directory)
const CDN = (env.OSS_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");
const FILES = ["rootfs.qcow2", "Image", "initrd.img"];
for (const f of FILES) if (!fs.existsSync(path.join(vd, f))) throw new Error(`missing ${f} in ${vd} — build it first (sandbox/qemu/build-rootfs-local.sh)`);

const client = new OSS({ accessKeyId: keyId, accessKeySecret: keySecret, bucket, region: endpoint.replace(/\.aliyuncs\.com$/, ""), secure: true });
for (const f of FILES) {
  const key = `${env.OSS_PREFIX || ""}vm/${vmArch}/${version}/${f}`;
  const file = path.join(vd, f);
  const size = fs.statSync(file).size;
  console.log(`[rootfs-publish] ${f} (${(size / 1048576).toFixed(0)} MB) → oss://${bucket}/${key}`);
  if (size > 20 * 1048576) {
    let last = -1;
    await client.multipartUpload(key, file, {
      parallel: 4, partSize: 8 * 1048576,
      progress: async (p) => { const pct = Math.floor(p * 100); if (pct >= last + 5) { last = pct; process.stdout.write(`\r[rootfs-publish]   ${pct}%   `); } },
    });
    process.stdout.write("\n");
  } else {
    await client.put(key, file);
  }
  console.log(`[rootfs-publish]   done → ${CDN}/${key}`);
}
console.log(`[rootfs-publish] OK — published vm/${vmArch}/${version}/ (rootfs.qcow2 + Image + initrd.img)`);
