/**
 * Sub-agent scheduler tests.
 *
 * The scheduler is deliberately dependency-free (no React, no LLM), so the delegation is just a promise
 * the test controls. That is what lets these assert the properties that actually matter and are otherwise
 * only observable against a live provider: that the concurrency cap holds, that a join suspends rather
 * than polls, that an outcome reaches the model exactly once, and that cancelling unblocks a waiting join.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SubAgentScheduler, CANCELLED_RESULT } from "../src/lib/ai/subagentScheduler.ts";

/** A delegation whose completion the test decides. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run, so spawns reach their `running` state before assertions. */
const tick = () => new Promise((res) => setTimeout(res, 0));

test("spawn returns handles synchronously", () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const a = s.spawn({ agent: "explore" }, () => new Promise(() => {}));
  const b = s.spawn({ agent: "plan" }, () => new Promise(() => {}));
  assert.equal(a.id, "s1");
  assert.equal(b.id, "s2");
  assert.deepEqual(s.outstanding(), ["s1", "s2"]);
});

test("concurrency cap holds; queued jobs start as slots free", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const d = [deferred(), deferred(), deferred()];
  const started = [];
  d.forEach((x, i) =>
    s.spawn({ i }, () => {
      started.push(i);
      return x.promise;
    }),
  );

  await tick();
  assert.deepEqual(started, [0, 1], "only `limit` delegations may run at once");
  assert.deepEqual(s.counts(), { queued: 1, running: 2, settled: 0, total: 3 });

  d[0].resolve("first done");
  await tick();
  assert.deepEqual(started, [0, 1, 2], "a freed slot goes to the queued job");

  d[1].resolve("second done");
  d[2].resolve("third done");
  await tick();
  assert.equal(s.counts().settled, 3);
});

test("join suspends until the work finishes, then reports in spawn order", async () => {
  const s = new SubAgentScheduler({ limit: 3 });
  const d = [deferred(), deferred(), deferred()];
  const ids = d.map((x, i) => s.spawn({ i }, () => x.promise).id);

  let settled = false;
  const joined = s.join(ids, { mode: "all" }).then((r) => {
    settled = true;
    return r;
  });

  await tick();
  assert.equal(settled, false, "join must not resolve while delegations are outstanding");

  // Finished out of order on purpose: reporting order is spawn order, not completion order.
  d[2].resolve("third");
  d[0].resolve("first");
  await tick();
  assert.equal(settled, false, "`all` waits for every id");

  d[1].resolve("second");
  const r = await joined;
  assert.deepEqual(
    r.ready.map((x) => x.outcome.result),
    ["first", "second", "third"],
  );
  assert.deepEqual(r.pending, []);
  assert.equal(r.timedOut, false);
});

test("join mode `any` returns as soon as the first delegation lands", async () => {
  const s = new SubAgentScheduler({ limit: 3 });
  const d = [deferred(), deferred()];
  const ids = d.map((x, i) => s.spawn({ i }, () => x.promise).id);

  const joined = s.join(ids, { mode: "any" });
  d[1].resolve("second finished first");
  const r = await joined;

  assert.deepEqual(
    r.ready.map((x) => x.outcome.result),
    ["second finished first"],
  );
  assert.deepEqual(r.pending, ["s1"], "the unfinished one is reported as still pending");
});

test("an outcome is delivered exactly once, whether by join or by drain", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const d = deferred();
  const { id } = s.spawn({ agent: "explore" }, () => d.promise);
  d.resolve("the conclusion");
  await tick();

  const first = await s.join([id]);
  assert.equal(first.ready.length, 1);
  assert.deepEqual(s.drain(), [], "drain must not re-report what join already delivered");

  const again = await s.join([id]);
  assert.deepEqual(again.ready, [], "joining a delivered job returns nothing new");
});

test("drain surfaces work that finished while the agent was busy elsewhere", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const d = [deferred(), deferred()];
  d.forEach((x, i) => s.spawn({ i }, () => x.promise));

  assert.deepEqual(s.drain(), [], "nothing to deliver while both are still running");
  d[0].resolve("background result");
  await tick();

  const drained = s.drain();
  assert.deepEqual(
    drained.map((x) => x.outcome.result),
    ["background result"],
  );
  assert.deepEqual(s.drain(), []);
});

test("a bare join collects outstanding work and anything not yet reported", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const a = deferred();
  const b = deferred();
  s.spawn({ i: 0 }, () => a.promise);
  s.spawn({ i: 1 }, () => b.promise);

  a.resolve("already finished");
  await tick();

  const joined = s.join(null, { mode: "all" });
  b.resolve("finished later");
  const r = await joined;

  assert.deepEqual(
    r.ready.map((x) => x.outcome.result),
    ["already finished", "finished later"],
  );
});

test("a failing delegation becomes an outcome, not a thrown join", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const bad = deferred();
  const good = deferred();
  s.spawn({ i: 0 }, () => bad.promise);
  s.spawn({ i: 1 }, () => good.promise);

  bad.reject(new Error("provider exploded"));
  good.resolve("still fine");

  const r = await s.join(null, { mode: "all" });
  assert.deepEqual(
    r.ready.map((x) => [x.outcome.state, x.outcome.result]),
    [
      ["failed", "provider exploded"],
      ["done", "still fine"],
    ],
    "one delegation failing must not lose the others",
  );
});

