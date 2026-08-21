/**
 * OAuth 2.0 Authorization Code + PKCE for plugin providers. See docs/plugin-oauth-provider-design.md.
 *
 * What this owns: building the authorization URL, catching the loopback callback, exchanging the
 * code, storing the tokens encrypted, refreshing them, and handing an Authorization header to the
 * host's egress path. What it never does is give any of that to plugin code -- see §5. A refresh
 * token is a standing grant, and handing one to a plugin makes every later compromise retroactive.
 *
 * **No `electron` import**, the same discipline storage.mjs states and for the same reason: one named
 * import from `electron` anywhere in the chain makes the whole chain impossible to cover with
 * `npm test`. The two host capabilities this genuinely needs arrive as injected seams --
 * `openExternal` (shell) and `secretBox` (safeStorage) -- wired once at startup by paths.mjs. A test
 * passes a fake browser and an identity box and drives the whole flow against a local fixture server.
 *
 * Threat notes that shaped this file, none of them theoretical:
 *   - The loopback interface is shared with every other process on the machine. PKCE is what makes an
 *     intercepted callback useless, which is why the schema refuses to let a manifest turn it off.
 *   - `state` is compared in constant time. A timing oracle on a CSRF token is a small hole but a
 *     free one to close.
 *   - The listener binds 127.0.0.1 explicitly, never 0.0.0.0, and never outlives its attempt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { OAUTH_PRESETS, OAUTH_PROFILE_DEFAULTS, isAcceptableOAuthEndpoint } from "./manifest.mjs";
import { pluginRoot, readJson, writeJsonAtomic } from "./storage.mjs";

/** How long the user has to finish in the browser before the listener is torn down. */
export const AUTH_TIMEOUT_MS = 300_000;
/** Refresh this far ahead of expiry, so a call never races the clock. */
export const REFRESH_SKEW_MS = 60_000;

/* ------------------------------------------------------------------ host seams */

let openExternal = async () => {
  throw new Error("oauth: openExternal is not wired -- call configureOAuthHost() during startup");
};
/** Identity by default so tests need no crypto; startup replaces it with safeStorage. */
let secretBox = { encrypt: (s) => s, decrypt: (s) => s, available: () => false };

/**
 * Wire the two host capabilities. Called once from paths.mjs, which owns the `electron` import:
 *
 *   configureOAuthHost({
 *     openExternal: (url) => shell.openExternal(url),
 *     secretBox: {
 *       available: () => safeStorage.isEncryptionAvailable(),
 *       encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
 *       decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
 *     },
 *   })
 */
export function configureOAuthHost(host) {
  if (host?.openExternal) openExternal = host.openExternal;
  if (host?.secretBox) secretBox = host.secretBox;
}

/* ------------------------------------------------------------------ protocol pieces */

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE S256. `plain` is not offered: the schema rejects it, so there is no code path that needs it. */
export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function randomState() {
  return b64url(crypto.randomBytes(32));
}

/** Constant-time equality that does not leak length through an early return. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Endpoints for a validated `oauth` block.
 *
 * The preset is resolved HERE, from the host's own table, and never read from the manifest -- §3.1.
 * A literal pair only reaches this point on a sideloaded manifest; registry mode refuses to publish
 * one. Both paths are re-checked for https because this is the last place before a browser opens.
 */
