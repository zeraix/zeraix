/**
 * Model-request retry (docs/agent-runtime-crash-recovery.md C8).
 *
 * A dropped network mid-turn used to end the turn with `HTTP 0 — fetch failed` and no retry. What decides whether a
 * failure is worth resending is the classification below, so that is what is pinned here: the split between "the bytes
 * never arrived" and "the provider refused what we sent" is the whole safety argument, because resending a rejection
 * bills the user for a request that can only fail again.
 *
 * The retry itself is safe with respect to side effects by construction, not by a check: the model request is the
 * first thing a round does, so no tool of that round has run when a retry fires. That property is asserted in the
 * round runner's own tests, not here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);

const {
  ChatRequestError,
  MAX_ATTEMPTS,
  asRequestFailure,
  classifyFailure,
  looksLikeNetworkFailure,
  retryDelayMs,
} = await import("../src/lib/ai/requestError.ts");

test("a lost connection is retryable however the transport words it", () => {
  // The three transports each phrase it differently and none of them sets a status.
  for (const message of [
    "fetch failed",
    "TypeError: Failed to fetch",
    "socket hang up",
    "read ECONNRESET",
    "getaddrinfo ENOTFOUND api.example.com",
    "Connection error.",
    "terminated",
  ]) {
    const f = classifyFailure(0, message);
    assert.equal(f.kind, "network", message);
    assert.equal(f.retryable, true, message);
    assert.equal(looksLikeNetworkFailure(message), true, message);
  }
  // No status and no recognisable text is still "no response", which is the network.
  assert.equal(classifyFailure(0, "").kind, "network");
});

test("the provider refusing what we sent is never retried", () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const f = classifyFailure(status, `HTTP ${status} — bad request`);
    assert.equal(f.kind, "client", String(status));
    assert.equal(f.retryable, false, String(status));
  }
});

test("a 4xx is a rejection even when its body mentions a timeout", () => {
  // The status is the evidence, not the prose. Retrying this would burn quota on a request that can only fail again.
  const f = classifyFailure(400, "HTTP 400 — invalid request: connection timeout value must be a number");
  assert.equal(f.kind, "client");
  assert.equal(f.retryable, false);
});

test("the provider failing on its own side is retryable", () => {
  for (const status of [408, 425, 500, 502, 503, 504, 522, 524]) {
    const f = classifyFailure(status, "");
    assert.equal(f.kind, "server", String(status));
    assert.equal(f.retryable, true, String(status));
  }
  const limited = classifyFailure(429, "");
  assert.equal(limited.kind, "rate-limit");
  assert.equal(limited.retryable, true);
});

test("409 is not retried: a conflict is about state, and repeating does not resolve it", () => {
  assert.equal(classifyFailure(409, "conflict").retryable, false);
});

test("an unrecognised failure is fatal rather than silently repeated", () => {
  const f = classifyFailure(-1, "something nobody has seen before");
  assert.equal(f.kind, "unknown");
  assert.equal(f.retryable, false);
});

test("the typed error carries its own verdict, and untyped errors are still classified", () => {
  const typed = new ChatRequestError("HTTP 503 — upstream unavailable", 503);
  assert.equal(typed.kind, "server");
  assert.equal(typed.retryable, true);
  assert.equal(typed.status, 503);
  assert.ok(typed instanceof Error, "callers do `e instanceof Error ? e.message : ...`");
  assert.equal(asRequestFailure(typed).retryable, true);

  // An older throw site formatted the status into the message; the status is recovered from the text.
  const legacy = asRequestFailure(new Error("HTTP 429 — slow down"));
  assert.equal(legacy.status, 429);
  assert.equal(legacy.kind, "rate-limit");
  assert.equal(legacy.retryable, true);

  const bare = asRequestFailure(new TypeError("fetch failed"));
  assert.equal(bare.kind, "network");
  assert.equal(bare.retryable, true);

  const refused = asRequestFailure(new Error("HTTP 401 — invalid api key"));
  assert.equal(refused.retryable, false);
});

test("backoff grows, is jittered, and is capped", () => {
  // Deterministic ends of the jitter range, so the schedule is asserted rather than sampled.
  const low = () => 0;
  const high = () => 1;
  const mid = () => 0.5;

  assert.equal(retryDelayMs(1, "network", mid), 600);
  assert.equal(retryDelayMs(2, "network", mid), 1800);
  // A rate limit waits longer: the provider has just said the opposite of "immediately".
  assert.equal(retryDelayMs(1, "rate-limit", mid), 2000);
  assert.ok(retryDelayMs(1, "network", low) < retryDelayMs(1, "network", high), "jitter spreads the retries");
  assert.ok(retryDelayMs(1, "network", low) >= 450 && retryDelayMs(1, "network", high) <= 750);
  assert.ok(retryDelayMs(9, "rate-limit", high) <= 30_000, "capped, so a long outage never parks a turn for minutes");
});

test("the attempt budget is small enough to notice a real outage", () => {
  assert.equal(MAX_ATTEMPTS, 3, "one request plus two retries");
});

// ── The retry runner ────────────────────────────────────────────────────────────────────────────────

const { withRequestRetry, delay } = await import("../src/lib/ai/requestError.ts");

/** A runner with no real waiting, recording what it was told. */
function runner(extra = {}) {
  const retries = [];
  const resets = [];
  const waits = [];
  return {
    retries,
    resets,
    waits,
    opts: {
      onRetry: (i) => retries.push(i),
      onBeforeRetry: () => resets.push(true),
      sleep: async (ms) => void waits.push(ms),
      delayFor: (n) => n * 100,
      ...extra,
    },
  };
}

