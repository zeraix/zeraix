/**
 * The main-process half of the sub-agent cutover (electron/agent/subagentBridge.mjs).
 *
 * Three hops have to line up for a delegation to run: the runtime asks the main process, the main
 * process asks the window that owns the turn, and the answer comes back the same way. This covers the
 * middle hop — the one with no test above it and no A/B harness beneath it, because a delegation's
 * content comes from a model and cannot be compared byte for byte.
 *
 * What it pins is the routing and the failure modes, both of which are decisions rather than plumbing:
 * which window gets the work, and what happens when there isn't one.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * A minimal Electron stand-in.
 *
 * `ipcMain.handle`/`on` record their handlers so the test can call them the way Electron would, and a
 * fake `webContents` records what was sent to it. The real modules are not reachable outside the app,
 * which is the same reason scripts/electron-stub-hook.mjs exists.
 */
const handlers = new Map();
const listeners = new Map();
const electronStub = {
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  },
  BrowserWindow: { getAllWindows: () => [] },
};

/** Stands in for the Rust bridge, so no sidecar is needed. */
const runtimeStub = {
  requestHandlers: new Map(),
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
    return () => this.requestHandlers.delete(method);
  },
  spawned: [],
  async subagentSpawn(turn, jobs) {
    this.spawned.push({ turn, jobs });
    return { jobs: jobs.map((_, i) => ({ id: `j${i}`, coalesced: false })) };
  },
  joined: [],
  async subagentJoin(turn, opts) {
    this.joined.push({ turn, opts });
    return { ready: [], pending: [], unknown: [], timed_out: false };
  },
  cancelled: [],
  async subagentCancel(turn, reason) {
    this.cancelled.push({ turn, reason });
  },
};

