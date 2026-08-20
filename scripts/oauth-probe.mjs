/**
 * Drive one REAL authorization against a live provider, outside Electron.
 *
 *   node scripts/oauth-probe.mjs plugins/zeraix/gmail-send/1.0.0/plugin.json
 *   node scripts/oauth-probe.mjs <plugin.json> --provider google_auth --keep
 *
 * This is the layer the fixture tests cannot reach: what the provider ACTUALLY does with our
 * parameters, as opposed to what we believe it does. Every bug left in the flow lives here --
 * a scope string Google spells differently, a redirect the client type does not permit, a token
 * response shaped unlike the spec.
 *
 * It works without Electron because `openExternal` and `secretBox` are injected seams (see
 * oauth.mjs). This script supplies a real browser opener and a throwaway box.
 *
 * SECRETS: a successful run yields a real refresh token -- a standing grant on your account. Outside
 * Electron there is no safeStorage to wrap it, so it would land on disk in plaintext. This runs
 * against a temp directory and DELETES it on exit. `--keep` opts out and prints where the plaintext
 * token was left; only do that if you intend to clean it up yourself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateManifest } from "../electron/plugins/manifest.mjs";
import { setPluginRoot } from "../electron/plugins/storage.mjs";
import {
  authorize,
  configureOAuthHost,
  credentialKey,
  credentialStatus,
  resolveEndpoints,
} from "../electron/plugins/oauth.mjs";

const argv = process.argv.slice(2);
/** Flags that consume the next argument. Everything else is boolean, so the arg after it is positional. */
const VALUE_FLAGS = new Set(["--provider"]);

const flags = new Set();
const opts = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) positional.push(a);
  else if (VALUE_FLAGS.has(a)) opts.set(a.slice(2), argv[++i]);
  else flags.add(a.slice(2));
}

const flag = (name) => flags.has(name);
const opt = (name) => opts.get(name) ?? null;
const file = positional[0];

if (!file) {
  console.error("usage: node scripts/oauth-probe.mjs <plugin.json> [--provider <id>] [--keep]");
  process.exit(2);
}

/* ---------------------------------------------------------------- the manifest */

// Client mode, not registry: a probe is exactly the case where a literal endpoint pair is legitimate
// (pointing at a local mock provider), and registry mode refuses to publish those.
const res = validateManifest(JSON.parse(fs.readFileSync(file, "utf8")), { mode: "client" });
if (!res.ok) {
  console.error("manifest is not valid:");
  res.errors.forEach((e) => console.error("  ", e));
  process.exit(1);
}

const wanted = opt("provider");
const entry = Object.entries(res.manifest.providers).find(
  ([id, p]) => p.kind === "oauth" && (!wanted || id === wanted),
);
if (!entry) {
  console.error(wanted ? `no oauth provider "${wanted}" in this manifest` : "this manifest declares no oauth provider");
  process.exit(1);
}
const [providerId, provider] = entry;
const { oauth } = provider;

/* ---------------------------------------------------------------- host seams */

/**
 * Open a URL in the user's real browser. Printed too, so a paste always works when the spawn does not.
 *
 * NOT `cmd /c start`: cmd re-parses its argument and `&` is its command separator, so an authorization
 * URL arrives truncated at the first parameter and the rest is executed as commands. Google answers
 * that with "Missing required parameter: redirect_uri", which reads like a bug in the request we built
 * rather than in how it was delivered. rundll32 is not a shell -- the argument reaches it verbatim.
 */
function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    console.log("\nIf a browser did not open, paste this:\n");
    console.log(`  ${url}\n`);
    execFile(cmd, args, () => resolve()); // failure is fine -- the URL is on screen
  });
}

/**
 * Read `.env.local` for a `needs` value.
 *
 * The manifest names the key; the value has to live somewhere that is not the manifest, because a
 * published manifest is world-readable. `.env.local` is the project's existing answer for exactly
 * this (see .gitignore) and it is ignored, so a real credential written there cannot be committed by
 * accident. Cached: read once per run, not once per lookup.
 */
