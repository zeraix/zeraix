/**
 * The OAuth flow, driven end to end against a fixture authorization server.
 *
 * These exist because the parts that must not regress are the security properties, and every one of
 * them is invisible to a type check: the code is not exchanged when `state` does not match, the token
 * never lands on disk in plaintext, a revoked grant is deleted rather than retried, and a refresh
 * response that omits the refresh token does not silently downgrade a durable grant to a one-hour one.
 *
 * The module takes its two host capabilities as injected seams (see its header), so a fake browser and
 * an identity secret-box drive the whole flow with no Electron present.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { setPluginRoot } from "../electron/plugins/storage.mjs";
import {
  authorize,
  configureOAuthHost,
  credentialKey,
  credentialStatus,
  injectAuthHeader,
  revokeCredential,
} from "../electron/plugins/oauth.mjs";
import { removeRoot } from "./helpers/tempRoot.mjs";

const KEY = credentialKey("alice/gmail", "google_auth", "gmail_oauth");

/** A validated oauth block, as validateManifest would normalize it — with literal endpoints so the
 *  fixture server can stand in for Google. */
const oauthBlock = (tokenUrl, authorizeUrl) => ({
  known_provider: null,
  authorize_url: authorizeUrl,
  token_url: tokenUrl,
  scopes: ["https://www.googleapis.com/auth/gmail.send"],
  client: { type: "public", id: "test-client" },
  redirect: { method: "loopback" },
  mints: "gmail_oauth",
  pkce: true,
});