export function resolveEndpoints(oauth) {
  // Endpoints AND behaviour. Providers disagree about more than URLs -- the scope delimiter, whether
  // the secret goes in the body or an Authorization header, whether PKCE exists, whether a refresh
  // rotates. Every one of those was hardcoded to Google's answer before this, which would have failed
  // on the four other presets the table already advertises.
  const ep = oauth.known_provider
    ? { ...OAUTH_PROFILE_DEFAULTS, ...OAUTH_PRESETS[oauth.known_provider] }
    : {
        ...OAUTH_PROFILE_DEFAULTS,
        authorize_url: oauth.authorize_url,
        token_url: oauth.token_url,
        // A literal manifest may describe a provider that refreshes elsewhere, or with a bare body.
        // Null means "same endpoint, RFC 6749 shape", which is what the defaults already say.
        ...(oauth.refresh_url ? { refresh_url: oauth.refresh_url } : {}),
        ...(oauth.refresh_grant_type !== null && oauth.refresh_grant_type !== undefined
          ? { refresh_grant_type: oauth.refresh_grant_type }
          : {}),
      };
  if (!ep?.authorize_url || !ep?.token_url) {
    throw new Error(`oauth: no endpoints for provider "${oauth.known_provider ?? "(literal)"}"`);
  }
  for (const url of [ep.authorize_url, ep.token_url, ep.refresh_url].filter(Boolean)) {
    // Same predicate the validator uses, imported rather than restated: the last gate before a browser
    // opens must not be able to disagree with the gate that let the manifest in.
    if (!isAcceptableOAuthEndpoint(url)) throw new Error(`oauth: refusing an unacceptable endpoint (${url})`);
  }
  return ep;
}

export function buildAuthorizeUrl({ profile, clientId, scopes, redirectUri, state, challenge }) {
  const u = new URL(profile.authorize_url);
  const q = u.searchParams;
  q.set("response_type", "code");
  q.set("client_id", clientId);
  q.set("redirect_uri", redirectUri);
  // Space is the RFC's delimiter and most providers follow it; Slack and others use a comma, and
  // sending the wrong one yields a grant with a single malformed scope rather than an error.
  q.set("scope", scopes.join(profile.scope_separator ?? " "));
  q.set("state", state);
  // Only when the provider has it. Sending code_challenge to one that does not is at best ignored.
  if (challenge && profile.pkce !== "unsupported") {
    q.set("code_challenge", challenge);
    q.set("code_challenge_method", "S256");
  }
  // Vendor-specific additions live in the profile, not here: `access_type=offline` is how Google
  // issues a refresh token at all, and means nothing to Figma.
  for (const [k, v] of Object.entries(profile.extra_authorize_params ?? {})) q.set(k, v);
  return u.toString();
}

/* ------------------------------------------------------------------ host credentials */

/**
 * Credentials this build ships for `client: { "type": "host" }`.
 *
 * Resolution order mirrors googleAuth.mjs's documented one: environment first (a developer overriding
 * locally), then the generated bundle (what a packaged build has). Read once.
 *
 * This is what removes the backend. The credential lives where the preset URLs live -- in the build --
 * so a plugin manifest names no client, a user is never asked for a secret, and adding a provider is
 * two environment variables rather than a deploy.
 */
let hostCredCache = null;
function hostCredentials(provider) {
  const upper = provider.toUpperCase();
  const envId = process.env[`PLUGIN_OAUTH_${upper}_CLIENT_ID`];
  const envSecret = process.env[`PLUGIN_OAUTH_${upper}_CLIENT_SECRET`];
  if (envId) return { client_id: envId, client_secret: envSecret ?? "" };

  if (!hostCredCache) {
    try {
      hostCredCache = JSON.parse(fs.readFileSync(new URL("./oauth-credentials.json", import.meta.url), "utf8"));
    } catch {
      // Absent is normal in a checkout that has never run the generator; the caller reports it.
      hostCredCache = {};
    }
  }
  return hostCredCache[provider] ?? null;
}

/* ------------------------------------------------------------------ loopback listener */

/** Shown in the browser tab the user is left staring at. Deliberately inert: no script, no styling hooks. */
const CLOSE_PAGE = (msg) =>
  `<!doctype html><meta charset="utf-8"><title>${msg}</title>` +
  `<body style="font:16px system-ui;padding:3rem;text-align:center">${msg}<br><br>You can close this tab.</body>`;

/**
 * Bind an ephemeral loopback port and resolve with the callback query.
 *
 * The port is the OS's choice, never the manifest's: a fixed port is squattable by any local process
 * and collides between plugins (§3.3). Binding happens BEFORE the browser opens, so a bind failure
 * never strands the user on a login page with nothing listening.
 *
 * @returns {Promise<{ redirectUri: string, waitForCode: () => Promise<object>, close: () => void }>}
 */