test("a transport failure is retried until it succeeds", async () => {
  const r = runner();
  let calls = 0;
  const out = await withRequestRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ChatRequestError("fetch failed", 0);
    return "answer";
  }, r.opts);

  assert.equal(out, "answer");
  assert.equal(calls, 3);
  assert.deepEqual(r.waits, [100, 200], "the wait grows between attempts");
  assert.deepEqual(r.retries.map((i) => [i.attempt, i.attempts, i.kind]), [[1, 3, "network"], [2, 3, "network"]]);
  assert.equal(r.resets.length, 2, "the partial reply is cleared before each new attempt");
});

test("the budget is finite: the last failure is what the caller sees", async () => {
  const r = runner();
  let calls = 0;
  await assert.rejects(
    () =>
      withRequestRetry(async () => {
        calls += 1;
        throw new ChatRequestError(`fetch failed #${calls}`, 0);
      }, r.opts),
    /fetch failed #3/,
  );
  assert.equal(calls, MAX_ATTEMPTS);
});

test("a rejection is not retried at all", async () => {
  const r = runner();
  let calls = 0;
  await assert.rejects(
    () =>
      withRequestRetry(async () => {
        calls += 1;
        throw new ChatRequestError("HTTP 400 — bad request", 400);
      }, r.opts),
    /bad request/,
  );
  assert.equal(calls, 1, "resending a refused request would only fail again, and bill for it");
  assert.equal(r.retries.length, 0);
});

test("Stop is honoured, before and during the wait", async () => {
  // Aborted before the failure is even classified: the user asked for this to end.
  const preAborted = AbortController ? new AbortController() : null;
  preAborted.abort();
  let calls = 0;
  await assert.rejects(
    () =>
      withRequestRetry(
        async () => {
          calls += 1;
          throw new ChatRequestError("fetch failed", 0);
        },
        { ...runner().opts, signal: preAborted.signal },
      ),
    /fetch failed/,
  );
  assert.equal(calls, 1);

  // Aborted DURING the backoff wait: the next attempt must not start.
  const midway = new AbortController();
  let calls2 = 0;
  const r = runner({ sleep: async () => midway.abort() });
  await assert.rejects(
    () =>
      withRequestRetry(
        async () => {
          calls2 += 1;
          throw new ChatRequestError("fetch failed", 0);
        },
        { ...r.opts, signal: midway.signal },
      ),
    /fetch failed/,
  );
  assert.equal(calls2, 1, "Stop during the pause ends it there");
  assert.equal(r.resets.length, 0, "and nothing is reset for an attempt that will not happen");
});

test("the abortable delay returns immediately once aborted", async () => {
  const c = new AbortController();
  const started = Date.now();
  const waiting = delay(5_000, c.signal);
  c.abort();
  await waiting;
  assert.ok(Date.now() - started < 1_000, "a Stop during a retry wait is not made to sit through it");
});
