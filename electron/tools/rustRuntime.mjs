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
 * ## Fail open is GONE (TODO §0.2 F1, decided 2026-09-01)
 *
 * This module used to resolve every failure -- binary missing, spawn refused, protocol mismatch, crash
 * mid-call -- to `null`, meaning "the JS handler serves this call". That made the sidecar optional: it could be
 * absent, broken or a version behind and the app behaved exactly as before.
 *
 * The JS handlers for every migrated tool have been deleted, so there is nothing left to fall back to. A
 * failure here is now a failure the model sees, and a runtime that will not start is an app that cannot read a
 * file or run a command. That is the decision the roadmap asked for -- §3's "core tool execution must no longer
 * bypass Rust Runtime through direct Electron / JavaScript execution" cannot be true while a second
 * implementation is sitting behind it -- and it is worth being plain about what it costs.
 *
 * `null` still means "not served here", but it now means it only for tools the runtime genuinely does not
 * implement (an MCP tool, a plugin tool, `append_file`), which still have handlers of their own.
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
import { createRequire } from "node:module";
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
 * Feature flag. Default ON in a packaged app, OFF in development and under plain node.
 *
 * `ZERAIX_RUST_RUNTIME=off` is a DEBUGGING switch, not a supported configuration. It used to be the field
 * escape hatch — flip it off and a bad sidecar fell back to the JS handlers — but those handlers are gone, so
 * turning the runtime off now turns off every file tool and every command. It is kept because being able to
 * start the app with the sidecar out of the picture is useful when diagnosing the sidecar; recovering from a
 * broken one means shipping a fixed binary, not setting this.
 *
 * `shadow` used to be accepted here and returned as its own state, described as "run both, compare, still
 * return the JS answer". Nothing implemented that, and `ensureStarted` only refuses on `"off"` — so the
 * value behaved EXACTLY like `on`: real calls went to the sidecar and the sidecar's answer was returned.
 * A flag whose safest-sounding setting silently enables the thing is worse than no flag, so it is refused
 * outright and says why. There is no longer a second implementation to compare it against either — see
 * scripts/runtime-smoke.mjs, which checks the sidecar serves what the app needs.
 */
