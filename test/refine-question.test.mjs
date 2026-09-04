/**
 * The refine_question helper call is bounded (electron/tools/aiToolkit.mjs chatComplete / refineQuestion).
 *
 * One call to the configured model took 328 s on 2026-09-04: non-streaming, no timeout, thinking left on for a
 * reasoning model, and unreachable by the user's Stop because the request lived in the main process. These pin the
 * three bounds against a fake OpenAI-compatible endpoint: the config's body fields (the thinking-off switch) and the
 * token cap are on the wire, Stop cancels the request, and a silent provider is given up on at the timeout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "../scripts/electron-stub-hook.mjs";

const { setLLMConfig, refineQuestion } = await import("../electron/tools/aiToolkit.mjs");

/** A chat-completions endpoint that records what it was sent and answers, hangs, or is cut off, per model name. */
const seen = [];
const open = new Set();
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push(body);
    if (body.model === "silent") {
      open.add(res); // never answers; the client has to give up on its own
      res.on("close", () => open.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "  How do I read a micrometer?  " } }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
test.after(() => {
  for (const r of open) r.destroy();
  server.close();
});

test("the thinking-off switch and the token cap travel with the request", async () => {
  setLLMConfig({ endpoint, apiKey: "k", model: "qwen-test", body: { enable_thinking: false }, timeoutMs: 5000 });
  const out = await refineQuestion({ question: "看圣诞节分厘卡就", context: "vague input" });
  assert.equal(out, "How do I read a micrometer?");
  const sent = seen.at(-1);
  assert.equal(sent.enable_thinking, false, "the family's off switch is on the wire");
  assert.equal(sent.max_tokens, 256);
  assert.equal(sent.model, "qwen-test");
  assert.match(sent.messages[1].content, /Original question:\n看圣诞节分厘卡就/);
});

test("the user's Stop cancels the request instead of abandoning it", async () => {
  setLLMConfig({ endpoint, apiKey: "k", model: "silent", timeoutMs: 10_000 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = performance.now();
  await assert.rejects(refineQuestion({ question: "q" }, { signal: ctrl.signal }), /stopped by the user/);
  assert.ok(performance.now() - t0 < 5000, "returned on the abort, not on the timeout");
});

test("a provider that never answers is given up on at the timeout, with advice the model can act on", async () => {
  setLLMConfig({ endpoint, apiKey: "k", model: "silent", timeoutMs: 200 });
  const t0 = performance.now();
  await assert.rejects(refineQuestion({ question: "q" }), /no answer within 0 s; continue without it/);
  assert.ok(performance.now() - t0 < 3000, "returned at the timeout");
});

test("an empty question is refused before any request is made", async () => {
  const before = seen.length;
  await assert.rejects(refineQuestion({ question: "   " }), /must not be empty/);
  assert.equal(seen.length, before);
});
