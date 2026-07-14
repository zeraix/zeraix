/**
 * QEMU 执行引擎：把 run_command 放进「单个长期存活」的 QEMU VM（macOS=HVF / Windows=WHPX /
 * Linux=KVM）里执行。命令经 qemu-guest-agent 在 guest 内以 bubblewrap 限定到挂载集运行。
 * 契约同 native：run 不抛异常。
 *
 * 长驻服务（dev server 等）在 guest 内运行，并用 QMP hostfwd 把端口「动态转发」到宿主，
 * 从而在宿主可预览。
 *
 * 机制文件在 sandbox/qemu/：control.mjs（QMP + guest-agent 客户端）、Dockerfile +
 * build-rootfs-local.sh（工具箱镜像 → 可引导 qcow2）。本模块直接拉起 qemu 进程（不经
 * shell），再用 control.mjs 的客户端连上。
 *
 * 挂载模型（无需热挂载 / 永不重建）：一次性 9p 共享「宿主根」（posix "/"，Windows 盘符）到
 * guest 的 /mnt/hostfs；任何 cwd 都已覆盖。未信任命令的可见范围由 bwrap 每命令限定到挂载集
 * （homeRoot ∪ 显式 extras），posix 下以「路径同构」bind（宿主路径==guest 路径，工具输出路径两侧一致）。
 *
 * 就绪前 / 失败时降级 native。需实机引导验证（见 sandbox/qemu/README）。
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

let cfg = null; // 由 engine.mjs 注入：{ image, memory, cpus, background, rootfs? }
let onExitCb = null; // engine.mjs 注入：VM 进程退出时回调（用于把「就绪」状态降级，避免 UI 一直显示运行中）
export function configure(c) {
  cfg = c;
  if (c && typeof c.onExit === "function") onExitCb = c.onExit;
}

const HOME = os.homedir();
const isWin = process.platform === "win32";
const QMP_PORT = 4444;
const GA_PORT = 4445;
const GUEST_MNT = "/mnt/hostfs"; // 宿主根在 guest 内的挂载点（firstboot.sh 以 9p 挂入，须与之一致）
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // guest 内 bash 单引号转义
// VM 磁盘/内核首次运行从公共 CDN 下载（docker.zeraix.com 前置 zeraix-docker 桶的公开只读入口）。
const VM_CDN = (process.env.ZERAIX_CDN || "https://docker.zeraix.com").replace(/\/+$/, "");

let vm = null; // { proc, ports, guest }
let ninep = null; // Windows: in-process 9p-over-TCP server backing the host share
let homeRoot = ""; // provision 的公共根（会话 workdir 的父目录）
let extraRoots = []; // 显式选择过的根外文件夹（累积；每命令并入 bwrap bind 集）
let degraded = ""; // 非空 = 本会话已降级 native，不再尝试
let degradeNoticeShown = false;
const EXTRA_ROOTS_MAX = 16;

// 后台长驻服务表：hostPort → { gpid, hostPort, guestPort, url, command, log }
const procs = new Map();
let svcSeq = 0;

// ── 路径 / 目录 ───────────────────────────────────────────────────────────────
// VM 镜像目录见 ./vmpaths.mjs（各平台本地应用数据目录；运行时与构建/发布脚本共用同一位置）。
// 应用名取自 userData 的 basename，确保与 llama/userData 同名（dev=Zeraix，打包=OperEase）。
const VM_FILES = ["rootfs.qcow2", "Image", "initrd.img"];
// 版本目录根（.../vm）：独立于 ZERAIX_VMDIR 覆盖，始终指默认布局，供版本枚举/清理。
function vmRoot() { return path.join(localDataDir(path.basename(app.getPath("userData"))), "vm"); }
function versionComplete(v) { return !!v && VM_FILES.every((f) => fs.existsSync(path.join(vmRoot(), v, f))); }
function installedVersions() {
  try { return fs.readdirSync(vmRoot()).filter((d) => !d.startsWith(".") && versionComplete(d)); } catch { return []; }
}
/**
 * 启动使用的版本：
 *   - configured（versions.json 目标）已完整下载 → 用它；
 *   - 否则有其它已下载版本 → 用最新的一个（即用旧镜像启动，不自动下载新版本——交给用户决定更新）；
 *   - 都没有 → configured（首次运行，会触发下载）。
 * forceConfigured=true（用户点「更新」）：强制用 configured（会下载新版本）。
 */
