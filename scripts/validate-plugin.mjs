/**
 * Validate a plugin.json the way the two readers do.
 *
 *   node scripts/validate-plugin.mjs <path> [registry|client]
 *
 * `registry` is what CI runs: anything a client would silently skip is an error here. `client` is
 * what the app runs at install time. Exits non-zero on rejection so it can gate a PR directly.
 */
import fs from "node:fs";
import { validateManifest, installableCapabilities } from "../electron/plugins/manifest.mjs";

const [file, mode = "registry"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/validate-plugin.mjs <plugin.json> [registry|client]");
  process.exit(2);
}

const res = validateManifest(JSON.parse(fs.readFileSync(file, "utf8")), { mode });
console.log(`[${mode}] ${res.ok ? "OK" : "REJECTED"}  ${file}`);
for (const e of res.errors) console.log("  error:", e);
for (const w of res.warnings) console.log("  warn: ", w);
for (const s of res.skipped) console.log("  skip: ", s.at, "-", s.reason);
if (res.ok) {
  // The gap that matters for this plugin: it publishes fine and installs nothing, because `tool`
  // and `http` are not implemented yet. Printed rather than left for someone to discover.
  const ids = installableCapabilities(res.manifest).map((c) => c.id);
  console.log(`  installable on this build: ${ids.length ? ids.join(", ") : "(none)"}`);
}
process.exit(res.ok ? 0 : 1);
