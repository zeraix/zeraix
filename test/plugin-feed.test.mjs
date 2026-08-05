/**
 * Registry feed tests: feed-type and rollback refusal, index and kill-list parsing.
 * See docs/plugin-marketplace-design.md §5.1, §5.3.
 *
 * The feeds carry no signature (§5.1), which makes the checks that remain the whole of the client's
 * defence rather than a second layer behind one:
 *   - a document of the WRONG feed type must not be accepted as an empty catalogue
 *   - an OLD document must not be accepted (kill-list rollback)
 *   - a bad entry in the index costs that entry; a bad entry in the kill-list costs the document
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openFeed, parseIndex, parseKillList, killListMatches } from "../electron/plugins/feed.mjs";

const HASH = `${"a".repeat(86)}==`;

const manifest = (over = {}) => ({
  schemaVersion: 1,
  id: "alice/postgres",
  version: "1.2.3",
  name: "Postgres",
  description: "Query Postgres from chat.",
  license: "MIT",
  capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH }],
  ...over,
});

const indexPayload = (plugins) => ({
  type: "index",
  sequence: 7,
  issuedAt: "2026-08-04T00:00:00.000Z",
  plugins,
});

const entry = (over = {}) => ({
  manifest: manifest(),
  dist: { baseUrl: "https://cdn.example.com/alice/postgres/1.2.3" },
  ...over,
});

/* ------------------------------------------------------------------ openFeed */

test("openFeed accepts a current feed of the expected type", () => {
  const r = openFeed(indexPayload([]), { type: "index", cachedSequence: 7 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.payload.sequence, 7);
});

test("a feed of the wrong type is refused", () => {
  // A kill-list served where the index was expected would parse as an empty catalogue — a denial
  // of service that looks exactly like a normal empty state.
  const r = openFeed({ type: "killlist", sequence: 1, issuedAt: "x", entries: [] }, { type: "index" });
  assert.equal(r.ok, false);
  assert.match(r.error, /expected a "index" feed, got "killlist"/);
});

test("an OLDER feed is refused as a rollback", () => {
  // The kill-list attack this exists to stop: replay yesterday's document to un-revoke a plugin.
  // Nothing upstream can catch this — a stale copy served by a cache is byte-for-byte genuine.
  const r = openFeed({ type: "killlist", sequence: 4, issuedAt: "x", entries: [] }, { type: "killlist", cachedSequence: 9 });
  assert.equal(r.ok, false);
  assert.match(r.error, /rollback refused/);

  // Re-serving the SAME sequence is fine — that is just a cache, not a rollback.
  const same = { type: "killlist", sequence: 9, issuedAt: "x", entries: [] };
  assert.equal(openFeed(same, { type: "killlist", cachedSequence: 9 }).ok, true);
});

test("openFeed requires a sequence and an issuedAt", () => {
  for (const payload of [
    { type: "index", issuedAt: "x" },
    { type: "index", sequence: -1, issuedAt: "x" },
    { type: "index", sequence: 1 },
  ]) {
    assert.equal(openFeed(payload, { type: "index" }).ok, false);
  }
});

test("a malformed document fails without throwing", () => {
  for (const bad of [null, 42, "{}", [], {}]) {
    const r = openFeed(bad, { type: "index" });
    assert.equal(r.ok, false);
    assert.equal(r.payload, null);
  }
});

/* ------------------------------------------------------------------ index */

test("parseIndex validates each manifest and keeps the good ones", () => {
  const { entries, dropped } = parseIndex(indexPayload([entry()]));
  assert.equal(entries.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(entries[0].manifest.publisher, "alice");
  assert.equal(entries[0].dist.baseUrl.endsWith("/"), true); // normalized for URL resolution
});

test("one publisher's bad manifest does not empty the marketplace", () => {
  const { entries, dropped } = parseIndex(
    indexPayload([entry({ manifest: manifest({ id: "BAD ID" }) }), entry()]),
  );
  assert.equal(entries.length, 1);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /id must be/);
});

test("a plaintext dist url is refused", () => {
  const { entries, dropped } = parseIndex(
    indexPayload([entry({ dist: { baseUrl: "http://cdn.example.com/x" } })]),
  );
  assert.equal(entries.length, 0);
  assert.match(dropped[0].reason, /https/);
});

test("duplicate id@version entries are dropped", () => {
  const { entries, dropped } = parseIndex(indexPayload([entry(), entry()]));
  assert.equal(entries.length, 1);
  assert.match(dropped[0].reason, /duplicate entry for alice\/postgres@1\.2\.3/);
});

/* ------------------------------------------------------------------ kill-list */

test("parseKillList accepts plugin-wide and per-capability entries", () => {
  const r = parseKillList({
    entries: [
      { id: "alice/postgres", version: "*", reason: "credential theft" },
      { id: "bob/tool", version: "2.0.0", capability: "run", reason: "arbitrary write" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entries[0].capability, null);
  assert.equal(r.entries[1].capability, "run");
});

test("a malformed kill-list entry rejects the WHOLE document", () => {
  // Opposite of the index on purpose: dropping an unparseable entry means failing to revoke
  // something, which is the exact outcome the feed exists to prevent.
  for (const bad of [
    [{ id: "alice/x", version: "*" }], // no reason
    [{ version: "*", reason: "r" }], // no id
    [{ id: "alice/x", version: "*", capability: 42, reason: "r" }],
    ["nope"],
  ]) {
    const r = parseKillList({ entries: bad });
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to sink the document`);
    assert.equal(r.entries.length, 0);
  }
});

test("killListMatches respects the version spec", () => {
  const entries = parseKillList({
    entries: [
      { id: "alice/postgres", version: "1.2.3", reason: "a" },
      { id: "bob/tool", version: "*", reason: "b" },
    ],
  }).entries;

  assert.equal(killListMatches(entries, { id: "alice/postgres", version: "1.2.3" }).length, 1);
  assert.equal(killListMatches(entries, { id: "alice/postgres", version: "1.2.4" }).length, 0);
  assert.equal(killListMatches(entries, { id: "bob/tool", version: "9.9.9" }).length, 1);
  assert.equal(killListMatches(entries, { id: "carol/x", version: "1.0.0" }).length, 0);
});
