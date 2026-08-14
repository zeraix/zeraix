/**
 * native execution engine: runs commands directly on the host (i.e. the original behavior of aiToolkit.mjs
 * before the refactor, moved over verbatim). Serves as both the default engine and the fallback engine:
 * whenever the qemu sandbox is unavailable or a single call fails and downgrades, everything routes here,
 * with behavior identical to the historical version.
 *
 * Engine contract (engine.mjs):
 *   run(cmd, { cwd, timeoutMs, maxBuffer, signal })
 *                                            → { stdout, stderr, code, killed, canceled } (does not throw)
 *   startBackground(cmd, { cwd })            → Promise<string> (formatted startup result text;
 *                                               maintains its own process table and broadcasts start/stop via events.mjs)
 *   stopProcess(pid) / listProcesses() / stopAll()
 */

import { spawn } from "node:child_process";

import { emitService } from "./events.mjs";

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

/** Last few KB of a background process's output, decoded — what a completion notice reports back to the model. */
export function tailOf(buf, max = 4000) {
  const s = decodeConsole(buf).trim();
  return s.length > max ? `…\n${s.slice(-max)}` : s;
}

/**
 * Kill a command and everything it started.
 *
 * The tree, never the single pid: the command runs under a shell, and the work the user wants stopped is
 * usually the shell's descendants — `npm install` is node spawning node, `cargo build` is cargo spawning
 * rustc. Killing only the shell leaves those running with nobody waiting on them, which looks exactly like
 * the bug this is here to fix.
 *
 * Same mechanism as stopProcess below: taskkill /T on Windows, the negative pid (process group) elsewhere,
 * which is why the child is spawned detached on POSIX — a non-detached child shares THIS app's process
 * group, and killing that group would take the app down with it.
 */
function killTree(child, sig = "SIGTERM") {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-pid, sig);
    }
  } catch {
    // The group may be gone already (normal exit racing the kill), or was never created. Fall back to the
    // single pid so a command that did not fork is still stopped.
    try {
      child.kill(sig);
    } catch {
      /* already exited */
    }
  }
}

/** Foreground children still running, so app shutdown can take them down too (they are detached — see killTree). */
const fgChildren = new Set();

/** How long a stopped command is given to exit on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 2000;

/**
 * Foreground execution: exec + timeout + output cap, returns decoded { stdout, stderr, code, killed, canceled }, does not throw.
 *
 * `signal` is what makes the user's Stop button reach a running command. Node's own `signal` support on exec
 * is not enough: it rejects the promise but the child survives (verified — see test/command-cancel.test.mjs),
 * so a stopped `npm install` would carry on writing to node_modules while the UI claimed it had stopped.
 * The timeout goes through the same kill for the same reason.
 *
 * Whatever the command printed before it was cut off is still returned: it is often the most useful part, and
 * it is what the model needs to explain what happened. `canceled` distinguishes a user stop from the timeout,
 * which the caller words very differently.
 */
export function run(cmd, { cwd, timeoutMs, maxBuffer, signal } = {}) {
  // Nothing has been started yet, so there is nothing to kill and no output to report.
  if (signal?.aborted) {
    return Promise.resolve({ stdout: "", stderr: "", code: "?", killed: false, canceled: true });
  }
  return new Promise((resolve) => {
    let canceled = false;
    let timedOut = false;
    let timer = null;
    let hardTimer = null;
    let exitTimer = null;
    let done = false;
    // spawn, not exec, for one reason: exec drops the `detached` option (it forwards only its own fixed
    // option list to spawn), so its child stays in THIS app's process group. The whole-tree kill below
    // needs a group of our own — and with exec, `kill(-pid)` either fails with ESRCH or, if some unrelated
    // group happens to share the number, signals a process that has nothing to do with us.
    const child = spawn(cmd, {
      cwd,
      shell: true, // same shell exec used: /bin/sh here, ComSpec on Windows
      windowsHide: true,
      detached: process.platform !== "win32", // Windows has no process groups here; taskkill /T walks by pid
      stdio: ["ignore", "pipe", "pipe"],
    });
    fgChildren.add(child);

    // Collected as raw bytes and decoded per code page at the end, to avoid garbled Chinese console output
    // (cp936/GBK) — the same reason exec was given encoding:"buffer".
    const chunks = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    const collect = (which) => (d) => {
      if (maxBuffer && size[which] >= maxBuffer) return; // cap reached: keep the head, drop the rest
      size[which] += d.length;
      chunks[which].push(d);
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const settle = (code) => {
      if (done) return;
      done = true;
      fgChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (exitTimer) clearTimeout(exitTimer);
      signal?.removeEventListener("abort", onAbort);
      const join = (which) => {
        const buf = Buffer.concat(chunks[which]);
        return decodeConsole(maxBuffer && buf.length > maxBuffer ? buf.subarray(0, maxBuffer) : buf);
      };
      resolve({ stdout: join("stdout"), stderr: join("stderr"), code, killed: timedOut, canceled });
    };

    /** SIGTERM now, SIGKILL if it is still there after the grace — a process that ignores TERM must not hang the turn. */
    const stop = () => {
      killTree(child);
      if (!hardTimer) hardTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    function onAbort() {
      canceled = true;
      stop();
    }
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    // `close` (stdio drained) is preferred over `exit`, so no output is lost. But the pipes are inherited,
    // so a grandchild the command deliberately detached can hold them open after the shell is gone — and
    // waiting forever for that is its own hang. Take the exit and a short drain window as the fallback.
    child.on("close", (code, sig) => settle(code ?? (sig ? "?" : 0)));
    child.on("exit", (code, sig) => {
      if (!exitTimer && !done) exitTimer = setTimeout(() => settle(code ?? (sig ? "?" : 0)), 1000);
    });
    child.on("error", (e) => {
      chunks.stderr.push(Buffer.from(String(e?.message ?? e)));
      settle("?");
    });
  });
}

/**
 * Start a command in the background without blocking: not killed by the 60s timeout. Captures early startup
 * output (returns early once a local address / readiness keyword appears, otherwise waits up to 8s) while the
 * process keeps running in the background. Returns the startup output + a pid hint.
 */
export function startBackground(cmd, { cwd, notify } = {}) {
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
    if (pid) bgProcs.set(pid, { command: cmd, url: "", notify: !!notify });
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
    child.on("exit", (code, signal) => {
      if (pid && bgProcs.has(pid)) {
        bgProcs.delete(pid);
        // Still `stopped`, so the running-services indicator keeps working unchanged; the extra fields are
        // what a `notify` job needs — the model has to learn whether the install SUCCEEDED and what it said,
        // and a bare "the pid is gone" cannot answer either.
        emitService({
          type: "stopped",
          pid,
          reason: "exited",
          command: cmd,
          code: code ?? null,
          signal: signal ?? null,
          tail: tailOf(buf),
          notify: !!notify,
        });
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
        // The `data` handlers stay attached on purpose. They used to be removed here, which both threw away
        // the output a completion notice reports and left the pipes with no reader — a chatty process then
        // fills the OS pipe buffer and blocks on write. `buf` is capped at 64 KB above, so holding on costs
        // a bounded amount of memory for the life of the process.
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
  // Foreground commands too: they run detached (see killTree), so unlike before they would otherwise outlive
  // the app that started them — a `sleep 600` still holding its working directory after the window is gone.
  for (const child of fgChildren) killTree(child);
  fgChildren.clear();
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
