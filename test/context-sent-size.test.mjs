/**
 * The size of a conversation is the size of what is SENT — replayed thinking included.
 *
 * With "send thinking as context" on, every earlier turn's thinking rides along in each request. It was never
 * counted: a 551-message conversation measured 125K while its requests carried 308K, so the compaction trigger
 * never saw a conversation long enough to summarise, and the meter under-read by the same margin. With the
 * setting off (the default) the thinking is stripped before sending, and must not be counted either.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/srcResolve.mjs", import.meta.url);

// The thinking settings live in localStorage as a JSON object under "agent" (zztool's dotted-path storage).
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const replayThinking = (on) =>
  on ? store.set("agent", JSON.stringify({ thinking: { sendContext: "1" } })) : store.delete("agent");

const { countMessageTokens, countMessagesTokens } = await import("../src/lib/ai/tokenizer.ts");
const { asSent, countSentTokens } = await import("../src/app/agent/chat/chatCompaction.ts");

const THOUGHT = "Let me think about which file holds the handler before reading anything. ".repeat(200);
const conversation = () => [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "find the handler" },
  { role: "assistant", content: "It is in a.ts.", reasoning_content: THOUGHT },
  { role: "user", content: "and the test?" },
  { role: "assistant", content: "In a.test.ts.", reasoning_content: THOUGHT },
];
const cloud = { providerId: "custom", endpoint: "https://api.example.com/v1/chat/completions" };

test("a message's replayed thinking is part of its size", () => {
  const plain = { role: "assistant", content: "It is in a.ts." };
  const withThinking = { ...plain, reasoning_content: THOUGHT };
  assert.ok(countMessageTokens(withThinking) > countMessageTokens(plain) + 1000);
});

test("the same message object counted again reflects thinking that was added or stripped", () => {
  const m = { role: "assistant", content: "It is in a.ts." };
  const before = countMessageTokens(m);
  m.reasoning_content = THOUGHT;
  assert.ok(countMessageTokens(m) > before, "the memo must not hand back the count from before");
  delete m.reasoning_content;
  assert.equal(countMessageTokens(m), before);
});

test("with thinking replay off, a conversation's size leaves its thinking out, as the request does", () => {
  replayThinking(false);
  const c = conversation();
  const stripped = c.map(({ reasoning_content: _r, ...rest }) => rest);
  assert.equal(countSentTokens(c, cloud), countMessagesTokens(stripped));
});

test("with thinking replay on, a conversation's size includes every turn's thinking", () => {
  replayThinking(true);
  try {
    const c = conversation();
    const stripped = c.map(({ reasoning_content: _r, ...rest }) => rest);
    assert.ok(countSentTokens(c, cloud) > countMessagesTokens(stripped) + 2000);
  } finally {
    replayThinking(false);
  }
});

test("the as-sent view lines up with the conversation, so a plan made on it indexes the conversation", () => {
  const c = conversation();
  const view = asSent(c, cloud);
  assert.equal(view.length, c.length);
  assert.deepEqual(view.map((m) => [m.role, m.content]), c.map((m) => [m.role, m.content]));
  assert.ok(c[2].reasoning_content, "the conversation itself is never edited");
});
