/**
 * native execution engine: runs commands directly on the host (i.e. the original behavior of aiToolkit.mjs
 * before the refactor, moved over verbatim). Serves as both the default engine and the fallback engine:
 * whenever the qemu sandbox is unavailable or a single call fails and downgrades, everything routes here,
 * with behavior identical to the historical version.
 *
 * Engine contract (engine.mjs):
 *   run(cmd, { cwd, timeoutMs, maxBuffer })  → { stdout, stderr, code, killed } (does not throw)
 *   startBackground(cmd, { cwd })            → Promise<string> (formatted startup result text;
 *                                               maintains its own process table and broadcasts start/stop via events.mjs)
 *   stopProcess(pid) / listProcesses() / stopAll()
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

import { emitService } from "./events.mjs";

const execAsync = promisify(exec);

export const id = "native";

// Persistent background processes (dev server / watcher / etc.): pid → { command, url }. Used for display / stop / cleanup on exit.
const bgProcs = new Map();

/**
 * Decode console output. Windows commands like cmd/dir output in the OEM code page by default
 * (cp936/GBK on Chinese systems), so decoding directly as UTF-8 produces garbled text. Here we first
 * decode as UTF-8, and if the replacement character U+FFFD appears we fall back to GBK (gb18030),
 * taking whichever has fewer replacement characters, so both UTF-8 and GBK output are handled.
 */
export function decodeConsole(buf) {
  if (!buf || buf.length === 0) return "";
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!utf8.includes("�")) return utf8;
  try {
    const gbk = new TextDecoder("gb18030", { fatal: false }).decode(data);
    const bad = (s) => (s.match(/�/g) || []).length;
    return bad(gbk) <= bad(utf8) ? gbk : utf8;
  } catch {
    return utf8; // fall back to UTF-8 when the decoder isn't available at runtime
  }
}

/** Foreground execution: exec + timeout + output cap, returns decoded { stdout, stderr, code, killed }, does not throw. */
export async function run(cmd, { cwd, timeoutMs, maxBuffer } = {}) {
  try {
    // Read as raw bytes then decode per code page, to avoid garbled Chinese console output (cp936/GBK).
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      encoding: "buffer",
    });
    return { stdout: decodeConsole(stdout), stderr: decodeConsole(stderr), code: 0, killed: false };
  } catch (e) {
    // exec rejects on a non-zero exit code / timeout, but still carries stdout/stderr/code.
    return {
      stdout: decodeConsole(e.stdout),
      stderr: decodeConsole(e.stderr),
      code: e.code ?? "?",
      killed: !!e.killed,
    };
  }
}

/**
 * Start a command in the background without blocking: not killed by the 60s timeout. Captures early startup
 * output (returns early once a local address / readiness keyword appears, otherwise waits up to 8s) while the
 * process keeps running in the background. Returns the startup output + a pid hint.
 */
export function startBackground(cmd, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32", // on non-Windows, form its own process group to ease killing the whole tree
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve(`Background startup failed: ${e?.message || e}`);
      return;
    }
    const pid = child.pid;
    if (pid) bgProcs.set(pid, { command: cmd, url: "" });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 64 * 1024) buf = buf.subarray(-64 * 1024);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      if (pid) bgProcs.delete(pid);
      resolve(`Background startup failed: ${e?.message || e}`);
    });
    child.on("exit", () => {
      if (pid && bgProcs.has(pid)) {
        bgProcs.delete(pid);
        emitService({ type: "stopped", pid }); // process ended → notify the renderer to remove it
      }
    });
    child.unref?.();

    const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
    const startedAt = Date.now();
    // Extract the first local service address from the output (dev servers usually print one, e.g. http://localhost:8081).
    const pickUrl = (s) => {
      const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)\]]*/i);
      if (!m) return "";
      try {
        const u = new URL(m[0]);
        const host = u.hostname === "0.0.0.0" ? "localhost" : u.hostname;
        return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
      } catch {
        return m[0];
      }
    };
    const timer = setInterval(() => {
      const out = decodeConsole(buf);
      const exited = !pid || !bgProcs.has(pid);
      if (READY.test(out) || exited || Date.now() - startedAt > 8000) {
        clearInterval(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        const alive = pid && bgProcs.has(pid);
        const url = pickUrl(out);
        // Record the address and notify the renderer to display it (GlobalNotifications shows "running project + address + stop").
        if (alive) {
          bgProcs.set(pid, { command: cmd, url });
          emitService({ type: "started", pid, url, command: cmd });
        }
        // The first line gives a clear conclusion so the model can directly tell it "started successfully" instead of poring over the raw logs.
        const headline = alive
          ? `✅ Service started successfully in the background and is running${url ? `: ${url}` : ""}${pid ? ` (pid ${pid})` : ""}.`
          : "⚠️ Process has ended (possibly a one-off command, or it exited on startup).";
        resolve(
          `${headline}\n\n` +
            `--- Startup output ---\n${out.trim() || "(no output yet)"}\n` +
            (alive
              ? "\nNote: the service keeps running in the background; this call does not block and won't be killed by the timeout." +
                (url ? `You can open ${url} with openBrowser to preview it, or just tell the user it's "started". ` : "") +
                "Do not run the same startup command again, and do not wait for it to finish."
              : ""),
        );
      }
    }, 300);
  });
}

/** Stop a background process (by pid, killing the whole tree). Returns whether the stop was initiated. */
export function stopProcess(pid) {
  const n = Number(pid);
  if (!bgProcs.has(n)) return false;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(n), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-n, "SIGTERM");
    }
  } catch {
    /* may have already exited */
  }
  return true;
}

/** List the current background processes (for the renderer's initial sync). */
export function listProcesses() {
  return [...bgProcs.entries()].map(([pid, v]) => ({ pid, url: v.url || "", command: v.command || "" }));
}

/** Terminate all background processes (for cleanup on app exit). Windows uses taskkill to kill the whole tree, other platforms use the process group. */
export function stopAll() {
  for (const pid of bgProcs.keys()) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      /* ignore if already exited / no permission */
    }
  }
  bgProcs.clear();
}
