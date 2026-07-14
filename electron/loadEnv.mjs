/**
 * Main-process environment variable loading.
 *
 * The Electron main process (electron .) and Next's dev server are two independent processes:
 * Next automatically reads the .env* files at the project root, but the main process does not.
 * As a result, process.env.GOOGLE_OAUTH_CLIENT_ID and the like are always empty in the main
 * process. In dev (unpackaged), this module loads the root .env files into process.env following
 * Next's precedence, filling only "not yet defined" keys (never overriding real environment
 * variables). After packaging these files usually don't exist, so it silently skips.
 *
 * It does only minimal KEY=VALUE parsing (ignoring comments/blank lines, stripping paired quotes);
 * it does not support advanced features such as variable interpolation.
 */
import fs from "node:fs";
import path from "node:path";

/** Parse .env text into key-value pairs. */
function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Load the project root's .env files into process.env following Next's precedence (earlier-loaded
 * wins and is not overridden by later ones).
 * @param {string} rootDir project root directory (containing the .env* files)
 * @param {string} [nodeEnv] environment name (defaults to "development"), determines the .env.<env> filename
 */
export function loadEnvFiles(rootDir, nodeEnv = "development") {
  // Next precedence: .env.<env>.local > .env.local > .env.<env> > .env
  const files = [`.env.${nodeEnv}.local`, ".env.local", `.env.${nodeEnv}`, ".env"];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(rootDir, file), "utf8");
    } catch {
      continue; // file doesn't exist, etc.: skip
    }
    for (const [k, v] of Object.entries(parseEnv(content))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
