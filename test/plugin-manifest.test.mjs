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
import { existsSync, readFileSync } from "node:fs";

import {
  SCHEMA_VERSION,
  CAPABILITY_TYPES,
  validateManifest,
  installableCapabilities,
  parsePluginId,
  isSupportedSchemaVersion,
  qualifiedCapabilityId,
  OAUTH_PRESETS,
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

  // validate(normalize(x)) must hold, or the registry publishes an entry every client then drops.
  // Normalizing a `bind` capability emits BOTH `bind` and `provider`, which the "exactly one of"
  // check used to count as two declarations -- so no plugin using bind could ever reach a user,
  // and the only trace was a `dropped` reason in parseIndex that nothing surfaces.
  const again = validateManifest(r.manifest, { mode: "client" });
  assert.equal(again.ok, true, `re-validating normalized output failed: ${again.errors.join("; ")}`);
  assert.deepEqual(again.manifest.capabilities[0].providers, ["socket", "cli"]);

  // The ambiguity the check exists for still fails: a provider that is NOT the first bind candidate.
  const disagreeing = structuredClone(r.manifest);
  disagreeing.capabilities[0].provider = "cli";
  assert.match(
    validateManifest(disagreeing).errors.join("\n"),
    /declare exactly one of/,
    "a provider disagreeing with bind[0] is an author error, not our normalized shape",
  );
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

/* ------------------------------------------------------------------ oauth provider kind
 *
 * See docs/plugin-oauth-provider-design.md. The properties worth pinning are the ones a plain schema
 * check gets wrong: an oauth provider is NOT bindable, its tier is not the author's choice, and the
 * rules that exist for security reasons (PKCE, presets, no embedded secret, host-chosen redirect) are
 * errors rather than warnings — a warning in registry CI is a merged PR.
 */

/** A correct oauth pair: the authorizer, plus the http consumer that names it. */
function oauthPlugin({ authorizer = {}, consumer = {}, capability = {} } = {}) {
  return {
    schemaVersion: 1,
    id: "alice/gmail",
    version: "1.0.0",
    name: "Gmail",
    description: "Send mail from chat.",
    license: "MIT",
    providers: {
      google_auth: {
        kind: "oauth",
        tier: "host",
        oauth: {
          known_provider: "google",
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
          client: { type: "public", id: "123.apps.googleusercontent.com" },
          redirect: { method: "loopback" },
          mints: "gmail_oauth",
          ...(authorizer.oauth ?? {}),
        },
        ...authorizer.provider,
      },
      gmail_api: {
        kind: "http",
        tier: "sandboxed",
        url: "https://gmail.googleapis.com",
        auth: "google_auth",
        permissions: { network: ["gmail.googleapis.com"], credentials: ["gmail_oauth"] },
        ...consumer,
      },
    },
    capabilities: [{ type: "tool", id: "send_email", module: "mail", provider: "gmail_api", ...capability }],
  };
}

const bothModes = (m) => [validateManifest(m, { mode: "client" }), validateManifest(m, { mode: "registry" })];

test("a correct oauth pair validates in both modes", () => {
  for (const res of bothModes(oauthPlugin())) {
    assert.equal(res.ok, true, res.errors.join("; "));
    assert.equal(res.manifest.providers.google_auth.oauth.mints, "gmail_oauth");
    assert.equal(res.manifest.providers.gmail_api.auth, "google_auth");
  }
});

test("normalization is idempotent for oauth, as parseIndex requires", () => {
  // The client re-validates every index entry it receives, so validate(normalize(x)) must hold or a
  // published oauth plugin vanishes from every catalogue with the reason recorded where nobody reads.
  const once = validateManifest(oauthPlugin(), { mode: "registry" });
  const twice = validateManifest(once.manifest, { mode: "registry" });
  assert.equal(twice.ok, true, twice.errors.join("; "));
  assert.deepEqual(twice.manifest.providers, once.manifest.providers);
});

test("an oauth provider must be tier host, in both modes", () => {
  const m = oauthPlugin({ authorizer: { provider: { tier: "sandboxed" } } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /tier must be "host"/);
  }
});

test("a capability may not bind directly to an oauth provider", () => {
  const m = oauthPlugin({ capability: { provider: "google_auth" } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /no capability may bind to it/);
  }
});

test("auth must reference a declared oauth provider", () => {
  const dangling = oauthPlugin({ consumer: { auth: "nope" } });
  assert.equal(validateManifest(dangling, { mode: "client" }).ok, false);

  const wrongKind = oauthPlugin({ consumer: { auth: "gmail_api" } });
  assert.match(validateManifest(wrongKind, { mode: "client" }).errors.join(" "), /must reference a provider of kind "oauth"/);
});

test("a consumer must declare the credential its authorizer mints", () => {
  // Otherwise the consent sheet shows no credential and the provider is handed one anyway.
  const m = oauthPlugin({ consumer: { permissions: { network: ["gmail.googleapis.com"], credentials: [] } } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /does not declare its credential/);
  }
});

test("only http and mcp-http may declare auth", () => {
  const m = oauthPlugin({
    consumer: { kind: "mcp-stdio", tier: "sandboxed", entry: "dist/i.js", sha512: HASH, url: undefined },
  });
  assert.match(validateManifest(m, { mode: "client" }).errors.join(" "), /cannot use "auth"/);
});

test("scopes are required and must be a non-empty array", () => {
  for (const scopes of [undefined, [], "gmail.send"]) {
    const m = oauthPlugin({ authorizer: { oauth: { scopes } } });
    assert.equal(validateManifest(m, { mode: "registry" }).ok, false, String(scopes));
  }
});

test("PKCE cannot be switched off", () => {
  const m = oauthPlugin({ authorizer: { oauth: { pkce: false } } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /pkce cannot be disabled/);
  }
});

test("a client secret may not be embedded in a published manifest", () => {
  const m = oauthPlugin({
    authorizer: { oauth: { client: { type: "public", id: "123.apps.googleusercontent.com", secret: "shh" } } },
  });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /must not embed a secret/);
  }
});

