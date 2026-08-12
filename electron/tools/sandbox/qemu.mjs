/**
 * QEMU execution engine: runs run_command inside a "single long-lived" QEMU VM (macOS=HVF / Windows=WHPX /
 * Linux=KVM). Commands run inside the guest via qemu-guest-agent, confined to the mount set by bubblewrap.
 * Same contract as native: run never throws.
 *
 * Long-lived services (dev servers, etc.) run inside the guest, and QMP hostfwd "dynamically forwards" their
 * ports to the host, so they can be previewed on the host.
 *
 * Mechanism files live in sandbox/qemu/: control.mjs (QMP + guest-agent client), Dockerfile +
 * build-rootfs-local.sh (toolbox image -> bootable qcow2). This module spawns the qemu process directly (no
 * shell), then connects with control.mjs's client.
 *
 * Mount model (no hot-mount / never rebuild): a one-time 9p share of the "host root" (posix "/", Windows drive
 * letters) into the guest's /mnt/hostfs; any cwd is already covered. The visible scope of untrusted commands is
 * confined per-command by bwrap to ONE directory: the command's own cwd, bound at the fixed guest path
 * /workspace (GUEST_WORKSPACE) and used as the guest cwd. The host path is therefore absent from the guest —
 * a command cannot name it and no `pwd` / error message can leak it.
 *
 * A sandbox failure is reported as a failed command, never re-run on the host (see sandboxFailure below). Routing to
 * native at all — dev mode, engine=native, before the VM is ready — is engine.mjs's decision, not this module's.
 * Requires real-machine boot verification (see sandbox/qemu/README).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import https from "node:https";
import { app } from "electron";

import { emitService } from "./events.mjs";
import { qmp, guestAgent } from "./control.mjs";
import { startNinepServer } from "./ninep-server.mjs";
import { vmDir, vmVersion, guestArch, localDataDir } from "./vmpaths.mjs";

export const id = "qemu";

let cfg = null; // Injected by engine.mjs: { image, memory, cpus, background, rootfs? }
let onExitCb = null; // Injected by engine.mjs: callback when the VM process exits (used to downgrade the "ready" state so the UI doesn't keep showing running)
export function configure(c) {
  cfg = c;
  if (c && typeof c.onExit === "function") onExitCb = c.onExit;
}

const HOME = os.homedir();
const isWin = process.platform === "win32";
const QMP_PORT = 4444;
const GA_PORT = 4445;
const GUEST_MNT = "/mnt/hostfs"; // Mount point of the host root inside the guest (firstboot.sh mounts it via 9p; must match)
// The one name the working directory has inside the sandbox. The bind used to be "isomorphic" (guest path == host path),
// which put the user's real directory structure inside the VM: `pwd` printed it, every command could name it, and every
// stack trace carried it. A fixed mount point removes it, and gives the model one workspace path that is identical in
// every conversation and on every install.
const GUEST_WORKSPACE = "/workspace";
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
const GUEST_TMP = "/var/tmp/sandbox-tmp";

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
const SWAPFILE = "/var/swapfile";
const SWAP_MIB = 2048;

/**
 * Give the guest swap. The image ships with none.
 *
 * Without it a transient spike is not a slowdown, it is a kill: the guest kernel logged twelve
 * `Out of memory: Killed process (python3)` in one boot, every one at roughly the RAM ceiling, with `Total swap = 0kB`. OCR
 * loading a model and rasterising a page peaks well above its steady state, and there was nothing to page it out to.
 *
 * A file rather than a partition, created here rather than in the image, so it needs no rootfs rebuild — same reasoning as
 * GUEST_TMP. It lands in run.qcow2, the throwaway overlay, so it costs host disk only while the VM is alive and is discarded
 * with it. fallocate is a metadata operation, so this adds no measurable boot time; dd is the fallback for a filesystem where
 * fallocate cannot produce a swap-eligible extent.
 *
 * Confirmed working and on the fast path: the guest logged `Adding 2097148k swap on /var/swapfile` at 1.8 s uptime, and the
 * overlay stayed at 8.5 MB afterwards — dd would have pushed 2 GiB into it. Subsequent runs of the same OCR workload stopped
 * being killed, at the SAME 2048 MiB of RAM that was being killed before, which is what identifies swap rather than RAM as
 * the fix.
 *
 * Best-effort: a guest that will not take swap should still boot and run commands, it just keeps the old OOM behaviour.
 */
