/**
 * Plugin manifest validation tests. See docs/plugin-marketplace-design.md §3, §4, §7.
 *
 * The properties that matter are the two asymmetries, because they are what a plain schema check
 * would get wrong:
 *
 *   1. Unknown FEATURES are skipped in client mode and fatal in registry mode. A v1 client must
 *      survive a v2 manifest; a v2 manifest that no client can use must not get merged.
 *   2. Unknown RESTRICTIONS are fatal in both. Skipping an unrecognized permission would silently
 *      grant it, which inverts the meaning of the field.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  CAPABILITY_TYPES,
  validateManifest,
  installableCapabilities,
  parsePluginId,
  isSupportedSchemaVersion,
  qualifiedCapabilityId,
} from "../electron/plugins/manifest.mjs";

/** 86 base64 chars + "==" — the shape of a base64 sha512. */
const HASH = `${"a".repeat(86)}==`;

/** A minimal manifest that must validate in both modes: text tier, static content, no code. */
function textPlugin(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "alice/postgres",
    version: "1.2.3",
    name: "Postgres",
    description: "Query Postgres from chat.",
    license: "MIT",
    capabilities: [{ type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH }],
    ...overrides,
  };
}

/** A manifest with a real executing provider — used for the trust-boundary cases. */
function codePlugin(overrides = {}) {
  return {
    ...textPlugin(),
    providers: {
      pg: {
        kind: "mcp-stdio",
        tier: "sandboxed",
        runtime: "node",
        entry: "dist/index.js",
        sha512: HASH,
        permissions: { network: ["db.example.com"], filesystem: ["$WORKSPACE"] },
      },
    },
    capabilities: [{ type: "tool", id: "pg_query", provider: "pg" }],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ helpers */

test("parsePluginId accepts publisher/name and rejects everything else", () => {
  assert.deepEqual(parsePluginId("alice/postgres"), { publisher: "alice", name: "postgres" });
  for (const bad of ["postgres", "Alice/postgres", "alice/", "/postgres", "alice/pg/extra", "-alice/pg", 42, null]) {
    assert.equal(parsePluginId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("qualifiedCapabilityId is publisher/plugin:capability", () => {
  assert.equal(qualifiedCapabilityId("alice/postgres", "pg_query"), "alice/postgres:pg_query");
});

test("isSupportedSchemaVersion rejects newer and non-integer versions", () => {
  assert.equal(isSupportedSchemaVersion(SCHEMA_VERSION), true);
  assert.equal(isSupportedSchemaVersion(SCHEMA_VERSION + 1), false);
  assert.equal(isSupportedSchemaVersion(0), false);
  assert.equal(isSupportedSchemaVersion("1"), false);
});

/* ------------------------------------------------------------------ happy path */

test("a minimal text plugin validates in both modes", () => {
  for (const mode of ["client", "registry"]) {
    const r = validateManifest(textPlugin(), { mode });
    assert.equal(r.ok, true, `${mode}: ${r.errors.join("; ")}`);
    assert.equal(r.manifest.capabilities.length, 1);
    assert.equal(r.manifest.publisher, "alice");
    assert.equal(r.skipped.length, 0);
  }
});

test("validation is idempotent: normalized output re-validates unchanged", () => {
  // Load-bearing, not tidy. The registry publishes normalized manifests in the index and the client
  // re-validates every one on the way in (parseIndex), precisely so it does not have to trust that
  // the registry validated correctly. If validate(normalize(x)) could fail, that defence-in-depth
  // would reject the registry's own output — which is exactly what happened before `has()`.
  for (const source of [textPlugin(), codePlugin()]) {
    const once = validateManifest(source, { mode: "registry" });
    assert.equal(once.ok, true, once.errors.join("; "));

    const twice = validateManifest(once.manifest, { mode: "registry" });
    assert.equal(twice.ok, true, `re-validation failed: ${twice.errors.join("; ")}`);
    assert.deepEqual(twice.manifest, once.manifest, "normalization must be a fixed point");
    // Same warnings, not zero: "not implemented yet" describes the build, so it legitimately
    // recurs. What must not appear is a NEW complaint about a field normalization itself wrote.
    assert.deepEqual(twice.warnings, once.warnings, "re-validation must not invent new warnings");
  }
});

test("an explicit null reads as absent, the ordinary JSON convention", () => {
  const r = validateManifest(textPlugin({ homepage: null, pricing: null }), { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.manifest.homepage, null);
});

test("normalization fills defaults and drops nothing the caller needs", () => {
  const r = validateManifest(codePlugin(), { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  const p = r.manifest.providers.pg;
  assert.deepEqual(p.permissions, { network: ["db.example.com"], filesystem: ["$WORKSPACE"], credentials: [] });
  assert.deepEqual(p.args, []);
  assert.deepEqual(p.needs, []);
  assert.equal(p.url, null);
});

/* ------------------------------------------------------------------ hard reject */

test("a newer schemaVersion is the one hard reject", () => {
  for (const mode of ["client", "registry"]) {
    const r = validateManifest(textPlugin({ schemaVersion: SCHEMA_VERSION + 1 }), { mode });
    assert.equal(r.ok, false);
    assert.equal(r.manifest, null);
    assert.match(r.errors[0], /newer than this client supports/);
    // It must not attempt partial acceptance: we cannot know which rules we are failing to apply.
    assert.equal(r.skipped.length, 0);
  }
});

test("identity fields are validated and every problem is reported at once", () => {
  const r = validateManifest(
    { schemaVersion: 1, id: "Bad/ID", version: "1.2", name: "", description: "", capabilities: [] },
    { mode: "registry" },
  );
  assert.equal(r.ok, false);
  const joined = r.errors.join("\n");
  for (const expected of [/^id must be/m, /version must be a semver/, /name is required/, /description is required/, /license is required/]) {
    assert.match(joined, expected);
  }
});

test("a non-object manifest fails without throwing", () => {
  for (const bad of [null, 42, "x", []]) {
    const r = validateManifest(bad);
    assert.equal(r.ok, false);
    assert.equal(r.manifest, null);
  }
});

/* ---------------------------------------------- asymmetry 1: unknown features */

test("unknown capability type: skipped in client mode, fatal in registry mode", () => {
  const m = textPlugin({
    capabilities: [
      { type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH },
      { type: "hologram", id: "future", provider: "nope" },
    ],
  });

  const client = validateManifest(m, { mode: "client" });
  assert.equal(client.ok, true, client.errors.join("; "));
  assert.equal(client.manifest.capabilities.length, 1);
  assert.equal(client.skipped.length, 1);
  assert.match(client.skipped[0].reason, /unknown capability type "hologram"/);

  const registry = validateManifest(m, { mode: "registry" });
  assert.equal(registry.ok, false);
  assert.match(registry.errors.join("\n"), /unknown capability type "hologram"/);
});

test("unknown provider kind drops the provider and everything bound to it", () => {
  const m = textPlugin({
    providers: { weird: { kind: "quantum-link", tier: "sandboxed" } },
    capabilities: [
      { type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH },
      { type: "tool", id: "pg_query", provider: "weird" },
    ],
  });

  const client = validateManifest(m, { mode: "client" });
  assert.equal(client.ok, true, client.errors.join("; "));
  assert.equal(client.manifest.capabilities.length, 1);
  assert.equal(client.manifest.capabilities[0].id, "pg_expert");
  assert.equal(client.skipped.length, 2); // the provider, and the capability that needed it

  assert.equal(validateManifest(m, { mode: "registry" }).ok, false);
});

test("unknown fields are ignored, and warned about in registry mode", () => {
  const m = textPlugin({ futureField: { anything: true } });
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.match(r.warnings.join("\n"), /unknown top-level field "futureField"/);
  assert.equal("futureField" in r.manifest, false); // normalized output carries only known fields
});

test("a reserved-but-unimplemented capability type validates in both modes and is warned about", () => {
  const m = textPlugin({
    capabilities: [
      { type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH },
      { type: "workflow", id: "nightly", path: "nightly.json", sha512: HASH },
    ],
  });

  // Reserving the type is the point of the enum, so neither mode rejects it. "Unimplemented" is a
  // property of this build, not of the document — it must not make CI and clients disagree.
  for (const mode of ["client", "registry"]) {
    const r = validateManifest(m, { mode });
    assert.equal(r.ok, true, `${mode}: ${r.errors.join("; ")}`);
    assert.equal(r.manifest.capabilities.length, 2);
    assert.equal(r.skipped.length, 0);
    assert.match(r.warnings.join("\n"), /"workflow" is not implemented yet/);
  }
});

test("installableCapabilities is what filters unimplemented types and provider kinds", () => {
  const m = validateManifest(
    textPlugin({
      capabilities: [
        { type: "skill", id: "pg_expert", path: "skill.md", sha512: HASH },
        { type: "workflow", id: "nightly", path: "nightly.json", sha512: HASH },
      ],
    }),
    { mode: "registry" },
  ).manifest;
  assert.deepEqual(installableCapabilities(m).map((c) => c.id), ["pg_expert"]);

  // A capability bound to a kind this build cannot run is not installable either...
  const coded = validateManifest(codePlugin(), { mode: "registry" }).manifest;
  assert.deepEqual(installableCapabilities(coded), []);

  // ...but one runnable candidate in a bind chain is enough.
  const mixed = validateManifest(
    {
      ...textPlugin(),
      providers: {
        srv: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: HASH },
        docs: { kind: "text", tier: "text" },
      },
      capabilities: [{ type: "skill", id: "s", bind: [{ provider: "srv" }, { provider: "docs" }] }],
    },
    { mode: "registry" },
  ).manifest;
  assert.deepEqual(installableCapabilities(mixed).map((c) => c.id), ["s"]);
});

/* ------------------------------------------ asymmetry 2: unknown restrictions */

test("an unrecognized permission rejects the provider in BOTH modes", () => {
  const m = codePlugin({
    providers: {
      pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: HASH, permissions: { camera: true } },
    },
  });
  for (const mode of ["client", "registry"]) {
    const r = validateManifest(m, { mode });
    assert.equal(r.ok, false, `${mode} must not accept an unenforceable permission`);
    assert.match(r.errors.join("\n"), /unrecognized permission "camera"/);
    assert.match(r.errors.join("\n"), /rejected rather than granted/);
  }
});

test("filesystem grants must be tokens, never raw paths", () => {
  for (const path of ["/", "/etc", "C:\\Users", "../escape", "$UNKNOWN/x"]) {
    const m = codePlugin({
      providers: {
        pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: HASH, permissions: { filesystem: [path] } },
      },
    });
    const r = validateManifest(m, { mode: "client" });
    assert.equal(r.ok, false, `expected ${path} to be rejected`);
  }
  const good = codePlugin({
    providers: {
      pg: {
        kind: "mcp-stdio",
        tier: "sandboxed",
        entry: "i.js",
        sha512: HASH,
        permissions: { filesystem: ["$WORKSPACE", "$HOME/.config"] },
      },
    },
  });
  assert.equal(validateManifest(good, { mode: "registry" }).ok, true);
});

test("network grants are hostnames, not URLs", () => {
  const bad = codePlugin({
    providers: {
      pg: {
        kind: "mcp-stdio",
        tier: "sandboxed",
        entry: "i.js",
        sha512: HASH,
        permissions: { network: ["https://db.example.com/path"] },
      },
    },
  });
  assert.equal(validateManifest(bad, { mode: "client" }).ok, false);

  const good = codePlugin({
    providers: {
      pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: HASH, permissions: { network: ["*.example.com"] } },
    },
  });
  assert.equal(validateManifest(good, { mode: "registry" }).ok, true);
});

/* ------------------------------------------------------------------ tier/kind */

test("a code provider cannot claim the text tier", () => {
  const m = codePlugin({
    providers: { pg: { kind: "mcp-stdio", tier: "text", entry: "i.js", sha512: HASH } },
  });
  const r = validateManifest(m, { mode: "client" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /executes code, so tier "text" is not permitted/);
});

test("a text provider cannot claim an execution tier", () => {
  const m = textPlugin({
    providers: { docs: { kind: "text", tier: "sandboxed" } },
    capabilities: [{ type: "skill", id: "s", provider: "docs" }],
  });
  const r = validateManifest(m, { mode: "client" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /executes nothing, so tier must be "text"/);
});

test("a local code provider must carry an artifact hash", () => {
  const m = codePlugin({
    providers: { pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "dist/index.js" } },
  });
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /sha512 is required/);
});

test("entry paths cannot escape the bundle", () => {
  const m = codePlugin({
    providers: { pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "../../etc/passwd", sha512: HASH } },
  });
  assert.equal(validateManifest(m, { mode: "client" }).ok, false);
});

test("host tier warns that its permissions are advisory", () => {
  const m = codePlugin({
    providers: {
      pg: { kind: "process", tier: "host", command: "pg", sha512: HASH, permissions: { network: ["db.example.com"] } },
    },
  });
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.match(r.warnings.join("\n"), /tier "host" cannot enforce permissions/);
});

test("a tool cannot be satisfied by a provider that executes nothing", () => {
  const m = textPlugin({
    providers: { docs: { kind: "text", tier: "text" } },
    capabilities: [{ type: "tool", id: "t", provider: "docs" }],
  });
  const r = validateManifest(m, { mode: "client" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /needs an executing provider/);
});

/* ------------------------------------------------------------------ binding */

test("exactly one of content, provider or bind", () => {
  const none = textPlugin({ capabilities: [{ type: "skill", id: "s" }] });
  assert.match(validateManifest(none).errors.join("\n"), /must declare one of/);

  const both = textPlugin({
    providers: { docs: { kind: "text", tier: "text" } },
    capabilities: [{ type: "skill", id: "s", path: "s.md", sha512: HASH, provider: "docs" }],
  });
  assert.match(validateManifest(both).errors.join("\n"), /declare exactly one of/);
});

test("content capabilities require a hash, and non-content types cannot use content", () => {
  const noHash = textPlugin({ capabilities: [{ type: "skill", id: "s", path: "s.md" }] });
  assert.match(validateManifest(noHash).errors.join("\n"), /sha512 is required with path/);

  const wrongType = codePlugin({
    capabilities: [{ type: "tool", id: "t", path: "t.md", sha512: HASH }],
  });
  assert.match(validateManifest(wrongType).errors.join("\n"), /cannot be satisfied by static content/);
});

test("bind is accepted and reduced to its first available candidate", () => {
  const m = {
    ...codePlugin(),
    providers: {
      socket: { kind: "mcp-stdio", tier: "sandboxed", entry: "sock.js", sha512: HASH },
      cli: { kind: "process", tier: "sandboxed", command: "docker", sha512: HASH },
    },
    capabilities: [
      {
        type: "tool",
        id: "docker_ps",
        bind: [
          { provider: "socket", when: "socket:/var/run/docker.sock" },
          { provider: "cli", when: "exec:docker" },
        ],
      },
    ],
  };
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  const cap = r.manifest.capabilities[0];
  assert.equal(cap.provider, "socket");
  assert.equal(cap.bind.length, 2);
  assert.deepEqual(cap.providers, ["socket", "cli"]);
});

test("bind referencing a missing provider: narrows in client mode, fatal in registry mode", () => {
  const m = {
    ...codePlugin(),
    providers: { cli: { kind: "process", tier: "sandboxed", command: "docker", sha512: HASH } },
    capabilities: [
      { type: "tool", id: "docker_ps", bind: [{ provider: "typo" }, { provider: "cli" }] },
    ],
  };
  const client = validateManifest(m, { mode: "client" });
  assert.equal(client.ok, true, client.errors.join("; "));
  assert.equal(client.manifest.capabilities[0].provider, "cli");

  const registry = validateManifest(m, { mode: "registry" });
  assert.equal(registry.ok, false);
  assert.match(registry.errors.join("\n"), /bind references a provider that is not declared/);
});

/* ------------------------------------------------------------------ hygiene */

test("duplicate capability ids are rejected", () => {
  const m = textPlugin({
    capabilities: [
      { type: "skill", id: "dup", path: "a.md", sha512: HASH },
      { type: "prompt", id: "dup", path: "b.md", sha512: HASH },
    ],
  });
  assert.match(validateManifest(m).errors.join("\n"), /"dup" is duplicated/);
});

test("a manifest with nothing installable left is not a successful install", () => {
  const m = textPlugin({ capabilities: [{ type: "hologram", id: "future", provider: "x" }] });
  const r = validateManifest(m, { mode: "client" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /no installable capabilities remain/);
});

test("high-bar capability types are flagged for review, not rejected", () => {
  const m = codePlugin({
    providers: { srv: { kind: "mcp-http", tier: "sandboxed", url: "https://x.example.com" } },
    capabilities: [{ type: "model", id: "m", provider: "srv" }],
  });
  const r = validateManifest(m, { mode: "registry" });
  assert.match(r.warnings.join("\n"), /requires elevated review/);
});

test("an unused provider is warned about", () => {
  const m = textPlugin({ providers: { orphan: { kind: "text", tier: "text" } } });
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.match(r.warnings.join("\n"), /providers.orphan is declared but no capability binds to it/);
});

test("needs is shape-checked so the consent sheet can render it", () => {
  const m = codePlugin({
    providers: {
      pg: {
        kind: "mcp-stdio",
        tier: "sandboxed",
        entry: "i.js",
        sha512: HASH,
        needs: [{ key: "PG_URL", prompt: "Connection string", secret: true }],
      },
    },
  });
  const r = validateManifest(m, { mode: "registry" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.manifest.providers.pg.needs, [{ key: "PG_URL", prompt: "Connection string", secret: true }]);

  const bad = codePlugin({
    providers: {
      pg: { kind: "mcp-stdio", tier: "sandboxed", entry: "i.js", sha512: HASH, needs: [{ key: "pg_url", prompt: "x" }] },
    },
  });
  assert.match(validateManifest(bad).errors.join("\n"), /needs\[0\]\.key must match/);
});

test("every declared capability type is either implemented or explicitly reserved", () => {
  // Guards against adding a type to the enum and forgetting it exists.
  for (const type of CAPABILITY_TYPES) {
    assert.equal(typeof type, "string");
    assert.match(type, /^[a-z]+$/);
  }
  assert.equal(new Set(CAPABILITY_TYPES).size, CAPABILITY_TYPES.length);
});