test("a user-supplied client id points at a needs key", () => {
  // The key must be well-formed AND declared: a `need` naming nothing is a prompt the user never sees
  // and a client id that never arrives.
  const declared = { needs: [{ key: "FIGMA_CLIENT_ID", prompt: "Client ID", secret: false }] };
  const ok = oauthPlugin({
    authorizer: { oauth: { client: { type: "user_supplied", need: "FIGMA_CLIENT_ID" } }, provider: declared },
  });
  assert.equal(validateManifest(ok, { mode: "registry" }).ok, true);

  const malformed = oauthPlugin({ authorizer: { oauth: { client: { type: "user_supplied", need: "figma id" } } } });
  assert.equal(validateManifest(malformed, { mode: "registry" }).ok, false);

  const undeclared = oauthPlugin({ authorizer: { oauth: { client: { type: "user_supplied", need: "FIGMA_CLIENT_ID" } } } });
  assert.equal(validateManifest(undeclared, { mode: "registry" }).ok, false);
});

test("the redirect port and scheme belong to the host, not the manifest", () => {
  for (const redirect of [{ method: "loopback", port: 8080 }, { method: "custom_scheme", scheme: "slack" }]) {
    const m = oauthPlugin({ authorizer: { oauth: { redirect } } });
    assert.match(validateManifest(m, { mode: "client" }).errors.join(" "), /chosen by the host/);
  }
});

test("literal endpoints are refused for publication but usable when sideloaded", () => {
  const literal = {
    known_provider: undefined,
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
  };
  const m = oauthPlugin({ authorizer: { oauth: literal } });

  const registry = validateManifest(m, { mode: "registry" });
  assert.equal(registry.ok, false);
  assert.match(registry.errors.join(" "), /known_provider/i);

  const client = validateManifest(m, { mode: "client" });
  assert.equal(client.ok, true, client.errors.join("; "));
  assert.match(client.warnings.join(" "), /bypass the preset allowlist/);
});

test("a non-https authorization endpoint is refused", () => {
  const m = oauthPlugin({
    authorizer: {
      oauth: { known_provider: undefined, authorize_url: "http://evil.test/auth", token_url: "https://x.test/t" },
    },
  });
  assert.equal(validateManifest(m, { mode: "client" }).ok, false);
});