async function enableSwap(guest) {
  // Braces are required, not style: `&&` and `||` have equal precedence and associate left-to-right, so an ungrouped
  // `a && b || c && d` runs `c`'s tail after `a && b` SUCCEEDS — here that meant re-running mkswap on an already-active
  // swapfile. Each alternative has to be one grouped command.
  const make = (alloc) => `{ ${[
    `${alloc}`,
    `chmod 600 ${SWAPFILE}`,
    `mkswap ${SWAPFILE} >/dev/null 2>&1`,
    `swapon ${SWAPFILE} 2>/dev/null`,
  ].join(" && ")}; }`;
  const script = [
    // fallocate first: it only writes metadata, so the common path costs milliseconds rather than the seconds it takes to
    // push 2 GiB through virtio-blk into a growing qcow2. swapon can still refuse the result — on some filesystems a
    // fallocate'd file's extents are unwritten and swap needs them mapped — so fall back to dd on the whole sequence, not
    // just on fallocate failing. That is the slow path, and the timing below says when it was taken.
    `${make(`fallocate -l ${SWAP_MIB}M ${SWAPFILE} 2>/dev/null`)} || ${make(`dd if=/dev/zero of=${SWAPFILE} bs=1M count=${SWAP_MIB} status=none`)} || true`,
    // MiB of swap the kernel reports as active; 0 means it did not take. Read from /proc, which is always there —
    // `free` comes from procps and a minimal image is not guaranteed to ship it.
    `awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo`,
  ].join("; ");
  const t0 = Date.now();
  try {
    const { out } = await guest.exec("/bin/bash", ["-lc", script]);
    const mib = parseInt(String(out).trim().split("\n").pop(), 10) || 0;
    const ms = Date.now() - t0;
    if (mib > 0) console.log(`[sandbox/qemu] swap enabled: ${mib} MiB in ${ms} ms`);
    else console.warn(`[sandbox/qemu] swap did NOT activate (${ms} ms) — the guest keeps its previous out-of-memory behaviour`);
  } catch (e) {
    console.warn(`[sandbox/qemu] swap setup failed after ${Date.now() - t0} ms: ${e?.message ?? e}`);
  }
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // bash single-quote escaping inside the guest
// VM disk/kernel are downloaded from a public CDN on first run (docker.zeraix.com fronts the public read-only entry of the zeraix-docker bucket).
const VM_CDN = (process.env.ZERAIX_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");

let vm = null; // { proc, ports, guest }
let ninep = null; // Windows: in-process 9p-over-TCP server backing the host share
let homeRoot = ""; // The common root from provision (parent of the session workdirs); only a fallback for a command that carries no cwd

// Background long-lived service table: id -> { id, gpid, hostPorts, url, command, log }. The id is the service's primary
// port when it has one, otherwise PORTLESS_ID_BASE + gpid; hostPorts lists every forward it actually got.
const procs = new Map();
let svcSeq = 0;

// ── Paths / directories ───────────────────────────────────────────────────────────────
// VM image directory: see ./vmpaths.mjs (per-platform local app-data directory; shared by the runtime and the build/publish scripts).
// The app name is taken from the basename of userData, ensuring it matches llama/userData (dev=Zeraix, packaged=OperEase).
const VM_FILES = ["rootfs.qcow2", "Image", "initrd.img"];
// Version directory root (.../vm): independent of the ZERAIX_VMDIR override, always points to the default layout, used for version enumeration/cleanup.
function vmRoot() { return path.join(localDataDir(path.basename(app.getPath("userData"))), "vm"); }
function versionComplete(v) { return !!v && VM_FILES.every((f) => fs.existsSync(path.join(vmRoot(), v, f))); }
function installedVersions() {
  try { return fs.readdirSync(vmRoot()).filter((d) => !d.startsWith(".") && versionComplete(d)); } catch { return []; }
}
/**
 * Version used at boot:
 *   - configured (the versions.json target) is fully downloaded -> use it;
 *   - otherwise, if another downloaded version exists -> use the latest one (i.e. boot from the old image, do not auto-download the new version -- leave the update decision to the user);
 *   - none present -> configured (first run, triggers a download).
 * forceConfigured=true (user clicks "Update"): force use of configured (downloads the new version).
 */
function bootVersion(forceConfigured = false) {
  const configured = vmVersion(guestArch());
  if (forceConfigured) return configured;
  if (versionComplete(configured)) return configured;
  const others = installedVersions().filter((v) => v !== configured);
  return others.length ? [...others].sort().slice(-1)[0] : configured;
}

function dirs(forceConfigured = false) {
  const override = process.env.ZERAIX_VMDIR; // Custom directory override: use it directly, no version layout applied
  const vd = override ? override : path.join(vmRoot(), bootVersion(forceConfigured));
  return { vd, rootfs: cfg?.rootfs || process.env.ZERAIX_ROOTFS || path.join(vd, "rootfs.qcow2") };
}

/** VM image directory (where rootfs.qcow2 / Image / initrd.img live). Static path, for UI display / opening the folder, no running VM required. */
export function vmImageDir() { return dirs().vd; }

/**
 * VM image version / install info, for the sandbox dialog display and the "update" decision.
 *   version      = version currently used at boot (may be an old version)
 *   targetVersion= versions.json target version
 *   complete     = target version is fully downloaded
 *   updatable    = currently using an old version and the target version is not yet downloaded -> user can trigger an update
 */
export function sandboxVmInfo() {
  const arch = guestArch();
  const targetVersion = vmVersion(arch);
  const version = bootVersion();
  const complete = versionComplete(targetVersion);
  return {
    dir: dirs().vd,
    version,
    targetVersion,
    complete,
    updatable: !!targetVersion && !complete && version !== targetVersion,
    otherVersions: installedVersions().filter((v) => v !== version),
  };
}

function qemuBin() {
  if (process.env.ZERAIX_QEMU) return process.env.ZERAIX_QEMU;
  const sys = isWin ? "qemu-system-x86_64.exe" : `qemu-system-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const archDir = `${process.platform}-${process.arch}`;
  // Packaged: extraResources lays resources/bin at the root of process.resourcesPath -> <arch>/qemu/.
  // dev (`electron .`): process.resourcesPath points to Electron's own resources (none of our binaries),
  //   so read from the repo's resources/bin/<arch>/qemu instead -- app.getAppPath()=repo root, same source as main.mjs's WEB_ROOT.
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

function bwrapFlags(cwd) {
  // Exactly one host directory is visible: this command's own cwd. Nothing has to be registered in advance for that to
  // hold — the 9p share already covers the whole disk — so there is no mount set to keep in sync, and a command cannot
  // reach a sibling session's files. This matches what the host-side file tools already enforce (resolveInside rejects
  // anything outside the working directory); the old union of roots was the one way around it.
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
    ...binds, "--chdir", chdir,
    // NOT --unshare-user: bwrap runs as root in the guest, and a user namespace makes the 9p
    // share (security_model=none) refuse the bind source with EPERM. bwrap-as-root still confines
    // the filesystem view to the workspace (that's the goal here); the VM is the privilege boundary.
    // Net is NOT unshared → the workload uses the guest's SLIRP network (internet reachable).
    "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session",
  ];
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function qemuArgs(vd, overlay) {
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

// Windows host share: qemu has no virtio-9p, so serve the host tree from an in-process 9p2000.L
// server (virtual multi-drive root; see ninep-server.mjs) mounted in-guest over trans=tcp via the
// SLIRP gateway 10.0.2.2 (→ host loopback). firstboot brings the NIC up first and is ordered
// Before qemu-guest-agent, so no NIC bring-up is needed here. A random attach token gates the
// loopback-bound server to this VM's mount.
// Transport benchmarks (2026-07, this host): SLIRP TCP reads ~93 MB/s / writes ~30 MB/s; the
// virtio-serial alternative (socat-bridged /dev/vport — trans=fd can't drive vport directly, the
// chardev lacks write_iter) inverts that: reads ~46 / writes ~114. Dev workloads are
// read-dominated and big writes land on guest tmpfs, so TCP wins; cache=readahead measured as a
// no-op. If a faster transport lands, ninep-server's connect mode is the ready-made hook.
async function winShareMount(guest) {
  const token = crypto.randomBytes(16).toString("hex");
  ninep = await startNinepServer({ drives: true, host: "127.0.0.1", port: 0, token });
  await guest.exec("/bin/sh", ["-c",
    `mkdir -p ${GUEST_MNT} && mount -t 9p -o trans=tcp,port=${ninep.port},version=9p2000.L,msize=524288,aname=${token} 10.0.2.2 ${GUEST_MNT}`]);
}

// Clean up unused old-version VM directories (free disk). Keep both "the current boot version keepVersion" and "the target version configured":
// when booting from an old version keep the old version (otherwise no image is available), keep the target version (used right after a user update); prune the rest.
// Skipped when ZERAIX_VMDIR overrides (to avoid accidentally deleting siblings of the custom directory).
function pruneOldVmVersions(keepVersion) {
  if (process.env.ZERAIX_VMDIR) return;
  const keep = new Set([keepVersion, vmVersion()].filter(Boolean));
  try {
    for (const name of fs.readdirSync(vmRoot())) {
      if (!keep.has(name) && !name.startsWith(".")) fs.rmSync(path.join(vmRoot(), name), { recursive: true, force: true }); // skip .build-<arch> build staging
    }
  } catch { /* ignore */ }
}

// On first run, download the VM disk + kernel (rootfs.qcow2 / Image / initrd.img) from the CDN into vd (versioned vm/<id>/, no arch segment); skipped if already present.
// Version = short hash of the docker image ID for this machine's arch; changing the ID changes the directory -> triggers a re-download and prunes old versions (version invalidated).
// Progress is reported to engine.mjs via onProgress(pct, msg) (broadcast to the UI). .part -> rename for atomic write, so an interruption leaves no half-finished file.
async function ensureRootfs(onProgress, forceConfigured = false) {
  const arch = guestArch();
  const configured = vmVersion(arch);
  if (!configured) throw new Error("VM_VERSION has no entry for this machine's arch (run build:rootfs + publish:rootfs first)");
  const version = bootVersion(forceConfigured); // booting from the old image does not download; first run/update = configured (triggers download)
  const vd = path.join(vmRoot(), version);
  const missing = VM_FILES.filter((f) => !fs.existsSync(path.join(vd, f)));
  if (!missing.length) { pruneOldVmVersions(version); onProgress?.(100, "Runtime environment ready (no download needed)"); return; } // already downloaded: prune stale then notify the UI
  // Download needed: only happens on "first run (no image at all)" or "user clicks update (forceConfigured)", where version === configured.
  fs.mkdirSync(vd, { recursive: true });
  let total = 0;
  for (const f of missing) total += await headSize(`${VM_CDN}/vm/${arch}/${version}/${f}`);
  // Resumable download: an existing .part counts toward completed progress (the server's 206 only returns the remaining bytes, no longer reported via onChunk).
  let done = 0;
  for (const f of missing) { const p = path.join(vd, f + ".part"); if (fs.existsSync(p)) done += fs.statSync(p).size; }
  const report = () => onProgress?.(total ? Math.min(99, Math.floor((done / total) * 100)) : null, `Downloading runtime environment ${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`);
  report(); // initial progress (including any already-resumed part)
  for (const f of missing) {
    const tmp = path.join(vd, f + ".part");
    await httpDownload(`${VM_CDN}/vm/${arch}/${version}/${f}`, tmp, (n) => { done += n; report(); });
    fs.renameSync(tmp, path.join(vd, f));
  }
  pruneOldVmVersions(version); // prune old images after the download completes (on update version=configured -> delete the old version, free disk)
  onProgress?.(100, "Runtime environment ready");
}
function headSize(url, redirs = 5) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: "HEAD" }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(headSize(res.headers.location, redirs - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HEAD ${url} → ${res.statusCode}`)); }
      resolve(Number(res.headers["content-length"] || 0));
    }).on("error", reject).end();
  });
}
// Resumable download: existing .part -> send Range: bytes=<have>-; 206 appends, 200 (server ignores Range) overwrites from the start.
function httpDownload(url, dest, onChunk, redirs = 5) {
  return new Promise((resolve, reject) => {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const opts = have > 0 ? { headers: { Range: `bytes=${have}-` } } : {};
    https.get(url, opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(httpDownload(res.headers.location, dest, onChunk, redirs - 1)); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`GET ${url} → ${res.statusCode}`)); }
      const resuming = res.statusCode === 206; // server accepts resume; 200 means it ignored Range and overwrites from the start
      const ws = fs.createWriteStream(dest, { flags: resuming ? "a" : "w" });
      res.on("data", (c) => onChunk?.(c.length));
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => resolve()));
      ws.on("error", reject);
    }).on("error", reject);
  });
}