export function startLoopbackListener({ timeoutMs = AUTH_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolveBind, rejectBind) => {
    let settle;
    const received = new Promise((res, rej) => {
      settle = { res, rej };
    });

    let timer = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      const denied = params.error === "access_denied";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CLOSE_PAGE(params.error ? (denied ? "Authorization declined." : "Authorization failed.") : "Authorized."));
      settle.res(params);
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      // closeAllConnections BEFORE close: `close()` alone stops new connections but waits for open
      // ones to end, and a browser's keep-alive socket does not end just because we are done with it.
      // Without this the listener outlives the attempt it belongs to -- holding the port, and holding
      // the process open at quit -- which is exactly what the header promises it never does.
      server.closeAllConnections?.();
      server.close();
    };

    server.once("error", rejectBind);
    // 127.0.0.1, never 0.0.0.0: a callback listener reachable from the LAN is a code-interception hole.
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectBind);
      const { port } = server.address();

      timer = setTimeout(() => {
        cleanup();
        // Abandoning the browser tab is indistinguishable from a timeout -- we get no signal either
        // way. The message says "timed out" rather than guessing at the user's intent.
        settle.rej(new Error("oauth: timed out waiting for the authorization callback"));
      }, timeoutMs);

      signal?.addEventListener(
        "abort",
        () => {
          cleanup();
          // The browser tab is left open. We cannot close a tab we did not create, and pretending
          // otherwise in the UI is worse than saying so.
          settle.rej(new Error("oauth: cancelled"));
        },
        { once: true },
      );

      resolveBind({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        waitForCode: () => received.finally(cleanup),
        close: cleanup,
      });
    });
  });
}

/* ------------------------------------------------------------------ token endpoint */

async function postForm(url, form, { basicAuth = null } = {}) {
  // RFC 6749 makes client_secret_basic the DEFAULT method and client_secret_post the optional one;
  // Google accepts the body, Figma and others require the header. Which one is a provider fact, so it
  // comes from the profile rather than being assumed.
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (basicAuth) {
    headers.authorization = `Basic ${Buffer.from(`${basicAuth.id}:${basicAuth.secret}`).toString("base64")}`;
    delete form.client_secret;
    delete form.client_id;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // GitHub answers form-encoded unless asked otherwise; treat anything unparseable that way before
    // giving up, rather than reporting "invalid JSON" for a perfectly valid response.
    body = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || body.error) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    const e = new Error(`oauth: token endpoint refused the request (${detail})`);
    e.oauthError = body.error ?? null;
    throw e;
  }
  return body;
}

/** Normalize a token response into what the store keeps. `expires_in` is seconds, and often absent. */
function toRecord(body, previous = null, requested = null) {
  const expiresAt = Number.isFinite(Number(body.expires_in))
    ? Date.now() + Number(body.expires_in) * 1000
    : null;
  return {
    access_token: body.access_token,
    // A refresh response usually omits the refresh token, and dropping it would silently downgrade a
    // durable grant to a one-hour one -- the failure that looks like "it stopped working overnight".
    refresh_token: body.refresh_token ?? previous?.refresh_token ?? null,
    token_type: body.token_type ?? "Bearer",
    scope: body.scope ?? previous?.scope ?? null,
    // What THIS grant was asked for, as opposed to what the provider says it gave.
    //
    // The two are not reliably comparable: providers return granted scopes in their own vocabulary,
    // add ones you did not request (Google appends openid/email/profile), and sometimes omit the field
    // entirely. Comparing a manifest against that string produces false "insufficient" verdicts, and a
    // false verdict here costs a consent screen on every single call. What we asked for is exact, and
    // it is the thing that changes when a plugin updates — which is the case this exists for.
    requested_scopes: requested ?? previous?.requested_scopes ?? null,
    expires_at: expiresAt,
    obtained_at: Date.now(),
  };
}

/* ------------------------------------------------------------------ storage */

/**
 * Answers design-doc §11.2 for OAuth: plugin tokens get their own store rather than reusing
 * `servers.json`, which is MCP-shaped, plaintext, and readable by anything that can read the config.
 * Values are wrapped with safeStorage (DPAPI / Keychain / libsecret) exactly as integrityStore does.
 */
const tokenFile = () => path.join(pluginRoot(), "oauth.json");

