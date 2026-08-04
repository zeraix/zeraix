/**
 * Root/release key delegation tests. See docs/plugin-marketplace-design.md §5.1.
 *
 * The properties that matter are the ones the two-tier split exists for:
 *   - a release key signs nothing until an offline root says it may
 *   - the root signs delegations and never feeds, and a delegation cannot promote a key to root
 *   - revoking a release key survives a replay of the pre-revocation delegation
 *   - a stolen key expires on its own even if nobody notices
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TRUSTED_ROOT_KEYS, signEnvelope, verifyEnvelope } from "../electron/plugins/signature.mjs";
import {
  activeReleaseKeys,
  cachedDelegationSequence,
  currentReleaseKeys,
  expiringSoon,
  storeDelegation,
  verifyDelegation,
} from "../electron/plugins/keyring.mjs";
import { openFeed } from "../electron/plugins/feed.mjs";
import { setPluginRoot } from "../electron/plugins/storage.mjs";

function makeKey(keyId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  };
}

// Deliberately NOT the real embedded key ids: a fixture sharing an id with a shipped trust anchor
// makes "unknown key" and "wrong signature" indistinguishable in a test.
const ROOT = makeKey("root-test");
const ROOT_NEXT = makeKey("root-test-next");
const REL = makeKey("rel-2026-08");
const REL_NEXT = makeKey("rel-2027-02");
const ROOT_KEYS = [{ keyId: ROOT.keyId, publicKey: ROOT.pub }];

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-04T00:00:00.000Z");

/** A delegation payload as scripts/sign-delegation.mjs produces it. */
function delegation({ keys = [REL], sequence = 1, notBefore = NOW - DAY, notAfter = NOW + 180 * DAY, role = "release" } = {}) {
  return {
    type: "keys",
    sequence,
    issuedAt: new Date(NOW).toISOString(),
    keys: keys.map((k) => ({
      keyId: k.keyId,
      publicKey: k.pub,
      role,
      notBefore: notBefore === null ? null : new Date(notBefore).toISOString(),
      notAfter: notAfter === null ? null : new Date(notAfter).toISOString(),
    })),
  };
}

const signedBy = (signer, payload) => signEnvelope(payload, signer);

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-keyring-"));
  setPluginRoot(dir);
  return dir;
}

/* ------------------------------------------------------- the embedded trust anchors */

test("every embedded root key is a usable ed25519 public key", () => {
  // A typo here ships a client that can verify nothing, and the only fix is another release —
  // the same "cannot be repaired remotely" shape as the Windows publisherName incident. Cheap to
  // check, so check it rather than finding out from users.
  assert.ok(
    TRUSTED_ROOT_KEYS.length > 0,
    "no root key is embedded — the marketplace cannot verify anything. Removing the last one should be deliberate.",
  );

  const ids = new Set();
  for (const key of TRUSTED_ROOT_KEYS) {
    assert.match(key.keyId, /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, `bad keyId: ${key.keyId}`);
    assert.equal(ids.has(key.keyId), false, `duplicate keyId: ${key.keyId}`);
    ids.add(key.keyId);

    const raw = Buffer.from(key.publicKey, "base64");
    // Buffer.from ignores junk instead of throwing, so a mangled paste only shows up as a wrong
    // length or a failed round trip.
    assert.equal(raw.toString("base64"), key.publicKey, `${key.keyId}: publicKey is not clean base64`);
    assert.equal(raw.length, 32, `${key.keyId}: ed25519 keys are 32 bytes, got ${raw.length}`);

    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const parsed = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    assert.equal(parsed.asymmetricKeyType, "ed25519", `${key.keyId}: not an ed25519 key`);
  }
});

test("the shipped key set refuses a delegation from a root it does not embed", () => {
  // Exercises the real TRUSTED_ROOT_KEYS default rather than a fixture: proves the wiring from the
  // embedded set through verifyDelegation is intact, without needing anyone's private half.
  const foreign = verifyDelegation(signedBy(ROOT, delegation()));
  assert.equal(foreign.ok, false, "a delegation from a key we do not embed must be refused");
  assert.match(foreign.error, /not authorized for this document/);
});

/* ------------------------------------------------------------------ delegation */

test("a root-signed delegation verifies and names its release keys", () => {
  const r = verifyDelegation(signedBy(ROOT, delegation()), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.keyId, "root-test");
  assert.deepEqual(activeReleaseKeys(r.payload, NOW).map((k) => k.keyId), ["rel-2026-08"]);
});

