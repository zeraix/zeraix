/**
 * Google Sign-In — main-process OAuth flow (design doc docs/google-signin-frontend.md).
 *
 * The desktop client is a "public client"; Google forbids running the login inside an embedded webview (disallowed_useragent),
 * so we use the RFC 8252 native-app authorization-code flow: system browser + loopback redirect + PKCE.
 *
 * This module is only responsible for "obtaining Google's id_token":
 *   1. Generate the PKCE code_verifier/code_challenge and a random state;
 *   2. Start a one-shot loopback http server on 127.0.0.1:0, and derive the redirect_uri from the assigned port;
 *   3. shell.openExternal opens Google's consent page (scope: openid email profile);
 *   4. In the loopback callback, verify state, take the code, and exchange it (with code_verifier) at the token endpoint for an id_token;
 *   5. Close the loopback server and hand the id_token back to the renderer (which then POSTs /auth/google).
 *
 * Security: PKCE + loopback prevent local authorization-code interception; state guards against CSRF; no secrets are shipped in the bundle—the desktop client is public by nature,
 * the real protection is PKCE plus the backend's independent validation of the id_token, not a "secret shipped with the package".
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shell } from "electron";
import { getAppConfig } from "../appConfig.mjs";
import { DEEP_LINK_SCHEME } from "./deepLink.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read the bundled Google credential fallback JSON (generated before build by scripts/gen-google-defaults.mjs; empty if missing). */
function readBundledGoogleDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "google-defaults.json"), "utf8")) || {};
  } catch {
    return {}; // File missing / parse failure: treat as no fallback
  }
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "openid email profile";
/** Upper bound for the loopback server to wait for the user to finish authorizing in the browser; on timeout, tear down and treat as canceled. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Desktop client credentials. The client id is used only to build the authorization URL and exchange the code — it is not a secret (PKCE is the protection,
 * and the backend separately validates the id_token's aud), so it can safely live in the bundled app.config.
 *
 * Resolution order: environment variable (in dev, injected from .env* via loadEnv) > the [google] section of app.config >
 * bundled fallback JSON (google-defaults.json, generated at build time from the local machine's .env — so packaged builds work out of the box).
 * The first two are convenient for local development / user overrides; throws when client_id is not configured.
 *
 * client_secret: Google's "Desktop app" clients still issue a secret, and its token endpoint [requires] it
 * when exchanging the authorization code (even together with PKCE). For an already-distributed desktop client this secret
 * is "not treated as a secret" (it cannot truly be kept secret; security is carried by PKCE + redirect restriction + backend validation of the id_token),
 * so it can be shipped in app.config. When missing, the token exchange fails with invalid_client.
 */
function readClientConfig() {
  const google = getAppConfig()?.google || {};
  const bundled = readBundledGoogleDefaults();
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID || google.client_id || bundled.client_id || "";
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || google.client_secret || bundled.client_secret || "";
  if (!clientId) {
    throw new Error(
      "Google OAuth client id is not configured (set the GOOGLE_OAUTH_CLIENT_ID environment variable, or [google] client_id in app.config)",
    );
  }
  return { clientId, clientSecret };
}

/** base64url encoding (no padding), used for PKCE / state. */
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate the PKCE parameters and a random state. */
function createPkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
}

/** Callback page: shown in the browser after authorization completes, prompting the user to return to the app. */
function callbackHtml(ok) {
  const title = ok ? "Sign-in successful" : "Sign-in not completed";
  const tip = ok ? "You're all set! Return to the Zeraix app to continue." : "Authorization was not completed. Please return to the app and try again.";
  // Success: brand teal check; failure: amber exclamation. Icons use inline SVG, self-contained with no external links.
  const accent = ok ? "#34d3a6" : "#f5a524";
  const icon = ok
    ? `<path d="M5 13.5l4.5 4.5L19 8" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M12 7.5v6" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/>`;
  // The "Open app" button points to a custom-protocol deep link; clicking it lets the OS bring Zeraix to the foreground.
  // Browsers usually block automatic protocol redirects without a user gesture, so the button is the primary entry point (no automatic onload redirect).
  const btnLabel = ok ? "Open Zeraix" : "Return to Zeraix";
  const deepLink = `${DEEP_LINK_SCHEME}://auth-complete?ok=${ok ? "1" : "0"}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Zeraix</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#e7ecff;background:#0b1020;
  background-image:radial-gradient(1200px 600px at 50% -10%,rgba(52,211,166,.10),transparent 60%),
    radial-gradient(900px 500px at 50% 120%,rgba(99,102,241,.14),transparent 60%);
  -webkit-font-smoothing:antialiased}
.box{position:relative;text-align:center;padding:48px 44px 40px;border-radius:22px;max-width:380px;width:100%;
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));
  border:1px solid rgba(255,255,255,.09);
  box-shadow:0 24px 70px -24px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);
  animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.badge{width:76px;height:76px;margin:0 auto 22px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;color:${accent};
  background:radial-gradient(circle at 50% 40%,color-mix(in srgb,${accent} 22%,transparent),transparent 70%);
  box-shadow:0 0 0 1px color-mix(in srgb,${accent} 35%,transparent),
    0 0 44px -6px color-mix(in srgb,${accent} 60%,transparent);
  animation:pop .55s .12s cubic-bezier(.2,1.4,.3,1) both}
.badge svg{width:38px;height:38px}
h1{font-size:21px;font-weight:650;letter-spacing:.2px;margin:0 0 10px}
p{font-size:14px;line-height:1.6;opacity:.62;margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:26px;
  padding:12px 26px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:600;
  color:#04140e;background:linear-gradient(180deg,color-mix(in srgb,${accent} 92%,#fff),${accent});
  box-shadow:0 10px 26px -10px color-mix(in srgb,${accent} 70%,transparent);
  transition:transform .12s ease,box-shadow .12s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 14px 30px -10px color-mix(in srgb,${accent} 80%,transparent)}
.btn:active{transform:translateY(0)}
.brand{margin-top:24px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.34}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.box,.badge{animation:none}}
</style>
</head><body><div class="box">
<div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
<h1>${title}</h1><p>${tip}</p>
<a class="btn" href="${deepLink}">${btnLabel}</a>
<div class="brand">Zeraix</div>
</div></body></html>`;
}

