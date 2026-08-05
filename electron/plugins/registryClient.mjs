/**
 * Talking to the registry. See docs/plugin-marketplace-design.md §5.1, §5.2.
 *
 * The registry itself is a public git repo (github.com/zeraix/registry, REGISTRY_URL in
 * src/constants/App.ts) -- that is where plugins are submitted, reviewed, published and withdrawn.
 * Its CI compiles the two feeds and mirrors them to our own API origin, which is what this module
 * fetches: the same host the app already needs for auth and wallet, so no new vendor and no new
 * failure domain, and it stays reachable from mainland China where raw GitHub is not (§5.2).
 *
 * Nothing here fetches from GitHub, which is why the repo URL is not a constant in this file.
 *
 * A registry that is down must be indistinguishable from a registry that has nothing new. Every
 * accepted feed is cached, every refresh falls back to the cache, and nothing here throws at the
 * caller.
 *
 * Plugin *artifacts* may live anywhere a publisher hosts them, which is safe only because the index
 * pins their hashes and store.mjs verifies before writing (§5.3). The one thing enforced here is
 * https: the hash would catch tampering, but there is no reason to accept the downgrade.
 */
import { openFeed, parseIndex, parseKillList } from "./feed.mjs";
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
 * Fetch, check and cache one feed.
 *
 * A rejected feed does NOT fall back to the cache silently -- it is reported, because a feed we
 * could parse and refused (wrong type, rolled-back sequence) is a different situation from a feed we
 * could not reach, and only one of them is routine. The cached copy is still what callers keep using
 * either way.
 */
async function refreshFeed(name, type) {
  const previous = readJson(feedFile(name));
  if (!origin) return { payload: previous, fromCache: true, error: "registry origin is not configured" };

  let document;
  try {
    document = await getJson(`${origin}/plugins/${name}.json`, FEED_TIMEOUT_MS);
  } catch (e) {
    return { payload: previous, fromCache: true, error: `could not reach the registry: ${e.message}` };
  }

  const opened = openFeed(document, { type, cachedSequence: cachedSequence(name) });
  if (!opened.ok) return { payload: previous, fromCache: true, error: opened.error };

  writeJsonAtomic(feedFile(name), opened.payload);
  return { payload: opened.payload, fromCache: false, error: null };
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

  const kill = await refreshFeed("killlist", "killlist");
  if (kill.error) errors.push(`kill-list: ${kill.error}`);
  let revoked = [];
  if (kill.payload) {
    const parsed = parseKillList(kill.payload);
    if (!parsed.ok) errors.push(`kill-list: ${parsed.error}`);
    else revoked = applyKillList(parsed.entries).revoked;
  }

  const index = await refreshFeed("index", "index");
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

/** The last accepted catalogue, without touching the network. What the UI reads on open. */
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
