/**
 * Host bridge to the Rust Agent Runtime sidecar.
 *
 * See docs/agent-runtime-migration.md. The runtime is migrating out of this process one stage at a
 * time; this module is the seam it arrives through. It owns three things and deliberately nothing else:
 * spawning the sidecar, speaking its protocol, and deciding — per call — whether the sidecar or the
 * existing JS handler serves a tool.
 *
 * ## Why a child process rather than a native addon
 *
 * A panic in a sidecar costs one restart of the sidecar. A panic in a NAPI addon takes down the main
 * process and every open conversation with it. A separate process also keeps the binary free of any
 * Electron ABI coupling, which this repo already pays for once with node-pty (electron-rebuild in dev,
 * asarUnpack when packaging) and explicitly avoided a second time by choosing node:sqlite over
 * better-sqlite3 -- see the header of electron/automation/db.mjs.
 *
 * ## Fail open, always
 *
 * Every failure mode here -- binary missing, spawn refused, protocol mismatch, crash mid-call, a tool
 * the runtime does not implement -- resolves to `null`, which means "the JS handler serves this call".
 * The runtime can therefore be absent, broken, or a version behind, and the app behaves exactly as it
 * did before it existed. That property is what makes the default below safe: a PACKAGED app now runs the
 * sidecar by default, while development and the test harness stay on the JS handlers. See flagState().
 *
 * ## Except once a command is running: then never fall back (Stage 2)
 *
 * Falling back means running the call again on the JS path, and `tryRunTool`'s tools are read-only, so
 * running one twice costs a little time and nothing else. `tryRunProcess` is not that. Re-running
 * `npm install`, `git push` or `rm -rf build` because the sidecar died halfway through executing it is
 * a second execution of a side effect the user asked for once.
 *
 * So the fallback rule is split by WHEN the failure happens, not by what it is. Before the request is
 * written -- runtime off, missing binary, feature absent, dead pipe -- nothing has run, and the answer
 * is `null` exactly as everywhere else. After it is written, the command may have run, so every outcome
 * resolves to a RESULT: the sidecar's own answer, or a synthesised failure that reports what went wrong
 * on stderr with a `"?"` exit code, which is the shape the JS path already returns when a child could
 * not start. The model sees a command that failed, never a command that silently happened twice.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** Protocol version this host speaks. Must satisfy the runtime's compatibility rule (same major, minor <= runtime's). */
const PROTOCOL_VERSION = "1.0";

/** A call the sidecar has not answered in this long is not going to help the turn it belongs to. */
const CALL_TIMEOUT_MS = 180_000;
/** Handshake budget. Generous: a cold binary on a slow disk still has to be paged in. */
const INIT_TIMEOUT_MS = 10_000;
/**
 * Consecutive spawn failures after which we stop trying for the rest of the session.
 *
 * Without this, a runtime that crashes on startup would be respawned on every single tool call --
 * turning a broken sidecar into a fork bomb that is slower than not having it at all.
 */
const MAX_SPAWN_FAILURES = 3;

/**
 * Is this a PACKAGED app, as opposed to `electron .` in development or a plain node process?
 *
 * Deliberately NOT `app.isPackaged`. This module imports node builtins and nothing else, because it is
 * loaded outside Electron in two places that matter: the test suite reaches it through aiToolkit.mjs, and
 * scripts/ab-runtime-parity.mjs imports it directly to drive both implementations. An
 * `import { app } from "electron"` here would break each of them, and the breakage would look like a
 * module-resolution error a long way from this decision.
 *
 * The two signals below cover the three environments exactly. `process.versions.electron` is absent under
 * plain node, so the harness and the tests answer false. `process.defaultApp` is set only when Electron was
 * launched with a path argument — which is what `electron .` does and what a packaged binary never does.
 * Packaged is therefore the one combination of "running under Electron" and "not launched as a dev app".
 */
function isPackaged() {
  return Boolean(process.versions.electron) && !process.defaultApp;
}

