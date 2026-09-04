/**
 * The pure half of out-of-line result storage (electron/store/resultBlobs.mjs): the walk that swaps large
 * strings for references and back, and what it promises about identity and about a blob that is gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BLOB_MIN_CHARS,
  blobHash,
  collectBlobRefs,
  detachLargeStrings,
  inlineBlobs,
  isBlobRef,
  missingBlobNote,
} from "../electron/store/resultBlobs.mjs";

const big = "x".repeat(BLOB_MIN_CHARS);
const small = "y".repeat(BLOB_MIN_CHARS - 1);

test("a string at the threshold leaves the document and comes back on inline", () => {
  const doc = { conversations: [{ id: "c", messages: [{ role: "tool", content: big }, { role: "assistant", content: small }] }] };
  const sink = new Map();
  const slim = detachLargeStrings(doc, (hash, text) => sink.set(hash, text));
  const ref = slim.conversations[0].messages[0].content;
  assert.ok(isBlobRef(ref), "the large string became a reference");
  assert.equal(ref.n, big.length);
  assert.equal(sink.get(ref.$blob), big);
  assert.equal(slim.conversations[0].messages[1].content, small, "the small one stayed");
  const docSize = JSON.stringify(slim).length;
  // The small string is one char under the threshold, so the document is it plus a few hundred chars of
  // structure — and nothing like the two strings together.
  assert.ok(docSize > small.length && docSize < small.length + 1024, `document is ${docSize} chars`);

  const back = inlineBlobs(slim, (hash) => sink.get(hash));
  assert.deepEqual(back, doc);
});

test("the hash is sha256 of the text, and a blob is the same file whoever wrote it", () => {
  assert.equal(blobHash(big), createHash("sha256").update(big).digest("hex"));
  // Sliced hashing must equal whole hashing across a slice boundary.
  const text = "abc".repeat(1_000_000);
  assert.equal(blobHash(text), createHash("sha256").update(text).digest("hex"));
});

test("subtrees with nothing large in them are returned as the same objects", () => {
  const untouched = { a: [1, "two", { three: small }], d: null, n: 3 };
  const doc = { untouched, changed: { content: big } };
  const slim = detachLargeStrings(doc, () => {});
  assert.notEqual(slim, doc, "the root changed because a descendant did");
  assert.equal(slim.untouched, untouched, "an unchanged subtree is the same object, not a copy");
  const same = detachLargeStrings(untouched, () => {});
  assert.equal(same, untouched, "a document with nothing large costs a walk and no allocation");
  assert.equal(inlineBlobs(untouched, () => "nope"), untouched);
});

test("collectBlobRefs finds every reference, and a missing blob becomes a note rather than a hole", () => {
  const doc = { a: [{ content: big }], b: { nested: { content: big + "!" } } };
  const slim = detachLargeStrings(doc, () => {});
  const refs = collectBlobRefs(slim);
  assert.equal(refs.size, 2);
  const back = inlineBlobs(slim, (hash, n) => missingBlobNote(n));
  assert.match(back.a[0].content, /no longer available/);
  assert.match(back.a[0].content, new RegExp(BLOB_MIN_CHARS.toLocaleString("en-US")));
  assert.equal(typeof back.b.nested.content, "string");
});

test("an object that merely looks like a reference is left alone unless the hash is well-formed", () => {
  assert.equal(isBlobRef({ $blob: "not-a-hash", n: 1 }), false);
  assert.equal(isBlobRef({ $blob: "a".repeat(64), n: 1 }), true);
  assert.equal(isBlobRef(null), false);
  assert.equal(isBlobRef("x"), false);
});
