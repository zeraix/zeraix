/**
 * Command-execution engine layer: pluggably decides where run_command / check_project execute.
 *
 *   - native  —— executed directly on the host (historical behavior, the default and fallback, see native.mjs)
 *   - qemu    —— hardware-level isolated execution inside a single long-lived QEMU VM
 *                (macOS=HVF / Windows=WHPX / Linux=KVM); commands run via qemu-guest-agent inside the
 *                guest, confined by bubblewrap to the mount set, and long-running services (dev servers,
 *                etc.) forward ports to the host dynamically via QMP hostfwd (see qemu.mjs).
 *
 * Engine contract (exported by every engine module):
 *   id
 *   run(cmd, { cwd, timeoutMs, maxBuffer })  → { stdout, stderr, code, killed } (does not throw)
 *   startBackground(cmd, { cwd })            → Promise<string> (formatted result text)
 *   stopProcess(pid) / listProcesses() / stopAll()
 *
 * Desktop-app shape: the sandbox initializes proactively in the background, never blocking commands
 * (everything runs native until ready); state-machine progress is broadcast to the UI via onSandboxStatus:
 *   unsupported(reason) | disabled | starting → ready | error(reason)
 * Initialization directly creates the single long-lived VM (mounting the shared root ∪ folders explicitly
 * chosen in the past) —— startup itself is the availability check, so the first command waits nothing extra.
 * The sandbox is only switched in when ready and in "daily" mode; dev mode always stays native. The VM
 * binaries ship with the app and the rootfs is downloaded on first run (see sandbox/qemu/README).
 *
 * Configuration (the [sandbox] section of app.config, all optional):
 *   engine = auto | native      auto (default): enable qemu in the background if hardware virtualization exists; native: fully disabled
 *   image  = <OCI reference>     toolbox image reference, used only for status display
 *   memory / cpus                VM spec, defaults to 2048 MiB / 2 vCPU
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import * as native from "./native.mjs";

export { setServiceEventHandler } from "./events.mjs";

// Default sandbox config (can be overridden by app.config [sandbox]).
const DEFAULTS = {
  engine: "auto",
  image: "docker.zeraix.com/botshub/sandbox:h-d0c4ebb4cec9",
  memory: 2048,
  cpus: 2,
};

let sandbox = null; // qemu engine module loaded once ready
let ready = false;
let mode = "daily"; // synced from the renderer via setSandboxMode; the sandbox only serves "daily" mode
let initPromise = null;
let disposing = false; // during intentional shutdown/restart: ignore the ensuing VM exit callback (not treated as a crash)
const loaded = [native]; // loaded engine instances (iterated in full on stop/cleanup)

// ── State machine + progress broadcast ───────────────────────────────────────
let status = { phase: "idle", reason: "", image: DEFAULTS.image, pct: null };
const statusListeners = new Set();

/** Subscribe to sandbox initialization status changes (main forwards to the renderer). Returns an unsubscribe function. */
export function onSandboxStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Current sandbox status (for the renderer's initial sync + building the system prompt). */
export function getSandboxStatus() {
  return { ...status, mode, active: getEngine().id, hostPlatform: process.platform };
}

function setStatus(phase, extra = {}) {
  status = { ...status, phase, reason: "", pct: null, ...extra };
  for (const fn of statusListeners) {
    try {
      fn(getSandboxStatus());
    } catch {
      /* a listener throwing must not affect the state machine */
    }
  }
}

/** Called back by qemu.mjs when the qemu VM process exits unexpectedly (crash / OOM / killed):
 *  downgrade the "ready" status and broadcast it, otherwise getSandboxStatus would keep reporting ready
 *  and the UI dialog/badge would wrongly show "running". Ignored while disposing=true during an intentional
 *  dispose/restart (that is an expected shutdown). After downgrading, the engine auto-falls back to native (getEngine depends on ready). */
function handleVmExit(code, signal) {
  if (disposing || !ready) return;
  ready = false;
  sandbox = null;
  initPromise = null; // allow re-initialization later (e.g. when the user clicks "update/restart")
  const how = signal ? `signal ${signal}` : `code ${code ?? "?"}`; // killed/suspended → signal; self-exit → exit code. See vd/qemu.log for details
  setStatus("error", { reason: `Execution environment exited (${how}) — fell back to native execution; see qemu.log for details` });
  console.warn(`[sandbox] VM exited unexpectedly (${how}); falling back to native`);
}

/** The renderer syncs the current mode (daily / dev). dev mode routes back to native immediately. */
export function setSandboxMode(m) {
  mode = m === "dev" ? "dev" : "daily";
  return getSandboxStatus();
}

/** Read the [sandbox] config. appConfig.mjs depends on electron, so import it lazily and fall back to defaults outside Electron. */
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

// Windows: whether WHP (Windows Hypervisor Platform) is available. A one-shot PowerShell probe P/Invokes
// WinHvPlatform.dll's WHvGetCapability(WHvCapabilityCodeHypervisorPresent=0) — the same check the N-API approach
// (whpAvailable in docs/windows-appcontainer-sandbox.md) would do, but without compiling a native addon.
// The result is cached; any exception (missing DLL / feature disabled / timeout) → false → always native.
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

/** Whether the host has the required hardware virtualization. darwin/linux is a pure static check; Windows uses the WHP command probe (see above, cached). */
async function hypervisorPresent() {
  // Explicit override: ZERAIX_FORCE_SANDBOX=1 forces it on (probe misdetection / testing), =0 forces it off (always native).
  const force = process.env.ZERAIX_FORCE_SANDBOX;
  if (force === "0") return false;
  if (force && /^(1|true|yes)$/i.test(force)) return true;
  if (process.platform === "darwin") return process.arch === "arm64"; // HVF on Apple Silicon
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
 * Resolve the mount set: the shared root (userData/agent/ai-agent, the parent of every session workdir in
 * daily mode; only this one level is mounted, so the conversation storage under agent/ is not exposed) ∪
 * folders explicitly chosen in the past (derived from the project index).
 */
async function resolveMounts(opts) {
  let mountRoot;
  try {
    const { app } = await import("electron");
    mountRoot = path.join(app.getPath("userData"), "agent", "ai-agent");
  } catch {
    mountRoot = opts.getWorkdir?.() ?? path.join(os.homedir(), "zeraix-workspace");
  }
  fs.mkdirSync(mountRoot, { recursive: true }); // a bind mount requires the directory to already exist
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
    /* not Electron / storage unavailable → shared root only */
  }
  return { mountRoot, extraMounts };
}

/**
 * Kick off the sandbox's background initialization (idempotent, returns immediately, never throws).
 * opts.getWorkdir: gets the current working directory (injected by aiToolkit; used only outside Electron
 * as the fallback mount root — normal runs mount the userData/agent shared root).
 */
let lastInitOpts = {}; // remember the first init's opts (incl. getWorkdir) for restartSandbox to reuse
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

      // Directly create the single long-lived QEMU VM: mount the shared root of the session working
      // directories (userData/agent/ai-agent, under which every session's workdir lives in daily mode) ∪
      // folders explicitly chosen in the past — no matter how many sessions/projects there are, there is
      // only this one VM, and each session merely switches the guest cwd. Boot is the verification; a
      // missing rootfs throws → error, downgrading to native.
      const m = await import("./qemu.mjs");
      m.configure({ ...cfg, onExit: handleVmExit }); // downgrade status as soon as the VM process exits (see handleVmExit)
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
 * Restart the sandbox engine: stop the current VM → reset the init state → run initEngine again (provision
 * downloads any missing image per the target version in versions.json). Used for "update the execution
 * environment": when the new-version directory is empty, re-running pulls the new image.
 */
export async function restartSandbox(opts = {}) {
  disposing = true; // stopping the old VM triggers its exit callback; mark it an expected shutdown so handleVmExit doesn't wrongly set status to error
  try { if (sandbox?.dispose) sandbox.dispose(); } catch { /* ignore */ }
  ready = false;
  sandbox = null;
  initPromise = null;
  setStatus("idle");
  // Reuse the first init's opts (getWorkdir, etc.); when update=true set forceConfigured so provision downloads the target version.
  try {
    return await initEngine({ ...lastInitOpts, forceConfigured: !!opts.update });
  } finally {
    disposing = false; // restore after re-ready/failure: only after this does a VM crash count as abnormal
  }
}

/** VM image version / install info (for UI display and the "update" check); lazily load the qemu module to compute the static info. */
export async function sandboxVmInfo() {
  try { const m = await import("./qemu.mjs"); return m.sandboxVmInfo(); } catch { return null; }
}

/** Current engine (synchronous). qemu only when ready and in "daily" mode, otherwise always native. */
export function getEngine() {
  return ready && sandbox && mode === "daily" ? sandbox : native;
}

/** Backward-compatible legacy diagnostics interface: { id, reason }. */
export function getEngineInfo() {
  return { id: getEngine().id, reason: status.reason || status.phase };
}

// ── Cross-engine aggregation: the background-process table may span both native and guest ────
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
      /* best effort */
    }
  }
}

/** Cleanup before exit: stop background processes + shut down the VM (best effort, does not block exit). */
export function disposeEngines() {
  disposing = true; // exit cleanup: stopping the VM triggers the exit callback, which is an expected shutdown, so don't broadcast error
  stopBackgroundProcs();
  for (const e of loaded) {
    try {
      e.dispose?.();
    } catch {
      /* best effort */
    }
  }
}