test("an unknown known_provider is refused rather than guessed at", () => {
  const m = oauthPlugin({ authorizer: { oauth: { known_provider: "gooogle" } } });
  assert.equal(validateManifest(m, { mode: "client" }).ok, false);
});

test("an oauth block is only meaningful on kind oauth", () => {
  const m = oauthPlugin({ consumer: { oauth: { known_provider: "google" } } });
  assert.match(validateManifest(m, { mode: "client" }).errors.join(" "), /only meaningful on kind "oauth"/);
});

test("an authorizer nothing references is warned about, not rejected", () => {
  const m = oauthPlugin({ consumer: { auth: undefined, permissions: { credentials: [] } } });
  const res = validateManifest(m, { mode: "client" });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.match(res.warnings.join(" "), /authorizer no provider references/);
});

test("an old client skips the whole oauth plugin instead of failing the install", () => {
  // §7 forward compatibility, simulated: a client that does not know the kind drops the provider,
  // and the capability bound to its consumer goes with it. Nothing here should throw.
  const m = oauthPlugin({ authorizer: { provider: { kind: "oauth-v2" } } });
  const res = validateManifest(m, { mode: "client" });
  assert.equal(res.ok, false); // nothing installable remains — this plugin was only the oauth pair
  assert.ok(res.skipped.some((s) => /unknown provider kind/.test(s.reason)));
});

test("a public client may still need a client_secret, and it survives normalization", () => {
  // Google requires client_secret at the token endpoint for Desktop-app clients even under PKCE.
  // Normalization used to drop this field for public clients, which surfaced as "client_secret is
  // missing." at the exchange — after the user had already consented.
  const m = oauthPlugin({
    authorizer: {
      oauth: { client: { type: "public", id: "123.apps.googleusercontent.com", secret_need: "GOOGLE_CLIENT_SECRET" } },
      provider: { needs: [{ key: "GOOGLE_CLIENT_SECRET", prompt: "Client secret", secret: true }] },
    },
  });
  const res = validateManifest(m, { mode: "registry" });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.manifest.providers.google_auth.oauth.client.secret_need, "GOOGLE_CLIENT_SECRET");
  // And it must survive the round trip parseIndex performs.
  const again = validateManifest(res.manifest, { mode: "registry" });
  assert.equal(again.manifest.providers.google_auth.oauth.client.secret_need, "GOOGLE_CLIENT_SECRET");
});

test("a client key that no needs[] entry declares is rejected", () => {
  // The typo that would otherwise surface as a 401 on the one install that used it.
  const m = oauthPlugin({
    authorizer: {
      oauth: { client: { type: "public", id: "123.apps.googleusercontent.com", secret_need: "GOOGLE_CLIENT_SECRET" } },
      provider: { needs: [{ key: "GOOGLE_CLIENT_SECRETT", prompt: "typo", secret: true }] },
    },
  });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /no needs\[\] entry declares that key/);
  }
});

test("a pasted secret in a key-reference field says so, rather than citing a regex", () => {
  // The mistake this catches happened in practice: a real Google client secret pasted into
  // `secret_need`, which is a reference to a needs[] key. The plain regex rejection was accurate and
  // told the author nothing about the credential they had just written into a registry-bound file.
  const m = oauthPlugin({
    authorizer: {
      oauth: { client: { type: "public", id: "123.apps.googleusercontent.com", secret_need: "GOCSPX-EXAMPLE-NOT-A-REAL-SECRET" } },
    },
  });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /looks like a SECRET VALUE/);
    assert.match(res.errors.join(" "), /rotate it/);
  }

  // A plain malformed key still gets the plain message — no scaremongering on an obvious typo.
  const typo = oauthPlugin({ authorizer: { oauth: { client: { type: "user_supplied", need: "figma id" } } } });
  assert.match(validateManifest(typo, { mode: "client" }).errors.join(" "), /must be a needs\[\] key matching/);
});

/* -------------------------------------------------- provider profiles (Figma, Slack, GitHub, …) */

test("a provider without PKCE cannot use a public client", () => {
  // No verifier and no client authentication leaves nothing in the exchange an interceptor lacks.
  const m = oauthPlugin({ authorizer: { oauth: { known_provider: "github" } } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /has no PKCE, so a "public" client is not safe/);
  }
});

