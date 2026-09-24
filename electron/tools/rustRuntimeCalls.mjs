/**
 * Single calls into the runtime: a tool, a command, a background service, a sub-agent delegation.
 *
 * Split out of rustRuntime.mjs, which re-exports all of it — import from there.
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
import { CALL_TIMEOUT_MS, ensureStarted, notify, readyState, request } from "./rustRuntimeCore.mjs";

/** Mints call ids when the caller brought none. Prefixed per kind, so they never collide with another module's. */
let callSeq = 0;

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
export async function tryRunTool(name, args, { signal, workdir, assetDir, callId } = {}) {
  const s = await ensureStarted();
  // `null` still means "not served here" — but only for a tool this runtime genuinely does not implement
  // (a state/app tool, an MCP tool, a plugin tool), which has a handler of its own. When the runtime is DOWN,
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
      // `asset_dir` is the read-only second root (the media library). Sent per call for the same reason
      // `workdir` is: it can change while the app runs — Settings → General moves the data storage
      // location, and the library moves with it (main/assetRoot.mjs syncAssetRoot). An older runtime ignores it.
      { name, args: args ?? {}, workdir, asset_dir: assetDir || null, call_id: id },
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
  const s = readyState();
  if (!s || !s.features.has("subagent.scheduler")) return;
  try {
    await request(s, "subagent.cancel", { turn, reason: reason ?? null }, 10_000);
  } catch {
    /* a turn being torn down does not need to hear about this */
  }
}
