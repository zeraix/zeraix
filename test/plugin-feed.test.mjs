/**
 * Registry feed tests: signed envelopes, rollback refusal, index and kill-list parsing.
 * See docs/plugin-marketplace-design.md §5.1, §5.3.
 *
 * The properties that matter here are the ones a signature alone does not give you:
 *   - a valid signature over the WRONG feed type must not be accepted
 *   - a valid signature over an OLD document must not be accepted (kill-list rollback)
 *   - a bad entry in the index costs that entry; a bad entry in the kill-list costs the document
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { signEnvelope, verifyEnvelope } from "../electron/plugins/signature.mjs";
import { openFeed, parseIndex, parseKillList, killListMatches } from "../electron/plugins/feed.mjs";

const HASH = `${"a".repeat(86)}==`;

/** A registry keypair, in the shape signature.mjs expects (raw 32-byte public key, base64). */
function makeKey(keyId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { keyId, privateKey, trusted: { keyId, publicKey: raw.toString("base64") } };
}

/** A RELEASE key: what a delegation authorizes to sign feeds. Roots never sign these documents. */
const KEY = makeKey("rel-test");
const OTHER = makeKey("rel-other");
const KEYS = [KEY.trusted];

const manifest = (over = {}) => ({
  schemaVersion: 1,
  id: "alice/postgres",
  version: "1.2.3",
  name: "Postgres",
  description: "Query Postgres from chat.",
  license: "MIT",
  capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH }],
  ...over,
});

const indexPayload = (plugins) => ({
  type: "index",
  sequence: 7,
  issuedAt: "2026-08-04T00:00:00.000Z",
  plugins,
});

const entry = (over = {}) => ({
  manifest: manifest(),
  dist: { baseUrl: "https://cdn.example.com/alice/postgres/1.2.3" },
  ...over,
});

/* ------------------------------------------------------------------ envelope */

test("a signature from a trusted key verifies and yields the payload", () => {
  const env = signEnvelope({ hello: "world" }, KEY);
  const r = verifyEnvelope(env, { keys: KEYS });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.payload, { hello: "world" });
  assert.equal(r.keyId, "rel-test");
});

test("a signature from an untrusted key is refused", () => {
  const env = signEnvelope({ hello: "world" }, OTHER);
  const r = verifyEnvelope(env, { keys: KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorized for this document/);
});

test("tampering with the payload invalidates the signature", () => {
  const env = signEnvelope({ amount: 1 }, KEY);
  env.payload = Buffer.from(JSON.stringify({ amount: 1000 }), "utf8").toString("base64");
  const r = verifyEnvelope(env, { keys: KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /signature does not match/);
});

test("co-signing lets an unknown key id ride along during a rotation", () => {
  // The feed is signed by the new key we have not shipped yet AND the current one. A build that
  // trusts only the current key must still accept it — that is what makes rotation non-breaking.
  const env = signEnvelope({ hello: "world" }, KEY);
  env.signatures.unshift({ keyId: "rel-next", alg: "ed25519", sig: "AAAA" });
  const r = verifyEnvelope(env, { keys: KEYS });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.keyId, "rel-test");
});

test("an unsupported algorithm is refused rather than assumed", () => {
  const env = signEnvelope({ a: 1 }, KEY);
  env.signatures[0].alg = "hmac-sha256";
  assert.match(verifyEnvelope(env, { keys: KEYS }).error, /unsupported alg/);
});

test("with no authorized keys, nothing verifies", () => {
  // The correct failure direction for a client that has never fetched a delegation: no marketplace,
  // not an unverified one.
  const env = signEnvelope({ a: 1 }, KEY);
  assert.match(verifyEnvelope(env, { keys: [] }).error, /no keys are authorized/);
  assert.match(verifyEnvelope(env, {}).error, /no keys are authorized/);
});

test("malformed envelopes fail without throwing", () => {
  for (const bad of [null, 42, {}, { payload: "" }, { payload: "abc" }, { payload: "abc", signatures: [] }]) {
    const r = verifyEnvelope(bad, { keys: KEYS });
    assert.equal(r.ok, false);
    assert.equal(r.payload, null);
  }
});

test("a signature over non-JSON is reported, never handed on", () => {
  const message = Buffer.from("not json", "utf8");
  const env = {
    payload: message.toString("base64"),
    signatures: [{ keyId: KEY.keyId, alg: "ed25519", sig: crypto.sign(null, message, KEY.privateKey).toString("base64") }],
  };
  assert.match(verifyEnvelope(env, { keys: KEYS }).error, /not valid JSON/);
});

/* ------------------------------------------------------------------ openFeed */

test("openFeed accepts a current feed of the expected type", () => {
  const env = signEnvelope(indexPayload([]), KEY);
  const r = openFeed(env, { type: "index", cachedSequence: 7, keys: KEYS });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.payload.sequence, 7);
});