async function boot(onProgress, forceConfigured = false) {
  await ensureRootfs(onProgress, forceConfigured); // first run downloads the image; forceConfigured=update (downloads the target version)
  const { vd, rootfs } = dirs(forceConfigured);
  if (!fs.existsSync(rootfs)) throw new Error(`rootfs not found: ${rootfs}`);
  if (!fs.existsSync(path.join(vd, "Image")) || !fs.existsSync(path.join(vd, "initrd.img")))
    throw new Error(`kernel not found: need Image + initrd.img next to ${rootfs}`);
  onProgress?.(null, "Starting the runtime environment..."); // image ready -> enter the boot phase (QEMU boot, no fine-grained progress, UI shows an indeterminate state)
  fs.mkdirSync(vd, { recursive: true });
  // Throwaway overlay: the base image stays clean, writes are discarded on shutdown.
  const overlay = path.join(vd, "run.qcow2");
  const imgBin = qemuBin().replace(/qemu-system-[^/\\]+(\.exe)?$/, isWin ? "qemu-img.exe" : "qemu-img");
  fs.rmSync(overlay, { force: true });
  await new Promise((res, rej) => {
    const p = spawn(imgBin, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", rootfs, overlay]);
    p.on("exit", (c) => (c ? rej(new Error(`qemu-img exit ${c}`)) : res()));
    p.on("error", rej);
  });
  reapOrphanVm(vd, overlay);
  // Capture qemu's own stdout/stderr to vd/qemu.log (was stdio:"ignore", leaving no way to diagnose a process crash).
  // This is the "host-side" qemu output (HVF errors, assertions, sleep/wake failures, etc.); the guest kernel/systemd output is in console.log instead.
  let lastStderr = "";
  const qlog = fs.createWriteStream(path.join(vd, "qemu.log"), { flags: "a" });
  try { qlog.write(`\n===== qemu started ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
  const proc = spawn(qemuBin(), qemuArgs(vd, overlay), { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  // Remember the last stderr line: qemu reports a fatal startup problem there and then exits, so by the time the exit handler
  // runs the reason is otherwise only in qemu.log. "Address already in use" in particular has a specific, actionable cause.
  proc.stderr.on("data", (b) => {
    const t = String(b).trim();
    if (t) lastStderr = t.split("\n").pop();
    try { qlog.write(b); } catch { /* ignore */ }
  });
  const exitCb = onExitCb; // bind the callback at the time this proc starts (after a restart, old and new procs each correspond to their own; see the engine.disposing guard)
  proc.on("exit", (code, signal) => {
    try { qlog.write(`\n===== qemu exited code=${code} signal=${signal ?? "-"} @ ${new Date().toISOString()} =====\n`); qlog.end(); } catch { /* ignore */ }
    vm = null; try { ninep?.close(); } catch {} ninep = null;
    try { exitCb?.(code, signal, lastStderr); } catch { /* ignore */ }
  });
  const ports = await qmp({ port: QMP_PORT });
  const guest = await guestAgent({ port: GA_PORT }); // includes waiting for the guest to be ready
  // Backing store for the sandbox's /tmp (see GUEST_TMP / bwrapFlags). Created here rather than in the image so it needs no
  // rootfs rebuild. 1777 = the mode /tmp is expected to have (world-writable, sticky).
  try { await guest.exec("/bin/mkdir", ["-p", "-m", "1777", GUEST_TMP]); } catch { /* bwrap falls back to failing loudly if absent */ }
  await enableSwap(guest);
  vm = { proc, ports, guest };
  if (isWin) await winShareMount(guest); // Windows host share: 9p-over-tcp (no virtio-9p)
  return vm;
}

/** Called by engine.mjs: start the long-lived VM. onProgress(pct,msg): progress callback for downloading the VM disk/kernel on first run.
 *  forceConfigured=true: user "update" -- download the versions.json target version and switch to it. */
export async function provision(rootHost, onProgress, forceConfigured = false) {
  homeRoot = path.resolve(rootHost);
  await boot(onProgress, forceConfigured);
}

// ── Foreground execution ─────────────────────────────────────────────────────────────────
/**
 * A sandbox failure is reported as a failed command. It is NOT retried on the host.
 *
 * Falling back to native was worse than failing in three ways. It broke the guarantee — the sandbox exists so a command runs
 * confined, and quietly running it on the user's real filesystem instead is the one outcome the feature is meant to prevent.
 * It was a one-way latch, so a single hiccup silently moved every later command in the session onto the host, with the notice
 * shown only once. And it disguised the cause: the guest toolbox has pymupdf4llm/rapidocr/ghostscript and the host does not,
 * so the fallback turned "the sandbox broke" into "ModuleNotFoundError: No module named 'pymupdf4llm'" — an error pointing at
 * the user's script instead of at the sandbox.
 *
 * Exit code 126 is the shell's "command found but not executable": the closest standard code for "could not be run here".
 */
function sandboxFailure(reason) {
  console.warn(`[sandbox/qemu] command not run: ${reason}`);
  return { stdout: "", stderr: `Sandbox unavailable: ${reason}\nThe command was NOT run. It is not retried on the host, because it would then run outside the sandbox and against the host's own toolchain.`, code: 126, killed: false };
}

/** Foreground execution: inside the guest, bwrap confined to the mount set, bash -c cmd, with a timeout; never throws. */
export async function run(cmd, opts = {}) {
  const { cwd, timeoutMs, maxBuffer } = opts;
  try {
    if (!vm) throw new Error("vm not ready");
    const argv = ["/usr/bin/bwrap", ...bwrapFlags(cwd), "--", "/bin/bash", "-c", cmd];
    const { out, err, code, killed } = await vm.guest.runStatus(argv, {
      timeoutSec: Math.max(1, Math.round((timeoutMs ?? 60000) / 1000)),
    });
    const cap = (s) => (maxBuffer && s.length > maxBuffer ? s.slice(0, maxBuffer) : s);
    return { stdout: cap(out), stderr: cap(err), code, killed };
  } catch (e) {
    return sandboxFailure(`exec failed: ${e?.message ?? e}`);
  }
}

// ── Background long-lived services: run inside the guest + QMP hostfwd forwards ports to the host ──────────────────────
const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
const pickPort = (s) => {
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  return m ? Number(m[1]) : 0;
};
const PORTLESS_ID_BASE = 100000; // above the top of the port range (65535), so a portless service's id can never be mistaken for a port
const PORT_WAIT_MS = 8000; // total time a service is given to bind before we return without a forward
const READY_GRACE_MS = 1500; // extra time after the log looks ready — a server binds before it logs, so this is slack, not a wait

/**
 * Every TCP port THIS service is listening on, ascending (empty if none).
 *
 * Plural because one service commonly binds several: a dev server with a separate HMR/websocket port, an app plus its
 * debug port, a framework that opens both v4 and v6 sockets. Returning just the first would forward whichever the
 * kernel happened to list first — ss output is in hash order, not port order — so the one the user was told about could
 * be the wrong one.
 *
 * The socket table decides, not the log. A log line is a convention every framework writes differently --
 * "http://localhost:5173/", "Listening on 0.0.0.0:9123", "Server listening on port 3000", or nothing at all -- while a
 * LISTEN socket is the fact we need. Reading the text forwarded the frameworks that print a URL and silently forwarded
 * nothing for the rest.
 *
 * The socket is attributed to the service by PROCESS ANCESTRY, not by diffing the guest's ports before and after: a
 * diff cannot tell two services starting at once apart, and answers "some port appeared" when the question is "which
 * port is this service's". Walking PPid from each listening socket's owner up to gpid answers exactly that, and it also
 * covers a server that forks workers, since every worker is still a descendant.
 *
 * Ancestry rather than session or process group: bwrap is invoked with --new-session, so the sandboxed process gets a
 * fresh session and pgid of its own and neither matches gpid.
 *
 * Asked through the guest agent, which runs OUTSIDE bwrap. Each command has its own PID namespace (--unshare-pid), so
 * one command can never see another's processes, but the guest agent sees the whole guest, and the network namespace is
 * shared, so the service's socket and its owning pid are both visible from there.
 */
async function servicePorts(gpid) {
  if (!gpid) return [];
  // For each LISTEN socket: take its owning pids out of the ss "users:((...,pid=N,...))" column, then walk each one up
  // the PPid chain (from /proc/<pid>/status, whose PPid line is safe to parse — /proc/<pid>/stat is not, because the
  // comm field can itself contain spaces and parentheses). First hit wins; the depth cap is a cycle guard.
  const script = `
ss -Hltnp 2>/dev/null | while read -r st rq sq local rest; do
  port=\${local##*:}
  for pid in $(printf '%s' "$rest" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    p=$pid; n=0
    while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ] && [ "$n" -lt 40 ]; do
      if [ "$p" = "$SVC_PID" ]; then echo "$port"; break 2; fi
      p=$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2>/dev/null)
      n=$((n + 1))
    done
  done
done | sort -un`;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_PID=${gpid}`] });
    return String(out)
      .split(/\s+/)
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  } catch {
    return []; // ss unavailable / agent hiccup — the caller falls back to reading the log
  }
}

/**
 * Start a long-lived command in the background inside the guest (bwrap-confined + network allowed), scan early output for a port, QMP hostfwd
 * to the same port on the host, and return a host-reachable URL. On stop, the forward is removed too. A launch-channel failure
 * is reported, not run on the host — same reasoning as sandboxFailure above, and a long-lived service escaping the sandbox is
 * worse than a one-shot command doing so.
 */
/**
 * Watch a guest background job and report how it ended.
 *
 * The host has no child process to hang an `exit` handler on — the job lives inside the VM behind the guest
 * agent — so completion has to be polled. `kill -0` is the cheapest liveness question there is, and 3s is
 * frequent enough that a finished install is announced while the user still cares, without making the guest
 * agent busy for the hours a dev server may run.
 *
 * Only started for `notify` jobs. Every other background command keeps the previous behaviour, where nobody
 * is listening for the end and polling would be pure cost.
 */
const watchers = new Map(); // key → interval id
function watchGuestJob({ key, gpid, cmd, log }) {
  if (watchers.has(key)) return;
  const timer = setInterval(async () => {
    if (!vm) return stopWatching(key);
    try {
      await vm.guest.exec("/bin/kill", ["-0", String(gpid)]);
      return; // still running
    } catch {
      /* gone → fall through and report */
    }
    stopWatching(key);
    let tail = "";
    // The exit CODE is not recoverable: the job was launched with `setsid … &` and its shell is long gone, so
    // there is nothing left to reap. The log tail is what remains, and it is what the model actually reads.
    try {
      const r = await vm.guest.exec("/bin/tail", ["-c", "4000", log]);
      tail = String(r.out ?? "").trim();
    } catch {
      /* log unreadable (VM restarted, /tmp cleared) — report completion without it */
    }
    emitService({ type: "stopped", pid: key, reason: "exited", command: cmd, code: null, tail, notify: true });
  }, 3000);
  timer.unref?.(); // a pending poll must never hold the app open at quit
  watchers.set(key, timer);
}
function stopWatching(key) {
  const t = watchers.get(key);
  if (t) clearInterval(t);
  watchers.delete(key);
}

export async function startBackground(cmd, opts = {}) {
  if (!vm) return sandboxFailure("vm not ready");
  const cwd = opts.cwd;
  const log = `/tmp/zx-svc-${++svcSeq}.log`;
  const flags = bwrapFlags(cwd).map(shq).join(" ");
  // SVC_CMD is passed via the guest-exec env (execve directly, no shell), and "$SVC_CMD" is used as a single whole string argument to bash -lc.
  const script =
    `setsid /usr/bin/bwrap ${flags} -- /bin/bash -lc "$SVC_CMD" >${shq(log)} 2>&1 </dev/null & echo $!`;
  let gpid = 0;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_CMD=${cmd}`] });
    gpid = parseInt(String(out).trim(), 10) || 0;
  } catch (e) {
    return sandboxFailure(`service launch failed: ${e?.message ?? e}`);
  }

  // Wait for the service to bind. The log supplies only the startup text shown to the user and the hint that the process
  // is up; the port comes from the socket table (servicePort), so a service that prints its port in an unusual format,
  // or prints nothing at all, is forwarded exactly like one that prints a tidy URL.
  //
  // READY no longer ends the scan on its own. It used to, and that lost the port for anything whose first line matched
  // before it had bound — "Server listening on port 3000" satisfies READY, carries no URL for pickPort, and the loop
  // exited right there:
  //   before: "listening" seen -> break -> no port -> no forward, and the service was left untracked
  //   after:  "listening" seen -> keep polling the socket table for READY_GRACE_MS -> port -> forward
  // Something that never listens (a watcher, a compiler) still returns promptly, one grace period after it looks ready,
  // instead of costing the full timeout.
  let out = "";
  let ports = [];
  let readyAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < PORT_WAIT_MS) {
    try {
      const r = await vm.guest.exec("/bin/cat", [log]);
      out = r.out || out;
    } catch {
      /* log not generated yet */
    }
    ports = await servicePorts(gpid);
    if (ports.length) break;
    if (readyAt && Date.now() - readyAt > READY_GRACE_MS) break;
    if (!readyAt && READY.test(out)) readyAt = Date.now();
    await new Promise((r) => setTimeout(r, 300));
  }
  // Last resort, for a guest where ss cannot answer: believe the log if it printed a URL.
  const logPort = pickPort(out);
  if (!ports.length && logPort) ports = [logPort];

  // Forward every port the service owns, guest port -> same host port (the guest must listen on 0.0.0.0, reached via the
  // SLIRP gateway 10.0.2.x). One may fail while others succeed — the host port can already be taken by something else on
  // the machine — so each is tried on its own and only the ones that took are remembered for teardown.
  const forwarded = [];
  for (const p of ports) {
    try {
      await vm.ports.addPort(p, p);
      forwarded.push(p);
    } catch {
      /* that host port is busy; the service still runs, and its other ports may still forward */
    }
  }
  // The URL names the port the service itself announced, when it announced one — for a dev server that is the page to
  // open, not its HMR socket, and the lowest number is not reliably either. Otherwise: the lowest forwarded port.
  const primary = forwarded.includes(logPort) ? logPort : forwarded[0] || 0;
  const url = primary ? `http://localhost:${primary}` : "";
  const extra = forwarded.filter((p) => p !== primary);

  const alive = gpid > 0;
  // Register whether or not a port was found. This used to live inside the branch above, so anything without a forward --
  // a watcher, a compiler, or a server whose port was missed -- ran on with no entry here: listProcesses could not list
  // it and stop_service could not stop it. Nothing else could either, because every command gets its own PID namespace,
  // so a kill from a later command cannot even see the process; only restarting the VM ended it.
  // The id is the primary port when there is one, so "stop_service 5173" reads naturally. Otherwise it is derived from
  // the guest pid and offset past the top of the port range, so a portless service can never be handed the same id as a
  // forwarded one — and if that number is somehow already taken, fall back too rather than evict the existing entry.
  let id = primary;
  if (!id || procs.has(id)) id = PORTLESS_ID_BASE + gpid;
  if (alive) {
    // hostPorts holds only the forwards that actually took, so stopping never removes one that was never added.
    procs.set(id, { id, gpid, hostPorts: forwarded, url, command: cmd, log });
    emitService({ type: "started", pid: id, url, command: cmd });
  }
  const headline = alive
    ? `✅ Service started in the background inside the sandbox${url ? `, and forwarded to the host: ${url}` : ports.length ? ` (guest port ${ports.join(", ")}, forwarding failed)` : ""}.`
    : "⚠️ The process failed to start.";
  return (
    `${headline}\n\n--- Startup output ---\n${(out.trim() || "(no output yet)").slice(-4000)}\n` +
    (url
      ? `\nNote: the service runs inside an isolated sandbox with its port forwarded, so the host can reach ${url} (use it to preview).${extra.length ? ` Its other ports are forwarded too: ${extra.map((p) => `http://localhost:${p}`).join(", ")}.` : ""} If it's unreachable, make the service listen on 0.0.0.0. Do not start it again.`
      : alive
        ? // Names stop_service and the id, because that is the only way to stop this process — it has no port to be
          // known by, and no other command can reach it (separate PID namespaces). The old text sent the model to
          // "expose_port", which is not a declared tool, for a service it also could not have stopped.
          `\nNote: the service runs in the background inside the sandbox. Nothing is listening yet, so no port is forwarded — if it should serve HTTP, make it listen on 0.0.0.0 (not 127.0.0.1, which the host cannot reach) and it will be forwarded on the next start. Stop it with stop_service pid ${id}.`
        : "")
  );
}