/** `<pluginId>:<providerId>:<credentialId>` -- unique per install, per authorizer, per credential. */
export const credentialKey = (pluginId, providerId, credentialId) => `${pluginId}:${providerId}:${credentialId}`;

function readAll() {
  return readJson(tokenFile()) ?? {};
}

function writeRecord(key, record) {
  const all = readAll();
  if (record === null) delete all[key];
  else all[key] = { enc: secretBox.available(), value: secretBox.encrypt(JSON.stringify(record)) };
  writeJsonAtomic(tokenFile(), all);
}

function readRecord(key) {
  const row = readAll()[key];
  if (!row) return null;
  try {
    return JSON.parse(row.enc ? secretBox.decrypt(row.value) : row.value);
  } catch {
    // A record we cannot decrypt is a record from another machine or another OS user. Treat it as
    // absent so the user is asked to re-authorize, rather than crashing every call that needs it.
    return null;
  }
}

/** What the renderer may know: that a grant exists and when it lapses. Never the token. */
export function credentialStatus(key) {
  const rec = readRecord(key);
  if (!rec) return { authorized: false };
  return {
    authorized: true,
    expiresAt: rec.expires_at,
    scope: rec.scope,
    requestedScopes: rec.requested_scopes ?? null,
    canRefresh: !!rec.refresh_token,
  };
}

export function revokeCredential(key) {
  writeRecord(key, null);
}

/**
 * The client id/secret for a validated oauth block, whichever of the three shapes it declares.
 *
 *   host          from this build (see hostCredentials) -- the manifest names nothing
 *   public        an id embedded in the manifest, protected by PKCE
 *   user_supplied the user's own project, via needs[]
 */
function resolveClient(oauth, resolveNeed) {
  const c = oauth.client;
  if (c.type === "host") {
    if (!oauth.known_provider) {
      // validateManifest refuses `host` without a preset, so reaching this means the block was built
      // or mutated outside validation. Worth a sentence rather than a TypeError three frames deeper.
      throw new Error('oauth: client type "host" requires known_provider — there is no key to look credentials up under');
    }
    const cred = hostCredentials(oauth.known_provider);
    if (!cred?.client_id) {
      throw new Error(
        `oauth: this build ships no credentials for "${oauth.known_provider}" — set ` +
          `PLUGIN_OAUTH_${oauth.known_provider.toUpperCase()}_CLIENT_ID/_SECRET and re-run ` +
          `scripts/gen-plugin-oauth-credentials.mjs`,
      );
    }
    return { clientId: cred.client_id, clientSecret: cred.client_secret || null };
  }
  const clientId = c.type === "public" ? c.id : resolveNeed(c.need);
  if (!clientId) throw new Error(`oauth: no client id (needs "${c.need}" to be set)`);
  return { clientId, clientSecret: c.secret_need ? resolveNeed(c.secret_need) : null };
}

/* ------------------------------------------------------------------ the flow */

/**
 * Run one authorization to completion and store the result.
 *
 * Binds the listener first, opens the browser second: the reverse order leaves the user typing a
 * password into a page whose redirect has nowhere to land.
 *
 * @param {object} args
 * @param {string} args.pluginId    `publisher/name`
 * @param {string} args.providerId  the oauth provider's id in the manifest
 * @param {object} args.oauth       the NORMALIZED oauth block from validateManifest
 * @param {(key: string) => string} args.resolveNeed  reads a `needs` value (user-supplied client id/secret)
 * @param {AbortSignal} [args.signal]
 */
