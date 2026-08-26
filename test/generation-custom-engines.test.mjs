/**
 * User-added generation engines (src/lib/ai/generation/custom.ts).
 *
 * The bug these exist for: a user added an image model through Settings → custom models, and
 * `image_generation` did not see it. It could not — `selectEngine` searched a hardcoded registry of four
 * vendors and had no reference to the model list anywhere.
 *
 * The fix could have been a `capability` tag on `AgentModel`, and that is what I proposed before reading
 * `models.ts:purgeLegacyImageModels`, which documents the same idea being shipped and reverted: image entries
 * in the chat model list "linger in the picker forever, and selecting one would send chat messages to
 * /images/generations". So engines are a separate list.
 *
 * What is tested here is the DECISIONS, not the storage: the storage layer is localStorage-backed and does
 * nothing at all under a test runner, which is exactly why `parseEngines`, `pickEngine` and
 * `resolveEngineSelection` are separate from the functions that read it. Everything below is about refusing to
 * half-work — an engine missing a key, an endpoint, or an adapter this build understands must be SKIPPED
 * rather than selected and failed on, because the registry fallback still works and a half-configured entry
 * should not take away a working default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { parseEngines, pickEngine, adapterFor, ENGINE_FORMATS } = await import(
  "../src/lib/ai/generation/custom.ts"
);
const { resolveEngineSelection } = await import("../src/lib/ai/generation/registry.ts");

const engine = (over = {}) => ({
  id: "engine::1",
  label: "My images",
  capability: "image_generation",
  endpoint: "https://images.example.test/v1/images/generations",
  model: "my-image-model",
  format: "openai-image",
  ...over,
});
const always = () => true;
const never = () => false;

// ── Reading what was stored ─────────────────────────────────────────────────────────────────────────────

test("a stored list round-trips", () => {
  const list = parseEngines(JSON.stringify([engine()]));
  assert.equal(list.length, 1);
  assert.equal(list[0].model, "my-image-model");
  assert.equal(list[0].capability, "image_generation");
});

test("nothing stored reads as no engines, never as a crash", () => {
  for (const raw of [undefined, null, "", "   ", 42, {}, "not json", "[", '"a string"']) {
    assert.deepEqual(parseEngines(raw), [], String(raw));
  }
});

test("malformed entries are dropped rather than surfaced", () => {
  const list = parseEngines(
    JSON.stringify([
      engine({ id: "ok" }),
      engine({ id: "no-endpoint", endpoint: undefined }),
      engine({ id: "no-model", model: undefined }),
      engine({ id: "bad-capability", capability: "chat" }),
      engine({ id: "bad-format", format: "made-up" }),
      null,
      "nonsense",
      42,
    ]),
  );
  assert.deepEqual(list.map((e) => e.id), ["ok"]);
});

test("every declared format has an adapter, and an unknown one has none", () => {
  for (const format of ENGINE_FORMATS) assert.ok(adapterFor({ format }), format);
  // A format written by a future build must read as "no adapter", not fall back to one that mangles the reply.
  assert.equal(adapterFor({ format: "video-something" }), null);
});

// ── Choosing one ────────────────────────────────────────────────────────────────────────────────────────

test("an engine with no API key is not selected", () => {
  assert.equal(pickEngine([engine()], "image_generation", never), null);
  assert.ok(pickEngine([engine()], "image_generation", always));
});

test("an engine for another capability is not selected", () => {
  assert.equal(pickEngine([engine()], "video_generation", always), null);
});

test("an engine whose format this build cannot read is not selected", () => {
  // It survived parsing under an older schema, or was hand-edited. Either way there is no adapter, so
  // selecting it would produce a successful call whose response nothing can decode.
  assert.equal(pickEngine([engine({ format: "made-up" })], "image_generation", always), null);
});

test("the first usable engine wins, and an unusable one does not block it", () => {
  const broken = engine({ id: "broken", endpoint: "" });
  const good = engine({ id: "good" });
  assert.equal(pickEngine([broken, good], "image_generation", always).id, "good");
});

test("keys are checked per engine, not globally", () => {
  const a = engine({ id: "a" });
  const b = engine({ id: "b" });
  assert.equal(pickEngine([a, b], "image_generation", (ref) => ref === "b").id, "b");
});

// ── Precedence: an explicit choice beats an inference from a key ────────────────────────────────────────

test("a configured engine outranks whatever the registry would have guessed", () => {
  const chosen = resolveEngineSelection("image_generation", "zhipu", engine());
  assert.ok(chosen);
  assert.equal(chosen.provider.id, "engine::1");
  assert.equal(chosen.model.id, "my-image-model");
  assert.equal(chosen.endpoint, "https://images.example.test/v1/images/generations");
  // The adapter travels with it — without one the response could not be read.
  assert.ok(chosen.provider.adapter);
});

test("with no configured engine the registry decides, exactly as before", () => {
  // Under the test runner no API keys are readable, so the registry can serve nothing and the answer is
  // null. What matters is that the custom branch did not intercept it.
  assert.equal(resolveEngineSelection("image_generation", "zhipu", null), null);
});

test("a chat provider hint is not mistaken for a generation engine", () => {
  assert.equal(resolveEngineSelection("video_generation", undefined, engine()), null,
    "the engine is an image engine; asking for video must not return it");
});

// ── Async jobs (video) ──────────────────────────────────────────────────────────────────────────────────
//
// The generic async-job reader is the piece most likely to disagree with a real vendor, so what is pinned
// here is the exact field set it claims to understand — the same list the Settings hint shows the user. If
// the two ever drift, the hint becomes a lie and a mismatched endpoint gets no usable diagnosis.

const { asyncJobAdapter } = await import("../src/lib/ai/generation/adapters.ts");

test("a submitted job is recognised by any of the documented task-id fields", () => {
  for (const body of [{ id: "t1" }, { task_id: "t1" }, { taskId: "t1" }, { output: { task_id: "t1" } }, { data: { task_id: "t1" } }]) {
    const r = asyncJobAdapter.fromResponse(body, 200);
    assert.equal(r.ok, true, JSON.stringify(body));
    assert.equal(r.pending?.taskId, "t1", JSON.stringify(body));
  }
});

test("a submit response carrying the finished result is NOT polled", () => {
  // The bug this pins: almost every vendor stamps an `id` on every response, so preferring the task id meant
  // a response that already held the URL was treated as pending — and a poll fired seconds after submit,
  // against a job that had already finished or had never existed.
  const r = asyncJobAdapter.fromResponse({ id: "req-1", url: "https://cdn.test/a.mp4" }, 200);
  assert.equal(r.pending, undefined, "a result present at submit time settles the request");
  assert.equal(r.artifacts[0].src, "https://cdn.test/a.mp4");
});

test("a result nested in the usual envelopes also settles at submit time", () => {
  for (const body of [
    { id: "x", data: [{ url: "https://cdn.test/a.mp4" }] },
    { request_id: "x", video_result: [{ url: "https://cdn.test/a.mp4" }] },
    { id: "x", output: { results: [{ url: "https://cdn.test/a.mp4" }] } },
  ]) {
    assert.equal(asyncJobAdapter.fromResponse(body, 200).pending, undefined, JSON.stringify(body));
  }
});

test("request_id is not mistaken for a task handle", () => {
  // It is a support-correlation id on several vendors (Zhipu returns it alongside a separate task `id`).
  // Polling it would use a well-formed identifier that names nothing, and the 404 would arrive minutes later.
  const r = asyncJobAdapter.fromResponse({ request_id: "corr-123" }, 200);
  assert.equal(r.ok, false, "a correlation id alone is not a job");
  const both = asyncJobAdapter.fromResponse({ request_id: "corr-123", id: "task-9" }, 200);
  assert.equal(both.pending?.taskId, "task-9", "the task id wins over the correlation id");
});

test("an endpoint that answers immediately is accepted rather than insisted into a job", () => {
  const r = asyncJobAdapter.fromResponse({ url: "https://cdn.test/clip.mp4" }, 200);
  assert.equal(r.pending, undefined);
  assert.equal(r.artifacts[0].src, "https://cdn.test/clip.mp4");
  assert.equal(r.artifacts[0].mime, "video/mp4");
});

test("a response matching nothing says what it looked for", () => {
  const r = asyncJobAdapter.fromResponse({ something_else: "x" }, 200);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /task_id/, "an unusable response must be diagnosable from the message alone");
  assert.match(r.error.message, /video_result/, "and it must name the result fields it searched too");
});

test("an HTTP failure is typed rather than reported as a missing task", () => {
  assert.equal(asyncJobAdapter.fromResponse({ error: { message: "nope" } }, 401).error.kind, "auth");
  assert.equal(asyncJobAdapter.fromResponse({}, 429).error.kind, "quota");
});

test("the poll URL substitutes {id}, or appends when the template has no placeholder", () => {
  assert.equal(
    asyncJobAdapter.poll.url("abc", "https://api.test/async-result/{id}"),
    "https://api.test/async-result/abc",
  );
  assert.equal(asyncJobAdapter.poll.url("abc", "https://api.test/tasks"), "https://api.test/tasks/abc");
  assert.equal(asyncJobAdapter.poll.url("abc", "https://api.test/tasks/"), "https://api.test/tasks/abc");
  // A task id is not guaranteed to be URL-safe.
  assert.match(asyncJobAdapter.poll.url("a/b", "https://api.test/{id}"), /a%2Fb$/);
});

test("a still-running job reads as pending, under any of the documented status fields", () => {
  for (const body of [
    { status: "processing" },
    { task_status: "PROCESSING" },
    { state: "running" },
    { output: { task_status: "PENDING" } },
    {},
  ]) {
    const r = asyncJobAdapter.poll.from(body, 200);
    assert.equal(r.ok, true, JSON.stringify(body));
    assert.ok(r.pending, JSON.stringify(body));
  }
});

test("a finished job yields its URL, under any of the documented shapes", () => {
  for (const body of [
    { status: "SUCCESS", url: "https://cdn.test/a.mp4" },
    { task_status: "SUCCEEDED", video_result: [{ url: "https://cdn.test/a.mp4" }] },
    { output: { task_status: "SUCCEEDED", results: [{ url: "https://cdn.test/a.mp4" }] } },
    { status: "completed", data: [{ url: "https://cdn.test/a.mp4" }] },
  ]) {
    const r = asyncJobAdapter.poll.from(body, 200);
    assert.equal(r.ok, true, JSON.stringify(body));
    assert.equal(r.artifacts[0].src, "https://cdn.test/a.mp4", JSON.stringify(body));
  }
});

test("a URL settles the job even when the status still says running", () => {
  // Some vendors report the result on the same response that still reads "processing".
  const r = asyncJobAdapter.poll.from({ status: "processing", url: "https://cdn.test/a.mp4" }, 200);
  assert.ok(r.artifacts);
});

test("a failed job is a failure, not an eternal poll", () => {
  for (const state of ["FAIL", "failed", "ERROR", "cancelled"]) {
    const r = asyncJobAdapter.poll.from({ task_status: state }, 200);
    assert.equal(r.ok, false, state);
    assert.match(r.error.message, new RegExp(state, "i"));
  }
});

test("success with no URL is an error naming the fields it searched, never a silent empty result", () => {
  const r = asyncJobAdapter.poll.from({ status: "SUCCESS" }, 200);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /video_result\[0\]\.url/);
});

test("the mime follows the URL's extension rather than being assumed", () => {
  const mimeOf = (url) => asyncJobAdapter.poll.from({ status: "SUCCESS", url }, 200).artifacts[0].mime;
  assert.equal(mimeOf("https://cdn.test/a.webm"), "video/webm");
  assert.equal(mimeOf("https://cdn.test/a.mov"), "video/quicktime");
  assert.equal(mimeOf("https://cdn.test/a.mp4?sig=x"), "video/mp4", "a query string must not hide the extension");
  assert.equal(mimeOf("https://cdn.test/opaque"), "video/mp4", "an extensionless URL falls back to mp4");
});

test("an async engine with no poll URL is not selected", () => {
  // It would submit, spend the vendor's quota, and then have nowhere to collect the result.
  const async = engine({ capability: "video_generation", format: "async-job" });
  assert.equal(pickEngine([async], "video_generation", always), null);
  assert.ok(pickEngine([{ ...async, pollUrl: "https://api.test/{id}" }], "video_generation", always));
});

// ── Explicit field paths ────────────────────────────────────────────────────────────────────────────────
//
// The escape hatch for an endpoint the generic reader does not know. What matters is that an override
// REPLACES the default for its field rather than being added to it: mixing the two would reintroduce exactly
// the ambiguity it exists to remove — a response with both `id` and a vendor-specific task field would still
// be a coin flip.

const { createAsyncJobAdapter } = await import("../src/lib/ai/generation/adapters.ts");

test("a named task-id field is used instead of the defaults", () => {
  const a = createAsyncJobAdapter({ taskId: "data.job.handle" });
  const r = a.fromResponse({ id: "wrong", data: { job: { handle: "right" } } }, 200);
  assert.equal(r.pending.taskId, "right", "the override must win over a default that also matched");
});

test("an override that does not match is an error, not a silent fall-back to the defaults", () => {
  // Falling back would resurrect the ambiguity: the user said where to look precisely because the default
  // was wrong, so guessing again after their answer fails is worse than saying so.
  const a = createAsyncJobAdapter({ taskId: "data.job.handle" });
  const r = a.fromResponse({ id: "would-have-matched-by-default" }, 200);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /data\.job\.handle/);
});

test("a named result field settles the job", () => {
  const a = createAsyncJobAdapter({ url: "payload.file" });
  const r = a.poll.from({ task_status: "SUCCESS", payload: { file: "https://cdn.test/a.mp4" } }, 200);
  assert.equal(r.artifacts[0].src, "https://cdn.test/a.mp4");
});

test("a named status field decides success and failure", () => {
  const a = createAsyncJobAdapter({ status: "meta.state" });
  assert.equal(a.poll.from({ meta: { state: "FAILED" } }, 200).ok, false);
  // The default `status` field is ignored once an override is given.
  assert.ok(a.poll.from({ status: "FAILED", meta: { state: "running" } }, 200).pending);
});

test("fields are overridden independently — naming one leaves the rest on their defaults", () => {
  const a = createAsyncJobAdapter({ url: "payload.file" });
  assert.equal(a.fromResponse({ task_id: "t9" }, 200).pending.taskId, "t9", "task id still uses the defaults");
});

test("an engine with no overrides uses the documented reader", () => {
  const plain = engine({ capability: "video_generation", format: "async-job", pollUrl: "https://x/{id}" });
  assert.ok(adapterFor(plain));
  // An object of blank strings is not a configuration and must not narrow anything.
  const blank = { ...plain, paths: { taskId: "", status: "  ", url: "" } };
  assert.equal(adapterFor(blank).fromResponse({ task_id: "t1" }, 200).pending.taskId, "t1");
});

test("an engine with overrides gets a reader that honours them", () => {
  const configured = engine({
    capability: "video_generation",
    format: "async-job",
    pollUrl: "https://x/{id}",
    paths: { taskId: "output.jobId" },
  });
  const r = adapterFor(configured).fromResponse({ id: "wrong", output: { jobId: "right" } }, 200);
  assert.equal(r.pending.taskId, "right");
});

// ── Poll cadence ────────────────────────────────────────────────────────────────────────────────────────
//
// Configurable per engine, with a floor. The floor is the point: a form that accepted one second and then
// polled at three would be lying quietly, so the runtime and the Settings field clamp through this same
// function rather than each applying their own idea of the minimum.

const { clampPollInterval, pollsWithinBudget, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, POLL_BUDGET_MS } =
  await import("../src/lib/ai/generation/polling.ts");

test("the default is used when nothing is configured", () => {
  assert.equal(clampPollInterval(undefined), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(clampPollInterval(null), DEFAULT_POLL_INTERVAL_MS);
});

test("anything below the floor is raised to it, never rejected", () => {
  // A stored engine may predate the floor, or carry a hand-edited value from index.json. Refusing to poll
  // would turn a configuration mistake into a video that never arrives.
  assert.equal(clampPollInterval(1), MIN_POLL_INTERVAL_MS);
  assert.equal(clampPollInterval(500), MIN_POLL_INTERVAL_MS);
  assert.equal(clampPollInterval(MIN_POLL_INTERVAL_MS - 1), MIN_POLL_INTERVAL_MS);
});

test("a wider interval is honoured exactly", () => {
  assert.equal(clampPollInterval(10_000), 10_000);
  assert.equal(clampPollInterval(60_000), 60_000);
});

test("unusable values fall back to the default rather than to zero", () => {
  // Zero would busy-loop the vendor; NaN would make setTimeout fire immediately, forever.
  for (const bad of [0, -1, NaN, Infinity, "3000", {}]) {
    assert.equal(clampPollInterval(bad), DEFAULT_POLL_INTERVAL_MS, String(bad));
  }
});

test("a fractional interval is rounded rather than passed to setTimeout as-is", () => {
  assert.equal(clampPollInterval(4500.7), 4501);
});

test("the number of checks a job gets follows from the interval and the budget", () => {
  assert.equal(pollsWithinBudget(DEFAULT_POLL_INTERVAL_MS), POLL_BUDGET_MS / DEFAULT_POLL_INTERVAL_MS);
  assert.equal(pollsWithinBudget(60_000), 5);
  // Below the floor it reports what will ACTUALLY happen, not what was asked for.
  assert.equal(pollsWithinBudget(1), pollsWithinBudget(MIN_POLL_INTERVAL_MS));
});

test("an engine's configured interval is stored clamped, so what is saved is what runs", () => {
  const slow = engine({ capability: "video_generation", format: "async-job", pollUrl: "https://x/{id}", pollIntervalMs: 15_000 });
  assert.equal(pickEngine([slow], "video_generation", always).pollIntervalMs, 15_000);
});
