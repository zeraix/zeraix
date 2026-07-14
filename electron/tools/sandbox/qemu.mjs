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
 * confined per-command to the mount set by bwrap (homeRoot ∪ explicit extras), bound on posix as an "isomorphic
 * path" (host path == guest path, so tool output paths match on both sides).
 *
 * Falls back to native before ready / on failure. Requires real-machine boot verification (see sandbox/qemu/README).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import https from "node:https";
import { app } from "electron";

import { emitService } from "./events.mjs";
import * as native from "./native.mjs";
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
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // bash single-quote escaping inside the guest
// VM disk/kernel are downloaded from a public CDN on first run (docker.zeraix.com fronts the public read-only entry of the zeraix-docker bucket).
const VM_CDN = (process.env.ZERAIX_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");

let vm = null; // { proc, ports, guest }
let ninep = null; // Windows: in-process 9p-over-TCP server backing the host share
let homeRoot = ""; // The common root from provision (parent directory of the session workdir)
let extraRoots = []; // Explicitly selected folders outside the root (accumulated; merged into the bwrap bind set per command)
let degraded = ""; // Non-empty = this session has degraded to native and will not retry
let degradeNoticeShown = false;
const EXTRA_ROOTS_MAX = 16;

// Background long-lived service table: hostPort -> { gpid, hostPort, guestPort, url, command, log }
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

/** Host path -> { src: 9p path inside the guest, dst: target inside bwrap (posix keeps isomorphism) }. */
function mapRoot(hostPath) {
  const abs = path.resolve(hostPath);
  if (!isWin) {
    const rel = abs.replace(/^\//, "");
    return { src: path.posix.join(GUEST_MNT, rel), dst: abs };
  }
  // Windows multi-drive: /mnt/hostfs/<drive>/<rest> (matching ninep-server's virtual multi-drive root), so a
  // workdir on any drive (C:, E:, ...) maps correctly.
  const m = abs.match(/^([A-Za-z]):[\\/]?(.*)$/);
  const drive = m ? m[1].toUpperCase() : "C";
  const rest = (m ? m[2] : "").split(path.sep).join("/");
  const g = path.posix.join(GUEST_MNT, drive, rest);
  return { src: g, dst: g }; // Windows does not keep isomorphism
}

/** When cwd is not covered by the mount set, merge it into extras (the broadcast root already covers the whole disk, no VM rebuild needed). */
function ensureRoot(cwd) {
  const abs = path.resolve(cwd || homeRoot || HOME);
  const under = (r) => {
    const rel = path.relative(r, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (homeRoot && under(homeRoot)) return;
  if (extraRoots.some(under)) return;
  extraRoots.push(abs);
  if (extraRoots.length > EXTRA_ROOTS_MAX) extraRoots = extraRoots.slice(-EXTRA_ROOTS_MAX);
}

/** bubblewrap flags (excluding argv[0] and the trailing command): only bind the mount set from /mnt/hostfs, chdir cwd.
 *  Network is open by default (no --unshare-net) -- commands inside the sandbox can reach the internet directly: pip / npm / git / curl, etc.
 *  DNS and routing are provided by the guest's SLIRP network (firstboot.sh configures 10.0.2.x + nameserver). */
function bwrapFlags(cwd) {
  const binds = [homeRoot, ...extraRoots].filter(Boolean).flatMap((r) => {
    const { src, dst } = mapRoot(r);
    return ["--bind", src, dst];
  });
  const { dst: chdir } = mapRoot(cwd || homeRoot || HOME);
  return [
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/opt", "/opt",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    // Put the toolbox venv first on PATH INSIDE the sandbox (bwrap runs every command), so
    // python/pip/unoserver/… resolve. Explicit --setenv so it holds regardless of how the
    // guest-agent/login-shell env would otherwise flow in. (Image also sets it in
    // /etc/profile.d for direct login/SSH shells.)
    "--setenv", "PATH", "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...binds, "--chdir", chdir,
    // NOT --unshare-user: bwrap runs as root in the guest, and a user namespace makes the 9p
    // share (security_model=none) refuse the bind source with EPERM. bwrap-as-root still confines
    // the filesystem view to the mount set (that's the goal here); the VM is the privilege boundary.
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
    "-drive", `if=none,file=${overlay},format=qcow2,id=hd0,cache=writeback,discard=unmap`,
    // romfile= disables the PCI option ROM (efi-virtio.rom): we kernel-boot / never PXE-boot,
    // and a relocated (bundled) qemu can't find qemu's data dir, so requiring the ROM would
    // abort boot. This keeps the bundle data-file-free (see scripts/bundle-bin-mac.mjs).
    "-device", "virtio-blk-pci,drive=hd0,romfile=",
    "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22",
    "-device", "virtio-net-pci,netdev=net0,romfile=",
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
  // Capture qemu's own stdout/stderr to vd/qemu.log (was stdio:"ignore", leaving no way to diagnose a process crash).
  // This is the "host-side" qemu output (HVF errors, assertions, sleep/wake failures, etc.); the guest kernel/systemd output is in console.log instead.
  const qlog = fs.createWriteStream(path.join(vd, "qemu.log"), { flags: "a" });
  try { qlog.write(`\n===== qemu started ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
  const proc = spawn(qemuBin(), qemuArgs(vd, overlay), { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  proc.stderr.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  const exitCb = onExitCb; // bind the callback at the time this proc starts (after a restart, old and new procs each correspond to their own; see the engine.disposing guard)
  proc.on("exit", (code, signal) => {
    try { qlog.write(`\n===== qemu exited code=${code} signal=${signal ?? "-"} @ ${new Date().toISOString()} =====\n`); qlog.end(); } catch { /* ignore */ }
    vm = null; try { ninep?.close(); } catch {} ninep = null;
    try { exitCb?.(code, signal); } catch { /* ignore */ }
  });
  const ports = await qmp({ port: QMP_PORT });
  const guest = await guestAgent({ port: GA_PORT }); // includes waiting for the guest to be ready
  vm = { proc, ports, guest };
  if (isWin) await winShareMount(guest); // Windows host share: 9p-over-tcp (no virtio-9p)
  return vm;
}

/** Called by engine.mjs: start the long-lived VM. onProgress(pct,msg): progress callback for downloading the VM disk/kernel on first run.
 *  forceConfigured=true: user "update" -- download the versions.json target version and switch to it. */
export async function provision(rootHost, onProgress, extras = [], forceConfigured = false) {
  homeRoot = path.resolve(rootHost);
  extraRoots = [];
  for (const d of extras) if (d) ensureRoot(d);
  await boot(onProgress, forceConfigured);
}

// ── Foreground execution ─────────────────────────────────────────────────────────────────
async function degradeRun(cmd, opts, reason) {
  if (!degraded) {
    degraded = reason;
    console.warn(`[sandbox/qemu] degraded to native: ${reason}`);
  }
  const r = await native.run(cmd, opts);
  if (!degradeNoticeShown) {
    degradeNoticeShown = true;
    const hint = `(Note: the QEMU sandbox is unavailable -- ${reason}. This and subsequent commands have been run directly on the host.)`;
    return { ...r, stderr: r.stderr ? `${r.stderr}\n${hint}` : hint };
  }
  return r;
}

/** Foreground execution: inside the guest, bwrap confined to the mount set, bash -c cmd, with a timeout; never throws. */
export async function run(cmd, opts = {}) {
  const { cwd, timeoutMs, maxBuffer } = opts;
  if (degraded) return degradeRun(cmd, opts, degraded);
  try {
    if (!vm) throw new Error("vm not ready");
    ensureRoot(cwd);
    const argv = ["/usr/bin/bwrap", ...bwrapFlags(cwd), "--", "/bin/bash", "-c", cmd];
    const { out, err, code, killed } = await vm.guest.runStatus(argv, {
      timeoutSec: Math.max(1, Math.round((timeoutMs ?? 60000) / 1000)),
    });
    const cap = (s) => (maxBuffer && s.length > maxBuffer ? s.slice(0, maxBuffer) : s);
    return { stdout: cap(out), stderr: cap(err), code, killed };
  } catch (e) {
    return degradeRun(cmd, opts, `exec failed: ${e?.message ?? e}`);
  }
}

// ── Background long-lived services: run inside the guest + QMP hostfwd forwards ports to the host ──────────────────────
const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
const pickPort = (s) => {
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  return m ? Number(m[1]) : 0;
};

/**
 * Start a long-lived command in the background inside the guest (bwrap-confined + network allowed), scan early output for a port, QMP hostfwd
 * to the same port on the host, and return a host-reachable URL. On stop, the forward is removed too. If the launch channel fails, falls back to native.
 */
export async function startBackground(cmd, opts = {}) {
  if (degraded || !vm) return native.startBackground(cmd, opts);
  const cwd = opts.cwd;
  ensureRoot(cwd);
  const log = `/tmp/zx-svc-${++svcSeq}.log`;
  const flags = bwrapFlags(cwd).map(shq).join(" ");
  // SVC_CMD is passed via the guest-exec env (execve directly, no shell), and "$SVC_CMD" is used as a single whole string argument to bash -lc.
  const script =
    `setsid /usr/bin/bwrap ${flags} -- /bin/bash -lc "$SVC_CMD" >${shq(log)} 2>&1 </dev/null & echo $!`;
  let gpid = 0;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_CMD=${cmd}`] });
    gpid = parseInt(String(out).trim(), 10) || 0;
  } catch {
    return native.startBackground(cmd, opts);
  }

  // Early readiness scan: read the log, match READY / extract the port / 8s cap (same cadence as native).
  let out = "";
  let guestPort = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try {
      const r = await vm.guest.exec("/bin/cat", [log]);
      out = r.out || out;
    } catch {
      /* log not generated yet */
    }
    guestPort = pickPort(out);
    if (guestPort || READY.test(out)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // Port forwarding: guest port -> same host port (the guest must listen on 0.0.0.0, reached via the SLIRP gateway 10.0.2.x).
  let url = "";
  if (guestPort) {
    try {
      await vm.ports.addPort(guestPort, guestPort);
      url = `http://localhost:${guestPort}`;
      procs.set(guestPort, { gpid, hostPort: guestPort, guestPort, url, command: cmd, log });
      emitService({ type: "started", pid: guestPort, url, command: cmd });
    } catch {
      url = "";
    }
  }

  const alive = gpid > 0;
  const headline = alive
    ? `✅ Service started in the background inside the sandbox${url ? `, and forwarded to the host: ${url}` : guestPort ? ` (guest port ${guestPort}, forwarding failed)` : ""}.`
    : "⚠️ The process failed to start.";
  return (
    `${headline}\n\n--- Startup output ---\n${(out.trim() || "(no output yet)").slice(-4000)}\n` +
    (url
      ? `\nNote: the service runs inside an isolated sandbox with its port forwarded, so the host can reach ${url} (use it to preview). If it's unreachable, make the service listen on 0.0.0.0. Do not start it again.`
      : alive
        ? "\nNote: the service runs in the background inside the sandbox; no port was detected/forwarded. If you need host access, use expose_port and make the service listen on 0.0.0.0."
        : "")
  );
}

/** Stop a background service (by hostPort): remove the hostfwd + terminate the guest process group. */
export function stopProcess(pid) {
  const key = Number(pid);
  const p = procs.get(key);
  if (!p) return false;
  procs.delete(key);
  vm?.ports.removePort(p.hostPort).catch(() => {});
  // setsid makes gpid the process-group leader; a negative kill terminates the whole group, falling back to the single process on failure.
  vm?.guest
    .exec("/bin/kill", ["-TERM", `-${p.gpid}`])
    .catch(() => vm?.guest.exec("/bin/kill", ["-TERM", String(p.gpid)]).catch(() => {}));
  emitService({ type: "stopped", pid: key });
  return true;
}

export function listProcesses() {
  return [...procs.values()].map((p) => ({ pid: p.hostPort, url: p.url, command: p.command }));
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

/** Prewarm: merge a new directory into the mount set (no rebuild needed, the broadcast root already covers everything). */
export function prewarm(cwd) {
  if (!degraded && cwd) ensureRoot(cwd);
}

/** Exit cleanup: remove all forwards + shut down the VM. */
export function dispose() {
  try { stopAll(); } catch { /* best effort */ }
  try { ninep?.close(); } catch { /* best effort */ } finally { ninep = null; }
  try { vm?.ports.quit(); } catch { /* best effort */ }
  try { vm?.proc.kill(); } catch { /* best effort */ }
  vm = null;
}