/**
 * Feature flag. Default ON in a packaged app, OFF in development and under plain node.
 *
 * The default flipped once the fail-open property below had been demonstrated rather than assumed: a
 * missing binary, a refused spawn, a protocol mismatch, a crash mid-call and an unimplemented tool all
 * resolve to `null`, which routes the call to the JS handler. Turning it on by default therefore changes
 * which implementation SERVES a call, never whether the call is served.
 *
 * Development stays off so that `npm run electron:dev` keeps exercising the JS handlers — they remain the
 * reference implementation the parity harness diffs against, and a dev build that silently used the
 * sidecar would stop testing them. `npm run electron:dev:rust` opts in.
 *
 * The env var overrides the default in BOTH directions, which is the point of recognising the off values:
 * a packaged build now runs the sidecar by default, so there has to be a way to turn it off in the field
 * without shipping a new installer. `ZERAIX_RUST_RUNTIME=off` is that switch.
 *
 * `shadow` used to be accepted here and returned as its own state, described as "run both, compare, still
 * return the JS answer". Nothing implemented that, and `ensureStarted` only refuses on `"off"` — so the
 * value behaved EXACTLY like `on`: real calls went to the sidecar and the sidecar's answer was returned.
 * A flag whose safest-sounding setting silently enables the thing is worse than no flag, so it is refused
 * outright and says why. Shadow comparison lives in scripts/ab-runtime-parity.mjs, which runs both
 * implementations against the same tree and diffs every byte.
 */
function flagState() {
  const raw = String(process.env.ZERAIX_RUST_RUNTIME ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "on" || raw === "true") return "on";
  if (raw === "0" || raw === "off" || raw === "false") return "off";
  if (raw === "shadow") {
    console.warn(
      "[rust-runtime] ZERAIX_RUST_RUNTIME=shadow is not implemented and is being treated as OFF. " +
        "For a side-by-side comparison run scripts/ab-runtime-parity.mjs.",
    );
    return "off";
  }
  return isPackaged() ? "on" : "off";
}