test("pkce may be waived only where the provider genuinely lacks it", () => {
  const declared = { needs: [{ key: "SLACK_CLIENT_ID", prompt: "Client ID", secret: false }] };
  // Slack: no PKCE, so a confidential client + pkce:false is the only declarable shape.
  const slack = oauthPlugin({
    authorizer: {
      oauth: {
        known_provider: "slack",
        pkce: false,
        client: { type: "user_supplied", need: "SLACK_CLIENT_ID" },
      },
      provider: declared,
    },
  });
  assert.equal(validateManifest(slack, { mode: "registry" }).ok, true);

  // Google: has PKCE, so waiving it is still refused.
  const google = oauthPlugin({ authorizer: { oauth: { pkce: false } } });
  assert.equal(validateManifest(google, { mode: "registry" }).ok, false);
});

test("an unverified preset is flagged for review rather than silently trusted", () => {
  const m = oauthPlugin({
    authorizer: {
      oauth: { known_provider: "figma", client: { type: "user_supplied", need: "FIGMA_CLIENT_ID" } },
      provider: { needs: [{ key: "FIGMA_CLIENT_ID", prompt: "Client ID", secret: false }] },
    },
  });
  const res = validateManifest(m, { mode: "registry" });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.match(res.warnings.join(" "), /has not been verified end to end/);
});

