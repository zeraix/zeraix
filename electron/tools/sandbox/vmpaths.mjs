/**
 * VM 镜像目录（rootfs.qcow2 + 内核）的统一位置。运行时（qemu.mjs）与构建/发布脚本
 * （build-rootfs / publish-rootfs）共用同一处，确保三者一致。纯 node（不依赖 electron），便于脚本直接引入。
 *
 * 大体积、可重下、机器本地（绝不随 Windows 漫游）→ 各平台「本地应用数据」目录：
 *   Windows  %LOCALAPPDATA%\<App>\vm
 *   macOS    ~/Library/Application Support/<App>/vm
 *   Linux    $XDG_DATA_HOME(或 ~/.local/share)/<App>/vm
 * <App> 必须与 userData 的应用名一致——注意 dev（package.json name = "Zeraix"）与打包
 * （electron-builder productName = "OperEase"）不同：运行时传 basename(app.getPath("userData"))，
 * 脚本传 appNameFromPackage()（仅 dev 运行）。ZERAIX_VMDIR 环境变量可覆盖整个 VM 目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM_VERSION } from "../../versions.mjs";

// VM 镜像版本移至单一来源 electron/versions.mjs（与 LLAMA_VERSION 同处；per-arch = docker 镜像 ID 短哈希）。此处透传。
// 路径为 vm/<id>/（不含 arch —— 镜像 ID 已隐含架构）；换 id → 换目录 → 重新下载 + 清理旧版本。
export { VM_VERSION };

/** 各平台本地应用数据根（含应用名）。appName 必传，须与 userData 应用名一致。 */
export function localDataDir(appName) {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), appName);
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", appName);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), appName);
}

/** 指定架构（默认本机）对应的 VM 镜像版本（docker 镜像 ID 短哈希；per-arch，空=未构建）。 */
export function vmVersion(arch = guestArch()) {
  return VM_VERSION[arch] || "";
}

/** VM 镜像目录（含版本，vm/<id>/，无 arch 段）。override（ZERAIX_VMDIR）为完整目录、优先且不追加版本。 */
export function vmDir(appName, arch = guestArch(), override) {
  return override || process.env.ZERAIX_VMDIR || path.join(localDataDir(appName), "vm", vmVersion(arch));
}

/** 供无 electron 的脚本取应用名：仓库根 package.json 的 name（dev 运行时 app.getName() 同源）。 */
export function appNameFromPackage(repoRoot = process.cwd()) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name || "Zeraix"; }
  catch { return "Zeraix"; }
}

/**
 * VM guest 架构（分发 / 下载 / 发布路径 `vm/<arch>/` 的 <arch>）。运行时、构建、发布三者共用同一推导，
 * 避免默认值分叉：Windows guest=amd64（WHPX x86-64），macOS guest=arm64（HVF aarch64），Linux 跟随主机。
 * 交叉构建时用 ARCH_DEB（构建）/ VMARCH（发布）显式覆盖。
 */
export function guestArch() {
  if (process.platform === "win32") return "amd64";
  if (process.platform === "darwin") return "arm64";
  return process.arch === "arm64" ? "arm64" : "amd64";
}
