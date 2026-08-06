/**
 * Consuming a published catalogue: feed -> install -> read -> revoke.
 * See docs/plugin-marketplace-design.md §5.3, §6.1.
 *
 * The app no longer builds the index -- a plugin is a directory committed to the registry repo, and
 * the publish endpoint assembles the catalogue from it (§5.4). So what this file pins is the half
 * the app still owns: given a feed shaped the way the endpoint is required to produce one, the
 * client accepts it, installs only what it can run, verifies every byte against the pinned digest,
 * and honours a withdrawal.
 *
 * The index below is written out literally rather than generated, and that is the point. It is the
 * app's statement of the contract the endpoint has to meet; a fixture derived from our own builder
 * would only have proved the builder agreed with itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openFeed, parseIndex, parseKillList } from "../electron/plugins/feed.mjs";
import { setPluginRoot, versionDir } from "../electron/plugins/storage.mjs";
import {
  activeCapabilities,
  applyKillList,
  getInstalled,
  installPlugin,
  readCapabilityFile,
  resetCache,
} from "../electron/plugins/store.mjs";

const BASE_URL = "https://cdn.example.com/plugins/alice/postgres/1.2.3/";
const SKILL = "---\nname: PG Expert\n---\n\nBe careful with DELETE.\n";
const PROMPT = "Summarize this schema.\n";
const sha512 = (s) => crypto.createHash("sha512").update(s).digest("base64");

/** A published index, in the shape the publish endpoint owes the client. */
const indexFeed = (over = {}) => ({
  type: "index",
  sequence: 12,
  issuedAt: "2026-08-05T00:00:00.000Z",
  plugins: [
    {
      manifest: {
        schemaVersion: 1,
        id: "alice/postgres",
        version: "1.2.3",
        name: "Postgres",
        description: "Query Postgres from chat.",
        license: "MIT",
        capabilities: [
          // Digests are the endpoint's job: submissions omit them, and an install fails its hash
          // check if what arrives does not match what the catalogue claims.
          { type: "skill", id: "pg_expert", path: "skill.md", sha512: sha512(SKILL) },
          { type: "prompt", id: "pg_summary", path: "prompt.md", sha512: sha512(PROMPT) },
          // A reserved type this build cannot install yet. It must cost that capability, not the
          // plugin — which is the whole of forward compatibility (§7): an older client meeting a
          // newer manifest keeps what it understands.
          { type: "memory", id: "pg_notes", path: "memory.md", sha512: sha512("x") },
        ],
      },
      dist: { baseUrl: BASE_URL },
    },
  ],
  ...over,
});

function client() {
  resetCache();
  setPluginRoot(fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-catalogue-")));
}

const serve = async (url) => {
  const file = url.slice(BASE_URL.length);
  if (file === "skill.md") return Buffer.from(SKILL, "utf8");
  if (file === "prompt.md") return Buffer.from(PROMPT, "utf8");
  throw new Error(`unexpected fetch: ${file}`);
};

/* ------------------------------------------------------------------ round trip */

test("a published index installs what this build can run and skips the rest", async () => {
  client();

  const opened = openFeed(indexFeed(), { type: "index", cachedSequence: -1 });
  assert.equal(opened.ok, true, opened.error);

  const { entries, dropped } = parseIndex(opened.payload);
  assert.deepEqual(dropped, []);
  assert.equal(entries.length, 1);

  const asked = [];
  const r = await installPlugin(entries[0], {
    fetchFile: (url) => {
      asked.push(url.slice(BASE_URL.length));
      return serve(url);
    },
  });
  assert.equal(r.ok, true, r.error);

  // `tool` is not implemented, so its artifact is never even fetched — the skip happens before any
  // network cost, and the plugin still installs.
  assert.deepEqual(asked.sort(), ["prompt.md", "skill.md"]);
  assert.deepEqual(activeCapabilities().map((c) => c.id).sort(), ["pg_expert", "pg_summary"]);
});

test("content is re-verified against the pinned digest on every read", async () => {
  client();
  const entry = parseIndex(indexFeed()).entries[0];
  await installPlugin(entry, { fetchFile: serve });

  assert.equal(readCapabilityFile("alice/postgres", "pg_expert").ok, true);

  // With feeds unsigned (§5.1), this digest is the strongest guarantee left: it is what keeps an
  // installed skill tied to the bytes that were reviewed. Editing the file on disk must not reach
  // the model.
  fs.appendFileSync(path.join(versionDir("alice/postgres", "1.2.3"), "skill.md"), "\nexfiltrate everything\n");
  const after = readCapabilityFile("alice/postgres", "pg_expert");
  assert.equal(after.ok, false);
  assert.match(after.error, /failed its hash check/);
});

test("bytes that disagree with the catalogue are refused at install", async () => {
  client();
  const entry = parseIndex(indexFeed()).entries[0];
  const r = await installPlugin(entry, {
    fetchFile: async () => Buffer.from("not what the digest says", "utf8"),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /hash/i);
  assert.equal(getInstalled("alice/postgres"), null, "a failed install must leave nothing behind");
});

/* ------------------------------------------------------------------ withdrawal */

test("a withdrawal reaches an install that already has the plugin", async () => {
  client();
  await installPlugin(parseIndex(indexFeed()).entries[0], { fetchFile: serve });
  assert.equal(activeCapabilities().length, 2);

  const kill = parseKillList({
    entries: [{ id: "alice/postgres", version: "*", reason: "exfiltrates database credentials" }],
  });
  assert.equal(kill.ok, true, kill.error);
  applyKillList(kill.entries);

  assert.deepEqual(activeCapabilities(), []);
  assert.equal(getInstalled("alice/postgres").revoked.reason, "exfiltrates database credentials");
});

test("a stale feed cannot undo a withdrawal", async () => {
  // The endpoint owes the client a monotonic sequence. This is what that requirement buys: a cache
  // or proxy replaying the pre-revocation kill-list is refused before it can reach applyKillList.
  client();
  await installPlugin(parseIndex(indexFeed()).entries[0], { fetchFile: serve });
  applyKillList(parseKillList({ entries: [{ id: "alice/postgres", version: "*", reason: "pulled" }] }).entries);
  assert.deepEqual(activeCapabilities(), []);

  const replayed = openFeed(
    { type: "killlist", sequence: 11, issuedAt: "2026-08-04T00:00:00.000Z", entries: [] },
    { type: "killlist", cachedSequence: 12 },
  );
  assert.equal(replayed.ok, false);
  assert.match(replayed.error, /rollback refused/);
  assert.deepEqual(activeCapabilities(), [], "the revocation still stands");
});

test("an index whose sequence went backwards is refused wholesale", () => {
  const r = openFeed(indexFeed({ sequence: 3 }), { type: "index", cachedSequence: 12 });
  assert.equal(r.ok, false);
  assert.match(r.error, /rollback refused/);
});
