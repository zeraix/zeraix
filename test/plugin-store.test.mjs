/**
 * Install / enable / revoke tests. See docs/plugin-marketplace-design.md §6.1, §5.3.
 *
 * The properties that matter:
 *   - bytes are verified BEFORE they land, and a failed install leaves nothing behind
 *   - a revoked plugin cannot be re-enabled by the user
 *   - revocation is idempotent, because it runs on every launch
 *   - Phase 1 refuses an executing provider outright rather than half-installing it
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setPluginRoot } from "../electron/plugins/storage.mjs";
import {
  activeCapabilities,
  applyKillList,
  getInstalled,
  installPlugin,
  listInstalled,
  readCapabilityFile,
  resetCache,
  setEnabled,
  sha512,
  uninstallPlugin,
} from "../electron/plugins/store.mjs";
import { validateManifest } from "../electron/plugins/manifest.mjs";
import { parseKillList } from "../electron/plugins/feed.mjs";

const SKILL = "# Postgres\n\nBe careful with DELETE.\n";
const SKILL_HASH = sha512(Buffer.from(SKILL, "utf8"));
const BASE = "https://cdn.example.com/alice/postgres/1.2.3/";

function freshRoot() {
  resetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-plugins-"));
  setPluginRoot(dir);
  return dir;
}

/** A catalogue entry as parseIndex would produce it: a validated manifest plus a dist. */
function entry(over = {}) {
  const raw = {
    schemaVersion: 1,
    id: "alice/postgres",
    version: "1.2.3",
    name: "Postgres",
    description: "Query Postgres from chat.",
    license: "MIT",
    capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md", sha512: SKILL_HASH }],
    ...over,
  };
  const result = validateManifest(raw, { mode: "registry" });
  assert.equal(result.ok, true, result.errors.join("; "));
  return { manifest: result.manifest, dist: { baseUrl: BASE } };
}

/** A fetchFile that serves a fixed body and records what was asked for. */
function server(body = SKILL) {
  const asked = [];
  return {
    asked,
    fetchFile: async (url) => {
      asked.push(url);
      if (body instanceof Error) throw body;
      return Buffer.from(body, "utf8");
    },
  };
}

/* ------------------------------------------------------------------ install */

test("installs a text plugin, verifies the hash, and records it", async () => {
  const root = freshRoot();
  const io = server();

  const r = await installPlugin(entry(), io);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(io.asked, [`${BASE}skill.md`]);

  const installed = getInstalled("alice/postgres");
  assert.equal(installed.version, "1.2.3");
  assert.equal(installed.enabled, true);
  assert.equal(installed.revoked, null);
  assert.equal(installed.capabilities.length, 1);

  // On disk under a version directory, and readable back through the verified path.
  assert.equal(fs.readFileSync(path.join(root, "files", "alice", "postgres", "1.2.3", "skill.md"), "utf8"), SKILL);
  assert.deepEqual(readCapabilityFile("alice/postgres", "pg_expert"), { ok: true, content: SKILL, error: null });
});

test("a hash mismatch aborts the install and leaves nothing behind", async () => {
  const root = freshRoot();

  const r = await installPlugin(entry(), server("# something else entirely\n"));
  assert.equal(r.ok, false);
  assert.match(r.error, /hash mismatch/);

  assert.equal(getInstalled("alice/postgres"), null);
  assert.deepEqual(listInstalled(), []);
  // No staging directory survives a failure.
  const files = path.join(root, "files", "alice", "postgres");
  const left = fs.existsSync(files) ? fs.readdirSync(files) : [];
  assert.deepEqual(left, []);
});

test("a fetch failure aborts the install cleanly", async () => {
  freshRoot();
  const r = await installPlugin(entry(), server(new Error("ECONNREFUSED")));
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(getInstalled("alice/postgres"), null);
});

test("reinstalling the same immutable version is a no-op", async () => {
  freshRoot();
  const io = server();
  await installPlugin(entry(), io);
  const again = await installPlugin(entry(), io);
  assert.equal(again.ok, true, again.error);
  assert.equal(io.asked.length, 1, "the second install must not refetch an immutable version");
});

test("upgrading replaces the record and removes the old version directory", async () => {
  const root = freshRoot();
  await installPlugin(entry(), server());

  const next = entry({ version: "1.3.0" });
  const r = await installPlugin(next, server());
  assert.equal(r.ok, true, r.error);
  assert.equal(getInstalled("alice/postgres").version, "1.3.0");
  assert.equal(fs.existsSync(path.join(root, "files", "alice", "postgres", "1.2.3")), false);
  assert.equal(fs.existsSync(path.join(root, "files", "alice", "postgres", "1.3.0")), true);
});

test("Phase 1 refuses a plugin needing a provider, and names the missing runtime", async () => {
  freshRoot();
  const withProvider = entry({
    providers: { pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: SKILL_HASH } },
    capabilities: [{ type: "skill", id: "pg_expert", provider: "pg" }],
  });
  const r = await installPlugin(withProvider, server());
  assert.equal(r.ok, false);
  // "no capabilities" would read as "this plugin is empty"; the real answer is "your app is too old".
  assert.match(r.error, /needs a provider this version of the app cannot run yet \(mcp-stdio\)/);
  assert.equal(getInstalled("alice/postgres"), null);
});

