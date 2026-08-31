/**
 * The runtime→host request direction, and sub-agent scheduling on top of it.
 *
 * Stage 4 adds a direction the protocol did not have. Events tell the host something happened;
 * a request *asks* it for something and waits. That is what lets the runtime own scheduling — order,
 * coalescing, the per-turn cap, the process-global concurrency limit, the cancellation tree — while the
 * host still runs each delegation, because running one means holding a model conversation.
 *
 * These drive the REAL sidecar. A fake could not prove the interesting half: that the runtime blocks on
 * the host's answer and resumes correctly when it arrives.
 *
 * Skipped when the binary has not been built, rather than failing: `cargo build --release` is not a
 * precondition of `npm test`, and CI builds it before running the parity job (.github/workflows/ci.yml).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rust = await import("../electron/tools/rustRuntime.mjs");

const BIN = ["release", "debug"]
  .map((profile) => path.resolve("runtime/target", profile, process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime"))
  .find((p) => fs.existsSync(p));
const skip = BIN ? false : "the sidecar has not been built (cargo build --release)";

/** Run `fn` with the real runtime enabled, then shut it down. */
async function withRuntime(fn) {
  const priorFlag = process.env.ZERAIX_RUST_RUNTIME;
  const priorBin = process.env.ZERAIX_RUST_RUNTIME_BIN;
  process.env.ZERAIX_RUST_RUNTIME = "on";
  process.env.ZERAIX_RUST_RUNTIME_BIN = BIN;
  try {
    return await fn();
  } finally {
    await rust.shutdown();
    if (priorFlag === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
    else process.env.ZERAIX_RUST_RUNTIME = priorFlag;
    if (priorBin === undefined) delete process.env.ZERAIX_RUST_RUNTIME_BIN;
    else process.env.ZERAIX_RUST_RUNTIME_BIN = priorBin;
  }
}

/**
 * A skipped test reports as a pass, which is exactly how five of the tests below went unrun in CI while
 * the job stayed green. Where the sidecar is supposed to exist, say so and fail loudly if it does not —
 * a removed build step or a moved output path is then a red run rather than silent coverage loss.
 */
test("the sidecar is present when the environment says it must be", { skip: !process.env.ZERAIX_REQUIRE_SIDECAR }, () => {
  assert.ok(
    BIN,
    "ZERAIX_REQUIRE_SIDECAR is set but no sidecar binary was found — did the build step run, and is it still writing to runtime/target/{release,debug}?",
  );
});

test("the runtime schedules and the host runs each delegation", { skip }, async () => {
  await withRuntime(async () => {
    const ran = [];
    rust.onRequest("subagent.run", async ({ meta }) => {
      ran.push(meta.prompt);
      return { result: `answered ${meta.prompt}` };
    });

    const spawned = await rust.subagentSpawn("turn-a", [
      { meta: { prompt: "one" } },
      { meta: { prompt: "two" } },
    ]);
    assert.equal(spawned.jobs.length, 2);

    const joined = await rust.subagentJoin("turn-a", { timeoutMs: 30_000 });
    assert.equal(joined.ready.length, 2);
    // Spawn order, whoever finished first, so a fan-out reads the same way every time.
    assert.deepEqual(
      joined.ready.map((r) => r.result),
      ["answered one", "answered two"],
    );
    assert.deepEqual(ran.sort(), ["one", "two"]);
  });
});

test("a delegation the host refuses is reported as failed, not as a hang", { skip }, async () => {
  await withRuntime(async () => {
    rust.onRequest("subagent.run", async () => {
      throw new Error("the sub-agent could not start");
    });
    await rust.subagentSpawn("turn-b", [{ meta: {} }]);
    const joined = await rust.subagentJoin("turn-b", { timeoutMs: 30_000 });
    assert.equal(joined.ready.length, 1);
    assert.equal(joined.ready[0].state, "failed");
    assert.match(joined.ready[0].result, /could not start/);
  });
});

/**
 * The case this direction gets wrong by default.
 *
 * The runtime waits up to thirty minutes for an answer, so a request nobody handles must not be met
 * with silence -- that reads as a sub-agent working for half an hour rather than as a missing handler.
 */
test("a request with no handler is answered rather than ignored", { skip }, async () => {
  await withRuntime(async () => {
    // Deliberately register nothing for subagent.run.
    rust.onRequest("subagent.run", undefined);
    const handlers = rust.onRequest("something.else", () => null);
    handlers(); // and immediately unregister it

    await rust.subagentSpawn("turn-c", [{ meta: {} }]);
    const started = Date.now();
    const joined = await rust.subagentJoin("turn-c", { timeoutMs: 20_000 });
    assert.ok(Date.now() - started < 20_000, "the delegation must not wait out the runtime's ceiling");
    assert.equal(joined.ready.length, 1);
    assert.equal(joined.ready[0].state, "failed");
    assert.match(joined.ready[0].result, /no handler/);
  });
});

test("identical delegations are coalesced, so the host runs one", { skip }, async () => {
  await withRuntime(async () => {
    let runs = 0;
    rust.onRequest("subagent.run", async () => {
      runs++;
      return { result: "once" };
    });

    const spawned = await rust.subagentSpawn("turn-d", [
      { meta: { prompt: "same" }, key: "k" },
      { meta: { prompt: "same" }, key: "k" },
    ]);
    assert.equal(spawned.jobs[0].coalesced, false);
    assert.equal(spawned.jobs[1].coalesced, true);
    assert.equal(spawned.jobs[0].id, spawned.jobs[1].id, "both callers hold the same handle");

    const joined = await rust.subagentJoin("turn-d", { timeoutMs: 30_000 });
    assert.equal(runs, 1, "one delegation ran, not two");
    assert.equal(joined.ready.length, 1);
  });
});

test("cancelling a turn stops a delegation the host is still working on", { skip }, async () => {
  await withRuntime(async () => {
    let dispatched;
    const seen = new Promise((resolve) => {
      dispatched = resolve;
    });
    // Never resolves: the host has taken the work and is still on it.
    rust.onRequest("subagent.run", () => {
      dispatched();
      return new Promise(() => {});
    });

    await rust.subagentSpawn("turn-e", [{ meta: {} }]);
    await seen;

    const started = Date.now();
    await rust.subagentCancel("turn-e", "the user pressed stop");
    // Blocking: a running delegation is given a grace window to return a partial conclusion before it
    // is abandoned, so it is not settled the instant it is cancelled.
    const joined = await rust.subagentJoin("turn-e", { timeoutMs: 20_000 });
    assert.ok(Date.now() - started < 20_000, "cancel must not wait out the body's ceiling");
    assert.equal(joined.ready.length, 1);
    assert.equal(joined.ready[0].state, "cancelled", "a stopped delegation is not a failed one");
  });
});

test("with the runtime unavailable, every call declines rather than throwing", { skip: false }, async () => {
  // The caller keeps its own scheduler. Nothing was scheduled, so there is no half-started state.
  const prior = process.env.ZERAIX_RUST_RUNTIME;
  process.env.ZERAIX_RUST_RUNTIME = "off";
  try {
    assert.equal(await rust.subagentSpawn("nope", [{ meta: {} }]), null);
    assert.equal(await rust.subagentJoin("nope", {}), null);
    await rust.subagentCancel("nope", "no runtime"); // must not throw
  } finally {
    if (prior === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
    else process.env.ZERAIX_RUST_RUNTIME = prior;
  }
});
