/**
 * Registry builder tests, ending in a full round trip.
 * See docs/plugin-marketplace-design.md §5.1, §5.4.
 *
 * The round trip is the point of this file: a registry source tree goes in, and a plugin comes out
 * installed and active on the client side, having passed every gate on the way -- strict validation,
 * feed acceptance, rollback refusal, hash verification. Each piece is unit-tested elsewhere; nothing
 * but an end-to-end run proves the builder and the client agree on the same format.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildIndex,
  buildKillList,
  collectPluginDirs,
  nextSequence,
  resolveArtifacts,
} from "../scripts/build-registry-index.mjs";
import { openFeed, parseIndex, parseKillList } from "../electron/plugins/feed.mjs";
import { setPluginRoot } from "../electron/plugins/storage.mjs";
import { activeCapabilities, applyKillList, getInstalled, installPlugin, resetCache } from "../electron/plugins/store.mjs";

const BASE_URL = "https://cdn.example.com/plugins";
const SKILL = "# Postgres\n\nBe careful with DELETE.\n";

/** A registry repo on disk: plugins/<publisher>/<name>/<version>/{plugin.json,files/}. */
function registry({ manifest = {}, files = { "skill.md": SKILL }, publisher = "alice", name = "postgres", version = "1.2.3" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-registry-"));
  const dir = path.join(root, "plugins", publisher, name, version);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });

  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, "files", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: `${publisher}/${name}`,
      version,
      name: "Postgres",
      description: "Query Postgres from chat.",
      license: "MIT",
      // No sha512: the builder computes it. That is the point -- a hand-written digest is a
      // transcription error waiting to break an install for everyone.
      capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md" }],
      ...manifest,
    }),
  );
  return root;
}

const build = (root, over = {}) =>
  buildIndex(root, { baseUrl: BASE_URL, sequence: 1, issuedAt: "2026-08-04T00:00:00.000Z", ...over });

/* ------------------------------------------------------------------ collect */

test("collectPluginDirs finds every publisher/name/version, sorted", () => {
  const root = registry();
  fs.mkdirSync(path.join(root, "plugins", "bob", "tool", "0.1.0"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "bob", "tool", "0.1.0", "plugin.json"), "{}");
  // A directory without a plugin.json is scaffolding, not a submission.
  fs.mkdirSync(path.join(root, "plugins", "carol", "empty", "1.0.0"), { recursive: true });

  assert.deepEqual(
    collectPluginDirs(root).map((e) => `${e.publisher}/${e.name}@${e.version}`),
    ["alice/postgres@1.2.3", "bob/tool@0.1.0"],
  );
});

/* ------------------------------------------------------------------ hashing */

test("hashes are computed from the bytes, not taken on trust", () => {
  const root = registry();
  const filesDir = path.join(root, "plugins", "alice", "postgres", "1.2.3", "files");
  const source = JSON.parse(fs.readFileSync(path.join(root, "plugins", "alice", "postgres", "1.2.3", "plugin.json"), "utf8"));

  const r = resolveArtifacts(source, filesDir);
  assert.deepEqual(r.problems, []);
  assert.equal(r.manifest.capabilities[0].sha512, crypto.createHash("sha512").update(SKILL).digest("base64"));
  assert.equal(source.capabilities[0].sha512, undefined, "the source must not be mutated");
});

