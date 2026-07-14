/**
 * 命令执行引擎层：以可插拔方式决定 run_command / check_project 在哪里执行。
 *
 *   - native  —— 宿主机直接执行（历史行为，默认与兜底，见 native.mjs）
 *   - qemu    —— 单个长期存活的 QEMU VM（macOS=HVF / Windows=WHPX / Linux=KVM）里硬件级隔离
 *                执行；命令经 qemu-guest-agent 在 guest 内以 bubblewrap 限定到挂载集运行，
 *                长驻服务（dev server 等）用 QMP hostfwd 动态转发端口到宿主（见 qemu.mjs）。
 *
 * 引擎契约（每个引擎模块导出）：
 *   id
 *   run(cmd, { cwd, timeoutMs, maxBuffer })  → { stdout, stderr, code, killed }（不抛异常）
 *   startBackground(cmd, { cwd })            → Promise<string>（格式化结果文本）
 *   stopProcess(pid) / listProcesses() / stopAll()
 *
 * 桌面应用形态：沙箱「后台主动初始化」，全程不阻塞命令（就绪前一律 native），
 * 状态机进度经 onSandboxStatus 广播给 UI：
 *   unsupported(原因) | disabled | starting → ready | error(原因)
 * 初始化直接创建「长期存活」的唯一 VM（挂载公共根 ∪ 历史显式选择过的文件夹）——
 * 启动本身即可用性验证，首条命令零额外等待。ready 且「日常」模式才切沙箱；开发模式
 * 始终 native。VM 二进制随应用分发、rootfs 首次运行下载（见 sandbox/qemu/README）。
 *
 * 配置（app.config 的 [sandbox] 一节，均可缺省）：
 *   engine = auto | native      auto（默认）：有硬件虚拟化则后台启用 qemu；native：完全禁用
 *   image  = <OCI 引用>          工具箱镜像引用，仅用于状态展示
 *   memory / cpus                VM 规格，默认 2048 MiB / 2 vCPU
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import * as native from "./native.mjs";

export { setServiceEventHandler } from "./events.mjs";

// 默认沙箱配置（可被 app.config [sandbox] 覆盖）。
const DEFAULTS = {
  engine: "auto",
  image: "docker.zeraix.com/botshub/sandbox:h-d0c4ebb4cec9",
  memory: 2048,
  cpus: 2,
};

let sandbox = null; // 就绪后加载的 qemu 引擎模块
let ready = false;
let mode = "daily"; // 渲染层经 setSandboxMode 同步；沙箱只服务「日常」模式
let initPromise = null;
let disposing = false; // 主动停机/重启中：忽略随之而来的 VM 退出回调（不当作异常崩溃）
const loaded = [native]; // 已加载的引擎实例（停止/清理时全量遍历）

// ── 状态机 + 进度广播 ─────────────────────────────────────────────────────────
let status = { phase: "idle", reason: "", image: DEFAULTS.image, pct: null };
const statusListeners = new Set();

/** 订阅沙箱初始化状态变化（main 转发给渲染层）。返回退订函数。 */
export function onSandboxStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** 当前沙箱状态（渲染层初始同步 + system 提示语构造用）。 */
export function getSandboxStatus() {
  return { ...status, mode, active: getEngine().id, hostPlatform: process.platform };
}

function setStatus(phase, extra = {}) {
  status = { ...status, phase, reason: "", pct: null, ...extra };
  for (const fn of statusListeners) {
    try {
      fn(getSandboxStatus());
    } catch {
      /* 监听方异常不影响状态机 */
    }
  }
}

/** qemu VM 进程意外退出（崩溃 / OOM / 被杀）时由 qemu.mjs 回调：把「就绪」状态降级并广播，
 *  否则 getSandboxStatus 会一直报 ready、UI 弹窗/徽标误显示为「运行中」。主动 dispose/restart
 *  期间 disposing=true 时忽略（那是预期停机）。降级后引擎自动回退 native（getEngine 依 ready）。 */
function handleVmExit(code, signal) {
  if (disposing || !ready) return;
  ready = false;
  sandbox = null;
  initPromise = null; // 允许后续重新初始化（如用户点「更新/重启」）
  const how = signal ? `signal ${signal}` : `code ${code ?? "?"}`; // 被杀/休眠→信号；自退→退出码。详因见 vd/qemu.log
  setStatus("error", { reason: `运行环境已退出（${how}）——已回退本机执行，详见 qemu.log` });
  console.warn(`[sandbox] VM exited unexpectedly (${how}); falling back to native`);
}

