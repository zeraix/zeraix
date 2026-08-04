/**
 * The offline signing tool, end to end. See docs/plugin-marketplace-design.md §5.1.
 *
 * `scripts/sign-delegation.mjs` deliberately imports nothing from this repo, so the offline machine
 * needs Node and one file rather than a checkout. That independence is the point and also the risk:
 * it inlines the envelope format, so nothing stops it drifting from electron/plugins/signature.mjs
 * except this file. Every test here runs the real script as a subprocess and verifies the result
 * with the real client code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDelegation, activeReleaseKeys } from "../electron/plugins/keyring.mjs";
import { releaseKeyIdFromDelegation } from "../scripts/build-registry-index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNER = path.join(repoRoot, "scripts", "sign-delegation.mjs");
const GEN = path.join(repoRoot, "scripts", "gen-registry-key.mjs");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-signdel-"));
  execFileSync("node", [GEN, "--role", "root", "--key-id", "root-x", "--out", dir], { stdio: "pipe" });
  execFileSync("node", [GEN, "--role", "release", "--key-id", "rel-a", "--out", dir], { stdio: "pipe" });
  execFileSync("node", [GEN, "--role", "release", "--key-id", "rel-b", "--out", dir], { stdio: "pipe" });
  const rootPub = JSON.parse(fs.readFileSync(path.join(dir, "root-x.pub"), "utf8"));
  return { dir, rootKeys: [{ keyId: rootPub.keyId, publicKey: rootPub.publicKey }] };
}

function sign(dir, extra = []) {
  const out = path.join(dir, "keys.json");
  execFileSync("node", [SIGNER, "--root-key", path.join(dir, "root-x.pem"), "--root-key-id", "root-x", "--out", out, ...extra], {
    stdio: "pipe",
  });
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

/* ------------------------------------------------- the standalone signer agrees with the client */

test("a delegation from the standalone signer verifies under the real client code", () => {
  // The whole reason this file exists: the script inlines signEnvelope, so drift is invisible until
  // a published delegation stops verifying on users' machines.
  const { dir, rootKeys } = workspace();
  const envelope = sign(dir, ["--key", path.join(dir, "rel-a.pub")]);

  const r = verifyDelegation(envelope, { rootKeys });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.keyId, "root-x");
  assert.deepEqual(activeReleaseKeys(r.payload).map((k) => k.keyId), ["rel-a"]);
});

test("keys do not expire by default", () => {
  // The recurring offline ceremony was the single most expensive part of the old design, and
  // revocation already covers the case it guarded. A default that quietly reintroduced it would
  // undo that decision without anyone noticing.
  const { dir, rootKeys } = workspace();
  const r = verifyDelegation(sign(dir, ["--key", path.join(dir, "rel-a.pub")]), { rootKeys });

  assert.equal(r.payload.keys[0].notAfter, null);
  const inTenYears = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
  assert.equal(activeReleaseKeys(r.payload, inTenYears).length, 1, "still authorized a decade later");
});

test("--months still sets a window for anyone who wants one", () => {
  const { dir, rootKeys } = workspace();
  const r = verifyDelegation(sign(dir, ["--key", path.join(dir, "rel-a.pub"), "--months", "6"]), { rootKeys });

  assert.notEqual(r.payload.keys[0].notAfter, null);
  const inSevenMonths = Date.now() + 214 * 24 * 60 * 60 * 1000;
  assert.equal(activeReleaseKeys(r.payload, inSevenMonths).length, 0, "expired");
});

/* ------------------------------------------------------------------ rotation and revocation */

test("rotation authorizes both keys, revocation drops one and climbs the sequence", () => {
  const { dir, rootKeys } = workspace();

  const both = verifyDelegation(sign(dir, ["--key", path.join(dir, "rel-a.pub"), "--key", path.join(dir, "rel-b.pub")]), { rootKeys });
  assert.deepEqual(activeReleaseKeys(both.payload).map((k) => k.keyId), ["rel-a", "rel-b"]);
  assert.equal(both.payload.sequence, 1);

  // Re-run without rel-a: that is what revocation is.
  const after = verifyDelegation(sign(dir, ["--key", path.join(dir, "rel-b.pub")]), { rootKeys, cachedSequence: 1 });
  assert.deepEqual(activeReleaseKeys(after.payload).map((k) => k.keyId), ["rel-b"]);
  assert.equal(after.payload.sequence, 2, "sequence must climb, or the old one could be replayed");
});

test("the signer refuses to put a root key in a delegation", () => {
  const { dir } = workspace();
  // A delegation naming the root would let the trust anchor sign feeds — the two tiers collapsing.
  fs.writeFileSync(
    path.join(dir, "fake.pub"),
    JSON.stringify({ keyId: "root-x", role: "release", publicKey: "x" }),
  );
  assert.throws(() => sign(dir, ["--key", path.join(dir, "fake.pub")]), /Command failed/);
});

test("a public half claiming the wrong role is refused", () => {
  const { dir } = workspace();
  assert.throws(() => sign(dir, ["--key", path.join(dir, "root-x.pub")]), /Command failed/);
});

/* ------------------------------------------------------------------ key id derivation */

test("the release key id is read out of the delegation, not configured twice", () => {
  const { dir } = workspace();
  sign(dir, ["--key", path.join(dir, "rel-a.pub")]);
  assert.equal(releaseKeyIdFromDelegation(dir), "rel-a");
});

test("mid-rotation the key id is ambiguous and must be given", () => {
  const { dir } = workspace();
  sign(dir, ["--key", path.join(dir, "rel-a.pub"), "--key", path.join(dir, "rel-b.pub")]);
  assert.throws(() => releaseKeyIdFromDelegation(dir), /authorizes 2 release keys .* pass --key-id/);
});

test("no delegation, or an unreadable one, is a clear error rather than a guess", () => {
  const { dir } = workspace();
  assert.throws(() => releaseKeyIdFromDelegation(dir), /keys\.json is missing/);

  fs.writeFileSync(path.join(dir, "keys.json"), "not json");
  assert.throws(() => releaseKeyIdFromDelegation(dir), /keys\.json is unreadable/);
});

/* ------------------------------------------------------------------ signing key input */

test("the signing key is accepted as a raw PEM and as base64 of one", () => {
  // GitHub secrets hold multiline values fine, so requiring base64 only ever produced confusing
  // errors. Both must work, because both are what someone will paste.
  const { dir } = workspace();
  sign(dir, ["--key", path.join(dir, "rel-a.pub")]);

  const pem = fs.readFileSync(path.join(dir, "rel-a.pem"), "utf8");
  for (const [label, value] of [["raw PEM", pem], ["base64", Buffer.from(pem, "utf8").toString("base64")]]) {
    const key = crypto.createPrivateKey(value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8"));
    assert.equal(key.asymmetricKeyType, "ed25519", `${label} did not load`);
  }
});
