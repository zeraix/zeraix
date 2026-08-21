/**
 * When a plugin's OAuth grant is asked for. See electron/plugins/auth.mjs.
 *
 * The rule this pins down: authorize on install completion, record the outcome either way, and ask
 * again before a capability that needs a grant is used. The properties worth protecting are the ones
 * a type check cannot see — that a failed authorization does not fail an otherwise-good install,
 * that a capability binding nothing never opens a browser, and that reinstalling over a live grant
 * does not re-prompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { setPluginRoot } from "../electron/plugins/storage.mjs";
import { configureOAuthHost, credentialKey, credentialStatus, revokeCredential } from "../electron/plugins/oauth.mjs";
import {
  authStatus,
  authorizeAfterInstall,
  ensureAuthorized,
  pluginAuthHeaders,
  reauthorize,
} from "../electron/plugins/auth.mjs";
import { getInstalled, installPlugin, resetCache, sha512 } from "../electron/plugins/store.mjs";
import { validateManifest } from "../electron/plugins/manifest.mjs";
import { removeRoot } from "./helpers/tempRoot.mjs";

const PLUGIN_ID = "alice/gmail";
const SKILL = "# Sending mail\n\nConfirm before sending to a list.\n";
const BASE = "https://cdn.example.com/alice/gmail/1.0.0/";
const KEY = credentialKey(PLUGIN_ID, "google_auth", "gmail_oauth");

/** Token endpoint stand-in. `handler` decides what the provider says. */
function fixtureServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(Object.fromEntries(new URLSearchParams(body)));
      const out = handler(seen.length);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/token`,
        seen,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      }),
    );
  });
}

/** Counts openings, so a test can assert a browser was NOT opened. */
function browser({ deny = false } = {}) {
  const opened = [];
  return {
    opened,
    openExternal: async (authorizeUrl) => {
      opened.push(authorizeUrl);
      const u = new URL(authorizeUrl);
      const cb = new URL(u.searchParams.get("redirect_uri"));
      if (deny) cb.searchParams.set("error", "access_denied");
      else cb.searchParams.set("code", "the-code");
      cb.searchParams.set("state", u.searchParams.get("state"));
      await fetch(cb.toString()).catch(() => {});
    },
  };
}

/**
 * A manifest shaped the way the schema actually requires.
 *
 * Nothing binds to an oauth provider directly — `oauth` is non-bindable, so a capability binds to the
 * provider that makes the CALL (gmail_api) and that provider names its authorizer through `auth`.
 * The two-hop resolution that follows is the thing under test, and getting it wrong would mean a tool
 * running with no grant.
 */
function entry(tokenUrl) {
  const raw = {
    schemaVersion: 1,
    id: PLUGIN_ID,
    version: "1.0.0",
    name: "Gmail",
    description: "Send email from chat.",
    license: "Apache-2.0",
    providers: {
      google_auth: {
        kind: "oauth",
        tier: "host",
        oauth: {
          authorize_url: "https://accounts.example.com/authorize",
          token_url: tokenUrl,
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
          client: { type: "public", id: "test-client" },
          redirect: { method: "loopback" },
          mints: "gmail_oauth",
        },
        permissions: { network: ["accounts.example.com"], credentials: [] },
      },
      gmail_api: {
        kind: "http",
        tier: "sandboxed",
        url: "https://gmail.example.com",
        auth: "google_auth",
        permissions: { network: ["gmail.example.com"], credentials: ["gmail_oauth"] },
      },
    },
    capabilities: [
      {
        type: "tool",
        id: "send_email",
        name: "Send email",
        description: "Send from the connected account.",
        provider: "gmail_api",
      },
      {
        type: "skill",
        id: "gmail_etiquette",
        name: "Sending mail well",
        description: "When to send and when to confirm first.",
        path: "skill.md",
        sha512: sha512(Buffer.from(SKILL, "utf8")),
      },
    ],
  };
  // client mode: literal endpoints are refused for publication, which is exactly what a fixture needs.
  const result = validateManifest(raw, { mode: "client" });
  assert.equal(result.ok, true, result.errors.join("; "));
  return { manifest: result.manifest, dist: { baseUrl: BASE } };
}

const io = { fetchFile: async () => Buffer.from(SKILL, "utf8") };

/**
 * Put `send_email` back on the installed record.
 *
 * `tool` is not in IMPLEMENTED_CAPABILITY_TYPES, so install drops it — which means the gate cannot be
 * exercised through a real install on this build. The provider graph it resolves against IS real
 * (installPlugin persists the manifest's providers verbatim); only the capability row is reinstated,
 * so what these tests cover is the resolution and the flow, not a fake.
 */
function withToolCapability(id = PLUGIN_ID) {
  const rec = getInstalled(id);
  rec.capabilities.push({
    id: "send_email",
    type: "tool",
    module: null,
    providers: ["gmail_api"],
    path: null,
    sha512: null,
    revoked: null,
  });
  return rec;
}

function withRoot(fn) {
  return async (t) => {
    resetCache();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zx-plugin-auth-"));
    setPluginRoot(root);
    process.env.ZX_TEST_ROOT = root; // so a test can reach into the credential store on disk
    configureOAuthHost({ secretBox: { available: () => false, encrypt: (s) => s, decrypt: (s) => s } });
    try {
      await fn(t);
    } finally {
      removeRoot(root);
    }
  };
}

const granting = () => fixtureServer(() => ({ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } }));

/* ------------------------------------------------------------------ install */

test(
  "installing authorizes the plugin's oauth provider and records the success",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });

    assert.equal((await installPlugin(entry(srv.url), io)).ok, true);
    const { results } = await authorizeAfterInstall(PLUGIN_ID);
    srv.close();

    assert.deepEqual(results, [{ providerId: "google_auth", authorized: true, error: null }]);
    assert.equal(b.opened.length, 1, "the flow ran exactly once");
    assert.equal(credentialStatus(KEY).authorized, true);
    assert.equal(getInstalled(PLUGIN_ID).auth.google_auth.error, null);
  }),
);

test(
  "a declined authorization is recorded but does not undo the install",
  withRoot(async () => {
    const srv = await granting();
    configureOAuthHost({ openExternal: browser({ deny: true }).openExternal });

    assert.equal((await installPlugin(entry(srv.url), io)).ok, true);
    const { results } = await authorizeAfterInstall(PLUGIN_ID);
    srv.close();

    assert.equal(results[0].authorized, false);
    assert.match(results[0].error, /declined/);
    // The bytes are on disk and verified; only the grant is missing.
    assert.equal(getInstalled(PLUGIN_ID).version, "1.0.0");
    assert.equal(credentialStatus(KEY).authorized, false);
    assert.match(getInstalled(PLUGIN_ID).auth.google_auth.error, /declined/);
  }),
);

test(
  "reinstalling over a live grant does not ask again",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });

    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);
    await authorizeAfterInstall(PLUGIN_ID); // a second install of the same version
    srv.close();

    assert.equal(b.opened.length, 1, "the existing grant was reused");
  }),
);

/* --------------------------------------------------------------- before use */

test(
  "using a capability bound to nothing never opens a browser",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    srv.close();

    // No grant exists at all, and this must still be fine: a content skill needs no account.
    const gate = await ensureAuthorized(PLUGIN_ID, "gmail_etiquette");
    assert.equal(gate.ok, true, gate.error);
    assert.deepEqual(gate.authorized, []);
    assert.equal(b.opened.length, 0);
  }),
);

test(
  "a capability that needs a grant re-triggers the flow when there is none",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    withToolCapability();

    // Stands in for every way a grant goes away after install: declined, interrupted, or revoked at
    // the provider months later.
    const gate = await ensureAuthorized(PLUGIN_ID, "send_email");
    srv.close();

    assert.equal(gate.ok, true, gate.error);
    assert.deepEqual(gate.authorized, ["google_auth"]);
    assert.equal(b.opened.length, 1);
    assert.equal(credentialStatus(KEY).authorized, true);
  }),
);

test(
  "a grant already held is used without re-asking",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);
    withToolCapability();

    const gate = await ensureAuthorized(PLUGIN_ID, "send_email");
    srv.close();

    assert.equal(gate.ok, true);
    assert.equal(b.opened.length, 1, "install authorized it; use did not ask again");
  }),
);

test(
  "a revoked grant is re-requested at the point of use",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);
    withToolCapability();
    revokeCredential(KEY); // as if the user withdrew it at the provider

    const gate = await ensureAuthorized(PLUGIN_ID, "send_email");
    srv.close();

    assert.equal(gate.ok, true, gate.error);
    assert.equal(b.opened.length, 2, "the flow ran again for the missing grant");
  }),
);

test(
  "a refused re-authorization reports why instead of throwing",
  withRoot(async () => {
    const srv = await granting();
    configureOAuthHost({ openExternal: browser({ deny: true }).openExternal });
    await installPlugin(entry(srv.url), io);
    withToolCapability();

    const gate = await ensureAuthorized(PLUGIN_ID, "send_email");
    srv.close();

    assert.equal(gate.ok, false);
    assert.match(gate.error, /send_email needs an authorized google_auth/);
    assert.match(gate.error, /declined/);
  }),
);

test(
  "a disabled plugin is refused before any flow is started",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    withToolCapability().enabled = false;

    const gate = await ensureAuthorized(PLUGIN_ID, "send_email");
    srv.close();

    assert.equal(gate.ok, false);
    assert.match(gate.error, /disabled/);
    assert.equal(b.opened.length, 0, "a disabled plugin must not open a browser");
  }),
);

/* -------------------------------------------------------------- status / UI */

test(
  "status reports the grant and the last failure separately",
  withRoot(async () => {
    const srv = await granting();
    configureOAuthHost({ openExternal: browser({ deny: true }).openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);

    const [denied] = authStatus(PLUGIN_ID);
    assert.equal(denied.authorized, false);
    assert.match(denied.lastError, /declined/);
    assert.deepEqual(denied.scopes, ["https://www.googleapis.com/auth/gmail.send"]);
    assert.equal(denied.tier, "host");

    // Recovering from a click clears the failure without needing a reinstall.
    configureOAuthHost({ openExternal: browser().openExternal });
    const again = await reauthorize(PLUGIN_ID);
    srv.close();

    assert.equal(again.ok, true, again.error);
    const [ok] = authStatus(PLUGIN_ID);
    assert.equal(ok.authorized, true);
    assert.equal(ok.lastError, null);
    assert.equal(ok.canRefresh, true);
  }),
);

test(
  "a plugin with no oauth provider has nothing to authorize",
  withRoot(async () => {
    const plain = {
      manifest: validateManifest(
        {
          schemaVersion: 1,
          id: "alice/notes",
          version: "1.0.0",
          name: "Notes",
          description: "A plain skill.",
          license: "MIT",
          capabilities: [{ type: "skill", id: "notes", path: "skill.md", sha512: sha512(Buffer.from(SKILL, "utf8")) }],
        },
        { mode: "client" },
      ).manifest,
      dist: { baseUrl: "https://cdn.example.com/alice/notes/1.0.0/" },
    };
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(plain, io);

    assert.deepEqual((await authorizeAfterInstall("alice/notes")).results, []);
    assert.deepEqual(authStatus("alice/notes"), []);
    assert.equal((await ensureAuthorized("alice/notes", "notes")).ok, true);
    assert.equal(b.opened.length, 0);
  }),
);

test(
  "an unknown capability is refused rather than waved through",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    srv.close();

    // "Needs no grant" and "does not exist" must not collapse into the same answer: a typo'd id
    // reaching an executor as authorized is the failure this distinction exists to prevent.
    const gate = await ensureAuthorized(PLUGIN_ID, "send_emial");
    assert.equal(gate.ok, false);
    assert.match(gate.error, /no installed capability "send_emial"/);
    assert.equal(b.opened.length, 0);
  }),
);

/* ------------------------------------------------ spending the grant from MCP */

test(
  "an MCP request spends the grant the install obtained",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);

    // The last step of the flow: the agent's calls through the plugin's MCP server reuse the account
    // already connected, rather than starting a second negotiation of their own.
    const headers = await pluginAuthHeaders({ accept: "application/json" }, {
      pluginId: PLUGIN_ID,
      providerId: "google_auth",
    });
    srv.close();

    assert.equal(headers.authorization, "Bearer at-1");
    assert.equal(headers.accept, "application/json", "existing headers survive");
    assert.equal(b.opened.length, 1, "spending a grant never opens a browser");
  }),
);

test(
  "an unconnected plugin reports why instead of sending an anonymous request",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    srv.close();

    // Sending it unauthenticated would surface as a 401 from the server, and the user would be told
    // their server is broken when their account is simply not connected.
    await assert.rejects(
      () => pluginAuthHeaders({}, { pluginId: PLUGIN_ID, providerId: "google_auth" }),
      /is not connected/,
    );
    assert.equal(b.opened.length, 0, "a transport must never open a consent screen mid-connect");
  }),
);

test(
  "a disabled plugin stops lending its credential immediately",
  withRoot(async () => {
    const srv = await granting();
    configureOAuthHost({ openExternal: browser().openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);
    srv.close();

    getInstalled(PLUGIN_ID).enabled = false;
    await assert.rejects(
      () => pluginAuthHeaders({}, { pluginId: PLUGIN_ID, providerId: "google_auth" }),
      /is disabled/,
    );
  }),
);

/* ------------------------------------------------------- updating a plugin */

test(
  "an update that widens scopes asks again; one that does not, does not",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);
    assert.equal(b.opened.length, 1);

    // A new version that asks for no more than before reuses the grant. This is the common update and
    // it must not cost the user a consent screen.
    await authorizeAfterInstall(PLUGIN_ID);
    assert.equal(b.opened.length, 1, "same scopes, same grant");

    // A new version that wants more. Nothing else would catch this: the token still works and has not
    // expired, so the only symptom would be 403s on the calls the update was published for.
    getInstalled(PLUGIN_ID).providers.google_auth.oauth.scopes.push("https://www.googleapis.com/auth/gmail.readonly");
    const { results } = await authorizeAfterInstall(PLUGIN_ID);
    srv.close();

    assert.equal(results[0].authorized, true, results[0].error);
    assert.equal(b.opened.length, 2, "the widened scope was requested from the provider");
  }),
);

test(
  "a grant predating scope tracking is not invalidated by an update",
  withRoot(async () => {
    const srv = await granting();
    const b = browser();
    configureOAuthHost({ openExternal: b.openExternal });
    await installPlugin(entry(srv.url), io);
    await authorizeAfterInstall(PLUGIN_ID);

    // What every already-installed plugin looks like on the release that adds this: a working grant
    // with no record of what it was asked for. Unknown history is not evidence of a narrow one, and
    // re-prompting everyone on upgrade would be a worse bug than the one being fixed.
    const store = JSON.parse(fs.readFileSync(path.join(process.env.ZX_TEST_ROOT ?? "", "oauth.json"), "utf8"));
    for (const row of Object.values(store)) {
      const rec = JSON.parse(row.value);
      delete rec.requested_scopes;
      row.value = JSON.stringify(rec);
    }
    fs.writeFileSync(path.join(process.env.ZX_TEST_ROOT ?? "", "oauth.json"), JSON.stringify(store), "utf8");

    await authorizeAfterInstall(PLUGIN_ID);
    srv.close();
    assert.equal(b.opened.length, 1, "an unknown scope history is treated as sufficient");
  }),
);
