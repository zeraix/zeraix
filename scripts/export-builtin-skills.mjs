#!/usr/bin/env node
/**
 * Package the built-in skills as registry plugins. See docs/plugin-marketplace-design.md §9 phase 1.
 *
 * The registry starts empty, and an empty marketplace cannot replace `src/lib/ai/skills/marketplace.ts`
 * — retiring that mock would take the catalogue from ten skills to nothing. So the first thing the
 * registry carries is the ten skills the app already ships, each as its own plugin, which makes the
 * eventual swap a straight substitution rather than a regression.
 *
 * One plugin per skill rather than one bundle of ten: they are independently useful and independently
 * revocable, and a user who wants the code reviewer should not have to take the writing assistant.
 *
 *   node scripts/export-builtin-skills.mjs --out registry
 *
 * Idempotent. Re-running overwrites the generated directories, so bumping a skill's `version:` in
 * src/skills/ and re-running is how a new version reaches the registry. Existing published versions
 * are immutable (§5.3), so never edit a version already in dist — bump instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest } from "../electron/plugins/manifest.mjs";

const PUBLISHER = "zeraix";
const LICENSE = "AGPL-3.0-or-later";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Minimal frontmatter read, matching src/lib/ai/skills/parse.ts: single-line scalars and inline
 * arrays only. Deliberately not a YAML dependency — the app parses these files the same way, and a
 * parser that accepts more than the app does would let a skill through that the app cannot read.
 */
function frontmatter(raw) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return {};
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    data[kv[1]] =
      value.startsWith("[") && value.endsWith("]")
        ? value.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
        : value.replace(/^['"]|['"]$/g, "");
  }
  return data;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(repoRoot, "src", "skills");
const outRoot = path.resolve(arg("out", "registry"));

const problems = [];
let written = 0;

for (const file of fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort()) {
  const raw = fs.readFileSync(path.join(skillsDir, file), "utf8");
  const meta = frontmatter(raw);
  const at = `src/skills/${file}`;

  const name = meta.id || path.basename(file, ".md");
  const version = meta.version || "1.0.0";
  if (!meta.description) {
    problems.push(`${at}: needs a description — it is what the marketplace card shows`);
    continue;
  }

  const manifest = {
    schemaVersion: 1,
    id: `${PUBLISHER}/${name}`,
    version,
    name: meta.name || name,
    description: meta.description,
    license: LICENSE,
    homepage: "https://github.com/zeraix/zeraix",
    // The whole file, frontmatter included: the app's own parser reads that frontmatter back, so
    // stripping it here would produce a skill the client cannot interpret.
    capabilities: [{ type: "skill", id: name.replace(/-/g, "_"), path: "skill.md" }],
  };

  // Validate before writing. The registry builder will check this again in strict mode, but failing
  // here points at the source file rather than at generated output nobody edited.
  const check = validateManifest({ ...manifest, capabilities: manifest.capabilities.map((c) => ({ ...c, sha512: `${"a".repeat(86)}==` })) }, { mode: "registry" });
  if (!check.ok) {
    problems.push(`${at}: ${check.errors.join("; ")}`);
    continue;
  }

  const dir = path.join(outRoot, "plugins", PUBLISHER, name, version);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "files", "skill.md"), raw);
  written += 1;
}

if (problems.length > 0) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
console.log(`wrote ${written} plugin(s) under ${path.join(outRoot, "plugins", PUBLISHER)}`);
console.log(`next: node scripts/build-registry-index.mjs --root ${outRoot} --check`);
