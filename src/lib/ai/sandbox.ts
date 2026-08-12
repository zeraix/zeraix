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
      // Kept SHORT on purpose: this rides every conversation's first turn, and the system prompt already
      // describes the sandbox and its toolchain at length — it explicitly defers here only for WHICH
      // environment is live. Restating what the sandbox is would be paying ~100 tokens a conversation to
      // repeat the seed.
      "【Command Execution Environment】`run_command` / `check_project` run in the Linux sandbox (Debian, bash); use Linux commands. " +
      // Only what is true wherever this text is used. It is a reminder line in the main conversation AND a sub-agent's
      // system prompt, and a sub-agent has no reminder and is never given the host path — so the host-path mapping is
      // stated on the reminder's working-directory line instead, which is the line that actually shows it.
      "The working directory is `/workspace` there — use `/workspace` or relative paths for commands and for file-tool paths. " +
      // The emitted marker is "[Execution environment switched]" (engineSwitchNote, main process). It used to be quoted
      // here as 【Execution Environment Switch】, which is not a string the model ever receives.
      "File tools share this working directory. On an [Execution environment switched] notice, switch accordingly."
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
  // Deliberately does NOT repeat that doc-media-toolbox is unavailable here. messages[0] lists the skill with its own
  // description, which already ends "REQUIRES the Linux sandbox … when commands are running directly on the host, this
  // skill is unavailable and its tools will not be found — the Command Execution Environment note says which is in
  // effect". The rule is stated there once, and it points at THIS line for the answer; restating it made the model read
  // the same rule twice and cost the tokens on every native-mode turn.
  return (
    `【Command Execution Environment】run_command / check_project run directly on the ${osName}; use matching commands. ` +
    "On an [Execution environment switched] notice, switch accordingly."
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