/** Exchange the authorization code + code_verifier at Google's token endpoint for an id_token. */
async function exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  // If the Desktop client was issued a non-secret secret, the token exchange must include it; omit when not configured.
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Failed to exchange id_token: ${detail}`);
  }
  return data.id_token;
}

// Single-flight: only one OAuth flow is allowed at a time (prevents a double-clicked button from starting multiple loopback servers / browser windows).
let activeFlow = null;

/**
 * Run one Google sign-in flow, resolving to { idToken }. When the user closes the browser / times out / declines authorization,
 * resolves to { canceled:true }; rejects (Error) when config is missing or the exchange fails.
 * Repeated calls (while a flow is already running) reuse the same Promise.
 */
export function runGoogleSignIn() {
  if (activeFlow) return activeFlow;

  activeFlow = new Promise((resolve, reject) => {
    let clientId, clientSecret;
    try {
      ({ clientId, clientSecret } = readClientConfig());
    } catch (err) {
      // Missing config is an early-exit failure: single-flight must be cleared first, otherwise later calls would reuse this already-rejected Promise.
      activeFlow = null;
      reject(err);
      return;
    }

    const { codeVerifier, codeChallenge, state } = createPkce();
    let settled = false;
    let timer = null;

    const server = http.createServer(async (req, res) => {
      // Only handle callback paths carrying code/state; ignore the browser's favicon and other miscellaneous requests.
      const url = new URL(req.url, "http://127.0.0.1");
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        res.statusCode = 204;
        res.end();
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      // User canceled / declined on the consent page: Google redirects back with error (e.g. access_denied).
      if (error) {
        console.warn("[google-auth] Google redirect error:", error);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finish({ canceled: true });
        return;
      }
      // state mismatch: suspected CSRF, reject.
      if (!returnedState || returnedState !== state) {
        console.warn("[google-auth] state validation failed:", { expected: state, got: returnedState });
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finishError(new Error("state validation failed (possible CSRF)"));
        return;
      }

      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const idToken = await exchangeCode({
          code,
          codeVerifier,
          redirectUri,
          clientId,
          clientSecret,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(true));
        finish({ idToken });
      } catch (err) {
        // Failed to exchange id_token: print Google's specific error to the main-process terminal for easier diagnosis
        // (most common: the Desktop client did not include client_secret → invalid_client / client_secret is missing).
        console.warn("[google-auth] Failed to exchange id_token:", err?.message || err);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finishError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Cleanup: close the loopback server, clear the timeout, release single-flight. Idempotent.
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        server.close();
      } catch {
        /* already closed */
      }
      activeFlow = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    server.on("error", (err) => finishError(err));

    // The loopback address must bind 127.0.0.1 explicitly (not localhost, to avoid IPv6/hosts resolution differences).
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        // Always let the user pick an account, to avoid silently reusing the previous Google session.
        prompt: "select_account",
      }).toString()}`;

      // Timeout fallback: if the user never finishes (closed the browser / walked away), tear down and return as canceled.
      timer = setTimeout(() => finish({ canceled: true }), FLOW_TIMEOUT_MS);

      // Open the consent page in the system browser; if opening fails (no available browser), return as an error.
      shell.openExternal(authUrl).catch((err) => finishError(err));
    });
  });

  return activeFlow;
}

/** Whether a sign-in flow is in progress (useful for the renderer's UI state, e.g. disabling the button). */
export function isGoogleSignInActive() {
  return activeFlow !== null;
}
