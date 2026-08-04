#!/usr/bin/env node
/**
 * Generate a registry signing key. See docs/plugin-marketplace-design.md §5.1.
 *
 * Two roles, with deliberately different handling:
 *
 *   --role root      The trust anchor. Generate it on an OFFLINE machine and keep the private half
 *                    there forever. It signs exactly one kind of document -- the delegation naming
 *                    the release keys (scripts/sign-delegation.mjs) -- and never a feed. Its public
 *                    half is pasted into TRUSTED_ROOT_KEYS in electron/plugins/signature.mjs, so
 *                    rotating it costs a client release. Never put it in CI. Never put it in a repo.
 *
 *   --role release   Signs the index and kill-list on every publish. Lives in registry CI as
 *                    REGISTRY_SIGNING_KEY. Assume it will eventually leak; that is what the root and
 *                    the delegation's expiry window are for.
 *
 *   node scripts/gen-registry-key.mjs --role root    --key-id root-2026
 *   node scripts/gen-registry-key.mjs --role release --key-id rel-2026-08
 *
 * Rotation is why every signature carries a key id. Rolling a RELEASE key is a registry operation:
 * generate a new one, sign a delegation listing it, publish -- existing installs pick it up with no
 * client change. Rolling the ROOT key means shipping a client that trusts both, then dropping the
 * old one a release later. The Windows publisherName incident (v1.7.0/v1.8.0) was exactly a
 * rotation-hostile identity baked into shipped clients, and it could not be repaired remotely.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const role = arg("role");
const keyId = arg("key-id");

if (!["root", "release"].includes(role) || !keyId || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(keyId)) {
  console.error("usage: node scripts/gen-registry-key.mjs --role root|release --key-id <id> [--out <dir>]");
  console.error('  <id> is lowercase [a-z0-9-], e.g. "root-2026" or "rel-2026-08". Date it — you will rotate.');
  process.exit(1);
}

const outDir = path.resolve(arg("out", path.join(os.homedir(), ".zeraix-registry-keys")));
const privatePath = path.join(outDir, `${keyId}.pem`);
const publicPath = path.join(outDir, `${keyId}.pub`);

if (fs.existsSync(privatePath)) {
  // Overwriting a signing key silently is how a registry loses the ability to publish updates for
  // everything already signed with it.
  console.error(`refusing to overwrite an existing key: ${privatePath}`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
// signature.mjs stores raw 32-byte keys and wraps them into SPKI on the way in — far nicer to paste
// into a source file, or into a delegation, than a PEM block.
const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
// The public half is written too, so the release key can be handed to the offline root machine
// without moving anything secret.
fs.writeFileSync(publicPath, `${JSON.stringify({ keyId, role, publicKey: rawPublic }, null, 2)}\n`);

console.log(`private key  ${privatePath}  (mode 0600 — never commit)`);
console.log(`public  key  ${publicPath}\n`);

if (role === "root") {
  console.log("This is the TRUST ANCHOR. Keep this machine offline and this key on it.\n");
  console.log("Add to TRUSTED_ROOT_KEYS in electron/plugins/signature.mjs:\n");
  console.log(`  { keyId: ${JSON.stringify(keyId)}, publicKey: ${JSON.stringify(rawPublic)} },\n`);
  console.log("Then ship a client release. Clients only accept a delegation signed by a root key");
  console.log("they already embed, so a build shipped before this will ignore anything it signs.");
} else {
  console.log("This is a RELEASE key. It signs feeds; it is not trusted on its own.\n");
  console.log("1. Store the private key in registry CI:\n");
  console.log(`     base64 -w0 ${privatePath}    # -> REGISTRY_SIGNING_KEY secret\n`);
  console.log(`2. Copy ${path.basename(publicPath)} to the offline root machine and authorize it:\n`);
  console.log(`     node scripts/sign-delegation.mjs --root-key <root.pem> --root-key-id <root-id> \\`);
  console.log(`       --key ${path.basename(publicPath)} --months 6 --out keys.json\n`);
  console.log("3. Publish the resulting keys.json alongside index.json. Until then this key signs");
  console.log("   nothing a client will accept.");
}
