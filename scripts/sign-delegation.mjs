#!/usr/bin/env node
/**
 * Sign the release-key delegation with the OFFLINE root key. See docs/plugin-marketplace-design.md §5.1.
 *
 * This is the only thing the root key ever signs.
 *
 * SELF-CONTAINED ON PURPOSE. It imports nothing from this repo, so the offline machine needs Node
 * and this one file — not a checkout, not an install. Copy it next to the root key and forget about
 * it. (The envelope format it writes is pinned to electron/plugins/signature.mjs by a test, so the
 * two cannot drift silently.)
 *
 *   # authorize a release key
 *   node sign-delegation.mjs --root-key root-2026.pem --root-key-id root-2026 \
 *     --key rel-2026-08.pub --out keys.json
 *
 *   # rotate: authorize the new key alongside the old, so publishing never has a gap
 *   node sign-delegation.mjs ... --key rel-2026-08.pub --key rel-2027-02.pub --out keys.json
 *
 *   # revoke: re-issue WITHOUT the compromised key. Clients refuse a lower sequence, so the old
 *   # delegation cannot be replayed to hand it back.
 *   node sign-delegation.mjs ... --key rel-2027-02.pub --out keys.json
 *
 * Keys do not expire by default. Revocation is the mechanism: if a key leaks, issue a delegation
 * without it and every install that fetches one stops accepting its signatures. An expiry window
 * would add a backstop against a leak nobody ever notices, at the cost of a recurring offline
 * ceremony that takes the whole marketplace down if it is ever missed — a worse expected outcome for
 * a small team. Pass --months N if you want one anyway.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SIGNATURE_ALG = "ed25519";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
/** Repeatable flag: --key a.pub --key b.pub */
function args(name) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

/**
 * Build a signed envelope. Mirrors signEnvelope() in electron/plugins/signature.mjs, inlined so this
 * script stands alone; test/plugin-sign-delegation.test.mjs verifies the output still verifies under
 * the real client code.
 */
function signEnvelope(payload, { keyId, privateKey }) {
  const message = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    payload: message.toString("base64"),
    signatures: [{ keyId, alg: SIGNATURE_ALG, sig: crypto.sign(null, message, privateKey).toString("base64") }],
  };
}

const rootKeyPath = arg("root-key");
const rootKeyId = arg("root-key-id");
const keyFiles = args("key");
const outPath = path.resolve(arg("out", "keys.json"));
const months = arg("months") === null ? null : Number(arg("months"));

if (!rootKeyPath || !rootKeyId || keyFiles.length === 0) {
  console.error("usage: node sign-delegation.mjs --root-key <pem> --root-key-id <id> \\");
  console.error("         --key <release.pub> [--key <another.pub>] [--months N] [--sequence N] [--out keys.json]");
  console.error("\nKeys do not expire unless --months is given; use a new delegation to revoke one.");
  process.exit(1);
}
if (months !== null && (!Number.isFinite(months) || months <= 0 || months > 120)) {
  console.error("--months must be between 1 and 120");
  process.exit(1);
}

/** Read a release key's public half, as written by gen-registry-key.mjs. */
function readReleaseKey(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.role !== "release") throw new Error(`${file}: role must be "release", got "${parsed.role}"`);
  if (!parsed.keyId || !parsed.publicKey) throw new Error(`${file}: needs keyId and publicKey`);
  if (parsed.keyId === rootKeyId) throw new Error(`${file}: a root key must never appear in a delegation`);
  return { keyId: parsed.keyId, publicKey: parsed.publicKey };
}

/** Sequence must climb: clients refuse an older delegation, which is what stops a replay. */
function nextSequence() {
  let last = 0;
  if (fs.existsSync(outPath)) {
    try {
      const payload = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(outPath, "utf8")).payload, "base64").toString("utf8"));
      if (Number.isInteger(payload.sequence)) last = payload.sequence;
    } catch {
      /* unreadable previous output: fall through */
    }
  }
  const explicit = arg("sequence");
  if (explicit !== null) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n <= last) throw new Error(`--sequence ${explicit} would roll back the delegation from ${last}`);
    return n;
  }
  return last + 1;
}

try {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(rootKeyPath, "utf8"));
  const now = new Date();
  let notAfter = null;
  if (months !== null) {
    notAfter = new Date(now);
    notAfter.setMonth(notAfter.getMonth() + months);
  }

  const payload = {
    type: "keys",
    sequence: nextSequence(),
    issuedAt: now.toISOString(),
    keys: keyFiles.map(readReleaseKey).map((k) => ({
      ...k,
      role: "release",
      notBefore: now.toISOString(),
      // null, not absent: the client reads null as "no limit" and an unparseable value as an error,
      // so being explicit costs nothing and documents the intent in the published file.
      notAfter: notAfter === null ? null : notAfter.toISOString(),
    })),
  };

  fs.writeFileSync(outPath, `${JSON.stringify(signEnvelope(payload, { keyId: rootKeyId, privateKey }), null, 2)}\n`);

  console.log(`wrote ${outPath} (sequence ${payload.sequence}), signed by ${rootKeyId}`);
  console.log(notAfter === null ? "authorizes (no expiry):" : `authorizes until ${notAfter.toISOString()}:`);
  for (const k of payload.keys) console.log(`  ${k.keyId}`);
  console.log("\nCommit this to the registry repo. To revoke a key later, re-run without it.");
  if (notAfter !== null) {
    console.log("Re-issue before the expiry above, or clients will stop accepting anything the registry signs.");
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
