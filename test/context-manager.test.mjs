/**
 * The buffer → wire transformation (docs/agent-runtime-loop.md §10) — milestone M5a.
 *
 * Almost every assertion here is about ORDER, because order is the only thing this module decides. Each
 * individual step is implemented and tested elsewhere (contextCompress, reminders, wireHelpers); what was
 * previously untestable is the sequence they run in, and every dependency in that sequence is one where the
 * wrong order still produces a plausible-looking array:
 *
 *  - reminders must be folded AFTER compaction, or a stubbed tool result loses the change event that rode on
 *    it and the model is never told the working directory changed;
 *  - bookkeeping must be stripped AFTER reminders are folded, or the fold has nothing left to read;
 *  - the system hoist must run LAST, or it hoists an array that later steps then reorder.
 *
 * Substitutable steps make that testable: each is replaced by one that records its own name, so the test can
 * assert on the sequence itself rather than trying to infer it from the output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { prepareWire, hasImages } = await import("../src/lib/agent/contextManager.ts");

/** Steps that append their own name to a trace, so the call order is directly observable. */
function tracingSteps(trace) {
  const step = (name) => (messages) => {
    trace.push(name);
    return messages;
  };
  return {
    buildWireContext: (messages) => {
      trace.push("compact");
      return messages;
    },
    sanitizeToolCallPairs: step("pair"),
    materializeReminders: step("reminders"),
    stripWireMetadata: step("metadata"),
    applyReasoningPolicy: (messages, isLocal, sendContext) => {
      trace.push(`reasoning:${isLocal}:${sendContext}`);
      return messages;
    },
    stripAllImagesForText: step("strip-all-images"),
    stripRemoteImagesForLocal: step("strip-remote-images"),
    hoistSystemToFront: step("hoist"),
  };
}

const model = (over = {}) => ({
  isLocal: false,
  acceptsImages: true,
  sendReasoningContext: false,
  modelId: "gpt-5",
  ...over,
});
const msgs = [{ role: "user", content: "hi" }];

test("the six steps run in the order the wire depends on", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model(), steps: tracingSteps(trace) });
  assert.deepEqual(trace, ["compact", "pair", "reminders", "metadata", "reasoning:false:false"]);
});

test("compaction precedes the reminder fold, so a stubbed result keeps its change event", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model(), steps: tracingSteps(trace) });
  assert.ok(trace.indexOf("compact") < trace.indexOf("reminders"));
});

test("bookkeeping is stripped only after the reminder fold has read it", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model(), steps: tracingSteps(trace) });
  assert.ok(trace.indexOf("reminders") < trace.indexOf("metadata"));
});

test("the system hoist runs last, on the final array", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model({ isLocal: true }), steps: tracingSteps(trace) });
  assert.equal(trace[trace.length - 1], "hoist");
});

test("the hoist is local-only — a cloud request is never reordered", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model({ isLocal: false }), steps: tracingSteps(trace) });
  assert.equal(trace.includes("hoist"), false);
});

test("the reasoning policy is told which model it is building for", () => {
  const trace = [];
  prepareWire(msgs, null, {
    model: model({ isLocal: true, sendReasoningContext: true }),
    steps: tracingSteps(trace),
  });
  assert.ok(trace.includes("reasoning:true:true"));
});

// ── The three image branches (§10, and the provider contracts behind them) ──────────────────────────────

test("a text-only model has every image stripped, wherever in the history it sits", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model({ acceptsImages: false }), steps: tracingSteps(trace) });
  assert.ok(trace.includes("strip-all-images"));
  assert.equal(trace.includes("strip-remote-images"), false, "the two strips are alternatives, never both");
});

test("a multimodal local model keeps inline images and downgrades remote ones", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model({ isLocal: true, acceptsImages: true }), steps: tracingSteps(trace) });
  assert.ok(trace.includes("strip-remote-images"), "llama cannot fetch a remote image");
  assert.equal(trace.includes("strip-all-images"), false);
});

test("a multimodal cloud model has its images left entirely alone", () => {
  const trace = [];
  prepareWire(msgs, null, { model: model({ isLocal: false, acceptsImages: true }), steps: tracingSteps(trace) });
  assert.equal(trace.includes("strip-all-images"), false);
  assert.equal(trace.includes("strip-remote-images"), false);
});

// ── The strip report ────────────────────────────────────────────────────────────────────────────────────

test("stripping is reported only when there was something to strip", () => {
  const withImage = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:x" } }] },
  ];
  const reported = [];
  prepareWire(withImage, null, {
    model: model({ acceptsImages: false, modelId: "text-only-1" }),
    steps: tracingSteps([]),
    onImagesStripped: (id) => reported.push(id),
  });
  assert.deepEqual(reported, ["text-only-1"], "silence here is what hid the CORS bug in image generation");

  const quiet = [];
  prepareWire(msgs, null, {
    model: model({ acceptsImages: false }),
    steps: tracingSteps([]),
    onImagesStripped: (id) => quiet.push(id),
  });
  assert.deepEqual(quiet, [], "a text-only conversation must not log a strip on every round");
});

test("a missing model id is reported as such rather than as undefined", () => {
  const withImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] }];
  const reported = [];
  prepareWire(withImage, null, {
    model: { isLocal: false, acceptsImages: false, sendReasoningContext: false },
    steps: tracingSteps([]),
    onImagesStripped: (id) => reported.push(id),
  });
  assert.deepEqual(reported, ["(no model)"]);
});

test("the report is optional — omitting it must not throw", () => {
  const withImage = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] }];
  assert.doesNotThrow(() =>
    prepareWire(withImage, null, { model: model({ acceptsImages: false }), steps: tracingSteps([]) }),
  );
});

test("image detection looks inside content parts, not at the message", () => {
  assert.equal(hasImages([{ role: "user", content: "just text" }]), false);
  assert.equal(hasImages([{ role: "user", content: [{ type: "text", text: "x" }] }]), false);
  assert.equal(hasImages([{ role: "user", content: [{ type: "image_url", image_url: { url: "u" } }] }]), true);
  assert.equal(hasImages([]), false);
});

// ── Purity ──────────────────────────────────────────────────────────────────────────────────────────────

test("the buffer is never modified — it is what gets persisted", () => {
  const buffer = [{ role: "user", content: "hi" }];
  const snapshot = JSON.parse(JSON.stringify(buffer));
  prepareWire(buffer, null, { model: model({ isLocal: true, acceptsImages: false }), steps: tracingSteps([]) });
  assert.deepEqual(buffer, snapshot);
});

test("the same inputs give the same output, which is what makes a round cacheable", () => {
  const trace1 = [];
  const trace2 = [];
  const a = prepareWire(msgs, null, { model: model(), steps: tracingSteps(trace1) });
  const b = prepareWire(msgs, null, { model: model(), steps: tracingSteps(trace2) });
  assert.deepEqual(a, b);
  assert.deepEqual(trace1, trace2);
});
