/**
 * Running a tool capability against an http provider. See electron/plugins/executor.mjs.
 *
 * The manifest decides the request and the model only supplies values, so these tests are mostly
 * about the boundary between those two: what an argument can and cannot change. A value that reaches
 * the URL as structure rather than data is the whole failure class here — it turns a tool scoped to
 * one API into one that can address anything the credential is good for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { setPluginRoot } from "../electron/plugins/storage.mjs";
import { configureOAuthHost } from "../electron/plugins/oauth.mjs";
import { authorizeAfterInstall } from "../electron/plugins/auth.mjs";
import { callTool, planRequest } from "../electron/plugins/executor.mjs";
import { getInstalled, installPlugin, resetCache } from "../electron/plugins/store.mjs";
import { validateManifest } from "../electron/plugins/manifest.mjs";
import { removeRoot } from "./helpers/tempRoot.mjs";

const PLUGIN_ID = "alice/gmail";

function manifest(tokenUrl, over = {}) {
  const raw = {
    schemaVersion: 1,
    id: PLUGIN_ID,
    version: "1.0.0",
    name: "Gmail",
    description: "The Gmail API.",
    license: "Apache-2.0",
    providers: {
      google_auth: {
        kind: "oauth",
        tier: "host",
        oauth: {
          authorize_url: "https://accounts.example.com/authorize",
          token_url: tokenUrl,
          scopes: ["https://mail.google.com/"],
          client: { type: "public", id: "test-client" },
          redirect: { method: "loopback" },
          mints: "gmail_oauth",
        },
        permissions: { network: ["accounts.example.com"], credentials: [] },
      },
      gmail_api: {
        kind: "http",
        tier: "sandboxed",
        url: "https://gmail.googleapis.com",
        auth: "google_auth",
        permissions: { network: ["gmail.googleapis.com"], credentials: ["gmail_oauth"] },
      },
    },
    capabilities: [
      {
        type: "tool",
        id: "users_messages_get",
        name: "users.messages.get",
        description: "Get one message. (GET /gmail/v1/users/me/messages/{id})",
        provider: "gmail_api",
        input_schema: { type: "object", properties: { id: { type: "string" }, format: { type: "string" } }, required: ["id"] },
        request: { method: "GET", path: "/gmail/v1/users/me/messages/{id}", query: { format: "{format}" } },
      },
      {
        type: "tool",
        id: "users_messages_send",
        name: "users.messages.send",
        description: "Send a message. (POST /gmail/v1/users/me/messages/send)",
        provider: "gmail_api",
        input_schema: { type: "object", properties: { body: { type: "object" } } },
        request: { method: "POST", path: "/gmail/v1/users/me/messages/send", body: "{body}" },
      },
    ],
    ...over,
  };
  const result = validateManifest(raw, { mode: "client" });
  assert.equal(result.ok, true, result.errors.join("; "));
  return { manifest: result.manifest, dist: { baseUrl: "https://cdn.example.com/alice/gmail/1.0.0/" } };
}

const io = { fetchFile: async () => Buffer.from("unused", "utf8") };

function fixtureServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/token`,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      }),
    );
  });
}

const fakeBrowser = async (authorizeUrl) => {
  const u = new URL(authorizeUrl);
  const cb = new URL(u.searchParams.get("redirect_uri"));
  cb.searchParams.set("code", "the-code");
  cb.searchParams.set("state", u.searchParams.get("state"));
  await fetch(cb.toString()).catch(() => {});
};

/** Records the request instead of making it. */
function recorder(response = { status: 200, body: '{"id":"m1"}' }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        ok: response.status < 400,
        status: response.status,
        statusText: response.statusText ?? "OK",
        text: async () => response.body,
      };
    },
  };
}

function withRoot(fn) {
  return async (t) => {
    resetCache();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zx-exec-"));
    setPluginRoot(root);
    configureOAuthHost({
      secretBox: { available: () => false, encrypt: (s) => s, decrypt: (s) => s },
      openExternal: fakeBrowser,
    });
    const srv = await fixtureServer();
    try {
      await installPlugin(manifest(srv.url), io);
      await fn(t, srv);
    } finally {
      srv.close();
      removeRoot(root);
    }
  };
}

/* ------------------------------------------------------------------ planning */