/** 渲染层同步当前模式（daily / dev）。dev 模式即刻回到 native 路由。 */
export function setSandboxMode(m) {
  mode = m === "dev" ? "dev" : "daily";
  return getSandboxStatus();
}

/** 读取 [sandbox] 配置。appConfig.mjs 依赖 electron，这里惰性引入并在非 Electron 环境下回退默认值。 */
async function readConfig() {
  try {
    const { getAppConfig } = await import("../../appConfig.mjs");
    const s = getAppConfig()?.sandbox ?? {};
    return {
      engine: (s.engine || DEFAULTS.engine).toLowerCase(),
      image: s.image || DEFAULTS.image,
      memory: Number(s.memory) > 0 ? Number(s.memory) : DEFAULTS.memory,
      cpus: Number(s.cpus) > 0 ? Number(s.cpus) : DEFAULTS.cpus,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Windows：WHP（Windows Hypervisor Platform）是否可用。用一次性 PowerShell 探针 P/Invoke
// WinHvPlatform.dll 的 WHvGetCapability(WHvCapabilityCodeHypervisorPresent=0) —— 即 N-API 方案
// （docs/windows-appcontainer-sandbox.md 的 whpAvailable）会做的同一检查，但无需编译原生插件。
// 结果缓存；任何异常（DLL 缺失 / 功能未开启 / 超时）→ false → 始终 native。
let whpCache;
function whpAvailable() {
  if (whpCache !== undefined) return whpCache;
  const script =
    "try{" +
    "Add-Type -Namespace Zx -Name Whp -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"WinHvPlatform.dll\")] public static extern int WHvGetCapability(int c, out int v, uint s, out uint w);' -ErrorAction Stop;" +
    "$v=0;$w=0;$hr=[Zx.Whp]::WHvGetCapability(0,[ref]$v,4,[ref]$w);" +
    "if($hr -eq 0 -and $v -ne 0){'WHP_YES'}else{'WHP_NO'}" +
    "}catch{'WHP_NO'}";
  whpCache = new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(!err && /WHP_YES/.test(stdout)));
  });
  return whpCache;
}