/** Stop a background service (by the id it was started under): remove the hostfwd, if it has one, + terminate the guest process group. */
export function stopProcess(pid) {
  const key = Number(pid);
  const p = procs.get(key);
  if (!p) return false;
  procs.delete(key);
  // Every forward this service got, not just one: a dev server with an HMR port would otherwise leave the second
  // hostfwd behind, pointing into a VM where nothing answers.
  for (const hp of p.hostPorts ?? []) vm?.ports.removePort(hp).catch(() => {});
  // setsid makes gpid the process-group leader; a negative kill terminates the whole group, falling back to the single process on failure.
  vm?.guest
    .exec("/bin/kill", ["-TERM", `-${p.gpid}`])
    .catch(() => vm?.guest.exec("/bin/kill", ["-TERM", String(p.gpid)]).catch(() => {}));
  emitService({ type: "stopped", pid: key });
  return true;
}

export function listProcesses() {
  // p.id, not a port: a service without a forward has no port to be named by, and reporting 0 for all of them would make
  // every such service look like the same one and stop none of them.
  return [...procs.values()].map((p) => ({ pid: p.id, url: p.url, command: p.command }));
}

export function stopAll() {
  for (const key of [...procs.keys()]) stopProcess(key);
}

/** Explicit port forwarding (for the LLM's expose_port tool): guest port -> host port, returns a reachable URL. */
export async function exposePort(guestPort, hostPort = guestPort) {
  if (!vm) throw new Error("sandbox not running");
  await vm.ports.addPort(hostPort, guestPort);
  return `http://localhost:${hostPort}`;
}
export async function unexposePort(hostPort) {
  if (!vm) return false;
  await vm.ports.removePort(hostPort).catch(() => {});
  return true;
}

