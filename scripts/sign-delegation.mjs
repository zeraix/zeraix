#!/usr/bin/env node
/**
 * Sign the release-key delegation with the OFFLINE root key. See docs/plugin-marketplace-design.md §5.1.
 *
 * This is the only thing the root key ever signs. Run it on the offline machine that holds the root
 * private key; nothing secret needs to leave that machine -- release keys arrive as `.pub` files
 * (public halves only), and what comes back out is a signed `keys.json` that is safe to publish.
 *
 *   # authorize one release key for six months
 *   node scripts/sign-delegation.mjs --root-key ~/keys/root-2026.pem --root-key-id root-2026 \
 *     --key rel-2026-08.pub --months 6 --out keys.json
 *
 *   # rotate: authorize the new key alongside the old one, so publishing never has a gap
 *   node scripts/sign-delegation.mjs ... --key rel-2026-08.pub --key rel-2027-02.pub --months 6 --out keys.json
 *
 *   # revoke: re-issue WITHOUT the compromised key. Clients refuse a lower sequence, so the old
 *   # delegation cannot be replayed to hand it back.
 *   node scripts/sign-delegation.mjs ... --key rel-2027-02.pub --sequence 4 --out keys.json
 *
 * The sequence must increase on every issuance. It is read from the previous keys.json when --out
 * already exists; pass --sequence to set it explicitly (it is refused if it would go backwards).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { signEnvelope } from "../electron/plugins/signature.mjs";

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

const rootKeyPath = arg("root-key");
const rootKeyId = arg("root-key-id");
const keyFiles = args("key");
const outPath = path.resolve(arg("out", "keys.json"));
const months = Number(arg("months", "6"));

if (!rootKeyPath || !rootKeyId || keyFiles.length === 0) {
  console.error("usage: node scripts/sign-delegation.mjs --root-key <pem> --root-key-id <id> \\");
  console.error("         --key <release.pub> [--key <another.pub>] [--months 6] [--sequence N] [--out keys.json]");
  process.exit(1);
}
if (!Number.isFinite(months) || months <= 0 || months > 24) {
  // An unbounded delegation defeats the point: a stolen release key would be good forever. Two
  // years is already generous for something an offline ceremony has to renew.
  console.error("--months must be between 1 and 24");
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
  const notAfter = new Date(now);
  notAfter.setMonth(notAfter.getMonth() + months);

  const payload = {
    type: "keys",
    sequence: nextSequence(),
    issuedAt: now.toISOString(),
    keys: keyFiles.map(readReleaseKey).map((k) => ({
      ...k,
      role: "release",
      notBefore: now.toISOString(),
      notAfter: notAfter.toISOString(),
    })),
  };

  fs.writeFileSync(outPath, `${JSON.stringify(signEnvelope(payload, { keyId: rootKeyId, privateKey }), null, 2)}\n`);

  console.log(`wrote ${outPath} (sequence ${payload.sequence}), signed by ${rootKeyId}`);
  console.log(`authorizes until ${notAfter.toISOString()}:`);
  for (const k of payload.keys) console.log(`  ${k.keyId}`);
  console.log("\nPublish this next to index.json. Re-issue before the expiry above, or clients will");
  console.log("stop accepting anything the registry signs.");
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
