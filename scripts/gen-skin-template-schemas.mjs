#!/usr/bin/env node
/**
 * Regenerate the JSON Schemas shipped in the official skin package template.
 *
 *   node scripts/gen-skin-template-schemas.mjs          write electron/skins/package-template/schemas/*.json
 *   node scripts/gen-skin-template-schemas.mjs --check  exit 1 if the committed files are stale
 *
 * The primitives' props come from their zod schemas (TypeScript), so this loads src/ through the
 * same resolver hook the test suite uses.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("../test/helpers/srcResolve.mjs", import.meta.url);

const { z } = await import("zod");
const primitives = await import("../src/components/theme/primitives/schemas.ts");
const refs = await import("../electron/skins/layoutRefs.mjs");
const { buildSkinSchemas, SCHEMA_FILES } = await import("./skinTemplateSchemas.mjs");

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../electron/skins/package-template/schemas");
const schemas = buildSkinSchemas({ z, primitiveSchemas: primitives.PRIMITIVE_SCHEMAS, refs });
const check = process.argv.includes("--check");

let stale = 0;
fs.mkdirSync(dir, { recursive: true });
for (const name of SCHEMA_FILES) {
  const text = `${JSON.stringify(schemas[name], null, 2)}\n`;
  const file = path.join(dir, name);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === text) {
    console.log(`[skin-schemas] ${name} is up to date`);
    continue;
  }
  if (check) {
    console.error(`[skin-schemas] ${name} is out of date — run npm run gen:skin-schemas`);
    stale++;
    continue;
  }
  fs.writeFileSync(file, text);
  console.log(`[skin-schemas] wrote ${name} (${text.length} bytes)`);
}
if (stale) process.exit(1);
