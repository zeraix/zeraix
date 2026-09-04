/**
 * Renderer-layer bridge for the sandbox (QEMU VM command-execution engine): status queries / engine sync / init-progress subscription.
 * Goes through window.sandbox (exposed by preload, Electron only); on non-Electron everything degrades to no-ops.
 *
 * The main process starts and validates the VM in the background without ever blocking command execution. Which engine actually
 * runs a command is the SESSION's choice: each conversation carries a secure-environment switch (Conversation.secureEnv), and the
 * chat page mirrors the active session's setting down here. With it on and phase=ready, commands run inside the VM; with it off —
 * or before the VM is ready — they run directly on the host.
 *
 * The switch used to be the daily/dev mode, a sidebar-global toggle. Binding it to the session instead is deliberate: a project
 * spans many conversations, and instructions given while one environment was live ("the binary is at /workspace/bin", "use the
 * host's node") are wrong for the other, so a project-level setting propagated stale context into every later chat.
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
  /** Whether the active session asked for the secure environment ("sandbox") or host execution ("host"). */
  preference: string;
  /** The execution engine id currently in effect (native / qemu). */
  active: string;
  /**
   * Whether the VM is up at all, independent of whether it is the active engine. Differs from
   * `active === "qemu"` only when the session chose host execution: commands run on the host but can still
   * reach the guest per-command via `run_command({ sandbox: true })` — which is what `sandbox_tools` tells
   * the model about.
   */
  available?: boolean;
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
  // Names the shell the runner actually uses, because the model writes for the shell it is told about. A host
  // command goes through `cmd.exe /d /s /c` on Windows and `/bin/sh -c` elsewhere (native.mjs, agent-process) —
  // one line, that shell's quoting. Told "cmd/PowerShell", a model wrote PowerShell here-strings with bash escapes
  // and got cmd parse errors (2026-09-04); told "zsh", it would use zsh-only syntax that sh rejects.
  const osName =
    p === "win32"
      ? "Windows host. Each command is one line run by cmd.exe (cmd quoting; no bash or PowerShell syntax). For PowerShell, call `powershell -Command \"...\"` on one line with cmd-safe quotes; the console code page is UTF-8"
      : p === "darwin"
        ? "macOS host. Each command runs through `/bin/sh -c` (POSIX sh quoting; not zsh)"
        : p === "linux"
          ? "Linux host. Each command runs through `/bin/sh -c` (POSIX sh quoting)"
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

/**
 * What a brand-new session falls back to when nothing can be inherited.
 *
 * Only reached for the FIRST session in a project — every later one inherits the project's most recent session (see
 * agentChatStore.secureEnvDefaultFor), so this is the value a user meets once and then steers with the toggle.
 *
 * False (host execution) because the one surviving mode is the developer one: its working directory is one of the user's real
 * projects, and that project's toolchain — git, node_modules, installed SDKs, native builds — is the host's. Booting a first
 * session into the VM would hand the model a /workspace where none of that resolves.
 */
export const DEFAULT_SECURE_ENV = false;

interface SandboxBridge {
  getStatus?(): Promise<SandboxStatus>;
  setMode?(preference: "sandbox" | "host"): Promise<SandboxStatus>;
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

/**
 * Mirror the active session's secure-environment switch to the main process.
 *
 * `secure` true makes the VM the default engine once it is ready; false runs every command directly on the host. Called on
 * every session switch as well as on every toggle — the setting belongs to the conversation, so opening an older one has to
 * re-point the engine at whatever THAT conversation was using.
 */
export async function setSecureEnv(secure: boolean): Promise<void> {
  try {
    await bridge()?.setMode?.(secure ? "sandbox" : "host");
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