// Loaded through a module hook so the bridge gets the stubs instead of the real modules.
const { register } = await import("node:module");
const stubUrl = "zeraix:subagent-test-stubs";
register(
  new URL(
    `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === "electron") return { url: "${stubUrl}:electron", format: "module", shortCircuit: true };
        if (specifier.endsWith("tools/rustRuntime.mjs")) return { url: "${stubUrl}:runtime", format: "module", shortCircuit: true };
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (url === "${stubUrl}:electron") {
          return { format: "module", shortCircuit: true, source: "export const { ipcMain, BrowserWindow } = globalThis.__electronStub;" };
        }
        if (url === "${stubUrl}:runtime") {
          return {
            format: "module",
            shortCircuit: true,
            source: [
              "const s = globalThis.__runtimeStub;",
              "export const onRequest = (m, h) => s.onRequest(m, h);",
              "export const subagentSpawn = (t, j) => s.subagentSpawn(t, j);",
              "export const subagentJoin = (t, o) => s.subagentJoin(t, o);",
              "export const subagentCancel = (t, r) => s.subagentCancel(t, r);",
            ].join("\\n"),
          };
        }
        return next(url, context);
      }
    `)}`,
  ),
);

globalThis.__electronStub = electronStub;
globalThis.__runtimeStub = runtimeStub;

const { initSubagentBridge, subagentsEnabled } = await import("../electron/agent/subagentBridge.mjs");
initSubagentBridge();

// The bridge refuses to schedule unless opted in, so the tests below -- which are about routing, not
// about the gate -- turn it on. The two tests that are about the gate manage it themselves.
process.env.ZERAIX_RUST_SUBAGENTS = "on";

/** A stand-in for a window. */
function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    once: () => {},
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

const spawn = (sender, turnId, jobs) => handlers.get("subagent:spawn")({ sender }, { turnId, jobs });
const runFromRuntime = (params) => runtimeStub.requestHandlers.get("subagent.run")(params);
const replyFromWindow = (body) => listeners.get("subagent:reply")({}, body);

test("it is off unless asked for, so a packaged build keeps the renderer's scheduler", () => {
  const prior = process.env.ZERAIX_RUST_SUBAGENTS;
  try {
    delete process.env.ZERAIX_RUST_SUBAGENTS;
    assert.equal(subagentsEnabled(), false, "no smoke test has run against a real model yet");
    for (const on of ["1", "on", "true", "ON"]) {
      process.env.ZERAIX_RUST_SUBAGENTS = on;
      assert.equal(subagentsEnabled(), true, on);
    }
    process.env.ZERAIX_RUST_SUBAGENTS = "yes-please";
    assert.equal(subagentsEnabled(), false, "an unrecognised value is not an opt-in");
  } finally {
    if (prior === undefined) delete process.env.ZERAIX_RUST_SUBAGENTS;
    else process.env.ZERAIX_RUST_SUBAGENTS = prior;
  }
});

test("with the opt-in unset, spawning is refused so the renderer keeps its own scheduler", async () => {
  const prior = process.env.ZERAIX_RUST_SUBAGENTS;
  delete process.env.ZERAIX_RUST_SUBAGENTS;
  try {
    const win = fakeWindow();
    const before = runtimeStub.spawned.length;
    assert.equal(await spawn(win, "turn-off", [{ meta: {} }]), null);
    assert.equal(runtimeStub.spawned.length, before, "the runtime was never asked");
    // And the turn was not registered, so nothing can be routed to that window either.
    await assert.rejects(runFromRuntime({ turn: "turn-off", job: "j0", meta: {}, depth: 1 }), /no window/);
  } finally {
    if (prior === undefined) delete process.env.ZERAIX_RUST_SUBAGENTS;
    else process.env.ZERAIX_RUST_SUBAGENTS = prior;
  }
});

test("a delegation is sent to the window that spawned the turn, and its answer returned", async () => {
  const win = fakeWindow();
  await spawn(win, "turn-1", [{ meta: { task: "look" } }]);

  const answer = runFromRuntime({ turn: "turn-1", job: "j0", meta: { task: "look" }, depth: 1 });
  assert.equal(win.sent.length, 1);
  const { channel, payload } = win.sent[0];
  assert.equal(channel, "subagent:run");
  assert.equal(payload.turnId, "turn-1");
  assert.equal(payload.jobId, "j0");
  assert.deepEqual(payload.meta, { task: "look" });

  replyFromWindow({ requestId: payload.requestId, result: "the conclusion" });
  assert.deepEqual(await answer, { result: "the conclusion" });
});

test("a window that reports an error fails that delegation rather than the turn", async () => {
  const win = fakeWindow();
  await spawn(win, "turn-2", [{ meta: {} }]);
  const answer = runFromRuntime({ turn: "turn-2", job: "j0", meta: {}, depth: 1 });
  replyFromWindow({ requestId: win.sent[0].payload.requestId, error: "the sub-agent could not start" });
  await assert.rejects(answer, /could not start/);
});

/**
 * The failure mode this hop introduces. A turn whose window has gone — closed, reloaded, or never
 * registered — must be refused rather than broadcast: running a delegation in another window would
 * attach its output to somebody else's conversation.
 */
test("a delegation for a turn no window owns is refused, not broadcast", async () => {
  await assert.rejects(
    runFromRuntime({ turn: "nobody-owns-this", job: "j0", meta: {}, depth: 1 }),
    /no window is running/,
  );
});

/**
 * The registration race, at this hop.
 *
 * The window can reply in the same tick it receives the work. The pending entry is therefore created
 * before the send, not after — the ordering rule that has now cost this migration four fixes, applied
 * here by construction rather than after a bug.
 */
test("a reply that arrives immediately is not lost", async () => {
  const win = fakeWindow();
  // Replies synchronously from inside `send`, which is the earliest an answer can possibly arrive.
  win.send = (channel, payload) => {
    win.sent.push({ channel, payload });
    replyFromWindow({ requestId: payload.requestId, result: "answered instantly" });
  };
  await spawn(win, "turn-3", [{ meta: {} }]);
  const answer = runFromRuntime({ turn: "turn-3", job: "j0", meta: {}, depth: 1 });
  assert.deepEqual(await answer, { result: "answered instantly" });
});

test("a reply for a request that already went away is ignored rather than thrown", () => {
  // A cancelled turn leaves the window free to answer work nobody is waiting for any more.
  replyFromWindow({ requestId: "not-a-real-request", result: "too late" });
});

test("cancelling a turn releases its window and tells the runtime", async () => {
  const win = fakeWindow();
  await spawn(win, "turn-4", [{ meta: {} }]);
  await handlers.get("subagent:cancel")({ sender: win }, { turnId: "turn-4", reason: "stopped" });
  assert.deepEqual(runtimeStub.cancelled.at(-1), { turn: "turn-4", reason: "stopped" });
  // And the turn is no longer routable, so a late delegation cannot reach a window that has moved on.
  await assert.rejects(runFromRuntime({ turn: "turn-4", job: "j0", meta: {}, depth: 1 }), /no window/);
});

test("join and spawn pass through to the runtime unchanged", async () => {
  const win = fakeWindow();
  await spawn(win, "turn-5", [{ meta: { a: 1 } }, { meta: { b: 2 } }]);
  assert.deepEqual(runtimeStub.spawned.at(-1).jobs, [{ meta: { a: 1 } }, { meta: { b: 2 } }]);

  await handlers.get("subagent:join")({}, { turnId: "turn-5", ids: ["j0"], mode: "any", timeoutMs: 5000, block: true });
  assert.deepEqual(runtimeStub.joined.at(-1), {
    turn: "turn-5",
    opts: { ids: ["j0"], mode: "any", timeoutMs: 5000, block: true },
  });
});