test("a delegation signed by anything other than a root key is refused", () => {
  // Including by a release key: a compromised CI must not be able to authorize itself more keys.
  for (const signer of [REL, ROOT_NEXT]) {
    const r = verifyDelegation(signedBy(signer, delegation()), { rootKeys: ROOT_KEYS });
    assert.equal(r.ok, false, `${signer.keyId} must not be able to sign a delegation`);
    assert.match(r.error, /not authorized for this document/);
  }
});

test("a delegation cannot promote a key to root", () => {
  // If `role: "root"` were accepted here, the delegation could authorize the trust anchor to sign
  // feeds — collapsing the two tiers back into one.
  const r = verifyDelegation(signedBy(ROOT, delegation({ role: "root" })), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /role must be one of release/);
});

test("a malformed key entry sinks the whole delegation", () => {
  // This document decides who may sign. Quietly dropping an entry changes that answer in a
  // direction nobody reviewed.
  const bad = delegation();
  bad.keys.push({ keyId: "half", role: "release" }); // no publicKey
  const r = verifyDelegation(signedBy(ROOT, bad), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /publicKey is required/);
});

test("a delegation with no keys is refused", () => {
  const r = verifyDelegation(signedBy(ROOT, delegation({ keys: [] })), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /names no keys/);
});

test("wrong document type is refused even when correctly root-signed", () => {
  const r = verifyDelegation(signedBy(ROOT, { type: "index", sequence: 1, issuedAt: "x", plugins: [] }), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /expected a "keys" document/);
});

test("with no root keys embedded, no delegation verifies", () => {
  const r = verifyDelegation(signedBy(ROOT, delegation()), { rootKeys: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no keys are authorized/);
});

/* ------------------------------------------------------------------ rotation */

test("rotation: both keys authorized at once, so publishing never has a gap", () => {
  const r = verifyDelegation(signedBy(ROOT, delegation({ keys: [REL, REL_NEXT], sequence: 2 })), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(activeReleaseKeys(r.payload, NOW).map((k) => k.keyId), ["rel-2026-08", "rel-2027-02"]);
});

test("root rotation is a client release: a new root is trusted only once embedded", () => {
  const signed = signedBy(ROOT_NEXT, delegation({ sequence: 2 }));
  assert.equal(verifyDelegation(signed, { rootKeys: ROOT_KEYS }).ok, false);

  const bothEmbedded = [...ROOT_KEYS, { keyId: ROOT_NEXT.keyId, publicKey: ROOT_NEXT.pub }];
  assert.equal(verifyDelegation(signed, { rootKeys: bothEmbedded }).ok, true);
});

/* ------------------------------------------------------------------ revocation */

test("revoking a release key: a lower-sequence delegation cannot replay it back", () => {
  const before = delegation({ keys: [REL, REL_NEXT], sequence: 5 });
  const after = delegation({ keys: [REL_NEXT], sequence: 6 }); // rel-2026-08 dropped

  const applied = verifyDelegation(signedBy(ROOT, after), { rootKeys: ROOT_KEYS, cachedSequence: 5 });
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(activeReleaseKeys(applied.payload, NOW).map((k) => k.keyId), ["rel-2027-02"]);

  // Serving the old, still validly-signed delegation must not hand the stolen key its authority back.
  const replay = verifyDelegation(signedBy(ROOT, before), { rootKeys: ROOT_KEYS, cachedSequence: 6 });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /rollback refused/);
});

test("a revoked release key's signature stops being accepted on feeds", () => {
  const after = verifyDelegation(signedBy(ROOT, delegation({ keys: [REL_NEXT], sequence: 6 })), { rootKeys: ROOT_KEYS });
  const keys = activeReleaseKeys(after.payload, NOW);

  const feed = signedBy(REL, { type: "index", sequence: 1, issuedAt: "x", plugins: [] });
  const opened = openFeed(feed, { type: "index", keys });
  assert.equal(opened.ok, false);
  assert.match(opened.error, /not authorized for this document/);
});

/* ------------------------------------------------------------------ expiry */

test("validity windows bound a stolen key even if nobody notices", () => {
  const payload = delegation({ notBefore: NOW - DAY, notAfter: NOW + DAY }).keys;
  const doc = { keys: payload.map((k) => ({ ...k, notBefore: Date.parse(k.notBefore), notAfter: Date.parse(k.notAfter) })) };

  assert.equal(activeReleaseKeys(doc, NOW).length, 1);
  assert.equal(activeReleaseKeys(doc, NOW + 2 * DAY).length, 0, "expired");
  assert.equal(activeReleaseKeys(doc, NOW - 2 * DAY).length, 0, "not yet valid");
});

test("an absent window means no limit, and an unparseable one is an error", () => {
  const open = verifyDelegation(signedBy(ROOT, delegation({ notBefore: null, notAfter: null })), { rootKeys: ROOT_KEYS });
  assert.equal(open.ok, true, open.error);
  assert.equal(activeReleaseKeys(open.payload, NOW + 3650 * DAY).length, 1);

  const bad = delegation();
  bad.keys[0].notAfter = "whenever";
  const r = verifyDelegation(signedBy(ROOT, bad), { rootKeys: ROOT_KEYS });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a valid timestamp/);
});

