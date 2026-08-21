/**
 * Validate a plugin.json the way the two readers do.
 *
 *   node scripts/validate-plugin.mjs <path> [registry|client]
 *
 * `registry` is what CI runs: anything a client would silently skip is an error here. `client` is
 * what the app runs at install time. Exits non-zero on rejection so it can gate a PR directly.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateManifest, installableCapabilities } from "../electron/plugins/manifest.mjs";

const [target = "plugins", mode = "registry"] = process.argv.slice(2);

/** Every plugin.json under a directory, or the single file given. */
function manifests(t) {
  if (!fs.existsSync(t)) return [];
  if (fs.statSync(t).isFile()) return [t];
  return fs
    .readdirSync(t, { recursive: true })
    .filter((f) => path.basename(f) === "plugin.json")
    .map((f) => path.join(t, f))
    .sort();
}

/**
 * Content hashes are half the trust model (design doc §5.3) and the half a schema check cannot see:
 * a manifest with a correct-looking but stale sha512 validates perfectly and fails at install, on a
 * user's machine, with an integrity error rather than a useful one.
 */
function checkHashes(file, manifest) {
  const dir = path.dirname(file);
  const bad = [];
  for (const c of manifest.capabilities ?? []) {
    if (!c.path || !c.sha512) continue;
    const artifact = path.join(dir, c.path);
    if (!fs.existsSync(artifact)) {
      bad.push(`${c.id}: ${c.path} does not exist`);
      continue;
    }
    const actual = crypto.createHash("sha512").update(fs.readFileSync(artifact)).digest("base64");
    if (actual !== c.sha512) bad.push(`${c.id}: ${c.path} sha512 is stale (recompute it)`);
  }
  return bad;
}

const files = manifests(target);
if (files.length === 0) {
  console.error(`nothing to validate at ${target}`);
  console.error("usage: node scripts/validate-plugin.mjs [<plugin.json>|<dir>] [registry|client]");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let res;
  try {
    res = validateManifest(JSON.parse(fs.readFileSync(file, "utf8")), { mode });
  } catch (e) {
    console.log(`[${mode}] UNREADABLE  ${file}\n  error: ${e.message}`);
    failed++;
    continue;
  }
  const hashProblems = res.ok ? checkHashes(file, res.manifest) : [];
  const ok = res.ok && hashProblems.length === 0;
  if (!ok) failed++;
  console.log(`[${mode}] ${ok ? "OK" : "REJECTED"}  ${file}`);
  for (const e of res.errors) console.log("  error:", e);
  for (const h of hashProblems) console.log("  error:", h);
  for (const w of res.warnings) console.log("  warn: ", w);
  for (const s of res.skipped) console.log("  skip: ", s.at, "-", s.reason);
  if (res.ok) {
    // A plugin can publish fine and install nothing, because `tool`/`http` are not implemented yet.
    // Printed rather than left for someone to discover after shipping.
    const ids = installableCapabilities(res.manifest).map((c) => c.id);
    console.log(`  installable on this build: ${ids.length ? ids.join(", ") : "(none)"}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} valid`);
process.exit(failed ? 1 : 0);
