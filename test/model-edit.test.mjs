/**
 * Editing an already-added model (src/lib/ai/models.ts).
 *
 * The bug these exist for: a typo in a model ID, a rotated key, or a moved endpoint could only be
 * fixed by deleting the entry and adding it back — which also threw away the default selection and,
 * for a custom entry, the API key stored against its id.
 *
 * Fixing that in place has one non-obvious constraint, and it is the reason for most of what is
 * pinned here: the entry's `id` must survive the edit. An official entry's id was minted as
 * `${providerId}::${model}`, so recomputing it from the edited fields looks natural and would
 * silently unbind three separate things that point at the old id — the default selection, every
 * conversation carrying a saved modelId, and (for custom entries) the API key ref.
 *
 * Storage is not tested, in keeping with the rest of the suite: it is localStorage-backed and does
 * nothing under a test runner, which is why the decision lives in `applyModelEdit` and only the
 * write wrapper touches the list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { applyModelEdit, splitCustomEndpoint } = await import("../src/lib/ai/models.ts");

const official = (over = {}) => ({
  id: "openai::gpt-5.5",
  providerId: "openai",
  model: "gpt-5.5",
  label: "gpt-5.5",
  custom: false,
  ...over,
});

const custom = (over = {}) => ({
  id: "custom::abc",
  providerId: "custom",
  model: "my-model",
  label: "My model",
  endpoint: "https://gw.example.test/v1/chat/completions",
  custom: true,
  apiFormat: "openai-chat",
  multimodal: false,
  ...over,
});

// ── Identity ────────────────────────────────────────────────────────────────────────────────────

test("the id survives an edit, even when the model string it was minted from changes", () => {
  const next = applyModelEdit(official(), { model: "gpt-5.6", label: "GPT-5.6" });
  assert.equal(next.id, "openai::gpt-5.5");
  assert.equal(next.model, "gpt-5.6");
  assert.equal(next.label, "GPT-5.6");
});

test("an untouched field is left exactly as it was", () => {
  const before = official({ contextWindow: 400000, multimodal: true });
  const next = applyModelEdit(before, { model: "gpt-5.6" });
  assert.equal(next.contextWindow, 400000);
  assert.equal(next.multimodal, true);
  assert.equal(next.providerId, "openai");
});

// ── Display name ────────────────────────────────────────────────────────────────────────────────

test("clearing the display name falls back to the model string, never to blank", () => {
  const next = applyModelEdit(official({ label: "Old name" }), { label: "   ", model: "gpt-5.6" });
  assert.equal(next.label, "gpt-5.6");
});

test("clearing the display name with no model edit keeps the name it had", () => {
  const next = applyModelEdit(official({ label: "Old name" }), { label: "" });
  assert.equal(next.label, "Old name");
});

// ── Endpoint ────────────────────────────────────────────────────────────────────────────────────

test("a custom entry's endpoint is re-resolved from the base URL and the format", () => {
  const next = applyModelEdit(custom(), { baseUrl: "https://new.example.test/v1", fullUrl: false });
  assert.equal(next.endpoint, "https://new.example.test/v1/chat/completions");
  // Switching the format moves the suffix with it.
  const responses = applyModelEdit(custom(), {
    baseUrl: "https://new.example.test/v1",
    fullUrl: false,
    apiFormat: "openai-responses",
  });
  assert.equal(responses.endpoint, "https://new.example.test/v1/responses");
});

test("full-URL mode is taken verbatim, with nothing appended", () => {
  const next = applyModelEdit(custom(), { baseUrl: "https://gw.example.test/proxy/chat", fullUrl: true });
  assert.equal(next.endpoint, "https://gw.example.test/proxy/chat");
});

test("an official entry never gains an endpoint, because resolveModel derives it per send", () => {
  // Frozen endpoints on provider-backed entries are the bug normalizeOfficialEndpoints exists to
  // undo; an edit form must not reintroduce one.
  const next = applyModelEdit(official(), { baseUrl: "https://someone.typed.this/v1", fullUrl: true });
  assert.equal(next.endpoint, undefined);
});

// ── The learned vision verdict ──────────────────────────────────────────────────────────────────

test("changing the model drops a learned image-rejection verdict", () => {
  const blind = official({ visionUnsupported: true, visionUnsupportedAt: Date.now() });
  const next = applyModelEdit(blind, { model: "gpt-5.6" });
  assert.equal(next.visionUnsupported, undefined);
  assert.equal(next.visionUnsupportedAt, undefined);
});

test("renaming alone keeps the verdict, which was about the model and still holds", () => {
  const at = Date.now();
  const blind = official({ visionUnsupported: true, visionUnsupportedAt: at });
  const next = applyModelEdit(blind, { label: "Renamed" });
  assert.equal(next.visionUnsupported, true);
  assert.equal(next.visionUnsupportedAt, at);
});

// ── Reading a stored endpoint back into the form ─────────────────────────────────────────────────

test("a stored endpoint splits back into the pair that produced it", () => {
  assert.deepEqual(splitCustomEndpoint("https://gw.example.test/v1/chat/completions", "openai-chat"), {
    baseUrl: "https://gw.example.test/v1",
    fullUrl: false,
  });
  assert.deepEqual(splitCustomEndpoint("https://gw.example.test/v1/responses", "openai-responses"), {
    baseUrl: "https://gw.example.test/v1",
    fullUrl: false,
  });
});

test("an endpoint that does not end in this format's suffix reads back as a full URL", () => {
  assert.deepEqual(splitCustomEndpoint("https://gw.example.test/proxy/chat", "openai-chat"), {
    baseUrl: "https://gw.example.test/proxy/chat",
    fullUrl: true,
  });
  // Same address, other format: the suffix no longer matches, so it is left whole rather than trimmed
  // at the wrong place.
  assert.deepEqual(splitCustomEndpoint("https://gw.example.test/v1/chat/completions", "openai-responses"), {
    baseUrl: "https://gw.example.test/v1/chat/completions",
    fullUrl: true,
  });
});

test("the split round-trips through applyModelEdit unchanged", () => {
  for (const endpoint of [
    "https://gw.example.test/v1/chat/completions",
    "https://gw.example.test/proxy/chat",
    "https://gw.example.test/v1/",
  ]) {
    const entry = custom({ endpoint });
    const { baseUrl, fullUrl } = splitCustomEndpoint(endpoint, entry.apiFormat);
    assert.equal(applyModelEdit(entry, { baseUrl, fullUrl }).endpoint, endpoint, endpoint);
  }
});
