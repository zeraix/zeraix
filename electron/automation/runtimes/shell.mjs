/**
 * Shell node runtime. See docs/automation-workflow-design.md §5.
 *
 * Runs a command and streams its output. This is the most dangerous runtime in the system -- it is
 * arbitrary code execution on the user's machine, unattended, on a schedule. It deliberately does no
 * permission checking of its own: that belongs at the Dispatcher's Policy Guard (§3.1), one
 * chokepoint for every runtime, so the check cannot be forgotten by a future runtime author.
 *
 * Config: { command: string, args?: string[], cwd?: string, env?: object, shell?: boolean }
 *
 * Inputs are exposed to the command as environment variables (see inputEnv): an input bound as
 * `prev` becomes $INPUT_PREV. Env is used rather than argv interpolation because splicing values
 * into a command string would be a shell-injection hole the moment an upstream node's output
 * contained a quote or a semicolon.
 */
import { spawn } from "node:child_process";
import { NodeCancelledError } from "./contract.mjs";
import { createEventQueue } from "./eventQueue.mjs";

/** Grace period between asking a process to stop and killing it outright. */
const SIGKILL_GRACE_MS = 3000;

/** Prefix for input-derived environment variables, so they cannot collide with real env vars. */
const INPUT_ENV_PREFIX = "INPUT_";

/**
 * Map resolved inputs to environment variables. Names are uppercased and sanitized; non-string
 * values are JSON-encoded so structured inputs survive the trip.
 */
function inputEnv(inputs = {}) {
  const env = {};
  for (const [key, value] of Object.entries(inputs)) {
    const name = INPUT_ENV_PREFIX + key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
    env[name] = typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
  return env;
}

/**
 * Kill a child and everything it spawned.
 *
 * `shell: true` means the recorded pid is a shell, and killing a shell does NOT reliably kill its
 * children -- they get reparented to init and keep running. For a scheduled, unattended run that
 * would silently leak processes on every cancel or timeout. So: POSIX gets its own process group
 * (detached) which we signal as a group; Windows gets taskkill /T.
 */
function killTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // No process groups: ask Windows to walk the tree for us.
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        windowsHide: true,
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    // Negative pid = "the whole process group", which detached:true gave us.
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone, or it was never created -- fall back to the single process.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Cap on captured output. Unbounded capture would put an arbitrarily large blob into the event log
 * and the node's outputs -- the same unbounded-growth failure the Data Bus rules exist to prevent
 * (§7.1). Truncation is reported rather than silent.
 */
const MAX_CAPTURE_BYTES = 1024 * 1024; // 1 MiB per stream

export function createShellRuntime() {
  return {
    kind: "shell",

    /**
     * @param {import("./contract.mjs").NodeContext} ctx
     * @returns {AsyncGenerator<import("./contract.mjs").NodeEvent>}
     */
    async *execute(ctx) {
      const cfg = ctx.config ?? {};
      const command = cfg.command;
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("shell node requires a non-empty config.command");
      }
      if (ctx.signal?.aborted) throw new NodeCancelledError();

      // Windows' default shell is cmd.exe, which cannot run the PowerShell automation steps almost
      // always want (Out-File, Test-Path, $env:...). So on Windows a shell node defaults to Windows
      // PowerShell, spawned directly rather than via `shell:true` -- Node's shell path adds cmd-style
      // `/d /s /c` flags that powershell.exe does not understand. `$ErrorActionPreference='Stop'` turns
      // a PowerShell error into a non-zero exit, so a broken step is reported failed instead of
      // silently "succeeding" with an empty result. A caller can still pin a shell with config.shell;
      // elsewhere (macOS/Linux) the default stays /bin/sh via shell:true.
      const usePowerShell = cfg.shell === undefined && process.platform === "win32";
      const file = usePowerShell ? "powershell.exe" : command;
      const args = usePowerShell
        ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop';\n${command}`]
        : cfg.args ?? [];
      const child = spawn(file, args, {
        cwd: cfg.cwd || ctx.workdir,
        // shell:true (pipes, redirection) for the POSIX default and any explicit override; PowerShell
        // is spawned directly. The safety story is the Policy Guard, not argument escaping.
        shell: usePowerShell ? false : cfg.shell ?? true,
        // Inputs last so a node cannot be silently starved of them by a stray cfg.env entry.
        env: { ...process.env, ...(cfg.env ?? {}), ...inputEnv(ctx.inputs) },
        windowsHide: true,
        // POSIX: give the shell its own process group so cancellation can kill the whole tree
        // rather than orphaning whatever the shell spawned (see killTree).
        detached: process.platform !== "win32",
      });

      // Surface the pid immediately so the Execution Manager can record it for orphan reaping --
      // if the app dies in the next millisecond, this pid is the only way to find the child (§5.1).
      if (child.pid) yield { type: "process", pid: child.pid, kind: "shell" };

      const queue = createEventQueue();
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const capture = (chunk, which) => {
        const text = chunk.toString();
        if (which === "stdout") {
          if (stdout.length < MAX_CAPTURE_BYTES) stdout += text;
          else stdoutTruncated = true;
        } else if (stderr.length < MAX_CAPTURE_BYTES) stderr += text;
        else stderrTruncated = true;

        // Stream every line so a long-running command shows progress in the Timeline rather than
        // appearing frozen until it exits.
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            queue.push({ type: "log", level: which === "stderr" ? "warn" : "info", message: line });
          }
        }
      };

      child.stdout?.on("data", (c) => capture(c, "stdout"));
      child.stderr?.on("data", (c) => capture(c, "stderr"));

      let exitCode = null;
      let signalUsed = null;
      let spawnError = null;

      child.on("error", (err) => {
        // e.g. ENOENT for a missing binary: spawn fails without ever emitting 'close'.
        spawnError = err;
        queue.close();
      });
      child.on("close", (code, signal) => {
        exitCode = code;
        signalUsed = signal;
        queue.close();
      });

      // Cancellation: ask politely, then kill. A cooperative flag is not enough -- an unattended
      // scheduled run must not be able to leave a child process behind.
      let killTimer = null;
      const onAbort = () => {
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), SIGKILL_GRACE_MS);
        killTimer.unref?.();
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        // Drain streamed events until the process closes.
        for await (const event of queue) yield event;

        if (spawnError) throw spawnError;
        if (ctx.signal?.aborted) throw new NodeCancelledError();

        if (stdoutTruncated || stderrTruncated) {
          yield {
            type: "log",
            level: "warn",
            message: `output truncated at ${MAX_CAPTURE_BYTES} bytes per stream`,
          };
        }

        // A non-zero exit is a node failure: silently continuing would let a broken chain report
        // success, which is worse than stopping.
        if (exitCode !== 0) {
          throw new Error(
            `command exited with ${signalUsed ? `signal ${signalUsed}` : `code ${exitCode}`}` +
              (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
          );
        }

        yield {
          type: "output",
          values: {
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode,
            truncated: stdoutTruncated || stderrTruncated,
          },
        };
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        clearTimeout(killTimer);
        // Belt and braces: never leave the tree running if we exit early for any reason.
        if (child.exitCode === null) killTree(child, "SIGKILL");
      }
    },

    /** Nothing pooled: each execution owns its child process, torn down in execute()'s finally. */
    async dispose() {},
  };
}