/** Where the compiled sidecar lives: packaged beside the app, or in the cargo target dir during development. */
function binaryPath() {
  const exe = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";
  const override = process.env.ZERAIX_RUST_RUNTIME_BIN;
  if (override) return override;
  const candidates = [
    // Packaged: electron-builder places it under resources/.
    path.join(process.resourcesPath ?? "", "runtime", exe),
    // Development: whichever profile was built last.
    path.join(process.cwd(), "runtime", "target", "release", exe),
    path.join(process.cwd(), "runtime", "target", "debug", exe),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

let state = null; // { child, pending, buffer, tools, features, nextId, ready }
let callSeq = 0;
let spawnFailures = 0;
let disabled = false;

/**
 * Handlers for runtime→host events, by method name.
 *
 * Registered on the module rather than per connection, because they must survive a sidecar restart:
 * the caller that cares about `process.exited` (native.mjs) subscribes once at import time, and a
 * runtime that crashed and came back has to keep reaching it.
 */
const eventHandlers = new Map();

/**
 * Subscribe to one runtime event.
 *
 * Deliberately one handler per method rather than a list. Every event this protocol has is a fact
 * about a specific process that exactly one place in the host is responsible for acting on, and a
 * fan-out would make "who removed this service from the registry" ambiguous.
 */
export function onEvent(method, handler) {
  eventHandlers.set(method, handler);
}

/**
 * Handlers for runtime→host REQUESTS, by method name.
 *
 * A request differs from an event in one way that matters: the runtime is waiting. Every path below
 * therefore ends in a reply, including the paths where something went wrong.
 */
const requestHandlers = new Map();

/**
 * Answer requests the runtime makes.
 *
 * The handler returns a value, which becomes the reply; throwing sends an error instead. Registered
 * per method for the same reason events are: exactly one part of the host is responsible for a given
 * question, and a fan-out would make "who answered" ambiguous.
 */
export function onRequest(method, handler) {
  requestHandlers.set(method, handler);
  return () => requestHandlers.delete(method);
}

/**
 * Run one inbound request and reply.
 *
 * An unregistered method is answered with an error rather than ignored, and that choice is the whole
 * point of this function. The runtime blocks a delegation on its answer for up to thirty minutes, so
 * silence would not read as "no handler" — it would read as a sub-agent that ran for half an hour. A
 * prompt error surfaces as one failed delegation, which is both true and actionable.
 */
async function serveRuntimeRequest(s, msg) {
  const reply = (body) => {
    try {
      s.child.stdin.write(`${JSON.stringify({ id: msg.id, ...body })}\n`);
    } catch {
      /* the sidecar is gone; its own teardown fails everything that was waiting */
    }
  };
  const handler = requestHandlers.get(msg.method);
  if (!handler) {
    reply({ error: `the host has no handler for ${msg.method}` });
    return;
  }
  try {
    reply({ result: (await handler(msg.params ?? {})) ?? null });
  } catch (e) {
    reply({ error: e?.message ?? String(e) });
  }
}

/**
 * Hold the event loop open only while a call is actually outstanding.
 *
 * A spawned child and its three pipes are ref'd handles, so an idle sidecar keeps its host process
 * alive indefinitely. Electron does not care — the app is running anyway and `shutdown()` runs on quit
 * — but any short-lived node process that touches this module inherits it: `npm test` and the parity
 * harness would each run to completion and then hang until something killed the sidecar. Measured
 * before this existed: a 2.7-second test file took 146 seconds to exit, and only because the sidecar
 * was killed by hand.
 *
 * Unref'ing unconditionally is the wrong fix in the other direction: with nothing else pending, node
 * would exit while a reply was still in flight and the call would simply never settle. A promise is not
 * a handle and does not hold the loop open by itself. So the refs follow the in-flight count, which is
 * exactly the condition "someone is waiting for this process to answer".
 *
 * The sidecar needs no signal when the host exits without one: stdin reaches EOF, `recv()` returns
 * None, and its request loop breaks — which is the same path `runtime.shutdown` takes.
 */
function updateRefs(s) {
  const busy = s.pending.size > 0;
  for (const handle of [s.child, s.child.stdin, s.child.stdout, s.child.stderr]) {
    try {
      if (busy) handle?.ref?.();
      else handle?.unref?.();
    } catch {
      /* a closed handle has nothing to hold open */
    }
  }
}

/**
 * Method name for the local event fired when the sidecar goes away.
 *
 * Not a wire event — there is nobody left to send one. It exists because a dying runtime takes its
 * background services with it (a child is killed when its handle drops), and no `process.exited` can
 * be delivered for them. Without this the host would keep showing services that no longer exist, and
 * the stop button would signal pids belonging to nothing.
 */
export const EVENT_RUNTIME_DISCONNECTED = "runtime.disconnected";

/** Tear down the current sidecar. Pending calls are rejected so no caller waits on a dead process. */
function teardown(reason) {
  const s = state;
  state = null;
  if (!s) return;
  if (s.ready) {
    // Only for a runtime that was actually serving: a failed handshake never started anything.
    try {
      eventHandlers.get(EVENT_RUNTIME_DISCONNECTED)?.({ reason });
    } catch (e) {
      console.warn("[rust-runtime] disconnect handler failed:", e?.message ?? e);
    }
  }
  for (const [, entry] of s.pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  s.pending.clear();
  updateRefs(s);
  try {
    s.child.kill();
  } catch {
    /* already gone */
  }
}

/** Parse whatever complete lines have arrived and settle the calls they answer. */
function onData(s, chunk) {
  s.buffer += chunk;
  let idx;
  while ((idx = s.buffer.indexOf("\n")) >= 0) {
    const line = s.buffer.slice(0, idx).trim();
    s.buffer = s.buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // The sidecar writes diagnostics to stderr, so anything unparseable on stdout is a bug in it.
      // Logged rather than fatal: one bad line must not strand every later call.
      console.warn("[rust-runtime] unparseable line on stdout:", line.slice(0, 200));
      continue;
    }
    // A method AND an id is a REQUEST from the runtime: it wants an answer. This is the direction
    // that lets the runtime own a decision while the host owns the work behind it -- scheduling a
    // sub-agent here, asking for consent later. See `onRequest`.
    if (msg.method && msg.id !== undefined) {
      void serveRuntimeRequest(s, msg);
      continue;
    }
    // An inbound message with a method and no id is an EVENT from the runtime, not a reply. This
    // direction exists for one thing the host cannot discover on its own: a background service that
    // ends after the caller stopped polling it. See `onEvent`.
    if (msg.method && msg.id === undefined) {
      const handler = eventHandlers.get(msg.method);
      if (!handler) {
        // Not an error. A runtime newer than this host may push events it has never heard of, and
        // ignoring them is exactly what the versioning scheme promises.
        continue;
      }
      try {
        handler(msg.params ?? {});
      } catch (e) {
        // A throwing handler must not strand the reply parsing for everything after it.
        console.warn(`[rust-runtime] ${msg.method} handler failed:`, e?.message ?? e);
      }
      continue;
    }
    const entry = s.pending.get(String(msg.id));
    if (!entry) continue;
    s.pending.delete(String(msg.id));
    updateRefs(s);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(Object.assign(new Error(msg.error.message ?? "runtime error"), { runtimeError: msg.error }));
    else entry.resolve(msg.result);
  }
}

/**
 * Send one request and await its reply.
 *
 * `timeoutMs` of 0 means no deadline. That exists for `process.run`, whose own timeout is the real
 * bound and can legitimately exceed any fixed one here: `CMD_FETCH_TIMEOUT_MS` is 10 minutes, so a
 * flat 180-second call timeout would abandon a download that was working — and abandoning it is not
 * free, because the caller would then fall back and run it a second time.
 */
function request(s, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++s.nextId;
    const timer = timeoutMs
      ? setTimeout(() => {
          s.pending.delete(String(id));
          updateRefs(s);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
    s.pending.set(String(id), { resolve, reject, timer });
    updateRefs(s);
    try {
      s.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (e) {
      s.pending.delete(String(id));
      updateRefs(s);
      clearTimeout(timer);
      // Marked so a caller can tell "never left this process" from "may have executed". For
      // process.run that difference decides whether re-running the command is safe -- see the header.
      reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { notSent: true }));
    }
  });
}

/** Fire-and-forget notification (no id, no reply). Used for cancel and cache invalidation. */
function notify(s, method, params) {
  try {
    s.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  } catch {
    /* the sidecar is gone; the caller's own teardown path will notice */
  }
}

/** Spawn and handshake. Returns the live state, or null if the runtime is unavailable for any reason. */
async function ensureStarted() {
  if (disabled || flagState() === "off") return null;
  if (state?.ready) return state;
  if (state) return null; // a start is already in flight; this call uses the JS handler

  const bin = binaryPath();
  if (!bin) {
    disabled = true; // not built -- there is nothing to retry
    return null;
  }

  let child;
  try {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    if (++spawnFailures >= MAX_SPAWN_FAILURES) disabled = true;
    console.warn("[rust-runtime] spawn failed:", e?.message ?? e);
    return null;
  }

  const s = { child, pending: new Map(), buffer: "", tools: new Set(), features: new Set(), nextId: 0, ready: false };
  state = s;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => onData(s, d));
  // The sidecar's own logs. Surfaced rather than swallowed: a silent sidecar that quietly falls back
  // on every call would look like "the Rust runtime is doing nothing" and be invisible to diagnose.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[rust-runtime] ${d}`));
  child.on("exit", (code, signal) => {
    if (state === s) teardown(`runtime exited (code=${code} signal=${signal ?? "-"})`);
    if (code !== 0 && ++spawnFailures >= MAX_SPAWN_FAILURES) {
      disabled = true;
      console.warn(`[rust-runtime] disabled after ${spawnFailures} failures`);
    }
  });
  child.on("error", (e) => {
    if (state === s) teardown(`runtime error: ${e?.message ?? e}`);
  });

  try {
    const init = await request(
      s,
      "runtime.initialize",
      { protocol_version: PROTOCOL_VERSION, client: "zeraix-electron" },
      INIT_TIMEOUT_MS,
    );
    for (const name of init?.tools ?? []) s.tools.add(name);
    // Feature-detected rather than inferred from the version: an additive protocol bump still
    // negotiates against an older binary, so the version alone cannot say whether process.run is there.
    for (const name of init?.features ?? []) s.features.add(name);
    s.ready = true;
    spawnFailures = 0;
    console.info(
      `[rust-runtime] ready -- protocol ${init?.protocol_version}, ${s.tools.size} tool(s)` +
        (s.features.size ? `, features: ${[...s.features].join(", ")}` : ""),
    );
    return s;
  } catch (e) {
    // A version mismatch lands here too, which is the point of negotiating: the host falls back
    // cleanly instead of failing somewhere deep in a turn.
    console.warn("[rust-runtime] handshake failed:", e?.message ?? e);
    teardown("handshake failed");
    if (++spawnFailures >= MAX_SPAWN_FAILURES) disabled = true;
    return null;
  }
}

