/**
 * QEMU engine — the command lines: the qemu-system binary and its argv, the guest's fixed mount points, and the
 * bubblewrap flags that confine each sandboxed command to its own working directory (plus the read-only asset, skills
 * and OCR-adapter binds). Part of the qemu engine; qemu.mjs is the public entry and its header describes the model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

import { GUEST_SKILLS_DIR, resolveSkillsHostDir, skillsHostDirExists } from "../../builtinSkills.mjs";
import { isWin, cfg, homeRoot } from "./shared.mjs";

const HOME = os.homedir();
export const QMP_PORT = 4444;
export const GA_PORT = 4445;
export const GUEST_MNT = "/mnt/hostfs"; // Mount point of the host root inside the guest (firstboot.sh mounts it via 9p; must match)
// The one name the working directory has inside the sandbox. The bind used to be "isomorphic" (guest path == host path),
// which put the user's real directory structure inside the VM: `pwd` printed it, every command could name it, and every
// stack trace carried it. A fixed mount point removes it, and gives the model one workspace path that is identical in
// every conversation and on every install.
const GUEST_WORKSPACE = "/workspace";

/**
 * Where the asset folder appears inside the guest (ASSET_ALIAS in tools/paths.mjs — keep in step).
 *
 * Bound READ-ONLY. It holds the media library, and the model is expected to read from it while never
 * altering it: a generated video the user cannot get back must not be destroyable by a shell command that
 * misfires. `--ro-bind` makes that a kernel refusal rather than an instruction, which is the same standard
 * every other confinement in this file is held to.
 */
const GUEST_ASSETS = "/assets";

/**
 * The host asset folder, or "" when none is configured.
 *
 * Set by the app once the data-storage location is known; empty leaves the bind set exactly as it was, so
 * nothing changes for a build that never configures one.
 */
let ASSET_HOST_DIR = "";

/** Point the read-only asset bind at a host directory, or "" to remove it. */
export function setAssetHostDir(dir) {
  ASSET_HOST_DIR = typeof dir === "string" && dir.trim() ? path.resolve(dir) : "";
  return ASSET_HOST_DIR;
}

/**
 * The read-only asset bind, or nothing.
 *
 * Skipped when the folder does not exist: bwrap fails the whole command on a bind whose source is missing,
 * so binding a not-yet-created library would break every sandbox command until the first asset was saved.
 */
function assetBind() {
  if (!ASSET_HOST_DIR) return [];
  try {
    if (!fs.existsSync(ASSET_HOST_DIR)) return [];
  } catch {
    return [];
  }
  return ["--ro-bind", guestPath(ASSET_HOST_DIR), GUEST_ASSETS];
}
/**
 * The read-only bind of the built-in skills' helper scripts (resources/skills → /mnt/skills), or nothing.
 *
 * Same shape as assetBind: skipped when the folder is absent, because bwrap fails the whole command on a bind whose
 * source is missing. Read-only for the same reason the asset library is — the scripts are application code the model
 * runs, and a shell command that misfires must not be able to rewrite them for every later conversation.
 */
function skillsBind() {
  const dir = resolveSkillsHostDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  if (!skillsHostDirExists(dir)) return [];
  return ["--ro-bind", guestPath(dir), GUEST_SKILLS_DIR];
}
/**
 * Backing directory for the sandbox's /tmp, on the guest's DISK rather than in RAM.
 *
 * bwrap used `--tmpfs /tmp`, which is RAM: a command writing a page raster there was competing with its own heap inside a 2 GiB
 * VM. It lands in run.qcow2 now — a throwaway overlay that boot() deletes and recreates every time — so the contents still
 * vanish with the VM and never reach the host. Verified from inside: `df /tmp` reports /dev/vda, not tmpfs.
 *
 * This was NOT the cause of the OOM kills that prompted it: every one of those recorded `shmem-rss:0kB`, which is where tmpfs
 * pages would show, so nothing was in /tmp at the time. It removes a ceiling rather than the one that was being hit.
 *
 * Space is shared with the swapfile on a 6 GiB disk and is not generous — measured at 77% used with 1.4 GiB free while a job
 * was running. Growing it means passing a size to qemu-img create (boot() recreates the overlay anyway) plus resize2fs in the
 * guest; /dev/vda is a bare filesystem with no partition table, so nothing else is needed.
 *
 * One directory for the whole VM session, not one per command: /tmp is then shared between commands, which is what someone
 * writing an intermediate file in one step and reading it in the next expects. The old per-command tmpfs discarded it.
 */
