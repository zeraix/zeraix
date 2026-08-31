/**
 * The renderer's adapter onto the runtime scheduler (src/app/agent/chat/runtimeScheduler.ts).
 *
 * It has to satisfy the same surface `SubAgentScheduler` does, because the delegation tools call it
 * without knowing which one they hold. What is worth testing is not the pass-through but the three
 * places the two implementations could quietly disagree:
 *
 * - **coalescing**, which stays here because `isSameDelegation` is a fuzzy overlap rather than an
 *   equality check and the runtime coalesces on an exact key;
 * - **exactly-once delivery**, which now has two possible reporters — `drain` (local, synchronous) and
 *   `join` (the runtime's) — and must never produce the same conclusion through both;
 * - **the registration race**, where the runtime asks this window to run a job before the reply
 *   carrying that job's id has arrived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);

/** A stand-in for the preload bridge. */
function installBridge({ spawnIds = ["j0", "j1", "j2"], joinResult } = {}) {
  let runCb = null;
  let n = 0;
  const replies = [];
  const bridge = {
    spawned: [],
    joined: [],
    cancelled: [],
    replies,
    async spawn(turnId, jobs) {
      bridge.spawned.push({ turnId, jobs });
      return { jobs: jobs.map(() => ({ id: spawnIds[n++], coalesced: false })) };
    },
    async join(turnId, opts) {
      bridge.joined.push({ turnId, opts });
      return joinResult ?? { ready: [], pending: [], unknown: [], timed_out: false };
    },
    async cancel(turnId, reason) {
      bridge.cancelled.push({ turnId, reason });
    },
    onRun(cb) {
      runCb = cb;
      return () => {
        runCb = null;
      };
    },
    reply: (requestId, body) => replies.push({ requestId, ...body }),
    /** Pretend the runtime asked this window to run a job. */
    ask: (payload) => runCb?.(payload),
  };
  globalThis.subagents = bridge;
  return bridge;
}

const { createRuntimeScheduler } = await import("../src/app/agent/chat/runtimeScheduler.ts");

/** `isSameDelegation` compares agent plus a subject token set, so metas need both. */
const meta = (agent, subject) => ({ agent, task: subject.join(" "), subject: new Set(subject) });

test("a delegation runs here and its conclusion goes back to the runtime", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-1", () => {});

  const res = await sched.spawn(meta("explore", ["auth", "flow"]), async () => "what I found");
  assert.equal(res.id, "j0");
  assert.equal(res.coalesced, false);
  assert.deepEqual(bridge.spawned[0].jobs.length, 1);

  bridge.ask({ requestId: "r1", turnId: "turn-1", jobId: "j0", meta: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(bridge.replies.at(-1), { requestId: "r1", result: "what I found" });
});

test("a delegation that throws is reported as an error, not a conclusion", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-2", () => {});
  await sched.spawn(meta("explore", ["one"]), async () => {
    throw new Error("the sub-agent gave up");
  });

  bridge.ask({ requestId: "r1", turnId: "turn-2", jobId: "j0", meta: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(bridge.replies.at(-1).error, /gave up/);
});

/**
 * The race, made deterministic: the runtime asks for the job BEFORE `spawn` has returned its id, which
 * is what happens when a slot is free and the reply is still travelling back. The request waits for the
 * body instead of failing.
 */
test("work that arrives before its body is registered still runs", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-3", () => {});

  // Asked for first, spawned second — the inverted order the race produces.
  bridge.ask({ requestId: "r1", turnId: "turn-3", jobId: "j0", meta: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(bridge.replies.length, 0, "it must wait rather than refuse");

  await sched.spawn(meta("explore", ["late"]), async () => "ran anyway");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(bridge.replies.at(-1), { requestId: "r1", result: "ran anyway" });
});

test("a near-identical delegation is folded in here, and the runtime never sees it", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-4", () => {});

  const first = await sched.spawn(meta("explore", ["auth", "login", "flow"]), async () => "once");
  const second = await sched.spawn(meta("explore", ["auth", "login", "flow"]), async () => "twice");

  assert.equal(second.coalesced, true, "the same question folds into the job already in flight");
  assert.equal(second.id, first.id, "and both callers hold the same handle");
  assert.equal(bridge.spawned.length, 1, "the runtime was asked once, because coalescing is a judgement here");
});

test("a different delegation is not folded", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-5", () => {});
  await sched.spawn(meta("explore", ["auth"]), async () => "a");
  const other = await sched.spawn(meta("explore", ["billing", "invoices", "tax"]), async () => "b");
  assert.equal(other.coalesced, false);
  assert.equal(bridge.spawned.length, 2);
});

test("a conclusion is delivered once, whether drain or join reports it", async () => {
  const bridge = installBridge({
    joinResult: {
      ready: [{ id: "j0", meta: {}, state: "done", result: "the conclusion", ms: 5, coalesced: 0 }],
      pending: [],
      unknown: [],
      timed_out: false,
    },
  });
  const sched = createRuntimeScheduler("turn-6", () => {});
  await sched.spawn(meta("explore", ["x"]), async () => "the conclusion");

  bridge.ask({ requestId: "r1", turnId: "turn-6", jobId: "j0", meta: {} });
  await new Promise((r) => setTimeout(r, 10));

  // drain reports it first -- the model was doing something else when it landed.
  const drained = sched.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].outcome.result, "the conclusion");

  // The runtime still has it in `ready`, and it must NOT be reported a second time: the model would
  // read that as the work having happened twice.
  const joined = await sched.join(null, { mode: "all", timeoutMs: 1000, block: true });
  assert.equal(joined.ready.length, 0, "already delivered");
  assert.equal(sched.drain().length, 0, "and drain has nothing left either");
});

test("cancelling tells the runtime and stops routing work to this turn", async () => {
  const bridge = installBridge();
  const sched = createRuntimeScheduler("turn-7", () => {});
  await sched.spawn(meta("explore", ["y"]), async () => "unused");

  sched.cancelAll();
  assert.equal(bridge.cancelled.at(-1).turnId, "turn-7");

  // The turn is deregistered, so a delegation arriving late is refused rather than run against a
  // scheduler whose turn is over.
  bridge.ask({ requestId: "r9", turnId: "turn-7", jobId: "j0", meta: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.match(bridge.replies.at(-1).error, /not scheduling delegations here/);
});

test("with no bridge present, the adapter declines so the renderer's own scheduler is used", () => {
  delete globalThis.subagents;
  assert.equal(createRuntimeScheduler("turn-8", () => {}), null);
});