/** Stands in for the provider: serves the token endpoint, and records what it was sent. */
function fixtureServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      seen.push(form);
      const out = handler(form, seen.length);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/token`,
        seen,
        // Same keep-alive trap the module's listener has: fetch holds the socket open, so close()
        // alone would leave the fixture running and the test process would never exit.
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      }),
    );
  });
}

/**
 * A browser that follows the redirect immediately. `mutate` lets a test corrupt the callback the way
 * an attacker or a provider error would.
 */
const fakeBrowser = (mutate = (u) => u) => async (authorizeUrl) => {
  const u = new URL(authorizeUrl);
  const cb = new URL(u.searchParams.get("redirect_uri"));
  cb.searchParams.set("code", "the-code");
  cb.searchParams.set("state", u.searchParams.get("state"));
  await fetch(mutate(cb).toString()).catch(() => {});
};

function withRoot(fn) {
  return async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zx-oauth-"));
    setPluginRoot(root);
    // Identity box by default; the encryption test replaces it.
    configureOAuthHost({ secretBox: { available: () => false, encrypt: (s) => s, decrypt: (s) => s } });
    try {
      await fn(t, root);
    } finally {
      removeRoot(root);
    }
  };
}

test(
  "a full authorization stores a usable grant and sends PKCE",
  withRoot(async () => {
    const srv = await fixtureServer(() => ({
      body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" },
    }));
    configureOAuthHost({ openExternal: fakeBrowser() });

    const status = await authorize({
      pluginId: "alice/gmail",
      providerId: "google_auth",
      oauth: oauthBlock(srv.url, "https://accounts.google.com/o/oauth2/v2/auth"),
      resolveNeed: () => null,
    });
    srv.close();

    assert.equal(status.authorized, true);
    assert.equal(status.canRefresh, true);
    // The verifier must reach the token endpoint, or PKCE is decorative.
    assert.match(srv.seen[0].code_verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(srv.seen[0].grant_type, "authorization_code");
    assert.equal(srv.seen[0].code, "the-code");
  }),
);

test(
  "a mismatched state is never exchanged",
  withRoot(async () => {
    // The CSRF case: redeeming a code we did not ask for binds this install to someone else's account.
    const srv = await fixtureServer(() => ({ body: { access_token: "should-never-be-issued" } }));
    configureOAuthHost({
      openExternal: fakeBrowser((cb) => {
        cb.searchParams.set("state", "attacker-state");
        return cb;
      }),
    });

    await assert.rejects(
      authorize({
        pluginId: "alice/gmail",
        providerId: "google_auth",
        oauth: oauthBlock(srv.url, "https://x.test/a"),
        resolveNeed: () => null,
      }),
      /state did not match/,
    );
    srv.close();
    assert.equal(srv.seen.length, 0, "the token endpoint must not have been called at all");
    assert.equal(credentialStatus(KEY).authorized, false);
  }),
);

test(
  "a declined authorization reports the user's choice, not a failure",
  withRoot(async () => {
    const srv = await fixtureServer(() => ({ body: {} }));
    configureOAuthHost({
      openExternal: fakeBrowser((cb) => {
        cb.searchParams.delete("code");
        cb.searchParams.set("error", "access_denied");
        return cb;
      }),
    });
    await assert.rejects(
      authorize({
        pluginId: "alice/gmail",
        providerId: "google_auth",
        oauth: oauthBlock(srv.url, "https://x.test/a"),
        resolveNeed: () => null,
      }),
      /you declined/,
    );
    srv.close();
  }),
);

test(
  "the token is encrypted at rest and never written in plaintext",
  withRoot(async (_t, root) => {
    const srv = await fixtureServer(() => ({ body: { access_token: "super-secret-token", expires_in: 3600 } }));
    configureOAuthHost({
      openExternal: fakeBrowser(),
      // Stands in for safeStorage: reversible, but not the plaintext.
      secretBox: {
        available: () => true,
        encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
        decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
      },
    });

    await authorize({
      pluginId: "alice/gmail",
      providerId: "google_auth",
      oauth: oauthBlock(srv.url, "https://x.test/a"),
      resolveNeed: () => null,
    });
    srv.close();

    const raw = fs.readFileSync(path.join(root, "oauth.json"), "utf8");
    assert.ok(!raw.includes("super-secret-token"), "the access token must not appear in the file");
    assert.equal(credentialStatus(KEY).authorized, true);
  }),
);

test(
  "an expired token is refreshed, and a refresh that omits the refresh token keeps the old one",
  withRoot(async () => {
    // Dropping it here is what turns a durable grant into a one-hour one — the bug that shows up as
    // "it stopped working overnight" rather than as an error.
    const srv = await fixtureServer((form, n) =>
      n === 1
        ? { body: { access_token: "at-1", refresh_token: "rt-1", expires_in: -1 } }
        : { body: { access_token: "at-2", expires_in: 3600 } },
    );
    configureOAuthHost({ openExternal: fakeBrowser() });
    const oauth = oauthBlock(srv.url, "https://x.test/a");

    await authorize({ pluginId: "alice/gmail", providerId: "google_auth", oauth, resolveNeed: () => null });
    const headers = await injectAuthHeader({}, {
      pluginId: "alice/gmail",
      providerId: "google_auth",
      oauth,
      resolveNeed: () => null,
    });
    srv.close();

    assert.equal(headers.authorization, "Bearer at-2");
    assert.equal(srv.seen[1].grant_type, "refresh_token");
    assert.equal(srv.seen[1].refresh_token, "rt-1");
    assert.equal(credentialStatus(KEY).canRefresh, true, "the refresh token must survive a response that omits it");
  }),
);

test(
  "a revoked grant is deleted rather than retried forever",
  withRoot(async () => {
    const srv = await fixtureServer((form, n) =>
      n === 1
        ? { body: { access_token: "at-1", refresh_token: "rt-1", expires_in: -1 } }
        : { status: 400, body: { error: "invalid_grant" } },
    );
    configureOAuthHost({ openExternal: fakeBrowser() });
    const oauth = oauthBlock(srv.url, "https://x.test/a");

    await authorize({ pluginId: "alice/gmail", providerId: "google_auth", oauth, resolveNeed: () => null });
    await assert.rejects(
      injectAuthHeader({}, { pluginId: "alice/gmail", providerId: "google_auth", oauth, resolveNeed: () => null }),
      /revoked/,
    );
    srv.close();
    assert.equal(credentialStatus(KEY).authorized, false, "the dead record must be cleared, not kept");
  }),
);

test(
  "credentialStatus never exposes the token, and revoke clears it",
  withRoot(async () => {
    const srv = await fixtureServer(() => ({ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } }));
    configureOAuthHost({ openExternal: fakeBrowser() });
    await authorize({
      pluginId: "alice/gmail",
      providerId: "google_auth",
      oauth: oauthBlock(srv.url, "https://x.test/a"),
      resolveNeed: () => null,
    });
    srv.close();

    // This is the shape the renderer is allowed to see (§5). An allowlist, so a field added to the
    // record has to be considered here before it can reach the renderer — which is the point.
    // `requestedScopes` is what we ASKED this grant for: it is in the manifest the user consented to,
    // and it is what the plugins page needs to explain that an update wants more than the grant covers.
    const status = credentialStatus(KEY);
    assert.deepEqual(Object.keys(status).sort(), ["authorized", "canRefresh", "expiresAt", "requestedScopes", "scope"]);
    assert.ok(!JSON.stringify(status).includes("at-1"));
    assert.ok(!JSON.stringify(status).includes("rt-1"), "nor the refresh token");
    assert.deepEqual(status.requestedScopes, ["https://www.googleapis.com/auth/gmail.send"]);

    revokeCredential(KEY);
    assert.equal(credentialStatus(KEY).authorized, false);
  }),
);
