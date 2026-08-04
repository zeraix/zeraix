/**
 * Registry feeds: the index and the kill-list. See docs/plugin-marketplace-design.md §5.1, §5.3.
 *
 * Both are signed envelopes (signature.mjs) wrapping a payload that carries a monotonic `sequence`.
 * The sequence is not decoration -- it is rollback protection, and it is the reason the kill-list
 * works at all. A signature proves a document is genuine; it says nothing about whether it is
 * *current*. Without a sequence check, anyone able to serve stale bytes -- a cache, a proxy, a
 * hostile network -- can replay yesterday's kill-list and silently un-revoke a plugin we pulled.
 * Refusing any feed whose sequence is below the one already stored closes that, and it has to exist
 * from the first release because a client that does not check cannot be taught to later.
 *
 * The index embeds full manifests rather than links to them, so one fetch is one signature is one
 * verified view of the catalogue -- there is no window where the list and its entries disagree.
 */
import { validateManifest } from "./manifest.mjs";
import { verifyEnvelope } from "./signature.mjs";

export const FEED_TYPES = ["index", "killlist"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
/** A version, or "*" meaning every version of that plugin. */
const isVersionSpec = (v) => v === "*" || isNonEmptyString(v);

/**
 * Verify an envelope, check it is the feed we asked for, and reject a rollback.
 *
 * @param {any} envelope
 * @param {{ type: string, cachedSequence?: number, keys: any[] }} options `keys` are the RELEASE
 *   keys the current delegation authorizes (keyring.mjs). A root key is never among them: the trust
 *   anchor signs the delegation and nothing else.
 * @returns {{ ok: boolean, payload: any, keyId: string|null, error: string|null }}
 */
export function openFeed(envelope, { type, cachedSequence = -1, keys } = {}) {
  const fail = (error) => ({ ok: false, payload: null, keyId: null, error });

  const verified = verifyEnvelope(envelope, { keys });
  if (!verified.ok) return fail(verified.error);

  const p = verified.payload;
  if (!isPlainObject(p)) return fail("payload must be an object");
  if (p.type !== type) {
    // A kill-list served where the index was expected would otherwise parse as an empty catalogue,
    // i.e. "no plugins exist" -- a denial of service that looks like a normal empty state.
    return fail(`expected a "${type}" feed, got "${p.type}"`);
  }
  if (!Number.isInteger(p.sequence) || p.sequence < 0) return fail("payload.sequence must be a non-negative integer");
  if (!isNonEmptyString(p.issuedAt)) return fail("payload.issuedAt is required");
  if (p.sequence < cachedSequence) {
    return fail(`rollback refused: feed sequence ${p.sequence} is older than the stored ${cachedSequence}`);
  }

  return { ok: true, payload: p, keyId: verified.keyId, error: null };
}

/**
 * Parse a verified index payload into catalogue entries.
 *
 * Entry-level problems never sink the whole feed: one publisher's bad manifest must not empty the
 * marketplace for everyone. Bad entries are dropped and reported, matching the client-mode posture
 * in manifest.mjs -- registry CI is where a bad manifest is supposed to be caught.
 *
 * @returns {{ entries: Array<{manifest: object, dist: object, warnings: string[]}>, dropped: Array<{at: string, reason: string}> }}
 */
export function parseIndex(payload) {
  const entries = [];
  const dropped = [];

  if (!Array.isArray(payload?.plugins)) {
    return { entries, dropped: [{ at: "payload.plugins", reason: "must be an array" }] };
  }

  const seen = new Set();
  payload.plugins.forEach((raw, i) => {
    const at = `plugins[${i}]`;
    if (!isPlainObject(raw)) return dropped.push({ at, reason: "must be an object" });

    const result = validateManifest(raw.manifest, { mode: "client" });
    if (!result.ok) return dropped.push({ at, reason: result.errors.join("; ") });

    const key = `${result.manifest.id}@${result.manifest.version}`;
    if (seen.has(key)) return dropped.push({ at, reason: `duplicate entry for ${key}` });
    seen.add(key);

    const dist = parseDist(raw.dist);
    if (!dist) return dropped.push({ at, reason: "dist.baseUrl must be an https URL" });

    entries.push({ manifest: result.manifest, dist, warnings: result.warnings });
  });

  return { entries, dropped };
}

/**
 * Where a plugin's files are fetched from. Kept out of the manifest because it is a distribution
 * fact the registry owns, not something the publisher asserts -- and because the hashes that make
 * the URL safe to trust already live on the capabilities (design doc §5.2).
 */
function parseDist(dist) {
  if (!isPlainObject(dist) || !isNonEmptyString(dist.baseUrl)) return null;
  let url;
  try {
    url = new URL(dist.baseUrl);
  } catch {
    return null;
  }
  // Plaintext would let a network attacker serve different bytes; the hash check would catch it, but
  // there is no reason to accept the downgrade in the first place.
  if (url.protocol !== "https:") return null;
  return { baseUrl: url.href.endsWith("/") ? url.href : `${url.href}/` };
}

/**
 * Parse a verified kill-list payload.
 *
 * Malformed entries are FATAL here, unlike the index. A kill-list is a safety mechanism: silently
 * dropping an entry we failed to parse means failing to revoke something, which is the exact
 * outcome the feed exists to prevent. Better to refuse the whole document and keep the last good one.
 *
 * @returns {{ ok: boolean, entries: Array<{id: string, version: string, capability: string|null, reason: string}>, error: string|null }}
 */
export function parseKillList(payload) {
  if (!Array.isArray(payload?.entries)) {
    return { ok: false, entries: [], error: "payload.entries must be an array" };
  }
  const entries = [];
  for (const [i, e] of payload.entries.entries()) {
    const at = `entries[${i}]`;
    if (!isPlainObject(e)) return { ok: false, entries: [], error: `${at} must be an object` };
    if (!isNonEmptyString(e.id)) return { ok: false, entries: [], error: `${at}.id is required` };
    if (!isVersionSpec(e.version)) return { ok: false, entries: [], error: `${at}.version must be a version or "*"` };
    if ("capability" in e && e.capability !== null && !isNonEmptyString(e.capability)) {
      return { ok: false, entries: [], error: `${at}.capability must be a string or null` };
    }
    if (!isNonEmptyString(e.reason)) {
      // Shown to the user when their plugin stops working. "It just disabled itself" is not an
      // acceptable experience, so the reason is mandatory rather than nice to have.
      return { ok: false, entries: [], error: `${at}.reason is required` };
    }
    entries.push({
      id: e.id,
      version: e.version,
      capability: isNonEmptyString(e.capability) ? e.capability : null,
      reason: e.reason,
    });
  }
  return { ok: true, entries, error: null };
}

/**
 * Which kill-list entries apply to an installed plugin.
 *
 * @param {Array} entries parsed kill-list entries
 * @param {{id: string, version: string}} installed
 */
export function killListMatches(entries, installed) {
  return entries.filter((e) => e.id === installed.id && (e.version === "*" || e.version === installed.version));
}