/** 宿主是否具备所需的硬件虚拟化。darwin/linux 为纯静态检查；Windows 用 WHP 命令探针（见上，缓存）。 */
async function hypervisorPresent() {
  // 显式覆盖：ZERAIX_FORCE_SANDBOX=1 强制启用（探针误判 / 测试用），=0 强制关闭（始终 native）。
  const force = process.env.ZERAIX_FORCE_SANDBOX;
  if (force === "0") return false;
  if (force && /^(1|true|yes)$/i.test(force)) return true;
  if (process.platform === "darwin") return process.arch === "arm64"; // Apple Silicon 的 HVF
  if (process.platform === "linux") {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") return whpAvailable();
  return false;
}

/**
 * 解析挂载集：公共根（userData/agent/ai-agent，日常模式所有会话 workdir 的父目录；只挂这一层，
 * agent/ 下的对话存储不暴露）∪ 历史显式选择过的文件夹（从项目索引推导）。
 */
async function resolveMounts(opts) {
  let mountRoot;
  try {
    const { app } = await import("electron");
    mountRoot = path.join(app.getPath("userData"), "agent", "ai-agent");
  } catch {
    mountRoot = opts.getWorkdir?.() ?? path.join(os.homedir(), "zeraix-workspace");
  }
  fs.mkdirSync(mountRoot, { recursive: true }); // bind mount 需要目录已存在
  let extraMounts = [];
  try {
    const { loadIndex } = await import("../../store/conversationStore.mjs");
    const { projects } = await loadIndex();
    extraMounts = projects
      .filter((p) => p?.mode === "daily" && typeof p?.workdir === "string" && p.workdir)
      .filter((p) => fs.existsSync(p.workdir))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .map((p) => p.workdir);
  } catch {
    /* 非 Electron / 存储不可用 → 仅公共根 */
  }
  return { mountRoot, extraMounts };
}

/**
 * 启动沙箱后台初始化（幂等、立即返回、绝不抛出）。
 * opts.getWorkdir：取当前工作目录（由 aiToolkit 注入；仅在非 Electron 环境下
 * 作为挂载根的回退——正常运行时挂载 userData/agent 公共根）。
 */
let lastInitOpts = {}; // 记住首次 init 的 opts（含 getWorkdir），供 restartSandbox 复用
export function initEngine(opts = {}) {
  lastInitOpts = opts;
  initPromise ??= (async () => {
    try {
      const cfg = await readConfig();
      status.image = cfg.image;
      if (cfg.engine === "native") {
        const reason = "disabled by config ([sandbox] engine=native)";
        setStatus("disabled", { reason });
        console.log(`[sandbox] disabled (staying native): ${reason}`);
        return getSandboxStatus();
      }
      if (!(await hypervisorPresent())) {
        const reason =
          process.platform === "win32"
            ? "Windows Hypervisor Platform (WHPX) not available — enable it (dism /enable-feature HypervisorPlatform) + reboot, or set ZERAIX_FORCE_SANDBOX=1"
            : "no hardware virtualization on this host";
        setStatus("unsupported", { reason });
        console.log(`[sandbox] unsupported (staying native): ${reason}`);
        return getSandboxStatus();
      }

      // 直接创建长期驻留的「唯一」QEMU VM：挂载会话工作目录的公共根（userData/agent/ai-agent，
      // 日常模式所有会话的 workdir 都在其下）∪ 历史显式选择过的文件夹——会话/项目再多也只有这
      // 一个 VM，按会话仅切换 guest 内 cwd。引导即验证；缺 rootfs 会抛→error 降级 native。
      const m = await import("./qemu.mjs");
      m.configure({ ...cfg, onExit: handleVmExit }); // VM 进程退出即降级状态（见 handleVmExit）
      const { mountRoot, extraMounts } = await resolveMounts(opts);
      setStatus("starting");
      await m.provision(mountRoot, (pct, msg) => setStatus("starting", { pct, reason: msg }), extraMounts, !!opts.forceConfigured);
      loaded.push(m);
      sandbox = m;
      ready = true;
      setStatus("ready");
      console.log("[sandbox] ready: qemu");
      return getSandboxStatus();
    } catch (e) {
      setStatus("error", { reason: `${e?.message ?? e}` });
      console.warn(`[sandbox] init failed, staying native: ${e?.message ?? e}`);
      return getSandboxStatus();
    }
  })();
  return initPromise;
}

/**
 * 重启沙箱引擎：停当前 VM → 复位初始化状态 → 重新 initEngine（provision 会按 versions.json
 * 的目标版本下载缺失镜像）。用于「更新运行环境」：新版本目录为空时重跑即拉取新镜像。
 */
export async function restartSandbox(opts = {}) {
  disposing = true; // 停旧 VM 会触发其退出回调；标记为预期停机，避免 handleVmExit 把状态误置 error
  try { if (sandbox?.dispose) sandbox.dispose(); } catch { /* ignore */ }
  ready = false;
  sandbox = null;
  initPromise = null;
  setStatus("idle");
  // 复用首次 init 的 opts（getWorkdir 等）；update=true 时置 forceConfigured 让 provision 下载目标版本。
  try {
    return await initEngine({ ...lastInitOpts, forceConfigured: !!opts.update });
  } finally {
    disposing = false; // 重新就绪/失败后恢复：此后 VM 崩溃才算异常
  }
}

/** VM 镜像版本 / 安装信息（供 UI 展示与「更新」判断）；按需加载 qemu 模块算静态信息。 */
export async function sandboxVmInfo() {
  try { const m = await import("./qemu.mjs"); return m.sandboxVmInfo(); } catch { return null; }
}

/** 当前引擎（同步）。就绪且处于「日常」模式才是 qemu，其余一律 native。 */
export function getEngine() {
  return ready && sandbox && mode === "daily" ? sandbox : native;
}

/** 兼容旧诊断接口：{ id, reason }。 */
export function getEngineInfo() {
  return { id: getEngine().id, reason: status.reason || status.phase };
}

// ── 跨引擎聚合：后台进程表可能分布在 native 与 guest 两侧 ─────────────────────────
export function listProcesses() {
  return loaded.flatMap((e) => e.listProcesses());
}

export function stopProcess(pid) {
  for (const e of loaded) {
    if (e.stopProcess(pid)) return true;
  }
  return false;
}

export function stopBackgroundProcs() {
  for (const e of loaded) {
    try {
      e.stopAll();
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 退出前清理：停后台进程 + 关停 VM（尽力而为，不阻塞退出）。 */
export function disposeEngines() {
  disposing = true; // 退出清理：VM 被停会触发退出回调，属预期停机，不广播 error
  stopBackgroundProcs();
  for (const e of loaded) {
    try {
      e.dispose?.();
    } catch {
      /* 尽力而为 */
    }
  }
}