test("expiringSoon warns before the offline re-signing ceremony is needed", () => {
  const r = verifyDelegation(signedBy(ROOT, delegation({ notAfter: NOW + 10 * DAY })), { rootKeys: ROOT_KEYS });
  assert.deepEqual(expiringSoon(r.payload, 30 * DAY, NOW).map((k) => k.keyId), ["rel-2026-08"]);
  assert.deepEqual(expiringSoon(r.payload, 5 * DAY, NOW), []);
});

/* ------------------------------------------------------------------ storage */

test("the delegation is cached, so an outage does not cost the marketplace", () => {
  freshRoot();
  assert.deepEqual(currentReleaseKeys(NOW), []);
  assert.equal(cachedDelegationSequence(), -1);

  const r = verifyDelegation(signedBy(ROOT, delegation({ sequence: 3 })), { rootKeys: ROOT_KEYS });
  storeDelegation(r.payload);

  assert.equal(cachedDelegationSequence(), 3);
  assert.deepEqual(currentReleaseKeys(NOW).map((k) => k.keyId), ["rel-2026-08"]);
});

test("a client that has never fetched a delegation trusts nothing", () => {
  freshRoot();
  const feed = signedBy(REL, { type: "index", sequence: 1, issuedAt: "x", plugins: [] });
  const opened = openFeed(feed, { type: "index", keys: currentReleaseKeys(NOW) });
  assert.equal(opened.ok, false);
  assert.match(opened.error, /no keys are authorized/);
});

/* ------------------------------------------- what the split does and does not buy */

test("a stolen release key CAN still sign a feed until it is revoked", () => {
  // Stated as a test so the limit is not mistaken for a guarantee: CI holds a key that is genuinely
  // authorized, so a compromise publishes real, verifiable feeds. What the root buys is that the
  // compromise cannot mint new authority and cannot outlive revocation.
  const active = verifyDelegation(signedBy(ROOT, delegation()), { rootKeys: ROOT_KEYS });
  const keys = activeReleaseKeys(active.payload, NOW);

  const malicious = signedBy(REL, { type: "index", sequence: 99, issuedAt: "x", plugins: [] });
  assert.equal(openFeed(malicious, { type: "index", keys }).ok, true);

  // ...and the root, which was never on that machine, is what ends it.
  const revoked = verifyDelegation(signedBy(ROOT, delegation({ keys: [REL_NEXT], sequence: 2 })), { rootKeys: ROOT_KEYS });
  assert.equal(openFeed(malicious, { type: "index", keys: activeReleaseKeys(revoked.payload, NOW) }).ok, false);
});

test("the root key cannot sign a feed even though the client embeds it", () => {
  // Structural, not conventional: feed verification is only ever handed keys that came out of a
  // delegation, and a delegation can only contain release keys.
  const active = verifyDelegation(signedBy(ROOT, delegation()), { rootKeys: ROOT_KEYS });
  const keys = activeReleaseKeys(active.payload, NOW);
  assert.equal(keys.some((k) => k.keyId === ROOT.keyId), false);

  const rootSignedFeed = signedBy(ROOT, { type: "index", sequence: 1, issuedAt: "x", plugins: [] });
  assert.equal(openFeed(rootSignedFeed, { type: "index", keys }).ok, false);
  // And it is refused even against the embedded root set, because openFeed is never given it.
  assert.equal(verifyEnvelope(rootSignedFeed, { keys: ROOT_KEYS }).ok, true, "root sig is valid, just never consulted for feeds");
});