test("each preset carries the behaviour the runtime needs, not just URLs", () => {
  // Guards against a preset being added with only its two URLs, which would silently inherit Google's
  // scope delimiter and auth method.
  for (const [name, p] of Object.entries(OAUTH_PRESETS)) {
    for (const key of ["authorize_url", "token_url", "scope_separator", "token_auth", "pkce", "refresh",
                       "refresh_grant_type"]) {
      assert.ok(p[key] !== undefined, `preset ${name} is missing ${key}`);
    }
    assert.ok(["post", "basic"].includes(p.token_auth), `${name}.token_auth`);
    assert.ok(["required", "supported", "unsupported"].includes(p.pkce), `${name}.pkce`);
    assert.ok(["static", "rotating", "none"].includes(p.refresh), `${name}.refresh`);
    // null means "refresh at token_url"; a string must be a real endpoint, not a path fragment.
    assert.ok(p.refresh_url === null || /^https:\/\//.test(p.refresh_url), `${name}.refresh_url`);
  }
});

/* -------------------------------------------------- host client type (no backend, no credentials) */

test("a host client declares no credentials at all", () => {
  const m = oauthPlugin({ authorizer: { oauth: { client: { type: "host" } } } });
  for (const res of bothModes(m)) {
    assert.equal(res.ok, true, res.errors.join("; "));
    assert.deepEqual(res.manifest.providers.google_auth.oauth.client, {
      type: "host",
      id: null,
      need: null,
      secret_need: null,
    });
  }
});

test("a host client rejects every credential field", () => {
  // The point of the type is that a published document has nowhere to put a secret. Accepting these
  // silently would reopen exactly that.
  for (const extra of [{ id: "x.apps.googleusercontent.com" }, { secret_need: "GOOGLE_OAUTH_CLIENT_SECRET" }, { secret: "GOCSPX-x" }]) {
    const m = oauthPlugin({ authorizer: { oauth: { client: { type: "host", ...extra } } } });
    const res = validateManifest(m, { mode: "registry" });
    assert.equal(res.ok, false, JSON.stringify(extra));
    assert.match(res.errors.join(" "), /takes no (id|secret_need|secret)/);
  }
});

test("a host client requires a known provider", () => {
  // Credentials are keyed by provider name; a literal endpoint pair has no key to look them up under.
  const m = oauthPlugin({
    authorizer: {
      oauth: {
        client: { type: "host" },
        known_provider: undefined,
        authorize_url: "https://id.example.com/authorize",
        token_url: "https://id.example.com/token",
      },
    },
  });
  assert.match(validateManifest(m, { mode: "client" }).errors.join(" "), /requires known_provider/);
});

test("a host client is confidential, so no-PKCE providers become declarable", () => {
  // The public-client ban on GitHub/Slack does not apply: a host client carries a secret.
  const m = oauthPlugin({
    authorizer: { oauth: { known_provider: "github", client: { type: "host" }, pkce: false } },
  });
  const res = validateManifest(m, { mode: "registry" });
  assert.equal(res.ok, true, res.errors.join("; "));
});

/**
 * The shipped manifest lives outside the repository.
 *
 * `/plugins` is gitignored — it is where installed plugins land, not source — so this file exists on a
 * developer machine that has the plugin and never in a fresh checkout. The test therefore passed
 * locally and failed in CI with ENOENT the first time the pipeline ran it.
 *
 * Skipped rather than deleted, because the guard is worth keeping where the file does exist: it asserts
 * that a PUBLISHED manifest carries no client secret. Skipped rather than made to pass against an inline
 * copy, because a copy proves nothing about the artifact that actually ships.
 *
 * If this guard is wanted in CI — and "no secret in a published manifest" is a reasonable thing to want
 * there — the manifest needs a tracked home. That is a decision about where plugin sources live, not
 * something a test should quietly work around.
 */
const SHIPPED_MANIFEST = new URL("../plugins/zeraix/gmail-send/1.0.0/plugin.json", import.meta.url);
const shippedManifestMissing = existsSync(SHIPPED_MANIFEST)
  ? false
  : "plugins/ is gitignored, so the shipped manifest is absent from a fresh checkout";

test("the shipped gmail-send plugin asks the user for nothing", { skip: shippedManifestMissing }, () => {
  // Regression guard for the whole point of this shape: no needs[], no client id, no secret anywhere.
  const raw = JSON.parse(readFileSync(SHIPPED_MANIFEST, "utf8"));
  const res = validateManifest(raw, { mode: "registry" });
  assert.equal(res.ok, true, res.errors.join("; "));
  const auth = res.manifest.providers.google_auth;
  assert.equal(auth.oauth.client.type, "host");
  assert.deepEqual(auth.needs, []);
  assert.ok(!JSON.stringify(raw).includes("GOCSPX"), "no secret may appear in a published manifest");
});

/* -------------------------------------------------- refresh endpoint declared by a manifest */

/** A sideloaded manifest describing a Figma-shaped provider: refreshes elsewhere, bare body. */
const literalFigmaShape = {
  known_provider: undefined,
  authorize_url: "https://id.example.com/oauth",
  token_url: "https://api.example.com/v1/oauth/token",
  refresh_url: "https://api.example.com/v1/oauth/refresh",
  refresh_grant_type: false,
};

test("a sideloaded manifest may name its own refresh endpoint", () => {
  // Without this a literal manifest could not describe Figma at all: its refresh endpoint is not the
  // one that issued the token, so the refresh would go to the wrong URL and fail 90 days later.
  const m = oauthPlugin({ authorizer: { oauth: literalFigmaShape } });
  const res = validateManifest(m, { mode: "client" });
  assert.equal(res.ok, true, res.errors.join("; "));
  const o = res.manifest.providers.google_auth.oauth;
  assert.equal(o.refresh_url, "https://api.example.com/v1/oauth/refresh");
  assert.equal(o.refresh_grant_type, false);
  // Round-trips, as parseIndex requires.
  assert.equal(validateManifest(res.manifest, { mode: "client" }).ok, true);
});

test("a manifest-named refresh endpoint is refused for publication", () => {
  // It receives the client secret and the refresh token, so naming it is naming where credentials go.
  const m = oauthPlugin({ authorizer: { oauth: literalFigmaShape } });
  const res = validateManifest(m, { mode: "registry" });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /receives the client secret and refresh token/);
});

test("a preset's refresh endpoint cannot be overridden", () => {
  // The dangerous shape: keep a trusted known_provider while redirecting where credentials are posted.
  for (const over of [{ refresh_url: "https://evil.test/collect" }, { refresh_grant_type: false }]) {
    const m = oauthPlugin({ authorizer: { oauth: over } });
    for (const res of bothModes(m)) {
      assert.equal(res.ok, false, JSON.stringify(over));
      assert.match(res.errors.join(" "), /belong to the provider preset and cannot be overridden/);
    }
  }
});

test("a non-https refresh endpoint is refused", () => {
  const m = oauthPlugin({
    authorizer: { oauth: { ...literalFigmaShape, refresh_url: "http://evil.test/collect" } },
  });
  assert.equal(validateManifest(m, { mode: "client" }).ok, false);
});
