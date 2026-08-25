/**
 * Run the desktop app in development with the Rust Agent Runtime enabled.
 *
 * Exists because the obvious instruction — `ZERAIX_RUST_RUNTIME=on npm run electron:dev` — is POSIX
 * shell syntax and simply fails on Windows `cmd`, which is where this project is developed. Setting the
 * variable in JS and spawning the existing script works identically on every platform.
 *
 * Deliberately NOT using `cross-env`, even though the dist scripts do: it is not declared in
 * package.json at all (it resolves only as a hoisted transitive dependency), so adding a dependency on
 * it here would either inherit that fragility or require a lockfile change that
 * `pnpm install --frozen-lockfile` would then reject in CI.
 *
 * Usage: npm run electron:dev:rust
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";
const built = path.join(root, "runtime", "target", "release", exe);

// Build only when it is missing. A release build is minutes cold, and paying that on every `npm run`
// would make the flagged path annoying enough that nobody would use it — which is the actual problem
// being solved here.
if (!fs.existsSync(built)) {
  console.log("[dev:rust] no release binary yet — building (this takes a few minutes the first time)");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-rust-runtime.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} else {
  console.log(`[dev:rust] using ${path.relative(root, built)}`);
  console.log("[dev:rust] rebuild it with `npm run build:runtime` after changing anything under runtime/");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "electron:dev"], {
  cwd: root,
  stdio: "inherit",
  // The whole point: the flag reaches the Electron main process, which is what reads it.
  env: { ...process.env, ZERAIX_RUST_RUNTIME: "on" },
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
