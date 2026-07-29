#!/usr/bin/env node
/**
 * Compute the seed prefix for every mode and record the hashes in versions.json.
 *
 * SEED_PREFIX must match the bytes the app sends, or every seed download 404s and users silently get a cold prefill with no error
 * anywhere. Keeping that right by hand is a checklist item nobody remembers on the one release where the prompt changed.
 *
 * Needs no app, no Electron, no model — the prefix is a pure function of mode (src/lib/ai/promptPrefix.ts), and the native tool
 * schemas are static data (electron/tools/toolSchemas.mjs). Run under tsx so the TypeScript modules load directly, which is what
 * keeps this on the SAME code path send() uses; a script with its own copy of the composition would drift and publish a seed that
 * never matches.
 *
 *   npm run seed:capture          write versions.json
 *   npm run seed:check            exit 1 if stale, write nothing (pre-release gate)
 *   --out <dir>                   also dump prefix-<mode>.json for gen-seed
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt, buildToolSet } from "../src/lib/ai/promptPrefix.ts";
import { TOOLS } from "../electron/tools/toolSchemas.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const check = process.argv.includes("--check");
const root = fileURLToPath(new URL("../", import.meta.url));
const versionsPath = path.join(root, "electron", "versions.json");

const MODES = ["daily", "dev"];
const native = TOOLS.map((t) => ({ type: "function", function: t })); // the shape listTools("openai") returns

const prefixes = {};
for (const mode of MODES) {
  const system = buildSystemPrompt(mode);
  const tools = buildToolSet(mode, native);
  const hash = crypto.createHash("sha256").update(JSON.stringify({ system, tools })).digest("hex").slice(0, 16);
  prefixes[mode] = { system, tools, hash };
  console.error(`capture-prefix: ${mode.padEnd(5)} ${system.length} chars, ${tools.length} tools -> ${hash}`);
}

// Both modes must differ. They select a different system prompt and a different open_browser description, so identical hashes mean
// the mode argument is not reaching the composition and one mode's seed would be published for both.
if (prefixes.daily.hash === prefixes.dev.hash) {
  console.error("capture-prefix: daily and dev produced the SAME hash — mode is not affecting the prefix; refusing to write");
  process.exit(1);
}

const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
const current = versions.seedPrefix ?? null;
const next = Object.fromEntries(MODES.map((m) => [m, prefixes[m].hash]));
const same = current && typeof current === "object" && MODES.every((m) => current[m] === next[m]);

if (same) {
  console.error("capture-prefix: versions.json is up to date");
} else if (check) {
  console.error(`capture-prefix: versions.json has ${JSON.stringify(current)}, app renders ${JSON.stringify(next)}`);
  console.error("  The prompt or tool declarations changed. Run 'npm run seed:capture', then regenerate and publish seeds.");
  process.exit(1);
} else {
  versions.seedPrefix = next;
  fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
  console.error(`capture-prefix: versions.json seedPrefix ${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
  console.error("capture-prefix: seeds for the previous prefix are now stale — regenerate and publish before shipping");
}

const out = arg("out");
if (out) {
  fs.mkdirSync(out, { recursive: true });
  for (const mode of MODES) {
    const { system, tools } = prefixes[mode];
    fs.writeFileSync(path.join(out, `prefix-${mode}.json`), JSON.stringify({ mode, system, tools }, null, 1));
  }
  console.error(`capture-prefix: wrote prefix-{${MODES.join(",")}}.json to ${out}`);
}

console.log(JSON.stringify(next));