test("identical in-flight delegations coalesce instead of running twice", async () => {
  const s = new SubAgentScheduler({
    limit: 4,
    isDuplicate: (a, b) => a.task === b.task,
  });
  const d = deferred();
  let runs = 0;
  const first = s.spawn({ task: "map the auth flow" }, () => {
    runs++;
    return d.promise;
  });
  const twin = s.spawn({ task: "map the auth flow" }, () => {
    runs++;
    return d.promise;
  });

  assert.equal(twin.coalesced, true);
  assert.equal(twin.id, first.id, "the duplicate is handed the running job's id");
  d.resolve("one investigation");
  await tick();
  assert.equal(runs, 1, "the delegation body must run only once");
});

test("a settled job is not a coalescing target", async () => {
  const s = new SubAgentScheduler({ limit: 2, isDuplicate: () => true });
  const d = deferred();
  s.spawn({ task: "x" }, () => d.promise);
  d.resolve("done");
  await tick();

  const next = s.spawn({ task: "x" }, () => Promise.resolve("fresh"));
  assert.equal(next.coalesced, false, "coalescing applies to in-flight work only");
  assert.equal(next.id, "s2");
});

test("the per-turn job cap refuses runaway fan-out", () => {
  const s = new SubAgentScheduler({ limit: 2, maxJobs: 2 });
  s.spawn({ i: 0 }, () => new Promise(() => {}));
  s.spawn({ i: 1 }, () => new Promise(() => {}));
  const third = s.spawn({ i: 2 }, () => new Promise(() => {}));
  assert.match(third.refused ?? "", /limit/);
  assert.equal(s.counts().total, 2);
});

test("a non-blocking join returns at once with whatever has finished", async () => {
  const s = new SubAgentScheduler({ limit: 3 });
  const a = deferred();
  const b = deferred();
  const ids = [s.spawn({ i: 0 }, () => a.promise).id, s.spawn({ i: 1 }, () => b.promise).id];

  a.resolve("first is done");
  await tick();

  // The point of the test is that this settles without anything else being resolved: if it blocked, the
  // await below would hang on b, which nothing ever completes.
  const r = await s.join(ids, { mode: "all", block: false });
  assert.deepEqual(
    r.ready.map((x) => x.outcome.result),
    ["first is done"],
  );
  assert.deepEqual(r.pending, [ids[1]], "the unfinished one is reported, not waited on");
  assert.equal(r.timedOut, false, "returning early is not a timeout");
});

test("a non-blocking join with nothing finished returns empty rather than waiting", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const d = deferred();
  const { id } = s.spawn({ i: 0 }, () => d.promise);

  const r = await s.join([id], { block: false });
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.pending, [id]);
});

test("a non-blocking join does not consume a result it did not report", async () => {
  // The delivered-once rule has to survive the early return, or a result harvested by nobody would be
  // marked delivered and then never reach the model at all.
  const s = new SubAgentScheduler({ limit: 2 });
  const d = deferred();
  const { id } = s.spawn({ i: 0 }, () => d.promise);

  await s.join([id], { block: false });
  d.resolve("landed after the collect");
  await tick();

  assert.deepEqual(
    s.drain().map((x) => x.outcome.result),
    ["landed after the collect"],
    "auto-delivery must still pick it up",
  );
});

test("join times out without losing the delegations", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const d = deferred();
  const { id } = s.spawn({ i: 0 }, () => d.promise);

  const r = await s.join([id], { timeoutMs: 20 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.pending, [id], "a timed-out delegation stays joinable");

  d.resolve("eventually");
  const again = await s.join([id]);
  assert.equal(again.ready[0].outcome.result, "eventually");
});

test("cancelAll unblocks a join in flight and refuses new spawns", async () => {
  const s = new SubAgentScheduler({ limit: 1 });
  s.spawn({ i: 0 }, () => new Promise(() => {}));
  s.spawn({ i: 1 }, () => new Promise(() => {}));

  const joined = s.join(null, { mode: "all" });
  s.cancelAll();
  const r = await joined;

  assert.deepEqual(
    r.ready.map((x) => x.outcome.state),
    ["cancelled", "cancelled"],
    "a queued job is cancelled too, not left to start later",
  );
  assert.equal(r.ready[0].outcome.result, CANCELLED_RESULT);

  const after = s.spawn({ i: 2 }, () => Promise.resolve("nope"));
  assert.equal(after.refused, CANCELLED_RESULT);
});

test("cancelling never starts a queued delegation", async () => {
  const s = new SubAgentScheduler({ limit: 1 });
  const d = deferred();
  let secondStarted = false;
  s.spawn({ i: 0 }, () => d.promise);
  s.spawn({ i: 1 }, () => {
    secondStarted = true;
    return Promise.resolve("should never run");
  });

  s.cancelAll();
  d.resolve("too late");
  await tick();
  assert.equal(secondStarted, false);
});

test("unknown ids are reported rather than silently ignored", async () => {
  const s = new SubAgentScheduler({ limit: 2 });
  const { id } = s.spawn({ i: 0 }, () => Promise.resolve("real"));
  await tick();

  const r = await s.join([id, "s99"]);
  assert.deepEqual(r.unknown, ["s99"]);
  assert.equal(r.ready.length, 1);
});