export async function authorize({ pluginId, providerId, oauth, resolveNeed, signal }) {
  const key = credentialKey(pluginId, providerId, oauth.mints);
  if (inFlight.has(key)) {
    // A second prompt for the same grant means two browser tabs and two listeners racing one
    // callback. The first attempt is the one that gets to finish.
    throw new Error("oauth: an authorization for this provider is already in progress");
  }

  const endpoints = resolveEndpoints(oauth);
  const { clientId, clientSecret } = resolveClient(oauth, resolveNeed);

  if (oauth.redirect.method !== "loopback") {
    // Reserved in the schema, not built. Saying so beats a half-registered scheme that fails on one OS.
    throw new Error(`oauth: redirect method "${oauth.redirect.method}" is not implemented yet`);
  }

  const { verifier, challenge } = createPkce();
  const state = randomState();
  const listener = await startLoopbackListener({ signal });

  const promise = (async () => {
    try {
      await openExternal(
        buildAuthorizeUrl({
          profile: endpoints,
          clientId,
          scopes: oauth.scopes,
          redirectUri: listener.redirectUri,
          state,
          challenge,
        }),
      );
      const params = await listener.waitForCode();

      if (!safeEqual(params.state, state)) {
        // The CSRF case. Do NOT exchange: a code arriving with someone else's state is a code we did
        // not ask for, and redeeming it would bind this install to an attacker's account.
        throw new Error("oauth: callback state did not match — the response was discarded");
      }
      if (params.error) {
        throw new Error(
          params.error === "access_denied"
            ? "oauth: you declined the authorization request"
            : `oauth: the provider returned "${params.error}"`,
        );
      }
      if (!params.code) throw new Error("oauth: the callback carried no authorization code");

      const body = await postForm(
        endpoints.token_url,
        {
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: listener.redirectUri,
          client_id: clientId,
          ...(endpoints.pkce !== "unsupported" ? { code_verifier: verifier } : {}),
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        },
        { basicAuth: endpoints.token_auth === "basic" && clientSecret ? { id: clientId, secret: clientSecret } : null },
      );
      writeRecord(key, toRecord(body, null, [...oauth.scopes]));
      return credentialStatus(key);
    } finally {
      listener.close();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/** Single-flight per credential: concurrent calls share one refresh instead of racing two. */
const inFlight = new Map();

/**
 * A currently-valid access token, refreshing first if it is close to expiry.
 *
 * Internal to the main process. Nothing exports this to the renderer or to a plugin -- the only
 * consumer is injectAuthHeader below, which spends it and discards it.
 */
async function accessToken(key, { oauth, resolveNeed }) {
  const rec = readRecord(key);
  if (!rec) throw new Error("oauth: not authorized");
  const fresh = !rec.expires_at || rec.expires_at - Date.now() > REFRESH_SKEW_MS;
  if (fresh) return rec.access_token;
  if (!rec.refresh_token) throw new Error("oauth: the access token expired and there is no refresh token");

  if (inFlight.has(key)) return inFlight.get(key);

  const endpoints = resolveEndpoints(oauth);
  const { clientId, clientSecret } = resolveClient(oauth, resolveNeed);

  const promise = (async () => {
    try {
      const body = await postForm(
        // Figma refreshes at a DIFFERENT endpoint from the one that issued the token, and its body
        // carries refresh_token alone -- no grant_type. Both are provider facts, so both come from
        // the profile rather than being assumed to follow Google.
        endpoints.refresh_url ?? endpoints.token_url,
        {
          ...(endpoints.refresh_grant_type !== false ? { grant_type: "refresh_token" } : {}),
          refresh_token: rec.refresh_token,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        },
        { basicAuth: endpoints.token_auth === "basic" && clientSecret ? { id: clientId, secret: clientSecret } : null },
      );
      writeRecord(key, toRecord(body, rec));
      return body.access_token;
    } catch (e) {
      if (e.oauthError === "invalid_grant") {
        // The user revoked upstream, or the grant aged out. Retrying cannot fix either, and keeping
        // the record makes every later call fail the same way with no path back.
        writeRecord(key, null);
        throw new Error("oauth: the grant was revoked — re-authorize this plugin");
      }
      throw e;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Add the Authorization header to a request the HOST is about to make on a provider's behalf.
 *
 * This is the whole isolation story (§5). The token is read, spent and dropped inside the main
 * process: never written into provider config, never passed as an env var, never returned over IPC.
 * A provider whose kind cannot route through here is refused `auth` at validation time, precisely so
 * this cannot be quietly worked around later.
 */
export async function injectAuthHeader(headers, { pluginId, providerId, oauth, resolveNeed }) {
  const key = credentialKey(pluginId, providerId, oauth.mints);
  const token = await accessToken(key, { oauth, resolveNeed });
  return { ...headers, authorization: `Bearer ${token}` };
}
