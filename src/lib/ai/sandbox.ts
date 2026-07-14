/**
 * Renderer-layer bridge for the sandbox (QEMU VM command-execution engine): status queries / mode sync / init-progress subscription.
 * Goes through window.sandbox (exposed by preload, Electron only); on non-Electron everything degrades to no-ops.
 *
 * The main process starts and validates the VM in the background without ever blocking command execution; when phase=ready and the mode is "daily",
 * commands automatically switch to running inside the sandbox, while dev mode always runs directly on the host.
 */

export interface SandboxStatus {
  /** idle | disabled | unsupported | installing-runtime | pulling-image | starting | ready | error */
  phase: string;
  /** Explanation of the reason when unsupported / error. */
  reason: string;
  /** The sandbox image reference in use. */
  image: string;
  /** Progress percentage (0-99) during the pulling-image phase, null in other phases. */
  pct: number | null;
  /** Current mode (daily / dev). */
  mode: string;
  /** The execution engine id currently in effect (native / qemu). */
  active: string;
  /** Host platform (process.platform: win32 / darwin / linux), used to describe the native environment in hint text. */
  hostPlatform?: string;
}

/**
 * Whether an isolated sandbox engine is in effect (qemu HVF/WHPX/KVM VM: Debian/bash Linux with the host directory mounted in).
 * native does not count. Used uniformly when determining the command-execution environment, badges, and built-in toolkit skill assembly.
 */
export function isSandboxEngine(active: string | null | undefined): boolean {
  return active === "qemu";
}

/**
 * The "command-execution environment" description injected into the system prompt: the model uses it to choose between Linux commands and host-system commands.
 * A mid-session engine switch is supplemented by the execution-environment-switch notice in run_command results (see the main-process aiToolkit).
 */
export function sandboxEnvHint(st: SandboxStatus | null): string {
  if (st && isSandboxEngine(st.active)) {
    return (
      "【Command Execution Environment】`run_command` / `check_project` are currently executed inside an isolated Linux (Debian, bash) sandbox: " +
      "Use Linux commands (ls, grep, curl, etc.) instead of Windows commands. File tools and terminal commands share the same working directory " +
      "(the host directory has been mounted into the sandbox). If an 【Execution Environment Switch】 notice appears in the tool output, switch to the matching commands as instructed."
    );
  }
  const p = st?.hostPlatform ?? "";
  const osName =
    p === "win32"
      ? "Windows（cmd/PowerShell）"
      : p === "darwin"
        ? "macOS（zsh/bash）"
        : p === "linux"
          ? "Linux（bash）"
          : "Host Machine";
  return (
    `【Command Execution Environment】run_command / check_project are currently executed directly on the ${osName},` +
    "Please use commands that match the system. If an 【Execution Environment Switch】 notice appears in the tool output, switch to the matching commands as instructed."
  );
}

/** VM image version / installation info. */
export interface SandboxVmInfo {
  dir: string;
  version: string;
  complete: boolean;
  otherVersions: string[];
  updatable: boolean;
}

interface SandboxBridge {
  getStatus?(): Promise<SandboxStatus>;
  setMode?(mode: "daily" | "dev"): Promise<SandboxStatus>;
  onStatus?(cb: (st: SandboxStatus) => void): () => void;
  vmDir?(): Promise<string | null>;
  vmInfo?(): Promise<SandboxVmInfo | null>;
  update?(): Promise<SandboxStatus>;
  restart?(): Promise<SandboxStatus>;
}

function bridge(): SandboxBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { sandbox?: SandboxBridge }).sandbox ?? null;
}

/** Current sandbox status (returns null on non-Electron / not ready). */
export async function getSandboxStatus(): Promise<SandboxStatus | null> {
  try {
    return (await bridge()?.getStatus?.()) ?? null;
  } catch {
    return null;
  }
}

/** Sync the current mode: the sandbox only serves "daily" mode, dev mode always runs directly on the host. */
export async function setSandboxMode(mode: "daily" | "dev"): Promise<void> {
  try {
    await bridge()?.setMode?.(mode);
  } catch {
    /* ignore */
  }
}

/** Subscribe to sandbox init-progress / ready / error events; returns an unsubscribe function (no-op in the Web environment). */
export function onSandboxStatus(cb: (st: SandboxStatus) => void): () => void {
  return bridge()?.onStatus?.(cb) ?? (() => {});
}

/** VM image directory (where rootfs.qcow2 etc. live); returns null on non-Electron / unavailable. */
export async function getSandboxVmDir(): Promise<string | null> {
  try {
    return (await bridge()?.vmDir?.()) ?? null;
  } catch {
    return null;
  }
}

/** VM image version / installation info; returns null on non-Electron / unavailable. */
export async function getSandboxVmInfo(): Promise<SandboxVmInfo | null> {
  try {
    return (await bridge()?.vmInfo?.()) ?? null;
  } catch {
    return null;
  }
}

/** Trigger a runtime update / restart (downloads the target version image); progress is pushed via onSandboxStatus. */
export async function updateSandbox(): Promise<void> {
  try {
    await bridge()?.update?.();
  } catch {
    /* ignore */
  }
}

/** Restart the runtime (using the existing image, no re-download): re-launch after a VM crash/exit; progress is pushed via onSandboxStatus. */
export async function restartSandbox(): Promise<void> {
  try {
    await bridge()?.restart?.();
  } catch {
    /* ignore */
  }
}