/** Exit cleanup: remove all forwards + shut down the VM. */
export async function dispose({ waitMs = 10000 } = {}) {
  const proc = vm?.proc;
  const ports = vm?.ports;
  const guest = vm?.guest;
  // Sweep the services while `vm` is still set, so each one really does have its forward removed and its process group
  // killed. Everything here dies with the VM anyway, but leaving `procs` to be cleared by a half-working sweep would
  // hide a bug the moment this is ever called without the VM going away.
  try { stopAll(); } catch { /* best effort */ }
  vm = null; // from here on no command may reach a VM that is going away
  try { ninep?.close(); } catch { /* best effort */ } finally { ninep = null; }
  try { ports?.quit(); } catch { /* best effort */ }
  try { proc?.kill(); } catch { /* best effort */ }
  // Hand back the control sockets. Both the QMP monitor and the guest agent serve ONE client, so a socket left open here
  // is not merely untidy: the next VM's handshake connects, is never accepted, and waits forever. That is exactly how a
  // restart used to stall in "starting" with a healthy VM running beside it.
  try { ports?.close?.(); } catch { /* best effort */ }
  try { guest?.close?.(); } catch { /* best effort */ }
  // Wait for the process to be gone before returning, so a caller that starts a new VM next cannot race the old one for
  // the fixed control ports. SIGTERM first; escalate only if it will not leave.
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, waitMs);
      proc.once("exit", done);
    });
  }
}

/**
 * Kill a qemu left behind by a previous run, before starting a new one.
 *
 * QMP_PORT / GA_PORT / the ssh forward are fixed, so exactly one VM can exist at a time. If the app dies without disposing —
 * crash, force quit, `pkill` — qemu is orphaned and keeps holding the port. Every later launch then dies instantly with
 * "Failed to find an available port: Address already in use", exit code 1, and every command then fails until someone finds
 * the stray process by hand. Observed in the wild; qemu.log had five unmatched "qemu started" lines.
 *
 * Scoped to OUR VM: matched on the overlay path in the process's own -drive argument, so an unrelated qemu on this machine is
 * never touched. Best-effort — a failure here just means the spawn below reports the port conflict as it did before.
 */
function reapOrphanVm(vd, overlay) {
  try {
    // -ax: other users' processes are not ours to kill, but they would still hold the port; listing them lets us say so.
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) {
      if (!line.includes("qemu-system-") || !line.includes(overlay)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!pid || pid === process.pid) continue;
      console.warn(`[sandbox] reaping orphaned VM (pid ${pid}) left by a previous session`);
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  } catch { /* ps unavailable: fall through and let the spawn report the conflict */ }
}
