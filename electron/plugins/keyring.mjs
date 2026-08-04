/**
 * Who may sign what. See docs/plugin-marketplace-design.md §5.1.
 *
 * Two tiers, because they have different exposure:
 *
 *   ROOT     Offline. Never in CI, never on a build machine. Signs exactly one kind of document --
 *            the delegation below -- and nothing else, ever. Its public half is embedded in the app
 *            (signature.mjs TRUSTED_ROOT_KEYS), so rotating it costs a client release.
 *   RELEASE  Lives in registry CI. Signs the index and the kill-list on every publish. Rotating or
 *            revoking one is a registry operation: the root issues a new delegation and existing
 *            installs pick it up. No client release needed.
 *
 * The delegation is the bridge: a root-signed document naming the release keys and how long each is
 * good for. A client trusts a feed only if (a) the delegation verifies under an embedded root key,
 * and (b) the feed verifies under a release key that delegation currently authorizes.
 *
 * What this buys, stated precisely: a compromised CI can still publish feeds, because it holds a key
 * that is genuinely authorized to sign them. What it CANNOT do is mint a new key, promote itself, or
 * outlive revocation -- the root survives the compromise, so the operator can issue a delegation
 * dropping the stolen key and every install that fetches it stops accepting that key's signatures.
 * The blast radius is bounded in time rather than eliminated; see §5.1 for what would be needed to
 * close it further.
 *
 * Like the feeds, the delegation carries a monotonic `sequence` and an older one is refused. Without
 * that, anyone able to serve stale bytes could replay the delegation from before a key was revoked
 * and hand the stolen key its authority back.
 */
import { verifyEnvelope, TRUSTED_ROOT_KEYS } from "./signature.mjs";
import { feedFile, readJson, writeJsonAtomic } from "./storage.mjs";

export const KEY_ROLES = ["release"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/** An ISO timestamp, or null when absent. Anything unparseable is an error, never "no limit". */
function parseTime(value, label, errors) {
  if (value === undefined || value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    errors.push(`${label} is not a valid timestamp`);
    return null;
  }
  return ms;
}

/**
 * Verify a delegation envelope under the embedded root keys and parse it.
 *
 * @param {any} envelope
 * @param {{ rootKeys?: any[], cachedSequence?: number }} [options]
 * @returns {{ ok: boolean, payload: object|null, keyId: string|null, error: string|null }}
 */
export function verifyDelegation(envelope, { rootKeys = TRUSTED_ROOT_KEYS, cachedSequence = -1 } = {}) {
  const fail = (error) => ({ ok: false, payload: null, keyId: null, error });

  const verified = verifyEnvelope(envelope, { keys: rootKeys });
  if (!verified.ok) return fail(`delegation: ${verified.error}`);

  const p = verified.payload;
  if (!isPlainObject(p)) return fail("delegation payload must be an object");
  if (p.type !== "keys") return fail(`expected a "keys" document, got "${p.type}"`);
  if (!Number.isInteger(p.sequence) || p.sequence < 0) return fail("delegation.sequence must be a non-negative integer");
  if (!isNonEmptyString(p.issuedAt)) return fail("delegation.issuedAt is required");
  if (p.sequence < cachedSequence) {
    // Replaying a pre-revocation delegation would hand a stolen release key its authority back.
    return fail(`rollback refused: delegation sequence ${p.sequence} is older than the stored ${cachedSequence}`);
  }
  if (!Array.isArray(p.keys)) return fail("delegation.keys must be an array");

  const errors = [];
  const keys = [];
  p.keys.forEach((k, i) => {
    const at = `delegation.keys[${i}]`;
    if (!isPlainObject(k)) return errors.push(`${at} must be an object`);
    if (!isNonEmptyString(k.keyId)) return errors.push(`${at}.keyId is required`);
    if (!isNonEmptyString(k.publicKey)) return errors.push(`${at}.publicKey is required`);
    if (!KEY_ROLES.includes(k.role)) {
      // A root key must never appear here. If it did, a delegation would be able to authorize the
      // trust anchor to sign feeds, collapsing the two tiers back into one.
      return errors.push(`${at}.role must be one of ${KEY_ROLES.join("|")} (got "${k.role}")`);
    }
    const notBefore = parseTime(k.notBefore, `${at}.notBefore`, errors);
    const notAfter = parseTime(k.notAfter, `${at}.notAfter`, errors);
    keys.push({ keyId: k.keyId, publicKey: k.publicKey, role: k.role, notBefore, notAfter });
  });

  // A malformed entry is fatal rather than skipped: this document decides who may sign, and quietly
  // dropping an entry we failed to parse changes that answer in a direction nobody reviewed.
  if (errors.length > 0) return fail(errors.join("; "));
  if (keys.length === 0) return fail("delegation names no keys");

  return { ok: true, payload: { ...p, keys }, keyId: verified.keyId, error: null };
}

/**
 * The release keys a delegation authorizes right now.
 *
 * Validity windows are enforced when present, so a stolen key stops working even if nobody notices
 * in time. They depend on the local clock, which is worth knowing: a badly wrong clock can make a
 * valid delegation look expired and leave that machine without a marketplace. It cannot make an
 * expired one look valid *and* useful, because the feed itself is still rollback-protected.
 */
export function activeReleaseKeys(payload, now = Date.now()) {
  return (payload?.keys ?? []).filter(
    (k) => k.role === "release" && (k.notBefore === null || now >= k.notBefore) && (k.notAfter === null || now <= k.notAfter),
  );
}

/** Keys expiring within `withinMs`, so the operator hears about it before the marketplace stops. */
export function expiringSoon(payload, withinMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()) {
  return activeReleaseKeys(payload, now).filter((k) => k.notAfter !== null && k.notAfter - now <= withinMs);
}

/* ------------------------------------------------------------------ storage */

const FEED_NAME = "keys";

/** The last verified delegation, or null. Cached so an outage does not cost the marketplace. */
export function cachedDelegation() {
  return readJson(feedFile(FEED_NAME));
}

export function cachedDelegationSequence() {
  const cached = cachedDelegation();
  return Number.isInteger(cached?.sequence) ? cached.sequence : -1;
}

export function storeDelegation(payload) {
  writeJsonAtomic(feedFile(FEED_NAME), payload);
}

/**
 * Release keys authorized by the cached delegation. What feed verification is handed.
 *
 * Returns an empty array when there is no delegation yet, which means nothing verifies -- again the
 * correct failure direction. A client that has never successfully fetched a delegation has no basis
 * for trusting anything the registry says.
 */
export function currentReleaseKeys(now = Date.now()) {
  return activeReleaseKeys(cachedDelegation(), now);
}
