/**
 * Generates electron/plugins/oauth-credentials.json (gitignored): the OAuth client credentials this
 * build ships for `client: { "type": "host" }` providers.
 *
 * The same arrangement scripts/gen-google-defaults.mjs already uses for sign-in, generalized to a map
 * keyed by `known_provider`. Why it exists: .env* does not ship with a packaged app, so a packaged
 * build would otherwise have no credentials at all; and the alternative -- putting them in the plugin
 * manifest -- publishes them to a registry, which is the one place they must never be.
 *
 * ADDING A PROVIDER is two environment variables and one OAUTH_PRESETS entry. No plugin change, no
 * backend, no re-publish of anything already in the registry:
 *
 *   PLUGIN_OAUTH_FIGMA_CLIENT_ID=...
 *   PLUGIN_OAUTH_FIGMA_CLIENT_SECRET=...
 *
 * Security: a desktop client cannot keep a secret -- users can unpack the bundle -- and Google says as
 * much about installed-app clients. This file is gitignored and generated from the local .env at build
 * time. What it buys is not confidentiality; it is that no credential ever enters a published manifest,
 * a registry, or a user-facing prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAUTH_PRESETS } from "../electron/plugins/manifest.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same minimal parsing as electron/loadEnv.mjs and gen-google-defaults.mjs. */
function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) out[key] = val;
  }
  return out;
}

const env = {};
for (const f of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  try {
    for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(path.join(root, f), "utf8")))) {
      if (env[k] === undefined) env[k] = v;
    }
  } catch {
    /* absent: skip */
  }
}
const read = (key) => process.env[key] || env[key] || "";

const out = {};
const report = [];
for (const provider of Object.keys(OAUTH_PRESETS)) {
  const upper = provider.toUpperCase();
  // Google falls back to the sign-in credentials this repo already defines, so an existing checkout
  // works with no new configuration. A dedicated PLUGIN_OAUTH_GOOGLE_* pair overrides it -- and should,
  // because sharing one client means plugin scopes accumulate on the sign-in consent screen.
  const id = read(`PLUGIN_OAUTH_${upper}_CLIENT_ID`) || (provider === "google" ? read("GOOGLE_OAUTH_CLIENT_ID") : "");
  const secret =
    read(`PLUGIN_OAUTH_${upper}_CLIENT_SECRET`) || (provider === "google" ? read("GOOGLE_OAUTH_CLIENT_SECRET") : "");
  if (id) out[provider] = { client_id: id, client_secret: secret };
  report.push(`${provider}: ${id ? (secret ? "id+secret" : "id only") : "—"}`);
}

const outPath = path.join(root, "electron", "plugins", "oauth-credentials.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`[gen-plugin-oauth-credentials] ${report.join(", ")} → ${outPath}`);
if (Object.keys(out).length === 0) {
  // Not fatal: a build with no credentials is valid, it simply cannot run a host-client provider.
  console.warn("[gen-plugin-oauth-credentials] no credentials configured; host-client plugins will report this at use");
}