let dotenvCache = null;
function dotenvLocal() {
  if (dotenvCache) return dotenvCache;
  dotenvCache = {};
  try {
    for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) dotenvCache[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* absent is normal -- the environment may carry everything */
  }
  return dotenvCache;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zx-oauth-probe-"));
setPluginRoot(root);
configureOAuthHost({
  openExternal: openInBrowser,
  // Outside Electron there is no OS keychain. Declaring available:false is honest -- it records in the
  // file that the value is NOT encrypted, rather than implying a protection that is not there.
  secretBox: { available: () => false, encrypt: (s) => s, decrypt: (s) => s },
});

const cleanup = () => {
  if (flag("keep")) {
    console.log(`\n!! plaintext token left at ${path.join(root, "oauth.json")} — delete it when done`);
    return;
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};
process.on("exit", cleanup);

/**
 * Resolve a `needs` value and say where it came from, with a fingerprint rather than the value.
 *
 * The fingerprint is what makes a mismatch diagnosable without ever printing the secret: compare the
 * first characters and the length against Cloud Console, and the sha prefix against another machine.
 */
function reportedNeed(key) {
  const fromEnv = process.env[key];
  const fromFile = dotenvLocal()[key];
  const value = fromEnv ?? fromFile ?? null;
  const source = fromEnv !== undefined ? "environment" : fromFile !== undefined ? ".env.local" : "NOT FOUND";
  const sha = value ? createHash("sha256").update(value).digest("hex").slice(0, 8) : "";
  console.log(`need      ${key} <- ${source}${value ? ` (${value.slice(0, 7)}…${value.length} chars, sha ${sha})` : ""}`);
  if (fromEnv !== undefined && fromFile !== undefined && fromEnv !== fromFile) {
    console.log(`          !! the environment is SHADOWING a different value in .env.local`);
    console.log(`          !! clear it with:  set ${key}=`);
  }
  return value;
}

/* ---------------------------------------------------------------- run it */

const endpoints = resolveEndpoints(oauth);
console.log(`plugin    ${res.manifest.id}`);
console.log(`provider  ${providerId} (${oauth.known_provider ?? "literal endpoints"})`);
console.log(`authorize ${endpoints.authorize_url}`);
console.log(`token     ${endpoints.token_url}`);
console.log(`scopes    ${oauth.scopes.join("\n          ")}`);
console.log(`client    ${oauth.client.type === "public" ? oauth.client.id : `needs ${oauth.client.need}`}`);

try {
  const status = await authorize({
    pluginId: res.manifest.id,
    providerId,
    oauth,
    // In the app a `needs` value comes from the consent sheet. Here: the environment first, then
    // .env.local — which is already git-ignored, so a real secret written there cannot be committed.
    // Which source won is REPORTED, because env silently shadowing the file is otherwise invisible
    // and presents as "the provider says my secret is invalid" with a correct file on disk.
    resolveNeed: reportedNeed,
  });
  console.log("\nAUTHORIZED");
  console.log(`  expires   ${status.expiresAt ? new Date(status.expiresAt).toISOString() : "(not stated)"}`);
  console.log(`  refresh   ${status.canRefresh ? "yes" : "NO — the grant will die at expiry"}`);
  console.log(`  scope     ${status.scope ?? "(not echoed by the provider)"}`);
  // The point of printing this: it is the whole shape the renderer is ever allowed to see (design §5).
  console.log(`\n  key       ${credentialKey(res.manifest.id, providerId, oauth.mints)}`);
  if (!status.canRefresh) {
    console.log("\n  No refresh token. For Google this usually means the account already granted this");
    console.log("  client — revoke it at https://myaccount.google.com/permissions and run again.");
  }
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exitCode = 1;
}
