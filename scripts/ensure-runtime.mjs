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
 * ## Builds when missing OR stale
 *
 * A cold release build is minutes, and paying that on every `npm run electron:dev` would make people stop
 * using the script — which is the actual problem being solved. So the rebuild is conditional: it happens
 * when there is no binary, and when the newest file under `runtime/` is newer than the binary. An unchanged
 * checkout is a stat walk and nothing else.
 *
 * Staleness has to count, because the runtime's tool list is load-bearing now — see the comment at the
 * check itself for the failure this was written after.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtimeBinaryPath } from "../electron/tools/runtimeBinary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The binary the DEV app will run, found by the very function the app uses. This list used to be a copy
// "kept in step by hand" with `binaryPath()`, and it had drifted: it checked the repo's `resources/runtime/`
// staging directory first, which the dev app never looks at. `resourcesPath: null` because in development
// there is no packaged location — Electron's own resources directory holds no runtime.
const found = runtimeBinaryPath({ resourcesPath: null, root, override: process.env.ZERAIX_RUST_RUNTIME_BIN });

/**
 * The newest mtime under `dir`, ignoring build output.
 *
 * Used to tell a current binary from a stale one. Skipping `target/` matters: it contains the binary itself
 * and every intermediate artifact, so including it would compare the build against its own output and always
 * look current.
 */
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
      if (e.name === "target" || e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* a file that vanished mid-walk cannot be newer than the build */
      }
    }
  };
  walk(dir);
  return newest;
}

if (found) {
  // A binary that exists is not necessarily the RIGHT binary.
  //
  // "Build only when missing" was right while the sidecar was an optional accelerator: an old one served the
  // same tools as a new one, and the JS handlers were there regardless. It is wrong now. The runtime's tool
  // list is load-bearing — a binary built before `write_file` moved into it serves six tools instead of
  // seven, there is no handler to fall back to, and every write fails with a message about an unknown tool.
  //
  // That is not hypothetical: it is exactly what happened, and it looked like a bug in the agent rather than
  // a stale build. So the check is now "current", not "present".
  const builtAt = fs.statSync(found).mtimeMs;
  const sourceAt = newestSource(path.join(root, "runtime"));
  if (sourceAt <= builtAt) {
    console.log(`[runtime] using ${path.relative(root, found)}`);
    process.exit(0);
  }
  console.log(`[runtime] ${path.relative(root, found)} is older than runtime/ — rebuilding.`);
} else {
  console.log("[runtime] no sidecar binary found — building it now.");
  console.log("[runtime] This is required: the JS tool handlers were removed at 2.0, so without it the app");
  console.log("[runtime] has no file tools and no command execution. First build takes a few minutes.");
}

try {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-rust-runtime.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} catch (e) {
  // Advice that matches the failure. This used to say "install a Rust toolchain" whatever went wrong —
  // including a compile error on a machine whose toolchain was fine, and a binary the running app had open,
  // where the only fix is to quit the app. See the exit codes in build-rust-runtime.mjs.
  console.error("");
  if (e?.status === 75) {
    console.error("[runtime] the runtime binary is in use by the running app, so it could not be rebuilt.");
    console.error("[runtime] Quit the app and run `npm run build:runtime` — the app will start on the OLD binary.");
  } else if (e?.status === 127) {
    console.error("[runtime] cargo is not installed. Install a Rust toolchain (https://rustup.rs) and run");
    console.error("[runtime] `npm run build:runtime`. Until then every tool call reports the runtime is not running.");
  } else {
    console.error("[runtime] the build failed — cargo's output above says why. The app will start, but on an");
    console.error("[runtime] OLD binary if there is one, and with no file tools or commands if there is not.");
  }
  // Deliberately not a hard failure: a developer working on the UI should still be able to open the window,
  // and the app's own error message already says exactly what is wrong.
  process.exit(0);
}
