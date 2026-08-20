/**
 * What counts as "this model cannot accept images".
 *
 * These pin the boundary that caused the field bug: requestChat retries any failed image request without its
 * images, and a retry that succeeded used to be taken as proof the model was text-only — a verdict then kept
 * against the model forever, stripping the user's pictures from every later turn so the model answered "I
 * cannot see images". But images are the largest part of a request, so a rate limit, a timeout, an oversized
 * body and a context overflow all recover the same way. The classifier has to tell those apart from a real
 * rejection, and the impostor half of this file is the half that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isVisionRejection, stripAllImagesForText } from "../src/app/agent/chat/wireHelpers.ts";

const err = (m) => new Error(m);

test("a provider that names the image input is a rejection", () => {
  for (const m of [
    "HTTP 400 — unknown variant `image_url`, expected `text`",
    "HTTP 400 — invalid_image_url: failed to download image",
    "HTTP 400 — this model does not support image input",
    "HTTP 400 — vision is not enabled for this deployment",
  ]) {
    assert.equal(isVisionRejection(err(m)), true, m);
  }
});

test("a model NAME containing 'vision' never brands the model", () => {
  // Providers echo the model name back in unrelated errors, and the models named for their vision are
  // exactly the ones that can see. Matching wording ahead of the status made these read as rejections.
  for (const m of [
    "HTTP 429 — rate limit reached for gpt-4-vision-preview, retry in 20s",
    "HTTP 500 — upstream error from the multimodal endpoint",
    "HTTP 502 — bad gateway (model: gpt-4o-vision)",
    "HTTP 503 — qwen-vl-max is temporarily unavailable",
  ]) {
    assert.equal(isVisionRejection(err(m)), false, m);
  }
});

test("wording that names the image beats an exclusion word in the same body", () => {
  assert.equal(
    isVisionRejection(err("HTTP 400 — image_url is not supported by this model, please try again")),
    true,
  );
});

test("the mid-conversation switch to a text-only model is still learned", () => {
  // Attach an image to a vision model, then switch to DeepSeek inside the same conversation: the history
  // still carries the image and the rejection never mentions one. If this were not learned, every later
  // turn of that conversation would pay a doomed request plus a retry.
  assert.equal(
    isVisionRejection(
      err(
        'HTTP 400 — {"error":{"message":"Failed to deserialize the JSON body into the target type: ' +
          'messages[1].content: invalid type: sequence, expected a string","type":"invalid_request_error"}}',
      ),
    ),
    true,
  );
});

test("a bare client rejection still counts — providers do refuse images that way", () => {
  assert.equal(isVisionRejection(err('HTTP 400 — {"error":{"message":"Invalid request"}}')), true);
  assert.equal(isVisionRejection(err("HTTP 415 — unsupported media type")), true);
  assert.equal(isVisionRejection(err("HTTP 422 — messages.0.content.1: extra fields not permitted")), true);
});

test("transient failures never brand the model", () => {
  for (const m of [
    "HTTP 429 — rate limit reached, please try again in 20s",
    "HTTP 500 — internal server error",
    "HTTP 503 — the engine is currently overloaded",
    "TypeError: Failed to fetch",
    "request timed out after 60000ms",
    "The operation was aborted",
    "read ECONNRESET",
  ]) {
    assert.equal(isVisionRejection(err(m)), false, m);
  }
});

test("failures the images merely caused by being big never brand the model", () => {
  // Every one of these succeeds on the stripped retry precisely BECAUSE the images were the bulk of the
  // body — the retry succeeding is evidence about size, not about vision.
  for (const m of [
    "HTTP 413 — request entity too large",
    "HTTP 400 — This model's maximum context length is 128000 tokens",
    "HTTP 400 — string too long: payload exceeds body limit",
  ]) {
    assert.equal(isVisionRejection(err(m)), false, m);
  }
});

test("auth and billing failures are not about images either", () => {
  assert.equal(isVisionRejection(err("HTTP 401 — invalid api key")), false);
  assert.equal(isVisionRejection(err("HTTP 402 — insufficient balance")), false);
});

test("an empty or unknown error is not enough to brand a model", () => {
  assert.equal(isVisionRejection(undefined), false);
  assert.equal(isVisionRejection(err("")), false);
});

test("the strip a wrong verdict causes: images out, note in", () => {
  // The user-visible half of the bug — this is what the model receives, and why it answers that it cannot
  // see the picture the user can see on screen.
  const [msg] = stripAllImagesForText([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    },
  ]);
  assert.equal(typeof msg.content, "string");
  assert.match(msg.content, /what is this\?/);
  assert.match(msg.content, /1 image\(s\) omitted/);
});
