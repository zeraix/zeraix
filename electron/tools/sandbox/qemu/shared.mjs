/**
 * What the parts of the QEMU engine share: the mutable state more than one of them touches, and the two answers a
 * command gets when the sandbox could not see it through.
 *
 * qemu.mjs is the public entry, and the work is split by concern into the files of qemu/ (see its header). A few
 * variables that were one file's globals are now read in one part and written in another. An ESM `let` can only be
 * reassigned by the module that declares it, so each of those lives HERE as an exported live binding with a setter:
 * every importer reads the current value, exactly as it did when they were all in one file, and only qemu.mjs
 * (configure / provision / boot / dispose) calls the setters.
 *
 * The parts import from this module and from each other, never from qemu.mjs, so there is no import cycle.
 */
import { recordRecovery } from "../../../store/recoveryLog.mjs";

export const isWin = process.platform === "win32";

export let cfg = null; // Injected by engine.mjs: { image, memory, cpus, background, rootfs? }
export function setCfg(c) { cfg = c; }

export let vm = null; // { proc, ports, guest }
export function setVm(v) { vm = v; }

export let homeRoot = ""; // The common root from provision (parent of the session workdirs); only a fallback for a command that carries no cwd
export function setHomeRoot(r) { homeRoot = r; }

// ── Foreground execution: the failure answers (used by run() in qemu.mjs; sandboxFailure also by startBackground) ──
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
export function sandboxFailure(reason) {
  console.warn(`[sandbox/qemu] command not run: ${reason}`);
  return { stdout: "", stderr: `Sandbox unavailable: ${reason}\nThe command was NOT run. It is not retried on the host, because it would then run outside the sandbox and against the host's own toolchain.`, code: 126, killed: false };
}

/**
 * The sandbox died while a command was RUNNING (docs/agent-runtime-crash-recovery.md C5, and §5's rule).
 *
 * A different answer from `sandboxFailure`, and the difference is the whole point. That one says "the command was NOT
 * run", which is true when the VM was never up — and flatly wrong here, where the command had started, may have run to
 * completion, and may already have written files or installed packages. Telling the model a command did not run when
 * it may have is exactly how a crash turns into a second `npm install`.
 *
 * There is no partial output to hand back: qemu's guest agent returns a command's stdout only once it has exited, so a
 * VM that dies mid-command takes the bytes with it. Saying so is better than implying the command produced nothing.
 */
export function sandboxDiedMidCommand(reason) {
  console.warn(`[sandbox/qemu] the sandbox stopped while a command was running: ${reason}`);
  recordRecovery("sandbox", "died-mid-command", { reason: String(reason).slice(0, 200) });
  return {
    stdout: "",
    stderr:
      `The sandbox stopped while this command was running (${reason}).\n` +
      "STATUS UNKNOWN: the command had already started, so it may have completed, partly completed, or done nothing. " +
      "Its output was lost with the sandbox. Do NOT assume it failed and do NOT simply repeat it — check the working " +
      "directory and whatever it would have changed first, and repeat it only if the work is verifiably not done.",
    code: 125,
    killed: false,
    unknown: true,
  };
}