test("a declared hash that disagrees with the bytes fails the build", () => {
  // Manifest and artifact from different builds: one of them is not what the publisher reviewed.
  const root = registry({ manifest: { capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md", sha512: `${"a".repeat(86)}==` }] } });
  const r = build(root);
  assert.equal(r.payload, null);
  assert.match(r.problems.join("\n"), /declared sha512 does not match files\/skill\.md/);
});

test("a manifest referencing a missing file fails the build", () => {
  const root = registry({ files: {} });
  const r = build(root);
  assert.equal(r.payload, null);
  assert.match(r.problems.join("\n"), /files\/skill\.md does not exist/);
});

test("an unreferenced file is a warning, not a failure", () => {
  const root = registry({ files: { "skill.md": SKILL, "leftover.md": "old" } });
  const r = build(root);
  assert.notEqual(r.payload, null);
  assert.match(r.warnings.join("\n"), /files\/leftover\.md is not referenced/);
});

/* ------------------------------------------------------------------ strict */

test("strict validation runs after hash injection and rejects what a client would skip", () => {
  // `hologram` is a type the client would silently skip. Merging that publishes an entry nobody can
  // use — exactly what registry mode exists to catch at review time.
  const root = registry({ manifest: { capabilities: [{ type: "hologram", id: "x", path: "skill.md" }] } });
  const r = build(root);
  assert.equal(r.payload, null);
  assert.match(r.problems.join("\n"), /unknown capability type "hologram"/);
});

test("the directory is the source of truth for id and version", () => {
  for (const [over, pattern] of [
    [{ id: "mallory/evil" }, /does not match its directory/],
    [{ version: "9.9.9" }, /version "9\.9\.9" does not match its directory/],
  ]) {
    const r = build(registry({ manifest: over }));
    assert.equal(r.payload, null);
    assert.match(r.problems.join("\n"), pattern);
  }
});

test("two versions of one plugin in the index is an error", () => {
  const root = registry();
  const dir = path.join(root, "plugins", "alice", "postgres", "1.3.0");
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "skill.md"), SKILL);
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "alice/postgres",
      version: "1.3.0",
      name: "Postgres",
      description: "d",
      license: "MIT",
      capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md" }],
    }),
  );
  const r = build(root);
  assert.equal(r.payload, null);
  assert.match(r.problems.join("\n"), /published twice/);
});

test("a submission may not claim a reserved publisher unless the build allows it", () => {
  // RESERVED_PUBLISHERS means "official", and the consent sheet presents it that way. The constant
  // existed with nothing reading it, so a pull request adding plugins/zeraix/* published as ours —
  // which, with feeds no longer signed, human review was the only thing standing in front of.
  const root = registry({ publisher: "zeraix", name: "office-suite", manifest: { id: "zeraix/office-suite" } });

  const submitted = build(root);
  assert.equal(submitted.payload, null);
  assert.match(submitted.problems.join("\n"), /"zeraix" is a reserved publisher/);

  const official = build(root, { allowReserved: true });
  assert.deepEqual(official.problems, []);
  assert.equal(official.payload.plugins[0].manifest.publisher, "zeraix");

  // An ordinary publisher is unaffected in either mode.
  assert.deepEqual(build(registry()).problems, []);
});

test("a plaintext base url is refused before anything is read", () => {
  const r = build(registry(), { baseUrl: "http://cdn.example.com" });
  assert.equal(r.payload, null);
  assert.match(r.problems[0], /must be an https URL/);
});

test("dist.baseUrl is derived per plugin version", () => {
  const r = build(registry());
  assert.equal(r.payload.plugins[0].dist.baseUrl, `${BASE_URL}/alice/postgres/1.2.3/`);
});

/* ------------------------------------------------------------------ sequence */

test("nextSequence increments from the last published feed", () => {
  const root = registry();
  assert.equal(nextSequence(root, "index"), 1);

  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "index.json"),
    JSON.stringify({ type: "index", sequence: 12, issuedAt: "x", plugins: [] }),
  );
  assert.equal(nextSequence(root, "index"), 13);
  assert.equal(nextSequence(root, "index", 20), 20);
  // Going backwards would make every existing install ignore the registry until the number climbs
  // past where it was — a self-inflicted outage with no client-side fix.
  assert.throws(() => nextSequence(root, "index", 5), /would roll back index from 12/);
  assert.throws(() => nextSequence(root, "index", 12), /would roll back/);
});

test("with no previous build there is nothing to count from, so CI must supply the sequence", () => {
  // dist/ is gitignored, so this is the state of EVERY CI run: derived numbering would hand out 1
  // forever and the client's rollback check would never fire. The explicit value is what advances.
  const root = registry();
  assert.equal(nextSequence(root, "index"), 1);
  assert.equal(nextSequence(root, "index"), 1, "still 1 — nothing was written in between");
  assert.equal(nextSequence(root, "index", 274), 274);
});

/* ------------------------------------------------------------------ kill-list */

