#!/usr/bin/env node
/**
 * Make sure a runnable sidecar exists before the app starts.
 *
 * ## Why this is a pre-step now and was not before
 *
 * The sidecar used to be optional. Every failure mode in `rustRuntime.mjs` fell back to a JS handler, so a
 * developer with no binary got the JS implementations and never noticed. Deleting those handlers (TODO §0.2
 * F1) removed the fallback: **a missing binary is now an app with no `read_file`, no `write_file`, no
 * `search_*` and no `run_command`.**
 *
 * Without this check that failure arrives as a wall of "served by the Zeraix agent runtime, which is not
 * running" on every tool call, several minutes into a session, with nothing pointing at the cause. Checking
 * here turns it into one line before the window opens.
 *
 * ## Builds only when missing
 *
 * A cold release build is minutes. Paying that on every `npm run electron:dev` would make people stop using
 * the script, which is the actual problem being solved. If the binary is there it is left alone — including
 * when it is stale, because deciding that would mean tracking the source, and the message below says how to
 * rebuild.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";

// The same places `rustRuntime.mjs::binaryPath` looks, in the same order. Kept in step by hand, and worth a
// glance if that function ever changes: a check that looks somewhere the app does not is a check that passes
// while the app fails.
const candidates = [
  path.join(root, "resources", "runtime", exe),
  path.join(root, "runtime", "target", "release", exe),
  path.join(root, "runtime", "target", "debug", exe),
];

const found = candidates.find((p) => fs.existsSync(p));
if (found) {
  console.log(`[runtime] using ${path.relative(root, found)}`);
  console.log("[runtime] rebuild with `npm run build:runtime` after changing anything under runtime/");
  process.exit(0);
}

console.log("[runtime] no sidecar binary found — building it now.");
console.log("[runtime] This is required: the JS tool handlers were removed at 2.0, so without it the app");
console.log("[runtime] has no file tools and no command execution. First build takes a few minutes.");

try {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-rust-runtime.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  console.error("");
  console.error("[runtime] the build failed. The app will start, but every tool call will report that the");
  console.error("[runtime] runtime is not running. Install a Rust toolchain (https://rustup.rs) and run");
  console.error("[runtime] `npm run build:runtime`.");
  // Deliberately not a hard failure: a developer working on the UI should still be able to open the window,
  // and the app's own error message already says exactly what is wrong.
  process.exit(0);
}
