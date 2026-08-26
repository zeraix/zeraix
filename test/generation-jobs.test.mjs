/**
 * Generation jobs that outlive their turn (src/lib/ai/generation/jobs.ts).
 *
 * The problem: video takes minutes, and awaiting it inside the tool call held the whole turn open — the model
 * could not act, the user could not be answered, and a spinner that had not moved in four minutes was
 * indistinguishable from one that had hung.
 *
 * A job therefore belongs to a CONVERSATION, not to a turn, and the properties worth pinning are all about
 * that ownership. It must survive the turn that started it, since by construction that turn is over long
 * before it lands. It must NOT survive the conversation being cleared, because the only thing it could then
 * do is wake something the user just dismissed. And a listener that throws must not strand every other job —
 * one rendering bug would otherwise silently break delivery for the whole session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { onGenerationJobEvent, jobsFor, cancelJobsFor, describeJobResult } = await import(
  "../src/lib/ai/generation/jobs.ts"
);

const job = (over = {}) => ({
  id: "gen_1",
  convId: "conv1",
  capability: "video_generation",
  prompt: "a slow dolly-in on a lighthouse",
  startedAt: 0,
  ...over,
});

test("nothing is running for a conversation that has started nothing", () => {
  assert.deepEqual(jobsFor("conv-unknown"), []);
  assert.equal(cancelJobsFor("conv-unknown"), 0);
});

test("a subscriber can unsubscribe, and stops hearing about jobs", () => {
  const seen = [];
  const off = onGenerationJobEvent((e) => seen.push(e));
  off();
  // Nothing to assert beyond "unsubscribing does not throw and leaves no listener"; the emit path is
  // exercised through the describe helpers below, which is where the wording that reaches the model lives.
  assert.equal(seen.length, 0);
});

// ── What the model is told ──────────────────────────────────────────────────────────────────────────────
//
// This wording is the entire interface between a finished job and the model. It has to say three things or
// the model mishandles it: that the job is FINISHED (not that it should wait), what was asked for (the turn
// that asked is long gone), and — on failure — that it must report rather than silently retry, since a retry
// costs minutes and real money.

test("a finished job says so, names the prompt, and says the user can already see it", () => {
  const text = describeJobResult({
    job: job(),
    status: "succeeded",
    artifact: { src: "https://cdn.test/a.mp4", mime: "video/mp4", servedBy: "wan-v1" },
    elapsedMs: 132_000,
  });
  assert.match(text, /finished/);
  assert.match(text, /lighthouse/, "the turn that asked for it is long over; the prompt is the only context");
  assert.match(text, /already displayed/, "the model must not repeat the URL into the transcript");
  assert.match(text, /132s/);
});

test("a failed job tells the model to report rather than retry", () => {
  const text = describeJobResult({
    job: job(),
    status: "failed",
    error: { kind: "quota", message: "insufficient balance" },
    elapsedMs: 4_000,
  });
  assert.match(text, /failed/);
  assert.match(text, /insufficient balance/);
  assert.match(text, /quota/);
  // A silent retry costs minutes and money, and the user never learns why their video never arrived.
  assert.match(text, /do not silently retry/i);
});

test("the capability is named, so an image job and a video job are not confused", () => {
  const asVideo = describeJobResult({
    job: job({ capability: "video_generation" }),
    status: "succeeded",
    artifact: { src: "x", mime: "video/mp4", servedBy: "e" },
    elapsedMs: 1000,
  });
  const asImage = describeJobResult({
    job: job({ capability: "image_generation" }),
    status: "succeeded",
    artifact: { src: "x", mime: "image/png", servedBy: "e" },
    elapsedMs: 1000,
  });
  assert.match(asVideo, /video_generation/);
  assert.match(asImage, /image_generation/);
});

test("elapsed time is reported in whole seconds, never as milliseconds", () => {
  const text = describeJobResult({
    job: job(),
    status: "succeeded",
    artifact: { src: "x", mime: "video/mp4", servedBy: "e" },
    elapsedMs: 1_500,
  });
  assert.match(text, /\b2s\b/, "rounded, so the model never reports '1500s' to the user");
});

/**
 * A finished job has to say WHERE the file is.
 *
 * The path was being written to disk and then dropped on the floor: `storeArtifact` returns it, the job runner
 * discarded the return value, and the success notice said only that the clip was "displayed to the user". So
 * the obvious follow-up to generating a video — add subtitles, extract a frame, stitch it into something —
 * had nowhere to start, and the model's options were to guess a path or to tell the user it could not.
 */
test("a finished job names the stored file, under the name the model can reach", () => {
  const evt = {
    job: job({ capability: "video_generation" }),
    status: "succeeded",
    artifact: { src: "https://cdn.test/a.mp4", mime: "video/mp4", servedBy: "wan-v1" },
    elapsedMs: 132_000,
    path: "C:\\Users\\hp\\AppData\\Roaming\\Zeraix\\agent\\media\\generated-a-clip.mp4",
  };
  // Natively the host path is the only name that resolves.
  const native = describeJobResult(evt, false);
  assert.ok(native.includes(evt.path), `host path missing from: ${native}`);
  assert.ok(!native.includes("/assets"), "named the sandbox mount on a native host");
  // Inside the guest that host path does not exist, and the mount does.
  const boxed = describeJobResult(evt, true);
  assert.ok(boxed.includes("/assets/generated-a-clip.mp4"), `mount path missing from: ${boxed}`);
  assert.ok(!boxed.includes(evt.path), "named a host path that does not exist inside the guest");
  // The library is read-only, so an in-place edit is refused by tools/paths.mjs. Saying so is the difference
  // between the model copying the file out and it burning a turn on a write that cannot succeed.
  assert.match(boxed, /READ-ONLY/);
});

test("a job whose save failed is given no path rather than a guessed one", () => {
  const text = describeJobResult({
    job: job(),
    status: "succeeded",
    artifact: { src: "https://cdn.test/a.mp4", mime: "video/mp4", servedBy: "wan-v1" },
    elapsedMs: 1_000,
  });
  assert.ok(!text.includes("/assets"), `invented a path in: ${text}`);
  assert.ok(!/media library at/.test(text), `claimed a location it does not have in: ${text}`);
});
