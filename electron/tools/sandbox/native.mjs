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
import {
  EVENT_RUNTIME_DISCONNECTED,
  onEvent,
  peekProcess,
  tryRunProcess,
  tryStartBackground,
} from "../rustRuntime.mjs";

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
export async function run(cmd, { cwd, timeoutMs, maxBuffer, signal } = {}) {
  // Nothing has been started yet, so there is nothing to kill and no output to report.
  if (signal?.aborted) {
    return { stdout: "", stderr: "", code: "?", killed: false, canceled: true };
  }
  // Rust Agent Runtime, Stage 2 (docs/agent-runtime-migration.md). This is the only hook the migration
  // adds to this file, and it is placed here rather than in the run_command handler on purpose: this
  // function is the engine contract, so both of its callers move at once -- the run_command tool and
  // runShell, which is what check_project runs every one of its probes through -- while the policy above
  // it stays exactly where it is. An automation *agent* node reaches this the same way, through
  // run_command; an automation *shell* node does not, having its own streaming spawn in
  // automation/runtimes/shell.mjs.
  //
  // The sidecar declines before it has started anything, and answers once it has. It never returns null
  // after the command may have run, because falling back would run it a second time. See tryRunProcess.
  const offloaded = await tryRunProcess(cmd, { cwd, timeoutMs, maxBuffer, signal });
  if (offloaded) return offloaded;
  return runOnNode(cmd, { cwd, timeoutMs, maxBuffer, signal });
}

/**
 * The Node implementation: the original body of `run`, unchanged.
 *
 * Kept rather than deleted for two reasons. It is the fallback whenever the sidecar is off, absent or
 * unreachable — which is every development run and every test — and it is the reference the A/B parity
 * harness diffs the Rust path against, so removing it would remove the thing that proves the replacement
 * behaves identically.
 */
function runOnNode(cmd, { cwd, timeoutMs, maxBuffer, signal } = {}) {
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
/** Readiness heuristics and the model-facing wording, shared by both implementations. */
const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;

/** How long to wait for a service to look ready before reporting whatever it has printed. */
const STARTUP_WINDOW_MS = 8000;
/** How often to re-read the startup output while waiting. */
const STARTUP_POLL_MS = 300;

/** Extract the first local service address from the output (dev servers usually print one, e.g. http://localhost:8081). */
function pickUrl(s) {
  const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)\]]*/i);
  if (!m) return "";
  try {
    const u = new URL(m[0]);
    const host = u.hostname === "0.0.0.0" ? "localhost" : u.hostname;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return m[0];
  }
}

/**
 * Wait for a just-started service to look ready, then describe it.
 *
 * Shared by the Node and runtime paths, which is the point: the readiness regex, the URL extraction and
 * every word below reach the model, so there is exactly one copy of them regardless of who spawned the
 * process. The two paths differ only in `read`, which answers "is it still running, and what has it
 * printed" -- from a local buffer, or from the sidecar.
 */
async function awaitStartup(pid, cmd, read) {
  const startedAt = Date.now();
  for (;;) {
    // Sleep first: the original polled on an interval, so the first look happened one tick in, and a
    // service is never ready at t=0 anyway.
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    const { alive, out } = await read();
    if (!READY.test(out) && alive && Date.now() - startedAt <= STARTUP_WINDOW_MS) continue;

    const url = pickUrl(out);
    // Record the address and notify the renderer to display it (GlobalNotifications shows "running project + address + stop").
    if (alive) {
      // Updated in place rather than replaced: the entry also carries `notify`, which the exit path
      // reads, and rebuilding it here used to drop that.
      const entry = bgProcs.get(pid);
      if (entry) entry.url = url;
      emitService({ type: "started", pid, url, command: cmd });
    }
    // The first line gives a clear conclusion so the model can directly tell it "started successfully" instead of poring over the raw logs.
    const headline = alive
      ? `✅ Service started successfully in the background and is running${url ? `: ${url}` : ""}${pid ? ` (pid ${pid})` : ""}.`
      : "⚠️ Process has ended (possibly a one-off command, or it exited on startup).";
    return (
      `${headline}\n\n` +
      `--- Startup output ---\n${out.trim() || "(no output yet)"}\n` +
      (alive
        ? "\nNote: the service keeps running in the background; this call does not block and won't be killed by the timeout." +
          (url ? `You can open ${url} with openBrowser to preview it, or just tell the user it's "started". ` : "") +
          "Do not run the same startup command again, and do not wait for it to finish."
        : "")
    );
  }
}

/**
 * Exits that arrived before the service they belong to was registered.
 *
 * A service can end before `startBackground` has recorded its pid, and it is not a rare case: the pid
 * and the exit can be written by the sidecar in one breath, reaching `onData` in a single chunk. Both
 * lines are then handled synchronously, and settling the start reply only SCHEDULES the caller's
 * continuation -- so the registration has not happened yet when the exit arrives.
 *
 * Bounded, because an entry here is only ever waiting for a caller that is a microtask away. Anything
 * that accumulates is for a pid nobody ever claimed, and the oldest is the safest to drop.
 */
const pendingExits = new Map();
const MAX_PENDING_EXITS = 64;