function bootVersion(forceConfigured = false) {
  const configured = vmVersion(guestArch());
  if (forceConfigured) return configured;
  if (versionComplete(configured)) return configured;
  const others = installedVersions().filter((v) => v !== configured);
  return others.length ? [...others].sort().slice(-1)[0] : configured;
}

function dirs(forceConfigured = false) {
  const override = process.env.ZERAIX_VMDIR; // 自定义目录覆盖：直接用，不套版本布局
  const vd = override ? override : path.join(vmRoot(), bootVersion(forceConfigured));
  return { vd, rootfs: cfg?.rootfs || process.env.ZERAIX_ROOTFS || path.join(vd, "rootfs.qcow2") };
}

/** VM 镜像目录（rootfs.qcow2 / Image / initrd.img 所在）。静态路径，供 UI 展示 / 打开文件夹，无需 VM 运行。 */
export function vmImageDir() { return dirs().vd; }

/**
 * VM 镜像版本 / 安装信息，供沙箱弹窗展示与「更新」判断。
 *   version      = 当前启动使用的版本（可能是旧版本）
 *   targetVersion= versions.json 目标版本
 *   complete     = 目标版本已完整下载
 *   updatable    = 正在用旧版本且目标版本尚未下载 → 可由用户触发更新
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
  // 打包版：extraResources 把 resources/bin 铺到 process.resourcesPath 根 → <arch>/qemu/。
  // dev（`electron .`）：process.resourcesPath 指向 Electron 自身的 resources（无我方二进制），
  //   改从仓库 resources/bin/<arch>/qemu 取——app.getAppPath()=仓库根，与 main.mjs 的 WEB_ROOT 同源。
  // 命中即返回全路径：qemu-system spawn、派生的 qemu-img、以及 -L share 固件目录三者一并修正。
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, archDir, "qemu", sys),
    !app.isPackaged && path.join(app.getAppPath(), "resources", "bin", archDir, "qemu", sys),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return sys;
}

/** 宿主路径 → { src: guest 内 9p 路径, dst: bwrap 内目标（posix 保持同构） }。 */
function mapRoot(hostPath) {
  const abs = path.resolve(hostPath);
  if (!isWin) {
    const rel = abs.replace(/^\//, "");
    return { src: path.posix.join(GUEST_MNT, rel), dst: abs };
  }
  // Windows 多盘：/mnt/hostfs/<盘符>/<其余>（对应 ninep-server 的虚拟多盘根），任意盘符的
  // workdir（C:、E:…）都能正确映射。
  const m = abs.match(/^([A-Za-z]):[\\/]?(.*)$/);
  const drive = m ? m[1].toUpperCase() : "C";
  const rest = (m ? m[2] : "").split(path.sep).join("/");
  const g = path.posix.join(GUEST_MNT, drive, rest);
  return { src: g, dst: g }; // Windows 不保持同构
}

/** cwd 未被挂载集覆盖时并入 extras（广播根已覆盖全盘，无需重建 VM）。 */
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

/** bubblewrap 参数（不含 argv[0] 与末尾命令）：只把挂载集从 /mnt/hostfs bind 进来，chdir cwd。
 *  网络默认放通（不 --unshare-net）——沙箱内命令可直达互联网：pip / npm / git / curl 等。
 *  DNS 与路由由 guest 的 SLIRP 网络提供（firstboot.sh 配置 10.0.2.x + nameserver）。 */
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

// ── 引导 ─────────────────────────────────────────────────────────────────────
function qemuArgs(vd, overlay) {
  const mem = cfg?.memory > 0 ? cfg.memory : 4096;
  const cpus = cfg?.cpus > 0 ? cfg.cpus : 4;
  const shareRoot = isWin ? `${process.env.SystemDrive || "C:"}\\` : "/";
  // 直接内核引导（无 bootloader / UEFI）：qemu 直接加载内核，整盘 ext4 作为 /dev/vda 根（无分区表）。
  // Image + initrd.img 由 build-rootfs-local.sh 与 rootfs 一起产出、一起分发（boot() 已校验存在）。
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
    // 打包后 qemu 位于 process.resourcesPath/<platform>-<arch>/qemu/，需显式 -L 指到随附固件目录（SeaBIOS/option
    // ROM），否则重定位后的 qemu 找不到数据目录而无法引导（bundle-bin-win.mjs 负责放置 share/）。
    const share = path.join(path.dirname(qemuBin()), "share");
    const L = fs.existsSync(share) ? ["-L", share] : [];
    // WHPX 对 CPU 模型远比 HVF/KVM 挑剔：`-cpu max` 会暴露 APX/MPX 等冲突特性，guest 在最初几条
    // 指令即三重故障（WHPX: Unexpected VP exit code 4=UnrecoverableException）。改用具名模型
    // Haswell（SSE4.2/AVX2/AES 齐备且 WHPX 稳定引导，已实测启到 login）。勿在 Windows 用 max/host。
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

// 清理无用的旧版本 VM 目录（释放磁盘）。保留「当前启动版本 keepVersion」与「目标版本 configured」两者：
// 用旧版本启动时留着旧版本（否则没镜像可用），目标版本留着（用户更新后即用）；其余清理。
// ZERAIX_VMDIR 覆盖时跳过（避免误删自定义目录同级）。
function pruneOldVmVersions(keepVersion) {
  if (process.env.ZERAIX_VMDIR) return;
  const keep = new Set([keepVersion, vmVersion()].filter(Boolean));
  try {
    for (const name of fs.readdirSync(vmRoot())) {
      if (!keep.has(name) && !name.startsWith(".")) fs.rmSync(path.join(vmRoot(), name), { recursive: true, force: true }); // 跳过 .build-<arch> 构建暂存
    }
  } catch { /* ignore */ }
}

// 首次运行从 CDN 下载 VM 磁盘 + 内核（rootfs.qcow2 / Image / initrd.img）到 vd（含版本 vm/<id>/，无 arch 段）；已存在则跳过。
// 版本 = 本机架构的 docker 镜像 ID 短哈希，换 ID 即换目录 → 触发重新下载并清理旧版本（版本失效）。
// 进度经 onProgress(pct, msg) 上报给 engine.mjs（广播 UI）。.part → rename 原子落盘，中断不留半成品。
async function ensureRootfs(onProgress, forceConfigured = false) {
  const arch = guestArch();
  const configured = vmVersion(arch);
  if (!configured) throw new Error("VM_VERSION 未配置本机架构（先 build:rootfs + publish:rootfs）");
  const version = bootVersion(forceConfigured); // 用旧镜像启动不下载；首次/更新则 = configured（触发下载）
  const vd = path.join(vmRoot(), version);
  const missing = VM_FILES.filter((f) => !fs.existsSync(path.join(vd, f)));
  if (!missing.length) { pruneOldVmVersions(version); onProgress?.(100, "运行环境已就绪（无需下载）"); return; } // 已下载：清理陈旧后告知 UI
  // 需下载：仅「首次运行（无任何镜像）」或「用户点更新（forceConfigured）」时发生，此时 version === configured。
  fs.mkdirSync(vd, { recursive: true });
  let total = 0;
  for (const f of missing) total += await headSize(`${VM_CDN}/vm/${arch}/${version}/${f}`);
  // 断点续传：已存在的 .part 计入已完成进度（服务器 206 只回传剩余字节，不再经 onChunk 报告）。
  let done = 0;
  for (const f of missing) { const p = path.join(vd, f + ".part"); if (fs.existsSync(p)) done += fs.statSync(p).size; }
  const report = () => onProgress?.(total ? Math.min(99, Math.floor((done / total) * 100)) : null, `下载运行环境 ${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`);
  report(); // 初始进度（含已续传部分）
  for (const f of missing) {
    const tmp = path.join(vd, f + ".part");
    await httpDownload(`${VM_CDN}/vm/${arch}/${version}/${f}`, tmp, (n) => { done += n; report(); });
    fs.renameSync(tmp, path.join(vd, f));
  }
  pruneOldVmVersions(version); // 下载完成后再清理旧镜像（更新时 version=configured → 删掉旧版本，释放磁盘）
  onProgress?.(100, "运行环境就绪");
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
// 断点续传：已有 .part → 发 Range: bytes=<have>-；206 追加写、200（服务器忽略 Range）从头覆盖。
function httpDownload(url, dest, onChunk, redirs = 5) {
  return new Promise((resolve, reject) => {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const opts = have > 0 ? { headers: { Range: `bytes=${have}-` } } : {};
    https.get(url, opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirs > 0) { res.resume(); return resolve(httpDownload(res.headers.location, dest, onChunk, redirs - 1)); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`GET ${url} → ${res.statusCode}`)); }
      const resuming = res.statusCode === 206; // 服务器接受续传；200 表示忽略 Range，从头覆盖
      const ws = fs.createWriteStream(dest, { flags: resuming ? "a" : "w" });
      res.on("data", (c) => onChunk?.(c.length));
      res.pipe(ws);
      ws.on("finish", () => ws.close(() => resolve()));
      ws.on("error", reject);
    }).on("error", reject);
  });
}