/**
 * Try to serve a tool call from the Rust runtime.
 *
 * Returns `{ ok, content }` on success, or **null** meaning "not served -- use the JS handler". Null is
 * returned for every failure mode there is, deliberately: the caller has a working implementation, so
 * there is never a reason to surface an infrastructure problem to the model as a tool failure.
 *
 * `tool.unsupported_pattern` is the one *expected* fallback rather than a fault: Rust's regex crate has
 * no backreferences or lookaround, so a pattern using them is valid in the JS handler and uncompilable
 * here. See the header of search_in_files.rs.
 */
export async function tryRunTool(name, args, { signal, workdir, callId } = {}) {
  const s = await ensureStarted();
  if (!s || !s.tools.has(name)) return null;
  if (!workdir) return null; // no workspace to scope the call to

  // Minted here when the caller has no handle of its own. runTool's signature carries a signal but no
  // id, and the id exists only so an abort can name the call it is aborting -- so generating it locally
  // keeps cancellation working without threading a new argument through every caller.
  const id = callId ?? `h${++callSeq}`;
  const onAbort = () => notify(s, "tool.cancel", { call_id: id });
  if (signal?.aborted) return { ok: false, content: "The user stopped this operation before it started." };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await request(
      s,
      "tool.call",
      { name, args: args ?? {}, workdir, call_id: id },
      CALL_TIMEOUT_MS,
    );
    if (!res) return null;
    // A capability gap in the Rust tool: fall back rather than reporting a failure the JS path
    // would not have produced.
    if (res.error?.code === "tool.unsupported_pattern") return null;
    return { ok: Boolean(res.ok), content: String(res.content ?? "") };
  } catch (e) {
    console.warn(`[rust-runtime] ${name} fell back to the JS handler:`, e?.message ?? e);
    return null;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Grace added to a command's own timeout before the IPC call gives up on it.
 *
 * The sidecar kills on the deadline, waits `KILL_GRACE` (2s) for SIGTERM, escalates to SIGKILL, then
 * drains the pipes (1s). This has to outlast all of that plus a reply, or the host would abandon a call
 * the runtime was about to answer correctly.
 */
const PROCESS_REPLY_GRACE_MS = 15_000;

/**
 * Try to run one foreground command in the Rust runtime.
 *
 * Returns the engine-contract result `{ stdout, stderr, code, killed, canceled }`, or **null** meaning
 * "not served -- run it on Node". Null is only ever returned for a failure that happened BEFORE the
 * command could have started; see the module header for why that distinction is the whole safety
 * argument for this function.
 *
 * The caller is `run()` in electron/tools/sandbox/native.mjs. Everything above that function -- the
 * run_command guardrails, engine selection, the sandbox fallback, the timeout wording -- is untouched
 * and stays in JS.
 */
export async function tryRunProcess(command, { cwd, timeoutMs, maxBuffer, signal, callId } = {}) {
  const s = await ensureStarted();
  if (!s || !s.features.has("process.run")) return null;

  const id = callId ?? `p${++callSeq}`;
  const onAbort = () => notify(s, "call.cancel", { call_id: id });
  // Nothing has been spawned yet, so this is still a pre-dispatch failure: let the caller handle an
  // already-aborted signal the way it always has.
  if (signal?.aborted) return null;
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const r = await request(
      s,
      "process.run",
      {
        command,
        cwd: cwd ?? null,
        timeout_ms: timeoutMs ?? null,
        max_buffer: maxBuffer ?? null,
        call_id: id,
      },
      // The command's own timeout is the real bound. Without one, wait indefinitely rather than
      // impose a deadline the JS path does not have.
      timeoutMs ? timeoutMs + PROCESS_REPLY_GRACE_MS : 0,
    );
    if (!r) throw new Error("empty reply");
    return {
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      code: r.code ?? "?",
      killed: Boolean(r.killed),
      canceled: Boolean(r.canceled),
    };
  } catch (e) {
    const why = e?.message ?? String(e);
    if (e?.notSent) {
      // The write itself failed, so the request never left this process and nothing ran.
      console.warn(`[rust-runtime] process.run not dispatched, running on Node instead: ${why}`);
      return null;
    }
    // It may have run. Report a failure rather than handing the caller a null that would re-run it.
    console.warn(`[rust-runtime] process.run failed after dispatch: ${why}`);
    return {
      stdout: "",
      stderr: `The command could not be completed by the agent runtime: ${why}`,
      code: "?",
      killed: false,
      canceled: Boolean(signal?.aborted),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Start a long-lived service in the Rust runtime.
 *
 * Returns `{ pid }`, or **null** meaning "not served — start it on Node". Unlike `tryRunProcess` there
 * is no post-dispatch hazard to reason about: a service that failed to start left nothing running, and
 * the runtime reports that as an error rather than a pid.
 *
 * What this deliberately does NOT do is decide when the service is *ready*. The caller polls
 * `peekProcess` and applies its own readiness patterns — see the header of `background.rs`.
 */
export async function tryStartBackground(command, { cwd } = {}) {
  const s = await ensureStarted();
  if (!s || !s.features.has("process.background")) return null;
  try {
    const r = await request(s, "process.start_background", { command, cwd: cwd ?? null }, CALL_TIMEOUT_MS);
    return r?.pid ? { pid: r.pid } : null;
  } catch (e) {
    // A spawn refusal arrives here as a structured error. Returning null hands the attempt to Node,
    // which will fail the same way and word it the way the model already expects.
    console.warn("[rust-runtime] process.start_background fell back to Node:", e?.message ?? e);
    return null;
  }
}

/** What a runtime-owned service has printed so far: `{ alive, output }`, or null if unreachable. */
export async function peekProcess(pid) {
  const s = await ensureStarted();
  if (!s || !s.features.has("process.background")) return null;
  try {
    const r = await request(s, "process.peek", { pid }, CALL_TIMEOUT_MS);
    return r ? { alive: Boolean(r.alive), output: String(r.output ?? "") } : null;
  } catch {
    // Treated as "cannot see it" rather than "it is gone": the caller's poll loop has its own 8s
    // ceiling, so a transient failure costs one tick instead of a wrong verdict.
    return null;
  }
}

/**
 * Sub-agent scheduling in the runtime.
 *
 * The division: the runtime decides *whether, when and how many* — ordering, coalescing, the per-turn
 * cap, the process-global concurrency limit, and the cancellation tree. The host decides *what a
 * sub-agent says*, because that means holding a model conversation. The runtime asks for that through
 * `subagent.run`, which a caller answers by registering a handler with `onRequest`.
 *
 * Each returns null when the runtime cannot serve the call, which means the caller keeps its own
 * scheduler. Nothing has been started at that point, so there is no half-scheduled state to unwind.
 */
export async function subagentSpawn(turn, jobs) {
  const s = await ensureStarted();
  if (!s || !s.features.has("subagent.scheduler")) return null;
  try {
    return await request(s, "subagent.spawn", { turn, jobs }, CALL_TIMEOUT_MS);
  } catch (e) {
    console.warn("[rust-runtime] subagent.spawn failed:", e?.message ?? e);
    return null;
  }
}

/**
 * Wait for delegations to settle.
 *
 * No IPC deadline: `timeoutMs` is the runtime's own bound on the wait and can legitimately be the full
 * 30-minute ceiling, so imposing a shorter one here would abandon a join that was working — the same
 * reasoning as `process.run`.
 */
export async function subagentJoin(turn, { ids = [], mode = "all", timeoutMs, block = true } = {}) {
  const s = await ensureStarted();
  if (!s || !s.features.has("subagent.scheduler")) return null;
  try {
    return await request(
      s,
      "subagent.join",
      { turn, ids, mode, timeout_ms: timeoutMs ?? null, block },
      timeoutMs ? timeoutMs + PROCESS_REPLY_GRACE_MS : 0,
    );
  } catch (e) {
    console.warn("[rust-runtime] subagent.join failed:", e?.message ?? e);
    return null;
  }
}

/** Stop every delegation in a turn. */
export async function subagentCancel(turn, reason) {
  const s = state;
  if (!s?.ready || !s.features.has("subagent.scheduler")) return;
  try {
    await request(s, "subagent.cancel", { turn, reason: reason ?? null }, 10_000);
  } catch {
    /* a turn being torn down does not need to hear about this */
  }
}

/**
 * Whether the runtime is available and serves a named capability.
 *
 * Starts the sidecar if it is not running, so a caller that asks gets a real answer rather than "not
 * yet". False whenever the runtime is off, absent, or older than the feature — which is exactly when
 * the caller should keep doing whatever it did before.
 */
export async function hasFeature(name) {
  const s = await ensureStarted();
  return Boolean(s?.features.has(name));
}

/**
 * Hand one stdio MCP server to the runtime to own.
 *
 * Returns true once the supervisor is running — NOT once the server is ready. Readiness, failure and
 * every later transition arrive as `mcp.state` events, which is the only arrangement compatible with
 * `listMcpTools()` staying synchronous.
 *
 * `env` is the child's complete environment and the host's responsibility: it is built from the MCP
 * SDK's allowlist precisely to keep `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` out of a node-based
 * server, and the sidecar carries both.
 */
export async function mcpConnect({ id, command, args, cwd, env, url, headers }) {
  const s = await ensureStarted();
  // A local program and a remote endpoint are separate capabilities: a runtime that serves one may not
  // serve the other, and routing on the wrong one is how a server silently stops connecting.
  const needed = url ? "mcp.http" : "mcp.stdio";
  if (!s || !s.features.has(needed)) return false;
  try {
    await request(
      s,
      "mcp.connect",
      url
        ? { id, url, headers: Object.entries(headers ?? {}) }
        : { id, command, args: args ?? [], cwd: cwd ?? null, env: Object.entries(env ?? {}) },
      CALL_TIMEOUT_MS,
    );
    return true;
  } catch (e) {
    console.warn(`[rust-runtime] mcp.connect(${id}) failed:`, e?.message ?? e);
    return false;
  }
}

/**
 * Call one tool on a runtime-owned server.
 *
 * Returns the server's reply **untouched** (`{ delivered, raw }`), or null if the runtime could not be
 * reached at all. The caller converts: the `[server]` description prefix, the schema normalisation and
 * the content flattening are all its own, and keeping them there is what stops the declarations and
 * results a model sees from shifting under this migration.
 */
export async function mcpCall(server, tool, args, { signal } = {}) {
  const s = await ensureStarted();
  if (!s || !s.features.has("mcp.stdio")) return null;

  const id = `m${++callSeq}`;
  const onAbort = () => notify(s, "call.cancel", { call_id: id });
  if (signal?.aborted) return { delivered: false, error: "the user stopped this operation" };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await request(s, "mcp.call", { server, tool, args: args ?? {}, call_id: id }, CALL_TIMEOUT_MS);
    return r ?? null;
  } catch (e) {
    // Unlike a command, an MCP call has no "it may already have run" hazard worth protecting: the
    // caller's fallback is its own SDK connection, which this server does not have. Report it.
    return { delivered: false, error: e?.message ?? String(e) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Stop supervising one server. */
export async function mcpDisconnect(id) {
  const s = state;
  if (!s?.ready || !s.features.has("mcp.stdio")) return false;
  try {
    const r = await request(s, "mcp.disconnect", { id }, 10_000);
    return Boolean(r?.disconnected);
  } catch {
    return false;
  }
}

/**
 * Tell the runtime a workspace's file list is stale.
 *
 * Needed only while the two runtimes share a tree: the JS handlers still own every mutating tool, so
 * the Rust side cannot know a file was created or deleted. Once those tools migrate, each reports the
 * invalidation itself and this goes away.
 */
export function invalidateFileList(workdir) {
  const s = state;
  if (s?.ready) notify(s, "workspace.invalidate", { workdir: workdir ?? null });
}

/**
 * Start the sidecar at app boot and say — once, plainly — what happened.
 *
 * Without this the bridge is invisible. `ensureStarted` is lazy, so nothing happens until the first tool
 * call, and every failure path returns null so the app keeps working with no indication that the runtime
 * it was told to use is absent. "Is Rust actually serving my calls?" then has no answer short of reading
 * a usage log, which is how you end up believing a flag took effect when it did not.
 *
 * Safe to call unconditionally: with the flag off it prints one line and starts nothing.
 */
export async function warmUp() {
  const flag = flagState();
  if (flag === "off") {
    const bin = binaryPath();
    // Name the actual reason. "Unset" stopped being the only way to be off once packaged builds began
    // defaulting to on: an operator who set ZERAIX_RUST_RUNTIME=off to chase a bug needs to see that
    // their override is the thing in effect, not a default they would then go looking for.
    const why = process.env.ZERAIX_RUST_RUNTIME ? "ZERAIX_RUST_RUNTIME=off" : "development build";
    console.info(
      bin
        ? `[rust-runtime] disabled (${why}) — a built binary is present; \`npm run electron:dev:rust\` enables it`
        : `[rust-runtime] disabled (${why}, no binary built)`,
    );
    return { enabled: false, ready: false, tools: [] };
  }

  const bin = binaryPath();
  if (!bin) {
    console.warn(
      "[rust-runtime] ENABLED but no binary found — run `npm run build:runtime`. " +
        "Every tool call will fall back to the JS handlers.",
    );
    return { enabled: true, ready: false, tools: [] };
  }

  const s = await ensureStarted();
  if (!s) {
    console.warn(`[rust-runtime] ENABLED but could not start ${bin} — falling back to the JS handlers.`);
    return { enabled: true, ready: false, tools: [] };
  }
  const tools = [...s.tools];
  const features = [...s.features];
  console.info(`[rust-runtime] ACTIVE — ${bin}`);
  console.info(`[rust-runtime] serving ${tools.length} tool(s): ${tools.join(", ")}`);
  if (features.includes("process.run")) {
    // Worth its own line: this one does not appear in the tool list, because it is not a tool. It is
    // the execution engine underneath run_command and check_project, so "which runtime ran my command"
    // has no other answer short of reading a usage log.
    console.info("[rust-runtime] serving host command execution (run_command, check_project)");
  }
  console.info("[rust-runtime] every other tool still runs on the JS handlers");
  return { enabled: true, ready: true, tools, features };
}

/** Which tools the runtime is currently serving. Diagnostic; also used by the A/B harness. */
export function servedTools() {
  return state?.ready ? [...state.tools] : [];
}

/** Whether the runtime is live. */
export function isReady() {
  return Boolean(state?.ready);
}

/** Stop the sidecar. Called on app quit so no orphan survives the window closing. */
export async function shutdown() {
  const s = state;
  if (!s?.ready) {
    teardown("shutdown");
    return;
  }
  try {
    await request(s, "runtime.shutdown", {}, 2000);
  } catch {
    /* it is going away regardless */
  }
  teardown("shutdown");
}