/** Report one ended service. False means its pid is not registered (yet). */
function reportExit({ pid, code, signal, output, command }) {
  const entry = bgProcs.get(pid);
  if (!entry) return false;
  bgProcs.delete(pid);
  emitService({
    type: "stopped",
    pid,
    reason: "exited",
    command: command ?? entry.command ?? "",
    code: code ?? null,
    signal: signal ?? null,
    // Clipped here rather than in the runtime, so the truncation notice a model reads is written in
    // one place. The runtime sends the whole trailing buffer.
    tail: tailOf(Buffer.from(String(output ?? ""), "utf8")),
    notify: !!entry.notify,
  });
  return true;
}

/**
 * A background process the Rust runtime owns has ended.
 *
 * The host cannot discover this on its own: `awaitStartup` stops polling once the service settles, so a
 * dev server that dies an hour later, or an install the user asked to be notified about, has no other
 * way to be noticed. Registered once at import; the bridge keeps it across a sidecar restart.
 */
onEvent("process.exited", (payload) => {
  if (reportExit(payload)) return;
  // Too early rather than unwanted -- see `pendingExits`. Dropping it here would leave the service in
  // the listing for good: nothing else ever reports an exit, so the indicator would keep offering to
  // stop a pid that owns nothing and a notify job would wait for a notice that never comes.
  pendingExits.set(payload.pid, payload);
  if (pendingExits.size > MAX_PENDING_EXITS) {
    pendingExits.delete(pendingExits.keys().next().value);
  }
});

/**
 * The sidecar went away, taking its background services with it.
 *
 * Its children are killed when it dies, so those services are genuinely gone -- but no `process.exited`
 * can arrive to say so. Left alone, the running-services indicator would keep offering to stop pids that
 * no longer exist. Reported as `exited` with no code, which is what "it is gone and we cannot say how"
 * already means everywhere else in this contract.
 */
onEvent(EVENT_RUNTIME_DISCONNECTED, () => {
  pendingExits.clear();
  for (const [pid, entry] of [...bgProcs.entries()]) {
    if (!entry.remote) continue;
    bgProcs.delete(pid);
    emitService({
      type: "stopped",
      pid,
      reason: "exited",
      command: entry.command ?? "",
      code: null,
      signal: null,
      tail: "",
      notify: !!entry.notify,
    });
  }
});

/**
 * Start a command in the background without blocking: not killed by the 60s timeout. Captures early startup
 * output (returns early once a local address / readiness keyword appears, otherwise waits up to 8s) while the
 * process keeps running in the background. Returns the startup output + a pid hint.
 */
export async function startBackground(cmd, { cwd, notify } = {}) {
  // Rust Agent Runtime, Stage 2b. The runtime owns the process -- spawning it, reading it, reaping it --
  // while everything a model or a user sees stays here. It declines before anything has started, so a
  // fallback costs nothing and starts nothing twice.
  const offloaded = await tryStartBackground(cmd, { cwd });
  if (offloaded) {
    const { pid } = offloaded;
    bgProcs.set(pid, { command: cmd, url: "", notify: !!notify, remote: true });
    // The service may already have ended -- possibly reported before this line ran. Draining here is
    // what closes that window; `awaitStartup` then sees a process that is not alive and says so.
    const early = pendingExits.get(pid);
    if (early) {
      pendingExits.delete(pid);
      reportExit(early);
    }
    return awaitStartup(pid, cmd, async () => {
      const seen = await peekProcess(pid);
      // A failed peek is "cannot see it this tick", not "it is gone": the 8s ceiling above bounds the
      // wait anyway, and treating a transient failure as an exit would report a healthy dev server as
      // having died on startup.
      if (!seen) return { alive: bgProcs.has(pid), out: "" };
      return { alive: seen.alive, out: seen.output };
    });
  }
  return startBackgroundOnNode(cmd, { cwd, notify });
}

/**
 * The Node implementation, unchanged apart from the settle loop it now shares.
 *
 * Kept for the same two reasons as `runOnNode`: it serves every build where the sidecar is off or
 * absent, and it is the reference the parity harness compares against.
 */
function startBackgroundOnNode(cmd, { cwd, notify } = {}) {
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
        const entry = bgProcs.get(pid);
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
          notify: !!entry?.notify,
        });
      }
    });
    child.unref?.();

    // The `data` handlers stay attached on purpose. They used to be removed once startup settled, which both
    // threw away the output a completion notice reports and left the pipes with no reader — a chatty process
    // then fills the OS pipe buffer and blocks on write. `buf` is capped at 64 KB above, so holding on costs
    // a bounded amount of memory for the life of the process.
    resolve(
      awaitStartup(pid, cmd, () => ({
        alive: Boolean(pid) && bgProcs.has(pid),
        out: decodeConsole(buf),
      })),
    );
  });
}

/**
 * Stop one background service by pid.
 *
 * Unchanged by the migration, and deliberately not routed through the sidecar even for a service the
 * sidecar started. A pid and its process group are the operating system's, not the spawner's: the
 * runtime starts every service in its own group, so the same signal reaches it whoever sends it. The
 * runtime's reaper still notices the exit and reports it back, so the bookkeeping is identical either
 * way -- and this stays synchronous, which `ipcMain.handle("ai-tools:stop-process")` and the
 * `stop_service` tool both rely on.
 */
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
