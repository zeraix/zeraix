/**
 * Keeping a malformed tool call from killing the conversation it appears in.
 *
 * A model can emit a tool call whose `arguments` are not valid JSON — typically a large payload cut off by the
 * output token limit. Reading that was already handled. What was not is what happens NEXT: the assistant turn
 * has to be replayed on every subsequent request (a provider rejects tool results whose `tool_calls` are
 * missing), so the malformed string went back out unchanged and came back as
 *
 *     HTTP 400 — Assistant tool call ***.arguments must be valid JSON.
 *
 * That is not a failed round. The bad call is in the history, so every later request replays it and gets the
 * same 400 — the user cannot send anything, and reopening does not help because it was persisted too. The
 * conversation is dead.
 *
 * These tests pin both halves: a broken call is repaired into something a provider accepts, and a healthy one
 * is returned untouched by reference, because rewriting healthy turns would break the prefix cache on every
 * round to fix a problem they do not have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { sanitizeToolCallArguments } = await import("../src/lib/ai/toolArgs.ts");

const call = (name, args, id = "call_1") => ({ id, type: "function", function: { name, arguments: args } });

/** The check a provider makes, and the only one that decides whether the next request survives. */
const isSendable = (calls) =>
  calls.every((c) => {
    if (typeof c.function.arguments !== "string") return false;
    try {
      JSON.parse(c.function.arguments);
      return true;
    } catch {
      return false;
    }
  });

test("a truncated payload is repaired into something the provider accepts", () => {
  // The reported shape: write_file with a huge body, cut off mid-string by the output limit.
  const truncated = '{"path":"C:\\\\Users\\\\hp\\\\Desktop\\\\js\\\\main.js","content":"const a = 1;\\nconst b';
  const out = sanitizeToolCallArguments([call("write_file", truncated)]);
  assert.ok(isSendable(out), "the repaired call must be valid JSON or the conversation stays dead");
  assert.notEqual(out[0].function.arguments, truncated, "the malformed text must not survive onto the wire");
});

test("what the parser could recover is kept, so the call is not silently emptied", () => {
  // The path survived the truncation; only `content` was cut. Keeping it means the model sees a call that
  // resembles the one it made, alongside the error explaining why it did not run.
  const truncated = '{"path":"main.js","content":"aaaa';
  const out = sanitizeToolCallArguments([call("write_file", truncated)]);
  const parsed = JSON.parse(out[0].function.arguments);
  assert.equal(parsed.path, "main.js", "a recoverable field should be carried through");
});

test("an unrecoverable payload still yields valid JSON rather than propagating", () => {
  for (const junk of ["", "not json at all", "{{{{", "undefined", "[1,2,3"]) {
    const out = sanitizeToolCallArguments([call("read_file", junk)]);
    assert.ok(isSendable(out), `sanitising ${JSON.stringify(junk)} must produce sendable JSON`);
  }
});

test("a healthy turn is returned by reference, so the prefix cache is not broken", () => {
  // The wire copy is deliberately byte-identical on a good round: rewriting it would cost a full re-prefill
  // on every turn of a long conversation. The sanitiser must therefore be a no-op unless something is wrong.
  const calls = [call("read_file", '{"path":"a.ts"}'), call("list_directory", '{"path":"src"}', "call_2")];
  const out = sanitizeToolCallArguments(calls);
  assert.equal(out, calls, "an already-valid round must not be reallocated");
  assert.equal(out[0].function.arguments, '{"path":"a.ts"}', "byte-identical, including key order");
});

test("valid JSON in an unusual spelling is left exactly as it was", () => {
  // Whitespace and key order are not errors. Normalising them would rewrite healthy calls, which is the
  // cache-breaking behaviour the reference check above exists to prevent.
  const odd = '{ "b" : 2,\n  "a" : 1 }';
  const calls = [call("some_tool", odd)];
  assert.equal(sanitizeToolCallArguments(calls), calls);
  assert.equal(calls[0].function.arguments, odd);
});

test("only the broken call in a batch is rewritten", () => {
  const good = call("read_file", '{"path":"a.ts"}');
  const bad = call("write_file", '{"path":"b.ts","content":"xx', "call_2");
  const out = sanitizeToolCallArguments([good, bad]);
  assert.ok(isSendable(out));
  assert.equal(out[0], good, "the healthy call keeps its identity and its bytes");
  assert.notEqual(out[1], bad);
  assert.equal(out[1].id, "call_2", "ids must survive, or tool results no longer pair with their calls");
});

test("a provider that sends arguments as an object is normalised to a JSON string", () => {
  // Some providers send an object rather than an encoded string. It parses fine, but it is not what the
  // wire format specifies, and echoing it back is a 400 on providers that validate the type.
  const out = sanitizeToolCallArguments([call("read_file", { path: "a.ts" })]);
  assert.ok(isSendable(out), "an object must be encoded before it is replayed");
  assert.deepEqual(JSON.parse(out[0].function.arguments), { path: "a.ts" });
});

test("an empty batch is handled without allocating", () => {
  const empty = [];
  assert.equal(sanitizeToolCallArguments(empty), empty);
});