test("buildKillList passes entries through, and an absent file means none", () => {
  const root = registry();
  assert.deepEqual(buildKillList(root, { sequence: 1, issuedAt: "x" }).payload.entries, []);

  fs.writeFileSync(
    path.join(root, "killlist.json"),
    JSON.stringify({ entries: [{ id: "alice/postgres", version: "*", reason: "exfiltrates credentials" }] }),
  );
  const r = buildKillList(root, { sequence: 2, issuedAt: "x" });
  assert.equal(r.payload.entries.length, 1);
  // The client is the authority on the entry shape (parseKillList), so what the builder emits must
  // satisfy it — a builder that can publish an unparseable kill-list is a broken safety mechanism.
  assert.equal(parseKillList(r.payload).ok, true);
});

/* ------------------------------------------------------------------ round trip */

test("round trip: registry source tree -> feed -> accepted -> installed -> revoked", async () => {
  const root = registry();
  const clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-client-"));
  resetCache();
  setPluginRoot(clientRoot);

  // 1. Registry CI builds. What it writes is what the mirror serves, byte for byte.
  const built = build(root);
  assert.deepEqual(built.problems, []);

  // 2. The client accepts the feed: right type, not a rollback.
  const opened = openFeed(built.payload, { type: "index", cachedSequence: -1 });
  assert.equal(opened.ok, true, opened.error);

  // 3. Parsing yields a catalogue entry whose manifest survived a second, independent validation.
  const { entries, dropped } = parseIndex(opened.payload);
  assert.deepEqual(dropped, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].manifest.id, "alice/postgres");

  // 4. Installing fetches by the URL the builder derived and verifies the hash the builder computed.
  const asked = [];
  const r = await installPlugin(entries[0], {
    fetchFile: async (url) => {
      asked.push(url);
      return Buffer.from(SKILL, "utf8");
    },
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(asked, [`${BASE_URL}/alice/postgres/1.2.3/skill.md`]);
  assert.deepEqual(activeCapabilities().map((c) => c.id), ["pg_expert"]);

  // 5. The registry pulls it; the client enforces that and cannot be talked out of it.
  fs.writeFileSync(
    path.join(root, "killlist.json"),
    JSON.stringify({ entries: [{ id: "alice/postgres", version: "*", reason: "exfiltrates credentials" }] }),
  );
  const killFeed = buildKillList(root, { sequence: 1, issuedAt: "x" }).payload;
  const killOpened = openFeed(killFeed, { type: "killlist", cachedSequence: -1 });
  assert.equal(killOpened.ok, true, killOpened.error);

  applyKillList(parseKillList(killOpened.payload).entries);
  assert.deepEqual(activeCapabilities(), []);
  assert.equal(getInstalled("alice/postgres").revoked.reason, "exfiltrates credentials");
});

test("round trip: replaying the pre-revocation kill-list does not un-revoke", async () => {
  // The one attack the client can still refuse on its own now that feeds are unsigned: a cache or
  // proxy serving the last kill-list from before a plugin was pulled. The bytes are genuine; only
  // the sequence says they are stale.
  const root = registry();
  const clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-client-"));
  resetCache();
  setPluginRoot(clientRoot);

  const built = build(root);
  const entries = parseIndex(built.payload).entries;
  await installPlugin(entries[0], { fetchFile: async () => Buffer.from(SKILL, "utf8") });

  fs.writeFileSync(
    path.join(root, "killlist.json"),
    JSON.stringify({ entries: [{ id: "alice/postgres", version: "*", reason: "exfiltrates credentials" }] }),
  );
  const current = buildKillList(root, { sequence: 8, issuedAt: "x" }).payload;
  applyKillList(parseKillList(openFeed(current, { type: "killlist", cachedSequence: -1 }).payload).entries);
  assert.deepEqual(activeCapabilities(), []);

  // Now the stale one comes back. Refused before it can reach applyKillList.
  const stale = { type: "killlist", sequence: 7, issuedAt: "x", entries: [] };
  const replayed = openFeed(stale, { type: "killlist", cachedSequence: 8 });
  assert.equal(replayed.ok, false);
  assert.match(replayed.error, /rollback refused/);
  assert.deepEqual(activeCapabilities(), [], "the revocation still stands");
});
