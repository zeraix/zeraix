/**
 * Unified location for the VM image directory (rootfs.qcow2 + kernel). The runtime (qemu.mjs) and the build/publish
 * scripts (build-rootfs / publish-rootfs) share the same location, keeping all three consistent. Pure node (no electron dependency), so scripts can import it directly.
 *
 * Large, re-downloadable, machine-local (must never roam with Windows) -> each platform's "local app data" directory:
 *   Windows  %LOCALAPPDATA%\<App>\vm
 *   macOS    ~/Library/Application Support/<App>/vm
 *   Linux    $XDG_DATA_HOME(or ~/.local/share)/<App>/vm
 * <App> must match the userData app name -- note that dev (package.json name = "Zeraix") and packaged
 * (electron-builder productName = "OperEase") differ: the runtime passes basename(app.getPath("userData")),
 * while scripts pass appNameFromPackage() (dev runs only). The ZERAIX_VMDIR environment variable can override the entire VM directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM_VERSION } from "../../versions.mjs";

// The VM image version was moved to a single source, electron/versions.mjs (alongside LLAMA_VERSION; per-arch = short hash of the docker image ID). Re-exported here.
// The path is vm/<id>/ (no arch -- the image ID already implies the arch); changing the id -> changes the directory -> re-download + prune old versions.
export { VM_VERSION };

/** Per-platform local app-data root (including the app name). appName is required and must match the userData app name. */
export function localDataDir(appName) {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), appName);
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", appName);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), appName);
}

/** The VM image version for the given arch (defaults to the host) (short hash of the docker image ID; per-arch, empty=not built). */
export function vmVersion(arch = guestArch()) {
  return VM_VERSION[arch] || "";
}

/** VM image directory (versioned, vm/<id>/, no arch segment). override (ZERAIX_VMDIR) is a full directory, takes precedence, and does not append a version. */
export function vmDir(appName, arch = guestArch(), override) {
  return override || process.env.ZERAIX_VMDIR || path.join(localDataDir(appName), "vm", vmVersion(arch));
}

/** For non-electron scripts to get the app name: the name in the repo root package.json (same source as app.getName() at dev runtime). */
export function appNameFromPackage(repoRoot = process.cwd()) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name || "Zeraix"; }
  catch { return "Zeraix"; }
}

/**
 * VM guest arch (the <arch> in the distribute / download / publish path `vm/<arch>/`). The runtime, build, and publish all share the same derivation,
 * avoiding a default-value fork: Windows guest=amd64 (WHPX x86-64), macOS guest=arm64 (HVF aarch64), Linux follows the host.
 * For cross builds, override explicitly with ARCH_DEB (build) / VMARCH (publish).
 */
export function guestArch() {
  if (process.platform === "win32") return "amd64";
  if (process.platform === "darwin") return "arm64";
  return process.arch === "arm64" ? "arm64" : "amd64";
}