function flagState() {
  const raw = String(process.env.ZERAIX_RUST_RUNTIME ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "on" || raw === "true") return "on";
  if (raw === "0" || raw === "off" || raw === "false") return "off";
  if (raw === "shadow") {
    console.warn(
      "[rust-runtime] ZERAIX_RUST_RUNTIME=shadow is not implemented and is being treated as OFF. " +
        "There is no second implementation to compare against since 2.0; run scripts/runtime-smoke.mjs to " +
        "check the sidecar serves what the app needs.",
    );
    return "off";
  }
  // On everywhere, because there is no longer anything to fall back TO.
  //
  // While the JS handlers existed this defaulted to packaged-only, so development and the test suite
  // exercised the JS path and a packaged build exercised the sidecar. Deleting those handlers (TODO §0.2 F1,
  // decided 2026-09-01) removes the alternative: a runtime that is off is a runtime with no file tools and no
  // commands at all. `ZERAIX_RUST_RUNTIME=0` still forces it off, which is now a debugging switch rather than
  // a supported configuration.
  return "on";
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
 * Subscribers to the runtime's structured state changes (`runtime.event`).
 *
 * A list rather than the single handler `onEvent` keeps, because these have several legitimate consumers at
 * once — a UI showing what the agent is doing, the usage log, an audit view — and they should not have to
 * cooperate over one slot.
 */
const runtimeEventListeners = new Set();

/**
 * Listen to every structured state change the runtime publishes.
 *
 * Payloads are the runtime's own event shape, tagged with `type` (`task_started`, `tool_completed`,
 * `permission_decided`, …) and carrying a monotonic `seq`. **The sequence is what makes a gap visible**: the
 * runtime drops events rather than buffering them when a consumer falls behind, because these drive
 * presentation and a queue of stale transitions is worse than a hole. A listener that cares can watch `seq`
 * for jumps; one that does not can ignore it safely.
 *
 * Returns an unsubscribe function.
 */
export function onRuntimeEvent(listener) {
  runtimeEventListeners.add(listener);
  return () => runtimeEventListeners.delete(listener);
}

// Registered on the module rather than per connection, for the reason the other handlers are: it has to
// survive a sidecar restart. A listener that had to re-subscribe after every crash would miss exactly the
// events that explain the crash.
onEvent("runtime.event", (params) => {
  for (const listener of runtimeEventListeners) {
    try {
      listener(params);
    } catch (e) {
      // One bad listener must not stop the others, and must never propagate into the read loop.
      console.warn("[rust-runtime] a runtime.event listener threw:", e?.message ?? e);
    }
  }
});

/**
 * Handlers for runtime→host REQUESTS, by method name.
 *
 * A request differs from an event in one way that matters: the runtime is waiting. Every path below
 * therefore ends in a reply, including the paths where something went wrong.
 */
const requestHandlers = new Map();

/**
 * Of those, the ones the runtime can call WITHOUT the host having a request outstanding.
 *
 * The distinction decides whether the host must stay alive merely because it registered a handler. A
 * sub-agent body is asked for long after `subagent.spawn` returned, so its handler has to hold the loop open.
 * `host.consent` and `host.ask` can only arrive while an `agent.run` is in flight — which is an outbound call
 * that already holds it open — so counting them would keep every host running forever.
 *
 * That is not hypothetical: registering the consent and ask handlers at module load made `requestHandlers`
 * permanently non-empty, and every test file that touched the runtime stopped exiting.
 */
const unpromptedHandlers = new Set();

/**
 * Answer requests the runtime makes.
 *
 * The handler returns a value, which becomes the reply; throwing sends an error instead. Registered
 * per method for the same reason events are: exactly one part of the host is responsible for a given
 * question, and a fan-out would make "who answered" ambiguous.
 */
export function onRequest(method, handler, { keepsHostAlive = true } = {}) {
  requestHandlers.set(method, handler);
  if (keepsHostAlive) unpromptedHandlers.add(method);
  else unpromptedHandlers.delete(method);
  // Applied immediately: the point of registering is that a call may arrive at any moment after it.
  if (state) updateRefs(state);
  return () => {
    requestHandlers.delete(method);
    if (state) updateRefs(state);
  };
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
  // Outbound calls are not the only reason to stay alive. Once the runtime can call US *unprompted* — which
  // is what registering an unprompted handler declares — the host must remain running to answer, even with
  // nothing of its own outstanding. A handler that can only fire during an outbound call does not count: the
  // call itself is already holding the loop open, and counting it would mean the host never exits.
  //
  // Without this, a sub-agent spawn resolves, the last pending call clears, everything is unref'd, and a
  // short-lived host drains its event loop while the runtime is midway through asking it to run the
  // delegation. Electron never notices (the app holds the loop open regardless); a test or a script
  // exits, and node reports it as "Promise resolution is still pending but the event loop has already
  // resolved" — which names neither the connection nor the request that never arrived.
  const busy = s.pending.size > 0 || unpromptedHandlers.size > 0;
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
  // Unref'd unconditionally rather than through updateRefs: this connection is gone, and a registered
  // handler must not keep its dead handles holding the loop open.
  for (const handle of [s.child, s.child.stdin, s.child.stdout, s.child.stderr]) {
    try {
      handle?.unref?.();
    } catch {
      /* already closed */
    }
  }
  try {
    s.child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Parse whatever complete lines have arrived and settle the calls they answer.
 *
 * Only the chunk that just arrived can hold the newline that completes a line, so that is the only text
 * scanned; the backlog waits as a list of chunks and is joined once, when a newline actually shows up. The
 * earlier version appended every chunk to one string and searched it from the start each time, which is
 * quadratic in the length of a line — 12 s of the main process for a 32 MB result, measured — and a
 * `read_file` result is as long as the file, with nothing capping it (2026-09-04).
 */
function onData(s, chunk) {
  if (!chunk.includes("\n")) {
    s.partial.push(chunk);
    return;
  }
  const text = s.partial.length ? s.partial.join("") + chunk : chunk;
  s.partial.length = 0;
  let from = 0;
  let idx;
  while ((idx = text.indexOf("\n", from)) >= 0) {
    const line = text.slice(from, idx).trim();
    from = idx + 1;
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
  if (from < text.length) s.partial.push(text.slice(from));
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

/**
 * Where the sidecar keeps its task journal, so an interrupted run can be reported at the next handshake.
 *
 * Under Electron this is the app's user-data directory, which is the only per-install writable location the
 * host can name. Outside it -- the test suite, the parity harness -- there is no such directory and no reason
 * to want one, so no argument is passed and the runtime starts without durability, exactly as before.
 *
 * `app` is resolved lazily for the reason given at the top of this module: this file is loaded under plain
 * node in two places, and a static `import { app } from "electron"` would break both. `createRequire` is used
 * rather than a dynamic `import()` because this function is synchronous and its caller is the spawn path.
 */
function stateDirArgs() {
  if (!process.versions.electron) return [];
  try {
    const { app } = createRequire(import.meta.url)("electron");
    const dir = path.join(app.getPath("userData"), "runtime-state");
    return ["--state-dir", dir];
  } catch (e) {
    // No Electron app object (a preload-less context, a stubbed harness). Logged rather than swallowed: this
    // is the difference between "durability is off because nobody asked for it" and "durability is off and
    // nobody noticed", and only the second one is a bug.
    console.warn("[rust-runtime] no state directory; the runtime will start without durability:", e?.message ?? e);
    return [];
  }
}

/**
 * What a previous run left unfinished, from the last handshake. `null` until one has happened.
 *
 * Kept rather than merely logged because the decision it needs is not this module's: `interrupted` tasks may
 * already have changed the user's machine, and whether repeating one is safe depends on what it was.
 */
let recovered = null;

/** Log what the last run left behind. Interrupted work is a warning; queued work is not. */
function reportRecovered(plan) {
  if (!plan) return;
  const queued = plan.resumable?.length ?? 0;
  const started = plan.interrupted?.length ?? 0;
  if (started > 0) {
    console.warn(
      `[rust-runtime] ${started} task(s) were RUNNING when the previous runtime stopped and may have had ` +
        `side effects; they are reported, never re-run: ` +
        plan.interrupted.map((t) => `${t.label} (${t.id})`).join(", "),
    );
  }
  if (queued > 0) {
    console.info(`[rust-runtime] ${queued} task(s) were queued and never started when the previous runtime stopped`);
  }
  if (plan.torn_tail || plan.corrupt_lines) {
    console.warn(
      `[rust-runtime] the task journal was damaged (torn tail: ${!!plan.torn_tail}, ` +
        `unreadable lines: ${plan.corrupt_lines ?? 0}); recovery used the readable part`,
    );
  }
}

/**
 * Subscribers to a run's tokens as they arrive (`agent.delta`).
 *
 * Keyed by nothing: a listener receives every run's deltas and filters on `run_id` itself. One dispatch rather
 * than a registry, because a UI showing one conversation and a log recording all of them want different
 * subsets and neither is the natural owner of the map.
 */
const agentDeltaListeners = new Set();

/**
 * Listen to tokens from `agent.run`, as they are generated.
 *
 * Each payload is `{ run_id, content, reasoning }` carrying the INCREMENT since the last one — appending them
 * in order reconstructs the reply exactly once. The runtime flushes every delta before it answers the run, so a
 * listener never sees the finished text before the tokens that make it up.
 *
 * Returns an unsubscribe function.
 */
export function onAgentDelta(listener) {
  agentDeltaListeners.add(listener);
  return () => agentDeltaListeners.delete(listener);
}

onEvent("agent.delta", (params) => {
  for (const listener of agentDeltaListeners) {
    try {
      listener(params);
    } catch (e) {
      console.warn("[rust-runtime] an agent.delta listener threw:", e?.message ?? e);
    }
  }
});

/**
 * Answer the runtime's questions.
 *
 * `host.consent` and `host.ask` are REQUESTS, not events: the runtime is waiting, and a turn is blocked until
 * one of these returns. Both therefore have a safe default — deny, and no answers — so a host that has not
 * registered a handler still lets the run continue rather than stalling it until the runtime's timeout.
 *
 * Registering these is what makes `agent.run` usable by the app: without them a run can never take a gated
 * action and can never ask a question.
 */
let consentHandler = null;
let askHandler = null;

/** Decide whether one gated action may proceed. `req` is { capability, resource, call, agent, depth }. */
export function onConsentRequest(handler) {
  consentHandler = handler;
  return () => {
    if (consentHandler === handler) consentHandler = null;
  };
}

/** Put questions to the user. Receives the model's own `ask_user` arguments; returns whatever it answered. */
export function onAskRequest(handler) {
  askHandler = handler;
  return () => {
    if (askHandler === handler) askHandler = null;
  };
}

// `keepsHostAlive: false`: both of these can only arrive while an `agent.run` is in flight, and that call
// already holds the event loop open. Registering them as unprompted would mean a host that merely imported
// this module could never exit.
onRequest(
  "host.consent",
  async (params) => {
  if (!consentHandler) {
    // Denied rather than stalled. A runtime that cannot ask must not proceed as though it had asked, and a
    // host with no handler is exactly that case seen from the other side.
    console.warn("[rust-runtime] a consent request arrived with no handler registered; denying");
    return { approved: false };
  }
    return { approved: Boolean(await consentHandler(params)) };
  },
  { keepsHostAlive: false },
);

onRequest(
  "host.ask",
  async (params) => {
  if (!askHandler) {
    console.warn("[rust-runtime] a question arrived with no handler registered; answering nothing");
    return { answers: [] };
  }
    return { answers: await askHandler(params) };
  },
  { keepsHostAlive: false },
);

/**
 * Tools the app has NO implementation for other than the runtime.
 *
 * Kept here, in the host, rather than read from the handshake: the failure being guarded against is the
 * runtime declaring FEWER tools than the app needs, and a check that trusts its list would agree with it no
 * matter how short it was.
 *
 * A stale binary is the way this happens in practice — one built before a tool moved into the runtime serves
 * the older, shorter list. The symptom is otherwise a per-call "Unknown tool: write_file", which reads as the
 * agent inventing a tool rather than as a build being out of date.
 */
const RUNTIME_ONLY_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "file_info",
  "search_files",
  "search_in_files",
];

/** Names the app needs and this runtime did not declare. Empty on a healthy handshake. */
export function missingRuntimeTools() {
  if (!state?.ready) return [];
  return RUNTIME_ONLY_TOOLS.filter((name) => !state.tools.has(name));
}

/** What the previous run left unfinished, or null if no handshake has completed. */
export function recoveredWork() {
  return recovered;
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
    child = spawn(bin, stateDirArgs(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    if (++spawnFailures >= MAX_SPAWN_FAILURES) disabled = true;
    console.warn("[rust-runtime] spawn failed:", e?.message ?? e);
    return null;
  }

  // `closing` marks a teardown this host asked for, so the exit handler can tell it from a crash.
  const s = {
    child,
    pending: new Map(),
    /// Chunks of an incomplete stdout line, joined only when the newline that ends it arrives (see onData).
    partial: [],
    tools: new Set(),
    /// Of `tools`, those that change something — see tryRunTool's catch.
    mutatingTools: new Set(),
    features: new Set(),
    nextId: 0,
    ready: false,
    closing: false,
  };
  state = s;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => onData(s, d));
  // The sidecar's own logs. Surfaced rather than swallowed: a silent sidecar that quietly falls back
  // on every call would look like "the Rust runtime is doing nothing" and be invisible to diagnose.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[rust-runtime] ${d}`));
  child.on("exit", (code, signal) => {
    if (state === s) teardown(`runtime exited (code=${code} signal=${signal ?? "-"})`);
    // A shutdown WE asked for is not a failure, and counting it as one is how the latch below fires on
    // a perfectly healthy runtime. `shutdown()` kills the child after its request is answered, so the
    // exit arrives by signal with a null code -- which `code !== 0` reads as a crash. Three restarts
    // later the bridge disables itself for the rest of the session and every call silently declines.
    //
    // Found in CI: a test file that shuts the runtime down between cases had its fourth case get `null`
    // from every bridge method and hang on a delegation that was never dispatched. Locally the graceful
    // exit usually won the race and the counter never moved, which is exactly the kind of difference a
    // slower machine turns into a red run.
    if (s.closing) return;
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
    // Which of them CHANGE something. See tryRunTool: a lost reply means something different for these.
    for (const name of init?.mutating_tools ?? []) s.mutatingTools.add(name);
    // Work the LAST run left unfinished. Reported here because this is the only moment it is still
    // distinguishable from this run's own work -- see the runtime's `with_state_dir`.
    recovered = init?.recovered ?? null;
    reportRecovered(recovered);
    // Feature-detected rather than inferred from the version: an additive protocol bump still
    // negotiates against an older binary, so the version alone cannot say whether process.run is there.
    for (const name of init?.features ?? []) s.features.add(name);
    s.ready = true;
    spawnFailures = 0;
    // Said once, at the handshake, rather than discovered one failed call at a time.
    const missing = RUNTIME_ONLY_TOOLS.filter((name) => !s.tools.has(name));
    if (missing.length) {
      console.error(
        `[rust-runtime] this runtime does not serve ${missing.join(", ")} — and nothing else implements ` +
          `them, so those calls will fail. The binary is almost certainly older than the app; rebuild it ` +
          `with \`npm run build:runtime\`.`,
      );
    }
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
  // `null` still means "not served here" — but only for a tool this runtime genuinely does not implement
  // (`append_file`, an MCP tool, a plugin tool), which has a handler of its own. When the runtime is DOWN,
  // `s` is null and every migrated tool falls through to `runTool`'s "runtime is not running" message rather
  // than to an implementation, because there no longer is one.
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
    // A failure is a failure. There is no JS handler behind this any more (TODO §0.2 F1), so returning `null`
    // would report the tool as unknown rather than as broken — the wrong diagnosis, and one the model would
    // waste a turn acting on.
    //
    // `notSent` still distinguishes the two shapes, because the ADVICE differs: a request that never left this
    // process definitely did nothing, while one that failed after dispatch may already have taken effect, and
    // for write_file or edit_file that is the difference between "try again" and "look before you touch it".
    const why = e?.message ?? String(e);
    console.warn(`[rust-runtime] ${name} failed:`, why);
    const mayHaveRun = !e?.notSent && s.mutatingTools.has(name);
    return {
      ok: false,
      content: mayHaveRun
        ? `${name} could not be completed by the agent runtime: ${why}. It may have already taken effect and ` +
          `is NOT being retried automatically — read the file to see its current state before deciding what ` +
          `to do.`
        : `${name} could not be completed by the agent runtime: ${why}. Nothing ran.`,
    };
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
    // Only an explicit override reaches here now that the default is on everywhere, so the reason is never
    // ambiguous — but it is still worth naming, because the consequence is severe and easy to forget.
    console.warn(
      `[rust-runtime] DISABLED by ZERAIX_RUST_RUNTIME=off${bin ? "" : " (and no binary is built)"} — ` +
        `no file tools and no command execution will be available. Unset it to restore them.`,
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
  if (s) s.closing = true; // deliberate: see the exit handler
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