test("a validly signed feed of the wrong type is refused", () => {
  // A kill-list served where the index was expected would parse as an empty catalogue — a denial
  // of service that looks exactly like a normal empty state.
  const env = signEnvelope({ type: "killlist", sequence: 1, issuedAt: "x", entries: [] }, KEY);
  const r = openFeed(env, { type: "index", keys: KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /expected a "index" feed, got "killlist"/);
});

test("a validly signed OLDER feed is refused as a rollback", () => {
  // The kill-list attack this exists to stop: replay yesterday's document to un-revoke a plugin.
  const env = signEnvelope({ type: "killlist", sequence: 4, issuedAt: "x", entries: [] }, KEY);
  const r = openFeed(env, { type: "killlist", cachedSequence: 9, keys: KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /rollback refused/);

  // Re-serving the SAME sequence is fine — that is just a cache, not a rollback.
  const same = signEnvelope({ type: "killlist", sequence: 9, issuedAt: "x", entries: [] }, KEY);
  assert.equal(openFeed(same, { type: "killlist", cachedSequence: 9, keys: KEYS }).ok, true);
});

test("openFeed requires a sequence and an issuedAt", () => {
  for (const payload of [
    { type: "index", issuedAt: "x" },
    { type: "index", sequence: -1, issuedAt: "x" },
    { type: "index", sequence: 1 },
  ]) {
    const r = openFeed(signEnvelope(payload, KEY), { type: "index", keys: KEYS });
    assert.equal(r.ok, false);
  }
});

/* ------------------------------------------------------------------ index */

test("parseIndex validates each manifest and keeps the good ones", () => {
  const { entries, dropped } = parseIndex(indexPayload([entry()]));
  assert.equal(entries.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(entries[0].manifest.publisher, "alice");
  assert.equal(entries[0].dist.baseUrl.endsWith("/"), true); // normalized for URL resolution
});

test("one publisher's bad manifest does not empty the marketplace", () => {
  const { entries, dropped } = parseIndex(
    indexPayload([entry({ manifest: manifest({ id: "BAD ID" }) }), entry()]),
  );
  assert.equal(entries.length, 1);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /id must be/);
});

test("a plaintext dist url is refused", () => {
  const { entries, dropped } = parseIndex(
    indexPayload([entry({ dist: { baseUrl: "http://cdn.example.com/x" } })]),
  );
  assert.equal(entries.length, 0);
  assert.match(dropped[0].reason, /https/);
});

test("duplicate id@version entries are dropped", () => {
  const { entries, dropped } = parseIndex(indexPayload([entry(), entry()]));
  assert.equal(entries.length, 1);
  assert.match(dropped[0].reason, /duplicate entry for alice\/postgres@1\.2\.3/);
});

/* ------------------------------------------------------------------ kill-list */

test("parseKillList accepts plugin-wide and per-capability entries", () => {
  const r = parseKillList({
    entries: [
      { id: "alice/postgres", version: "*", reason: "credential theft" },
      { id: "bob/tool", version: "2.0.0", capability: "run", reason: "arbitrary write" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entries[0].capability, null);
  assert.equal(r.entries[1].capability, "run");
});

test("a malformed kill-list entry rejects the WHOLE document", () => {
  // Opposite of the index on purpose: dropping an unparseable entry means failing to revoke
  // something, which is the exact outcome the feed exists to prevent.
  for (const bad of [
    [{ id: "alice/x", version: "*" }], // no reason
    [{ version: "*", reason: "r" }], // no id
    [{ id: "alice/x", version: "*", capability: 42, reason: "r" }],
    ["nope"],
  ]) {
    const r = parseKillList({ entries: bad });
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to sink the document`);
    assert.equal(r.entries.length, 0);
  }
});

test("killListMatches respects the version spec", () => {
  const entries = parseKillList({
    entries: [
      { id: "alice/postgres", version: "1.2.3", reason: "a" },
      { id: "bob/tool", version: "*", reason: "b" },
    ],
  }).entries;

  assert.equal(killListMatches(entries, { id: "alice/postgres", version: "1.2.3" }).length, 1);
  assert.equal(killListMatches(entries, { id: "alice/postgres", version: "1.2.4" }).length, 0);
  assert.equal(killListMatches(entries, { id: "bob/tool", version: "9.9.9" }).length, 1);
  assert.equal(killListMatches(entries, { id: "carol/x", version: "1.0.0" }).length, 0);
});
