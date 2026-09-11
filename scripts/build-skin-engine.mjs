/**
 * Build the skin-engine addon (native/skin-engine, Rust + napi-rs) and lay the .node binary beside
 * its loader, named the way napi-rs names prebuilt artefacts.
 *
 * Same shape as build-rust-runtime.mjs, for the same reason: one known destination, so neither
 * electron-builder.yml nor the loader has to guess at cargo's output layout. No cross-compilation:
 * each release runner builds for its own host (see that script for why).
 *
 * Usage:
 *   node scripts/build-skin-engine.mjs            # cargo build --release --features node, then stage
 *   node scripts/build-skin-engine.mjs --check     # verify the staged binary loads and answers ping()
 *   node scripts/build-skin-engine.mjs --skip-build
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "native", "skin-engine");

/** Must match TRIPLES in native/skin-engine/index.js. */
const TRIPLES = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`skin-engine: unsupported host ${process.platform}-${process.arch}`);

/** cargo's cdylib name per platform. */
const built = path.join(
  crate,
  "target",
  "release",
  process.platform === "win32" ? "skin_engine.dll" : process.platform === "darwin" ? "libskin_engine.dylib" : "libskin_engine.so",
);
export const staged = path.join(crate, `skin-engine.${triple}.node`);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** Load the addon in THIS process and call ping(): proves it links and registers, not just exists. */
function verify(binary) {
  if (!fs.existsSync(binary)) throw new Error(`no addon at ${binary}`);
  const { size } = fs.statSync(binary);
  if (size < 50_000) throw new Error(`addon at ${binary} is only ${size} bytes — truncated?`);
  const require = createRequire(import.meta.url);
  const mod = require(binary);
  const pong = mod.ping();
  if (!/^skin-engine \d+\.\d+\.\d+ ok$/.test(pong)) throw new Error(`unexpected ping(): ${JSON.stringify(pong)}`);
  return { size, pong };
}

if (has("--check")) {
  const { size, pong } = verify(staged);
  console.log(`[skin-engine] staged ok — ${path.relative(root, staged)} (${(size / 1e6).toFixed(1)} MB, "${pong}")`);
  process.exit(0);
}

if (!has("--skip-build")) {
  console.log("[skin-engine] cargo build --release --locked --features node");
  execFileSync("cargo", ["build", "--release", "--locked", "--features", "node"], { cwd: crate, stdio: "inherit" });
}

if (!fs.existsSync(built)) throw new Error(`no cdylib at ${built}`);
fs.copyFileSync(built, staged);
const { size, pong } = verify(staged);
console.log(`[skin-engine] staged ${path.relative(root, staged)} — ${(size / 1e6).toFixed(1)} MB, "${pong}", ${process.platform}/${process.arch}`);
