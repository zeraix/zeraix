/**
 * Signed-envelope primitives. See docs/plugin-marketplace-design.md §5.1.
 *
 * Everything the registry publishes -- the key delegation, the index, the kill-list -- travels in
 * the same envelope:
 *
 *   { "payload": "<base64 of the exact JSON bytes>", "signatures": [ { keyId, alg, sig } ] }
 *
 * The payload is base64, not an inline object, and that is the whole point. Signing a JSON *object*
 * requires both sides to agree on a canonical serialization -- key order, whitespace, number
 * formatting, unicode escaping -- and every scheme that has tried has produced a signature-bypass
 * bug. Base64 removes the question: the signature covers bytes, and those bytes are what gets parsed.
 *
 * This module knows nothing about WHO may sign WHAT. It verifies an envelope against a key set it is
 * handed; deciding which keys authorize which document is keyring.mjs's job, and keeping that
 * separate is what makes the root/release split enforceable rather than a naming convention.
 */
import crypto from "node:crypto";

export const SIGNATURE_ALG = "ed25519";

/**
 * DER prefix for an ed25519 SubjectPublicKeyInfo. Raw 32-byte keys are far nicer to ship and paste
 * than PEM, and node's createPublicKey only takes SPKI/PEM -- so wrap on the way in.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * ROOT public keys, embedded in the app. The only trust anchor there is.
 *
 * A root key signs ONE thing: the delegation naming the release keys (keyring.mjs). It never signs a
 * feed, it never touches CI, and it lives offline -- so a compromised build pipeline cannot mint a
 * new trusted key or extend its own authority. Rotating a *release* key is a registry operation;
 * rotating a *root* key requires shipping a new client, which is why there is a set here and not a
 * single value: ship the successor alongside the incumbent, then drop the incumbent a release later.
 *
 * An empty set means nothing verifies, which is the correct failure direction: no marketplace rather
 * than an unverified one. Add a key with scripts/gen-registry-key.mjs --role root.
 *
 * These are PUBLIC keys and belong in the repo. The private halves live on the offline machine and
 * must never appear here, in CI, or in any build.
 */
export const TRUSTED_ROOT_KEYS = [
  { keyId: "root-2026", publicKey: "Guuz1J7VSj7oHCLLD5bV0QWQW8dw7RoG30wgTOpmmIE=" },
];

/** Wrap a raw 32-byte ed25519 public key into something node:crypto will accept. */
function toPublicKey(base64Raw) {
  const raw = Buffer.from(base64Raw, "base64");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify a signed envelope against an explicit key set and return its parsed payload.
 *
 * `keys` is required and has no default on purpose. A default would mean some caller, somewhere,
 * verifies a document against whatever set happened to be in scope -- which is exactly how a feed
 * ends up accepted under the root key it was never supposed to be signable by.
 *
 * @param {any} envelope
 * @param {{ keys: Array<{keyId: string, publicKey: string}> }} options
 * @returns {{ ok: boolean, payload: any, keyId: string|null, error: string|null }}
 *   One valid signature from a listed key is enough; the array exists so a document can be co-signed
 *   during a rotation without two publishes.
 */
export function verifyEnvelope(envelope, { keys } = {}) {
  const fail = (error) => ({ ok: false, payload: null, keyId: null, error });

  if (!envelope || typeof envelope !== "object") return fail("envelope must be an object");
  if (typeof envelope.payload !== "string" || envelope.payload.length === 0) {
    return fail("envelope.payload must be a base64 string");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    return fail("envelope.signatures must be a non-empty array");
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    return fail("no keys are authorized to sign this document");
  }

  const message = Buffer.from(envelope.payload, "base64");
  // Buffer.from ignores junk rather than throwing, so a payload that does not round-trip is a
  // malformed document and must not reach the parser.
  if (message.toString("base64").replace(/=+$/, "") !== envelope.payload.replace(/=+$/, "")) {
    return fail("envelope.payload is not valid base64");
  }

  const byId = new Map(keys.map((k) => [k.keyId, k]));
  const tried = [];

  for (const sig of envelope.signatures) {
    if (!sig || typeof sig !== "object") continue;
    if (sig.alg !== SIGNATURE_ALG) {
      tried.push(`${sig.keyId ?? "?"}: unsupported alg "${sig.alg}"`);
      continue;
    }
    const key = byId.get(sig.keyId);
    if (!key) {
      // Not an error on its own: a document co-signed for a rotation carries a key this build has
      // not shipped yet. It only matters if NO signature verifies.
      tried.push(`${sig.keyId}: not authorized for this document`);
      continue;
    }
    if (typeof sig.sig !== "string") {
      tried.push(`${sig.keyId}: signature must be a base64 string`);
      continue;
    }
    let verified = false;
    try {
      verified = crypto.verify(null, message, toPublicKey(key.publicKey), Buffer.from(sig.sig, "base64"));
    } catch (e) {
      tried.push(`${sig.keyId}: ${e.message}`);
      continue;
    }
    if (!verified) {
      tried.push(`${sig.keyId}: signature does not match`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(message.toString("utf8"));
    } catch {
      // Signed but unparseable: the signature is valid over garbage, which means the signer shipped
      // garbage. Never hand it on.
      return fail(`payload signed by ${sig.keyId} is not valid JSON`);
    }
    return { ok: true, payload, keyId: sig.keyId, error: null };
  }

  return fail(`no valid signature: ${tried.join("; ") || "no usable signature entries"}`);
}

/**
 * Build an envelope. Used by the offline root tooling and by registry CI -- the app never signs
 * anything, and there is deliberately no private key of any kind in the client.
 *
 * @param {any} payload
 * @param {{ keyId: string, privateKey: import("node:crypto").KeyObject }} signer
 */
export function signEnvelope(payload, { keyId, privateKey }) {
  const message = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    payload: message.toString("base64"),
    signatures: [{ keyId, alg: SIGNATURE_ALG, sig: crypto.sign(null, message, privateKey).toString("base64") }],
  };
}

/** Add another signature to an existing envelope, for co-signing across a rotation. */
export function coSignEnvelope(envelope, { keyId, privateKey }) {
  const message = Buffer.from(envelope.payload, "base64");
  return {
    ...envelope,
    signatures: [
      ...envelope.signatures,
      { keyId, alg: SIGNATURE_ALG, sig: crypto.sign(null, message, privateKey).toString("base64") },
    ],
  };
}
