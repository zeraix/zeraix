/**
 * Where plugin data lives.
 *
 * Root directory and file helpers, deliberately with **no `electron` import** -- the same discipline
 * automation/storage.mjs follows and for the same reason: one named import from `electron` anywhere
 * in the dependency chain makes the whole chain impossible to cover with `npm test`. paths.mjs owns
 * the Electron side and calls setPluginRoot() at startup; tests point it at a temp directory.
 *
 * Layout under the root:
 *   installed.json                       the lockfile -- what is installed, enabled, revoked
 *   feeds/index.json, feeds/killlist.json  last accepted feeds, so an outage is not an outage
 *   files/<publisher>/<name>/<version>/  content-addressed plugin files, one dir per version
 */
import fs from "node:fs";
import path from "node:path";

let root = null;

/** Configure the root. Called once at startup (see paths.mjs) or by a test with a temp dir. */
export function setPluginRoot(dir) {
  root = dir;
  return root;
}

/** The configured root. Throws rather than silently writing to a wrong-but-plausible location. */
export function pluginRoot() {
  if (!root) {
    throw new Error("plugin root is not configured -- call setPluginRoot() during startup (see paths.mjs)");
  }
  return root;
}

/** Whether a root has been configured (lets callers no-op cleanly before startup finishes). */
export function isConfigured() {
  return root !== null;
}

export const lockFile = () => path.join(pluginRoot(), "installed.json");
export const feedFile = (name) => path.join(pluginRoot(), "feeds", `${name}.json`);
/** Versioned so an install never overwrites a version already on disk (design doc §5.3). */
export const versionDir = (id, version) => path.join(pluginRoot(), "files", ...id.split("/"), version);

/** Parse a JSON file, or null. A corrupt file is never a crash -- callers fall back to defaults. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write via a temp file + rename so a crash mid-write cannot leave a truncated file behind. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
