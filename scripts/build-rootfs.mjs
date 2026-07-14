#!/usr/bin/env node
/**
 * Build the VM rootfs (rootfs.qcow2 + Image + initrd.img) via sandbox/qemu/build-rootfs-local.sh
 * (needs Docker), then version it by the built **Docker image ID** and stage it under the local
 * app-data VM dir the runtime reads (electron/tools/sandbox/vmpaths.mjs). Cross-platform:
 *   - Windows: runs the script + `docker image inspect` inside WSL (Docker lives there).
 *   - macOS/Linux: bash + docker directly (Docker Desktop / native).
 * Flow: build → `.../vm/.build-<arch>/` (staging) → `docker image inspect` → version = sha-<12hex>
 *   → rename to `.../vm/<version>/` → write VM_VERSION.<arch> into electron/versions.mjs (commit it).
 * ARCH_DEB defaults per platform (amd64 for Win/Linux-x64, arm64 for Apple Silicon); override ARCH_DEB / SUITE.
 * Pair with publish-rootfs.mjs — `npm run image:publish` does both.
 *
 *   node scripts/build-rootfs.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appNameFromPackage, guestArch, localDataDir } from "../electron/tools/sandbox/vmpaths.mjs";
import { shortImageId, writeVmVersion } from "./vmVersion.mjs";

const REPO = process.cwd();
const isWin = process.platform === "win32";
const archDeb = process.env.ARCH_DEB || guestArch(); // 与 publish/runtime 同一推导（mac=arm64 / win=amd64 / linux 随架构）
const suite = process.env.SUITE || "trixie";
const imgTag = `zx-vm-${archDeb}`;

// C:\Users\hp\AppData\Local\Zeraix\vm  ->  /mnt/c/Users/hp/AppData/Local/Zeraix/vm  (for the WSL invocation)
const toWsl = (p) => {
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split(path.sep).join("/")}` : p;
};

const vmRoot = path.join(localDataDir(appNameFromPackage()), "vm");
const staging = path.join(vmRoot, `.build-${archDeb}`); // 版本（镜像 ID）构建后才知，先建到暂存目录，再改名到 .../vm/<version>/
fs.rmSync(staging, { recursive: true, force: true });

console.log(`[build-rootfs] building ARCH_DEB=${archDeb} SUITE=${suite} → ${staging}`);
if (isWin) {
  const scriptDir = toWsl(path.join(REPO, "sandbox", "qemu"));
  const cmd = `cd ${scriptDir} && ARCH_DEB=${archDeb} SUITE=${suite} bash build-rootfs-local.sh "${toWsl(staging)}"`;
  console.log(`[build-rootfs] wsl -e bash -lc "${cmd}"`);
  execFileSync("wsl.exe", ["-e", "bash", "-lc", cmd], { stdio: "inherit" });
} else {
  const script = path.join(REPO, "sandbox", "qemu", "build-rootfs-local.sh");
  execFileSync("bash", [script, staging], { stdio: "inherit", env: { ...process.env, ARCH_DEB: archDeb, SUITE: suite } });
}

// 版本 = 刚构建的 docker 镜像 ID（per-arch）。Windows 上 docker 在 WSL 内。
const inspectArgs = ["image", "inspect", "--format", "{{.Id}}", imgTag];
const rawId = (isWin
  ? execFileSync("wsl.exe", ["-e", "docker", ...inspectArgs], { encoding: "utf8" })
  : execFileSync("docker", inspectArgs, { encoding: "utf8" })).trim();
const version = shortImageId(rawId);

// staging → .../vm/<version>/（原子替换；version 已隐含 arch，无需 arch 段）。
const out = path.join(vmRoot, version);
fs.rmSync(out, { recursive: true, force: true });
fs.renameSync(staging, out);

const updated = writeVmVersion(archDeb, version);
console.log(`[build-rootfs] VM_VERSION.${archDeb} = ${version}${updated ? "（已写入 electron/versions.json，请提交）" : "（未变）"}`);
console.log(`[build-rootfs] OK — rootfs built to ${out}`);
