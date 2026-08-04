/**
 * Talking to the registry. See docs/plugin-marketplace-design.md §5.1, §5.2.
 *
 * The feeds are served from our own API origin -- the same host the app already needs for auth and
 * wallet -- so this adds no new vendor and no new failure domain. It does add a dependency, and the
 * rule that follows is: a registry that is down must be indistinguishable from a registry that has
 * nothing new. Every verified feed is cached, every refresh falls back to the cache, and nothing
 * here throws at the caller.
 *
 * Plugin *artifacts* may live anywhere a publisher hosts them, which is safe only because the index
 * pins their hashes and store.mjs verifies before writing (§5.3). The one thing enforced here is
 * https: the hash would catch tampering, but there is no reason to accept the downgrade.
 */
import { openFeed, parseIndex, parseKillList } from "./feed.mjs";
import {
  cachedDelegationSequence,
  currentReleaseKeys,
  expiringSoon,
  storeDelegation,
  verifyDelegation,
} from "./keyring.mjs";
import { applyKillList } from "./store.mjs";
import { feedFile, readJson, writeJsonAtomic } from "./storage.mjs";

/** A feed is small JSON; a plugin file is small text. Neither justifies a long wait. */
const FEED_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 30_000;
/** A text capability that big is a mistake, and an unbounded read is a memory bug waiting to happen. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

let origin = null;
let fetchImpl = null;

/**
 * @param {{origin: string, fetchImpl?: typeof fetch}} config `origin` is NEXT_PUBLIC_API_BASE_URL;
 *   `fetchImpl` is injected by tests.
 */
export function configureRegistry({ origin: apiOrigin, fetchImpl: impl } = {}) {
  origin = typeof apiOrigin === "string" && apiOrigin ? apiOrigin.replace(/\/+$/, "") : null;
  fetchImpl = impl ?? null;
  return origin;
}

export function isRegistryConfigured() {
  return origin !== null;
}

const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);

async function getJson(url, timeoutMs) {
  const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Sequence of the cached copy, so openFeed can refuse a rollback (feed.mjs). */
function cachedSequence(name) {
  const cached = readJson(feedFile(name));
  return Number.isInteger(cached?.sequence) ? cached.sequence : -1;
}

/**
 * Fetch, verify and cache one feed.
 *
 * A verification failure does NOT fall back to the cache silently -- it is reported, because a feed
 * that fails to verify is a different situation from a feed we could not reach, and only one of
 * them is routine. The cached copy is still what callers keep using either way.
 */
async function refreshFeed(name, type, keys) {
  const previous = readJson(feedFile(name));
  if (!origin) return { payload: previous, fromCache: true, error: "registry origin is not configured" };

  let envelope;
  try {
    envelope = await getJson(`${origin}/plugins/${name}.json`, FEED_TIMEOUT_MS);
  } catch (e) {
    return { payload: previous, fromCache: true, error: `could not reach the registry: ${e.message}` };
  }

  const opened = openFeed(envelope, { type, cachedSequence: cachedSequence(name), keys });
  if (!opened.ok) return { payload: previous, fromCache: true, error: opened.error };

  writeJsonAtomic(feedFile(name), opened.payload);
  return { payload: opened.payload, fromCache: false, error: null };
}

/**
 * Refresh the root-signed delegation naming the release keys (keyring.mjs).
 *
 * Runs before the feeds, every time, because it is what decides whether their signatures mean
 * anything. Fetching it first is also what makes revocation of a stolen release key take effect on
 * the same round trip rather than the next one.
 */
async function refreshDelegation() {
  if (!origin) return { error: "registry origin is not configured" };

  let envelope;
  try {
    envelope = await getJson(`${origin}/plugins/keys.json`, FEED_TIMEOUT_MS);
  } catch (e) {
    // Falling back to the cached delegation is correct: it was root-signed, and it is the last
    // statement of who may sign that we actually verified.
    return { error: `could not reach the registry: ${e.message}` };
  }

  const opened = verifyDelegation(envelope, { cachedSequence: cachedDelegationSequence() });
  if (!opened.ok) return { error: opened.error };

  storeDelegation(opened.payload);
  const soon = expiringSoon(opened.payload);
  if (soon.length > 0) {
    // The root key is offline by design, so re-issuing takes a human at a particular machine. That
    // is exactly the kind of task that needs warning about well before the deadline.
    console.warn(`[plugins] release key(s) expiring soon: ${soon.map((k) => k.keyId).join(", ")}`);
  }
  return { error: null };
}

/**
 * Refresh both feeds and apply the kill-list.
 *
 * Order matters: revoke first, then publish the new catalogue. If the two disagree -- a plugin
 * listed in the index and killed in the kill-list -- the kill wins, and doing it in this order means
 * there is no window where the UI offers something we have just pulled.
 *
 * @returns {Promise<{catalogue: Array, dropped: Array, revoked: Array, fromCache: boolean, errors: string[]}>}
 */
export async function refreshRegistry() {
  const errors = [];

  // Who may sign, before anything signed. A stale or missing delegation is survivable (the cached
  // one still applies); no delegation at all is not, and yields an empty key set below.
  const delegation = await refreshDelegation();
  if (delegation.error) errors.push(`keys: ${delegation.error}`);

  const keys = currentReleaseKeys();
  if (keys.length === 0) {
    // Nothing can be verified, so nothing is fetched. Reporting it as an error rather than an empty
    // catalogue matters: "no plugins exist" and "we cannot tell what exists" are different states.
    return {
      catalogue: cachedCatalogue().entries,
      dropped: [],
      revoked: [],
      fromCache: true,
      errors: [...errors, "no release key is currently authorized — the registry cannot be verified"],
    };
  }

  const kill = await refreshFeed("killlist", "killlist", keys);
  if (kill.error) errors.push(`kill-list: ${kill.error}`);
  let revoked = [];
  if (kill.payload) {
    const parsed = parseKillList(kill.payload);
    if (!parsed.ok) errors.push(`kill-list: ${parsed.error}`);
    else revoked = applyKillList(parsed.entries).revoked;
  }

  const index = await refreshFeed("index", "index", keys);
  if (index.error) errors.push(`index: ${index.error}`);
  const { entries, dropped } = index.payload ? parseIndex(index.payload) : { entries: [], dropped: [] };

  return {
    catalogue: entries,
    dropped,
    revoked,
    fromCache: index.fromCache && kill.fromCache,
    errors,
  };
}

/** The last verified catalogue, without touching the network. What the UI reads on open. */
export function cachedCatalogue() {
  const payload = readJson(feedFile("index"));
  return payload ? parseIndex(payload) : { entries: [], dropped: [] };
}

/**
 * Download one plugin file. Passed to store.installPlugin as `fetchFile`, which verifies the hash
 * before anything is written -- so this deliberately does no integrity checking of its own. Keeping
 * verification in exactly one place is what stops it from being skipped in a second one.
 */
export async function fetchPluginFile(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing a non-https plugin file: ${parsed.protocol}//`);

  const res = await doFetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${parsed.pathname}`);

  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    throw new Error(`plugin file is ${declared} bytes, over the ${MAX_FILE_BYTES} limit`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Re-check after reading: content-length is a claim, not a guarantee.
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw new Error(`plugin file is ${buf.byteLength} bytes, over the ${MAX_FILE_BYTES} limit`);
  }
  return buf;
}
