/**
 * What the client says when a refresh fails. See docs/plugin-marketplace-design.md §5.2.
 *
 * Narrow on purpose: the feed *contents* are covered by plugin-feed.test.mjs and the install round
 * trip by plugin-catalogue.test.mjs. What is pinned here is the diagnosis, because the origin
 * defaults to NEXT_PUBLIC_API_BASE_URL -- a live host already serving auth, wallet and Stripe -- so
 * "no publish endpoint yet" does not surface as a connection error. It surfaces as that API
 * rejecting an unknown route, and calling that "could not reach the registry" sent at least one
 * person off debugging credentials for a subsystem that has none.
 *
 * In every case the refresh still falls back to cache and never throws. Only the message differs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureRegistry, refreshRegistry } from "../electron/plugins/registryClient.mjs";
import { setPluginRoot } from "../electron/plugins/storage.mjs";
import { resetCache } from "../electron/plugins/store.mjs";

const ORIGIN = "https://api.example.com/api";

function client() {
  resetCache();
  setPluginRoot(fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-registry-client-")));
}

/** A fetch that answers every feed request with one status, the way a generic API rejects a route. */
const respondWith = (status) => async () =>
  new Response(JSON.stringify({ success: false, message: "no such route" }), {
    status,
    headers: { "content-type": "application/json" },
  });

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} on a feed path reads as "no registry here", not as an outage`, async () => {
    client();
    configureRegistry({ origin: ORIGIN, fetchImpl: respondWith(status) });

    const result = await refreshRegistry();

    assert.equal(result.fromCache, true, "an unreachable catalogue still falls back to cache");
    assert.ok(result.errors.length > 0, "the failure is reported rather than swallowed");
    for (const message of result.errors) {
      assert.match(message, /serves no plugin registry/, `should name the real cause: ${message}`);
      assert.match(message, new RegExp(String(status)), "should keep the status for a bug report");
      // The old wording. Reporting it for a 401 is what made this confusing enough to test.
      assert.doesNotMatch(message, /could not reach/, `should not read as an outage: ${message}`);
    }
  });
}

test("a transport failure still reads as an outage", async () => {
  client();
  configureRegistry({
    origin: ORIGIN,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.com");
    },
  });

  const result = await refreshRegistry();

  assert.equal(result.fromCache, true);
  assert.ok(result.errors.length > 0);
  for (const message of result.errors) {
    assert.match(message, /could not reach the registry/, `a real outage keeps its wording: ${message}`);
    assert.doesNotMatch(message, /serves no plugin registry/);
  }
});

test("a 500 is an outage, not a missing registry", async () => {
  client();
  configureRegistry({ origin: ORIGIN, fetchImpl: respondWith(500) });

  const result = await refreshRegistry();

  // A server error means the registry is there and broken -- retrying is the right advice, which is
  // the opposite of what "check your origin" would tell someone.
  for (const message of result.errors) {
    assert.match(message, /could not reach the registry: HTTP 500/, message);
  }
});

test("an unconfigured origin is neither: it is a missing configuration", async () => {
  client();
  configureRegistry({ origin: null });

  const result = await refreshRegistry();

  assert.equal(result.fromCache, true);
  for (const message of result.errors) {
    assert.match(message, /origin is not configured/, message);
  }
});