export const GUEST_TMP = "/var/tmp/sandbox-tmp";

/**
 * The PP-OCRv6 adapter, shadowed from the host over the copy baked into the image.
 *
 * The image does `COPY rapidocr_v6_api.py /opt/ocr/` (Dockerfile), so without this the file only changes by rebuilding and
 * republishing the rootfs — a new VM_VERSION and a ~1 GB download for every user, to alter a default. That is the wrong price
 * for a file that is application logic: it is the pymupdf4llm↔RapidOCR integration, the piece most likely to need tuning.
 *
 * Binding the single FILE, not /opt/ocr as a directory: in dev the host source sits in sandbox/qemu/ alongside the Dockerfile
 * and the build context, none of which should appear inside the sandbox. The image copy stays as the fallback — if the host
 * file is missing (older build, resource not staged) the bind is skipped and the baked-in version is used.
 */
const GUEST_OCR_ADAPTER = "/opt/ocr/rapidocr_v6_api.py";
const ocrAdapterHostPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "ocr", "rapidocr_v6_api.py")
    : path.join(app.getAppPath(), "sandbox", "qemu", "rapidocr_v6_api.py");

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // bash single-quote escaping inside the guest

export function qemuBin() {
  if (process.env.ZERAIX_QEMU) return process.env.ZERAIX_QEMU;
  const sys = isWin ? "qemu-system-x86_64.exe" : `qemu-system-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const archDir = `${process.platform}-${process.arch}`;
  // Packaged: extraResources lays resources/bin at the root of process.resourcesPath -> <arch>/qemu/.
  // dev (`electron .`): process.resourcesPath points to Electron's own resources (none of our binaries),
  //   so read from the repo's resources/bin/<arch>/qemu instead -- app.getAppPath()=repo root, same source as main/appProtocol.mjs's WEB_ROOT.
  // On a hit, return the full path: qemu-system spawn, the derived qemu-img, and the -L share firmware directory are all fixed up together.
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, archDir, "qemu", sys),
    !app.isPackaged && path.join(app.getAppPath(), "resources", "bin", archDir, "qemu", sys),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return sys;
}

/** Host path -> where it appears inside the guest, under the 9p share of the host root.
 *  This used to also return the bwrap target, which on posix was the host path itself and on Windows was not — the bind
 *  is a fixed mount point on both now, so the two platforms no longer differ and there is one path to compute. */
function guestPath(hostPath) {
  const abs = path.resolve(hostPath);
  if (!isWin) return path.posix.join(GUEST_MNT, abs.replace(/^\//, ""));
  // Windows multi-drive: /mnt/hostfs/<drive>/<rest> (matching ninep-server's virtual multi-drive root), so a
  // workdir on any drive (C:, E:, ...) maps correctly.
  const m = abs.match(/^([A-Za-z]):[\\/]?(.*)$/);
  const drive = m ? m[1].toUpperCase() : "C";
  const rest = (m ? m[2] : "").split(path.sep).join("/");
  return path.posix.join(GUEST_MNT, drive, rest);
}

/** bubblewrap flags (excluding argv[0] and the trailing command): bind this command's cwd from /mnt/hostfs to /workspace, and chdir there.
 *  Network is open by default (no --unshare-net) -- commands inside the sandbox can reach the internet directly: pip / npm / git / curl, etc.
 *  DNS and routing are provided by the guest's SLIRP network (firstboot.sh configures 10.0.2.x + nameserver). */
/** bwrap args that overlay the host's OCR adapter onto the image's, or nothing when the host copy is absent. */
function ocrAdapterBind() {
  const host = ocrAdapterHostPath();
  // Reached through the 9p share like every other host path (guestPath), not by any special channel.
  try { if (fs.existsSync(host)) return ["--ro-bind", guestPath(host), GUEST_OCR_ADAPTER]; } catch { /* fall through */ }
  return [];
}

export function bwrapFlags(cwd) {
  // Two host directories are visible: this command's own cwd, read-write, and the asset folder, read-only.
  // Nothing else has to be registered in advance — the 9p share already covers the whole disk — so there is still no
  // mount set to keep in sync, and a command cannot reach a sibling session's files. This matches what the host-side
  // file tools enforce (tools/paths.mjs: the same two roots, the same read-only rule); the old union of roots was the
  // one way around it, and the two halves must keep agreeing or a shell could write what the file tools refuse.
  const workspace = guestPath(cwd || homeRoot || HOME);
  return [
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/opt", "/opt",
    // Shadow the image's OCR adapter with the host's, AFTER /opt is bound so it lands on top. See GUEST_OCR_ADAPTER.
    ...ocrAdapterBind(),
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--proc", "/proc", "--dev", "/dev",
    // /tmp on the guest DISK, not a tmpfs — see GUEST_TMP. A page raster or an intermediate file written here no longer
    // eats the same RAM the command itself needs.
    "--bind", GUEST_TMP, "/tmp",
    // Put the toolbox venv first on PATH INSIDE the sandbox (bwrap runs every command), so
    // python/pip/unoserver/… resolve. Explicit --setenv so it holds regardless of how the
    // guest-agent/login-shell env would otherwise flow in. (Image also sets it in
    // /etc/profile.d for direct login/SSH shells.)
    "--setenv", "PATH", "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    // The rest of the image's runtime ENV, for the same reason. A Dockerfile `ENV` lives in image METADATA; the rootfs is
    // exported and booted by qemu, so systemd and the guest agent never see any of it. Whatever a sandbox command needs has to
    // be named here — the Dockerfile declaring it is intent, not effect.
    //
    //   PYTHONPATH  /opt/ocr holds rapidocr_v6_api.py (COPYed by the image, and /opt is ro-bound above, so the file was
    //               always there) and the image declares ENV PYTHONPATH=/opt/ocr, which by the above never reached the guest.
    //               `from rapidocr_v6_api import exec_ocr` failed with ModuleNotFoundError while `import pymupdf4llm` on the
    //               same line succeeded — so the interpreter was the guest venv and only the path was missing. NOT yet
    //               confirmed fixed by running the import in the guest.
    //   LANG        the toolbox handles CJK documents; ghostscript/poppler/unoserver read the locale for encoding. Python
    //               coerces C -> C.UTF-8 on its own (PEP 538), the native tools do not.
    //   PYTHONUNBUFFERED  every command's stdout is redirected to a log file, so block buffering would hold a long-running
    //               script's output back until it exits instead of streaming it.
    //   JAVA_HOME   `java` and `javac` are on PATH without it, but Maven, Gradle and most JVM build scripts read JAVA_HOME and
    //               fail outright when it is unset. /usr/lib/jvm/default-java is the stable symlink java-common maintains, so
    //               this survives the suite moving to a new JDK release.
    "--setenv", "PYTHONPATH", "/opt/ocr",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PYTHONUNBUFFERED", "1",
    "--setenv", "JAVA_HOME", "/usr/lib/jvm/default-java",
    // The writable root: this command's own cwd, at the fixed mount point, and where it starts.
    "--bind", workspace, GUEST_WORKSPACE,
    // The second root: readable, never writable. See assetBind and tools/paths.mjs — the file tools enforce
    // the identical split on the host side, and the two must not disagree about what is writable.
    ...assetBind(),
    // The built-in document skills' helper scripts, readable at a fixed path (see builtinSkills.mjs).
    ...skillsBind(),
    "--chdir", GUEST_WORKSPACE,
    // NOT --unshare-user: bwrap runs as root in the guest, and a user namespace makes the 9p
    // share (security_model=none) refuse the bind source with EPERM. bwrap-as-root still confines
    // the filesystem view to the workspace (that's the goal here); the VM is the privilege boundary.
    // Net is NOT unshared → the workload uses the guest's SLIRP network (internet reachable).
    "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session",
  ];
}

// ── Boot ─────────────────────────────────────────────────────────────────────
export function qemuArgs(vd, overlay) {
  const mem = cfg?.memory > 0 ? cfg.memory : 4096;
  const cpus = cfg?.cpus > 0 ? cfg.cpus : 4;
  const shareRoot = isWin ? `${process.env.SystemDrive || "C:"}\\` : "/";
  // Direct kernel boot (no bootloader / UEFI): qemu loads the kernel directly, whole-disk ext4 as the /dev/vda root (no partition table).
  // Image + initrd.img are produced and distributed by build-rootfs-local.sh together with rootfs (boot() already verifies they exist).
  const con = !isWin && process.arch === "arm64" ? "ttyAMA0" : "ttyS0"; // virt=pl011 / q35=16550
  const a = [
    "-smp", String(cpus), "-m", String(mem),
    // cache=writeback. cache=none was tried, on the theory that the host cache for this image was inflating qemu's footprint,
    // and measured NO change: 3.25 GB before, 3.34 GB after, at the same -m 2048. vmmap shows why — the excess over guest RAM
    // is qemu's own process memory (~1.2 GB: 282 MB of libraries plus writable regions), not page cache for the disk. So
    // writeback stays, because it is the faster mode and the slower one bought nothing.
    "-drive", `if=none,file=${overlay},format=qcow2,id=hd0,cache=writeback,discard=unmap`,
    // romfile= disables the PCI option ROM (efi-virtio.rom): we kernel-boot / never PXE-boot,
    // and a relocated (bundled) qemu can't find qemu's data dir, so requiring the ROM would
    // abort boot. This keeps the bundle data-file-free (see scripts/bundle-bin-mac.mjs).
    "-device", "virtio-blk-pci,drive=hd0,romfile=",
    "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22",
    "-device", "virtio-net-pci,netdev=net0,romfile=",
    // No virtio-balloon here, deliberately. `virtio-balloon-pci,free-page-reporting=on,deflate-on-oom=on` was tried and
    // measured WORSE on macOS/HVF: resident went from 3.78 GB to 4.93 GB against a 4.83 GB ceiling, i.e. the guest ended up
    // having touched 100% of its RAM. The mechanism was not established — the plausible reading is that reporting free pages
    // makes the guest walk them while the host-side discard does not actually decommit on Darwin, but that was not verified.
    // The measurement is the reason it is absent; treat the explanation as a guess.
    // Windows has no virtio-9p (fsdev compiled out); the host share is instead an in-process
    // 9p-over-TCP server mounted post-boot (winShareMount). macOS/Linux share via virtio-9p here.
    ...(isWin ? [] : ["-fsdev", `local,id=hostfs,path=${shareRoot},security_model=none`,
      "-device", "virtio-9p-pci,fsdev=hostfs,mount_tag=hostfs"]),
    "-qmp", `tcp:127.0.0.1:${QMP_PORT},server=on,wait=off`,
    "-chardev", `socket,host=127.0.0.1,port=${GA_PORT},server=on,wait=off,id=ga`,
    "-device", "virtio-serial-pci",
    "-device", "virtserialport,chardev=ga,name=org.qemu.guest_agent.0",
    "-display", "none",
    "-chardev", `file,id=ser0,path=${path.join(vd, "console.log")}`,
    "-serial", "chardev:ser0",
    "-kernel", path.join(vd, "Image"), "-initrd", path.join(vd, "initrd.img"),
    // Windows: signal firstboot (via kernel cmdline) to skip the virtio-9p mount — there is no such
    // device; the host mounts the share over 9p-over-tcp post-boot instead (see winShareMount).
    "-append", `root=/dev/vda rw console=${con}${isWin ? " zeraix.share=tcp" : ""} init=/lib/systemd/systemd`,
  ];
  if (isWin) {
    // After packaging, qemu lives at process.resourcesPath/<platform>-<arch>/qemu/, so an explicit -L must point to the
    // bundled firmware directory (SeaBIOS/option ROM), otherwise the relocated qemu can't find its data directory and fails to boot (bundle-bin-win.mjs is responsible for placing share/).
    const share = path.join(path.dirname(qemuBin()), "share");
    const L = fs.existsSync(share) ? ["-L", share] : [];
    // WHPX is far pickier about the CPU model than HVF/KVM: `-cpu max` exposes conflicting features like APX/MPX, and the guest
    // triple-faults within the first few instructions (WHPX: Unexpected VP exit code 4=UnrecoverableException). Use the named model
    // Haswell instead (SSE4.2/AVX2/AES all present and WHPX boots stably, measured booting to login). Do not use max/host on Windows.
    return ["-machine", "q35,accel=whpx,kernel-irqchip=off", "-cpu", "Haswell", ...L, ...a];
  }
  if (process.platform === "darwin") return ["-machine", "virt,accel=hvf,gic-version=3", "-cpu", "host", ...a];
  const machine = process.arch === "arm64" ? "virt,accel=kvm,gic-version=3" : "q35,accel=kvm";
  return ["-machine", machine, "-cpu", "host", ...a]; // linux
}
