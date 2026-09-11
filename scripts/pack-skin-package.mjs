#!/usr/bin/env node
/**
 * Zip a skin package source folder into a `.skinpkg`.
 *
 *   node scripts/pack-skin-package.mjs docs/skin-packages/examples/aurora-night [out.skinpkg]
 *
 * A .skinpkg is a plain zip whose root holds manifest.json and tokens.css (docs/skin-packages/README.md).
 * Uses the repo's own zip writer (electron/skins/zipio.mjs), so nothing has to be installed. The output
 * is not validated here -- installing it is the validation (native/skin-engine), and the test suite
 * packs these same examples through the engine.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { writeZip } from "../electron/skins/zipio.mjs";

const [, , srcArg, outArg] = process.argv;
if (!srcArg) {
  console.error("usage: node scripts/pack-skin-package.mjs <package-dir> [out.skinpkg]");
  process.exit(2);
}
const src = path.resolve(srcArg);
const manifestPath = path.join(src, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`${src} has no manifest.json at its root`);
  process.exit(2);
}
const id = JSON.parse(fs.readFileSync(manifestPath, "utf8")).id ?? path.basename(src);
const out = path.resolve(outArg ?? `${id}.skinpkg`);

/** Every file under `dir`, as forward-slash paths relative to it, sorted for a reproducible archive. */
function walk(dir, rel = "") {
  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) entries.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) entries.push({ name: r, data: fs.readFileSync(path.join(dir, e.name)) });
  }
  return entries;
}

const entries = walk(src);
fs.writeFileSync(out, writeZip(entries));
console.log(`${path.relative(process.cwd(), out)}: ${entries.length} files, ${fs.statSync(out).size} bytes`);
for (const e of entries) console.log(`  ${e.name} (${e.data.length} bytes)`);