test("a plugin using only unimplemented capability types names those instead", async () => {
  freshRoot();
  const unimplemented = entry({
    capabilities: [{ type: "workflow", id: "nightly", path: "n.json", sha512: SKILL_HASH }],
  });
  const r = await installPlugin(unimplemented, server());
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot install yet \(workflow\)/);
});

test("a dist path that escapes its prefix is refused", async () => {
  freshRoot();
  // The manifest validator blocks "..", so this checks the second line of defence: whatever
  // survives URL resolution must still land under the plugin's own prefix.
  const escaping = entry();
  escaping.dist.baseUrl = "https://cdn.example.com/alice/postgres/1.2.3/";
  escaping.manifest.capabilities[0].path = "sub/../../other/skill.md";
  const r = await installPlugin(escaping, server());
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes the plugin's dist prefix/);
});

/* ------------------------------------------------------------------ lifecycle */

test("uninstall removes the record and the files", async () => {
  const root = freshRoot();
  await installPlugin(entry(), server());

  assert.deepEqual(uninstallPlugin("alice/postgres"), { ok: true, error: null });
  assert.equal(getInstalled("alice/postgres"), null);
  assert.equal(fs.existsSync(path.join(root, "files", "alice", "postgres", "1.2.3")), false);
  assert.match(uninstallPlugin("alice/postgres").error, /not installed/);
});

test("disabling hides a capability without uninstalling it", async () => {
  freshRoot();
  await installPlugin(entry(), server());
  assert.equal(activeCapabilities().length, 1);

  setEnabled("alice/postgres", false);
  assert.deepEqual(activeCapabilities(), []);
  assert.equal(getInstalled("alice/postgres").version, "1.2.3", "still installed, just off");

  setEnabled("alice/postgres", true);
  assert.equal(activeCapabilities().length, 1);
});

test("state survives a fresh process reading the same root", async () => {
  const root = freshRoot();
  await installPlugin(entry(), server());

  resetCache();
  setPluginRoot(root);
  assert.equal(getInstalled("alice/postgres").version, "1.2.3");
});

/* ------------------------------------------------------------------ revocation */

test("a plugin-wide revocation disables it and cannot be undone by the user", async () => {
  freshRoot();
  await installPlugin(entry(), server());

  const entries = parseKillList({
    entries: [{ id: "alice/postgres", version: "*", reason: "exfiltrates credentials" }],
  }).entries;
  const { revoked } = applyKillList(entries);

  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].reason, "exfiltrates credentials");
  const p = getInstalled("alice/postgres");
  assert.equal(p.enabled, false);
  assert.equal(p.revoked.reason, "exfiltrates credentials");
  assert.deepEqual(activeCapabilities(), []);

  // The kill-list is not a suggestion: the toggle must not override it.
  const attempt = setEnabled("alice/postgres", true);
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /was revoked/);
  assert.equal(getInstalled("alice/postgres").enabled, false);
});

test("capability-level revocation leaves the rest of the plugin working", async () => {
  freshRoot();
  const two = entry({
    capabilities: [
      { type: "skill", id: "pg_expert", path: "skill.md", sha512: SKILL_HASH },
      { type: "prompt", id: "pg_prompt", path: "skill.md", sha512: SKILL_HASH },
    ],
  });
  await installPlugin(two, server());
  assert.equal(activeCapabilities().length, 2);

  const entries = parseKillList({
    entries: [{ id: "alice/postgres", version: "*", capability: "pg_prompt", reason: "injection" }],
  }).entries;
  applyKillList(entries);

  const active = activeCapabilities();
  assert.deepEqual(active.map((c) => c.id), ["pg_expert"]);
  assert.equal(getInstalled("alice/postgres").enabled, true, "the plugin itself stays enabled");
});

test("applying the same kill-list twice reports the change once", async () => {
  freshRoot();
  await installPlugin(entry(), server());
  const entries = parseKillList({ entries: [{ id: "alice/postgres", version: "*", reason: "bad" }] }).entries;

  assert.equal(applyKillList(entries).revoked.length, 1);
  // Runs on every launch and after every refresh, so repeating it must be silent.
  assert.equal(applyKillList(entries).revoked.length, 0);
});

test("a kill-list for a version we do not have leaves us alone", async () => {
  freshRoot();
  await installPlugin(entry(), server());
  const entries = parseKillList({ entries: [{ id: "alice/postgres", version: "9.9.9", reason: "bad" }] }).entries;

  assert.equal(applyKillList(entries).revoked.length, 0);
  assert.equal(getInstalled("alice/postgres").enabled, true);
});

test("a tampered file on disk fails its hash check on read", async () => {
  const root = freshRoot();
  await installPlugin(entry(), server());

  fs.writeFileSync(path.join(root, "files", "alice", "postgres", "1.2.3", "skill.md"), "# rewritten\n");
  const r = readCapabilityFile("alice/postgres", "pg_expert");
  assert.equal(r.ok, false);
  assert.match(r.error, /failed its hash check on read/);
});