async function boot(onProgress, forceConfigured = false) {
  await ensureRootfs(onProgress, forceConfigured); // 首次运行下载镜像；forceConfigured=更新（下载目标版本）
  const { vd, rootfs } = dirs(forceConfigured);
  if (!fs.existsSync(rootfs)) throw new Error(`rootfs not found: ${rootfs}`);
  if (!fs.existsSync(path.join(vd, "Image")) || !fs.existsSync(path.join(vd, "initrd.img")))
    throw new Error(`kernel not found: need Image + initrd.img next to ${rootfs}`);
  onProgress?.(null, "正在启动运行环境…"); // 镜像就绪 → 进入启动阶段（QEMU 引导，无细粒度进度，UI 显示不确定态）
  fs.mkdirSync(vd, { recursive: true });
  // 抛弃式 overlay：基镜像保持干净，写入停机即弃。
  const overlay = path.join(vd, "run.qcow2");
  const imgBin = qemuBin().replace(/qemu-system-[^/\\]+(\.exe)?$/, isWin ? "qemu-img.exe" : "qemu-img");
  fs.rmSync(overlay, { force: true });
  await new Promise((res, rej) => {
    const p = spawn(imgBin, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", rootfs, overlay]);
    p.on("exit", (c) => (c ? rej(new Error(`qemu-img exit ${c}`)) : res()));
    p.on("error", rej);
  });
  // 捕获 qemu 自身 stdout/stderr 到 vd/qemu.log（原为 stdio:"ignore"，进程崩溃时无从查因）。
  // 这里是「宿主侧」qemu 的输出（HVF 报错、断言、休眠唤醒失败等）；guest 内核/systemd 输出另见 console.log。
  const qlog = fs.createWriteStream(path.join(vd, "qemu.log"), { flags: "a" });
  try { qlog.write(`\n===== qemu 启动 ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
  const proc = spawn(qemuBin(), qemuArgs(vd, overlay), { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  proc.stderr.on("data", (b) => { try { qlog.write(b); } catch { /* ignore */ } });
  const exitCb = onExitCb; // 绑定本 proc 启动时的回调（重启后新旧 proc 各自对应，见 engine.disposing 守卫）
  proc.on("exit", (code, signal) => {
    try { qlog.write(`\n===== qemu 退出 code=${code} signal=${signal ?? "-"} @ ${new Date().toISOString()} =====\n`); qlog.end(); } catch { /* ignore */ }
    vm = null; try { ninep?.close(); } catch {} ninep = null;
    try { exitCb?.(code, signal); } catch { /* ignore */ }
  });
  const ports = await qmp({ port: QMP_PORT });
  const guest = await guestAgent({ port: GA_PORT }); // 内含 guest 就绪等待
  vm = { proc, ports, guest };
  if (isWin) await winShareMount(guest); // Windows host share: 9p-over-tcp (no virtio-9p)
  return vm;
}

/** engine.mjs 调用：启动长期 VM。onProgress(pct,msg)：首次运行下载 VM 磁盘/内核的进度回调。
 *  forceConfigured=true：用户「更新」——下载 versions.json 目标版本并切换。 */
export async function provision(rootHost, onProgress, extras = [], forceConfigured = false) {
  homeRoot = path.resolve(rootHost);
  extraRoots = [];
  for (const d of extras) if (d) ensureRoot(d);
  await boot(onProgress, forceConfigured);
}

// ── 前台执行 ─────────────────────────────────────────────────────────────────
async function degradeRun(cmd, opts, reason) {
  if (!degraded) {
    degraded = reason;
    console.warn(`[sandbox/qemu] degraded to native: ${reason}`);
  }
  const r = await native.run(cmd, opts);
  if (!degradeNoticeShown) {
    degradeNoticeShown = true;
    const hint = `（提示：QEMU 沙箱不可用——${reason}。已在宿主机直接执行本次及后续命令。）`;
    return { ...r, stderr: r.stderr ? `${r.stderr}\n${hint}` : hint };
  }
  return r;
}

/** 前台执行：guest 内 bwrap 限定到挂载集，bash -c cmd，带超时；不抛异常。 */
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

// ── 后台长驻服务：guest 内运行 + QMP hostfwd 转发端口到宿主 ──────────────────────
const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
const pickPort = (s) => {
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  return m ? Number(m[1]) : 0;
};

/**
 * 在 guest 内后台启动长驻命令（bwrap 限定 + 允许网络），扫描早期输出取端口，QMP hostfwd
 * 转发到宿主同端口，返回宿主可达 URL。停止时一并撤销转发。启动通道异常则退回 native。
 */
export async function startBackground(cmd, opts = {}) {
  if (degraded || !vm) return native.startBackground(cmd, opts);
  const cwd = opts.cwd;
  ensureRoot(cwd);
  const log = `/tmp/zx-svc-${++svcSeq}.log`;
  const flags = bwrapFlags(cwd).map(shq).join(" ");
  // SVC_CMD 经 guest-exec env 传入（execve 直传，不过 shell），"$SVC_CMD" 以整串作为 bash -lc 参数。
  const script =
    `setsid /usr/bin/bwrap ${flags} -- /bin/bash -lc "$SVC_CMD" >${shq(log)} 2>&1 </dev/null & echo $!`;
  let gpid = 0;
  try {
    const { out } = await vm.guest.exec("/bin/bash", ["-lc", script], { env: [`SVC_CMD=${cmd}`] });
    gpid = parseInt(String(out).trim(), 10) || 0;
  } catch {
    return native.startBackground(cmd, opts);
  }

  // 早期就绪扫描：读日志，命中 READY / 提取端口 / 8s 上限（与 native 相同节奏）。
  let out = "";
  let guestPort = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try {
      const r = await vm.guest.exec("/bin/cat", [log]);
      out = r.out || out;
    } catch {
      /* 日志尚未生成 */
    }
    guestPort = pickPort(out);
    if (guestPort || READY.test(out)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // 端口转发：guest 端口 → 宿主同端口（需 guest 监听 0.0.0.0，SLIRP 经网关 10.0.2.x 到达）。
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
    ? `✅ 服务已在沙箱内后台启动${url ? `，并转发到宿主：${url}` : guestPort ? `（guest 端口 ${guestPort}，转发失败）` : ""}。`
    : "⚠️ 进程未能启动。";
  return (
    `${headline}\n\n--- 启动输出 ---\n${(out.trim() || "(暂无输出)").slice(-4000)}\n` +
    (url
      ? `\n说明：服务运行在隔离沙箱内，已端口转发，宿主可达 ${url}（用它预览）。若访问不到，请让服务监听 0.0.0.0。请勿重复启动。`
      : alive
        ? "\n说明：服务在沙箱内后台运行；未探测到端口/未转发。若需宿主访问，请用 expose_port，并让服务监听 0.0.0.0。"
        : "")
  );
}

/** 停止后台服务（按 hostPort）：撤销 hostfwd + 结束 guest 进程组。 */
export function stopProcess(pid) {
  const key = Number(pid);
  const p = procs.get(key);
  if (!p) return false;
  procs.delete(key);
  vm?.ports.removePort(p.hostPort).catch(() => {});
  // setsid 使 gpid 为进程组长；kill 负号结束整组，失败退回单进程。
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

/** 显式端口转发（供 LLM 的 expose_port 工具调用）：guest 端口 → 宿主端口，返回可达 URL。 */
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

/** 预热：把新目录并入挂载集（无需重建，广播根已全覆盖）。 */
export function prewarm(cwd) {
  if (!degraded && cwd) ensureRoot(cwd);
}

/** 退出清理：撤销所有转发 + 关停 VM。 */
export function dispose() {
  try { stopAll(); } catch { /* 尽力而为 */ }
  try { ninep?.close(); } catch { /* 尽力而为 */ } finally { ninep = null; }
  try { vm?.ports.quit(); } catch { /* 尽力而为 */ }
  try { vm?.proc.kill(); } catch { /* 尽力而为 */ }
  vm = null;
}
