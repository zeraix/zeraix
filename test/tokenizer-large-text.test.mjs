/**
 * The token estimator must stay bounded on text the tokenizer's merge loop cannot handle.
 *
 * js-tiktoken's byte-pair merge is quadratic per pre-tokenizer piece, and a piece is an entire run of letters. A
 * 2 MB file of `A`s is one piece; encoding it directly does not finish in any time a user would wait, and it ran
 * on the renderer's main thread after a read_file (2026-09-03: the app froze). These pin the guard in tokenizer.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { countTokens, countMessagesTokens } = await import("../src/lib/ai/tokenizer.ts");
const { getEncoding } = await import("js-tiktoken");

const timed = (fn) => {
  const t0 = Date.now();
  const v = fn();
  return { v, ms: Date.now() - t0 };
};

// The first encode loads the rank table (a second or two in Node); every timing below is of the steady state.
countTokens("warm up the tokenizer");

test("a 2 MB single run of letters is counted in bounded time", () => {
  const text = "A".repeat(2 * 1024 * 1024);
  const { v, ms } = timed(() => countTokens(text));
  assert.ok(v > 0, "a positive estimate");
  assert.ok(ms < 250, `took ${ms} ms; the unguarded encode does not finish at all`);
  // The estimate is the same whether the text arrives as one message or the whole conversation.
  assert.equal(countMessagesTokens([{ role: "tool", content: text }]) > v, true);
});

test("a long base64-like blob, letters and digits with no separators, is bounded too", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  for (let i = 0; i < 300_000; i++) s += alphabet[(i * 7919) % alphabet.length];
  const { ms } = timed(() => countTokens(s));
  assert.ok(ms < 250, `took ${ms} ms`);
});

test("a 60 KB single run, under the sampling threshold, is bounded on the windowed path as well", () => {
  const { ms } = timed(() => countTokens("B".repeat(60_000)));
  assert.ok(ms < 100, `took ${ms} ms`);
});

test("ordinary prose keeps the tokenizer's own count to within a few percent", () => {
  const para =
    "The quick brown fox jumps over the lazy dog, then sits down to read the release notes for a tool that " +
    "counts tokens. Numbers like 2026-09-03 and paths such as src/lib/ai/tokenizer.ts appear as well.\n";
  const text = para.repeat(200); // ~40 KB: under the sampling threshold, so this is the windowed exact path
  const exact = getEncoding("cl100k_base").encode(text).length;
  const ours = countTokens(text);
  const drift = Math.abs(ours - exact) / exact;
  assert.ok(drift < 0.03, `windowed count ${ours} vs exact ${exact} (${(drift * 100).toFixed(1)}% drift)`);
});

test("a long ordinary text is estimated by sampling, and lands near the true count", () => {
  const para = "Ordinary sentences, with spaces and punctuation, are what most conversations are made of. ";
  const text = para.repeat(3000); // ~270 KB: over the threshold, so this is the sampled path
  const exact = getEncoding("cl100k_base").encode(text).length;
  const ours = countTokens(text);
  const drift = Math.abs(ours - exact) / exact;
  assert.ok(drift < 0.05, `sampled estimate ${ours} vs exact ${exact} (${(drift * 100).toFixed(1)}% drift)`);
});