test(
  "a path parameter fills the template and a query parameter is appended",
  withRoot(async () => {
    const { plan } = planRequest(PLUGIN_ID, "users_messages_get", { id: "18f0c", format: "full" });
    assert.equal(plan.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f0c?format=full");
    assert.equal(plan.method, "GET");
    assert.equal(plan.auth, "google_auth");
  }),
);

test(
  "an omitted optional query parameter is absent, not empty",
  withRoot(async () => {
    // `?format=` is a different request from no `format`, and APIs do treat it differently.
    const { plan } = planRequest(PLUGIN_ID, "users_messages_get", { id: "18f0c" });
    assert.equal(plan.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f0c");
  }),
);

test(
  "a path argument is data, never structure",
  withRoot(async () => {
    // The failure this prevents: an id that walks out of the messages collection and addresses the
    // settings API — or any other endpoint the same token opens — from a tool scoped to reading mail.
    const { plan } = planRequest(PLUGIN_ID, "users_messages_get", { id: "../../settings/forwarding" });
    assert.equal(plan.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/..%2F..%2Fsettings%2Fforwarding");
    assert.ok(!plan.url.includes("/settings/forwarding"), "traversal must not survive encoding");
  }),
);

test(
  "a query argument cannot smuggle in a second parameter",
  withRoot(async () => {
    const { plan } = planRequest(PLUGIN_ID, "users_messages_get", { id: "m1", format: "full&userId=someone@else.com" });
    const url = new URL(plan.url);
    assert.equal(url.searchParams.get("format"), "full&userId=someone@else.com");
    assert.equal(url.searchParams.get("userId"), null, "the extra parameter must not be parsed as its own");
  }),
);

test(
  "a request outside the provider's permitted hosts is refused",
  withRoot(async () => {
    const rec = getInstalled(PLUGIN_ID);
    // The consent sheet named gmail.googleapis.com; this is what happens if the provider url moves.
    rec.providers.gmail_api.url = "https://evil.example.com";
    const r = planRequest(PLUGIN_ID, "users_messages_get", { id: "m1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /not in this plugin's permitted hosts/);
  }),
);

test(
  "a non-https provider is refused even when its host is permitted",
  withRoot(async () => {
    const rec = getInstalled(PLUGIN_ID);
    rec.providers.gmail_api.url = "http://gmail.googleapis.com";
    const r = planRequest(PLUGIN_ID, "users_messages_get", { id: "m1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /non-https/);
  }),
);

test(
  "a disabled or revoked plugin cannot be called",
  withRoot(async () => {
    getInstalled(PLUGIN_ID).enabled = false;
    assert.match(planRequest(PLUGIN_ID, "users_messages_get", { id: "m1" }).error, /disabled/);
    getInstalled(PLUGIN_ID).enabled = true;
    getInstalled(PLUGIN_ID).revoked = { reason: "withdrawn", at: "now" };
    assert.match(planRequest(PLUGIN_ID, "users_messages_get", { id: "m1" }).error, /revoked/);
  }),
);

/* ------------------------------------------------------------------- calling */

test(
  "a call carries the plugin's grant and nothing of the model's choosing",
  withRoot(async () => {
    await authorizeAfterInstall(PLUGIN_ID);
    const rec = recorder();
    const r = await callTool(PLUGIN_ID, "users_messages_get", { id: "m1" }, { fetchImpl: rec.fetchImpl });

    assert.equal(r.ok, true, r.content);
    assert.equal(r.content, '{"id":"m1"}');
    assert.equal(rec.calls[0].headers.authorization, "Bearer at-1");
    assert.equal(rec.calls[0].method, "GET");
    assert.equal(rec.calls[0].body, undefined, "a GET carries no body");
  }),
);

test(
  "a POST sends the caller's resource as the JSON body",
  withRoot(async () => {
    await authorizeAfterInstall(PLUGIN_ID);
    const rec = recorder();
    await callTool(PLUGIN_ID, "users_messages_send", { body: { raw: "encoded-rfc822" } }, { fetchImpl: rec.fetchImpl });

    assert.equal(rec.calls[0].method, "POST");
    assert.equal(rec.calls[0].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(rec.calls[0].body), { raw: "encoded-rfc822" });
  }),
);

test(
  "an API error comes back as readable content, not an exception",
  withRoot(async () => {
    await authorizeAfterInstall(PLUGIN_ID);
    // The body is the useful half: it names the missing scope or the bad id, and a thrown error
    // would lose it and end the turn.
    const rec = recorder({ status: 403, statusText: "Forbidden", body: '{"error":{"message":"Insufficient Permission"}}' });
    const r = await callTool(PLUGIN_ID, "users_messages_get", { id: "m1" }, { fetchImpl: rec.fetchImpl });

    assert.equal(r.ok, false);
    assert.match(r.content, /HTTP 403 Forbidden/);
    assert.match(r.content, /Insufficient Permission/);
  }),
);

test(
  "an unconnected plugin re-runs the flow rather than calling unauthenticated",
  withRoot(async () => {
    // No authorizeAfterInstall: this is a tool used before the account was ever connected.
    const rec = recorder();
    const r = await callTool(PLUGIN_ID, "users_messages_get", { id: "m1" }, { fetchImpl: rec.fetchImpl });

    assert.equal(r.ok, true, r.content);
    assert.equal(rec.calls[0].headers.authorization, "Bearer at-1", "the grant was obtained at the point of use");
  }),
);

test(
  "an oversized response is truncated and says so",
  withRoot(async () => {
    await authorizeAfterInstall(PLUGIN_ID);
    const rec = recorder({ status: 200, body: "x".repeat(300 * 1024) });
    const r = await callTool(PLUGIN_ID, "users_messages_get", { id: "m1" }, { fetchImpl: rec.fetchImpl });

    assert.equal(r.ok, true);
    assert.match(r.content, /\[truncated: response was 307200 bytes/);
  }),
);

test(
  "a capability that is not a callable tool is refused",
  withRoot(async () => {
    assert.match(planRequest(PLUGIN_ID, "nope", {}).error, /no installed capability/);
  }),
);
