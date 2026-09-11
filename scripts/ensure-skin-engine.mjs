#!/usr/bin/env node
/**
 * Make sure the skin-engine addon exists (and is current) before the dev app starts.
 *
 * Same policy as ensure-runtime.mjs: build when the binary is missing or older than the newest
 * source under native/skin-engine, and never fail the launch — without the addon the app still
 * opens, and Settings → Appearance says skin packages are unavailable (electron/skins/engine.mjs).
 * A release build of this crate is well under a minute warm.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "native", "skin-engine");

const TRIPLES = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
const staged = triple ? path.join(crate, `skin-engine.${triple}.node`) : null;

function newestSource(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "target" || e.name === ".git" || e.name.endsWith(".node")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(dir);
  return newest;
}

if (staged && fs.existsSync(staged)) {
  const builtAt = fs.statSync(staged).mtimeMs;
  if (newestSource(crate) <= builtAt) {
    console.log(`[skin-engine] using ${path.relative(root, staged)}`);
    process.exit(0);
  }
  console.log(`[skin-engine] ${path.relative(root, staged)} is older than native/skin-engine/ — rebuilding.`);
} else {
  console.log("[skin-engine] no addon found — building it now (skin packages need it; the rest of the app does not).");
}

try {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-skin-engine.mjs")], { cwd: root, stdio: "inherit" });
} catch {
  console.error("[skin-engine] the build failed. The app will start; Settings → Appearance will report that skin");
  console.error("[skin-engine] packages are unavailable. Install a Rust toolchain (https://rustup.rs) and run");
  console.error("[skin-engine] `npm run build:skin-engine`.");
  process.exit(0);
}
