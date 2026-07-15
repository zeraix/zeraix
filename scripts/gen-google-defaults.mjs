/**
 * Generates electron/services/google-defaults.json (gitignored): writes the Google OAuth credentials
 * from the local .env* into a JSON that ships with the package, for the packaged main process to read
 * as a "last-resort fallback".
 *
 * Why it's needed: the main process only injects .env* into process.env via loadEnv during dev (unpackaged);
 * once packaged, .env* does not ship with the app, so process.env.GOOGLE_OAUTH_CLIENT_ID is always empty and
 * Google sign-in reports "client_id not configured". Before the build, this script writes the credentials to
 * JSON and bakes them into the package (electron-builder's files include electron/**), making the packaged
 * build work out of the box.
 * The priority order is still: env vars > app.config [google] > this fallback JSON (see readClientConfig in googleAuth).
 *
 * Security: a desktop client is a public client; the real protection is PKCE + independent verification of the
 * id_token by the backend. The client_id is public, and the client_secret is likewise "non-secret" for a desktop
 * client. The file is gitignored and not committed; it is generated from the local .env only at build time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env parsing (same as electron/loadEnv.mjs: ignore comments/blank lines, strip paired quotes). */
function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// Read the root .env* files in Next's priority order (first one wins), then let the real env vars override.
const env = {};
for (const f of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  try {
    const c = fs.readFileSync(path.join(root, f), "utf8");
    for (const [k, v] of Object.entries(parseEnv(c))) if (env[k] === undefined) env[k] = v;
  } catch {
    /* file does not exist: skip */
  }
}

const client_id = process.env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID || "";
const client_secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || "";

const outPath = path.join(root, "electron", "services", "google-defaults.json");
fs.writeFileSync(outPath, JSON.stringify({ client_id, client_secret }, null, 2) + "\n", "utf8");
console.log(
  `[gen-google-defaults] client_id: ${client_id ? "set" : "EMPTY"}, client_secret: ${client_secret ? "set" : "EMPTY"} → ${outPath}`,
);
if (!client_id) {
  // On CI there is no .env* to fall back on (they are gitignored), so an empty client_id means the
  // secret is missing and the installer would ship with Google sign-in broken. Fail the build instead.
  if (process.env.CI) {
    throw new Error(
      "[gen-google-defaults] GOOGLE_OAUTH_CLIENT_ID is required in CI; set it as a repository secret.",
    );
  }
  console.warn(
    "[gen-google-defaults] Warning: GOOGLE_OAUTH_CLIENT_ID was not found in .env* / env vars; the packaged build will lack a default client_id.",
  );
}
