/**
 * Where the Rust sidecar binary is — the ONE answer, shared by the app and the scripts that prepare it.
 *
 * ## Why this is its own module
 *
 * The rule used to live in two places: `binaryPath()` in rustRuntime.mjs, and a candidate list in
 * scripts/ensure-runtime.mjs whose comment said it was "the same places … in the same order. Kept in step by
 * hand". It was not the same places. In development `process.resourcesPath` is Electron's own
 * `node_modules/electron/dist/resources`, so the app never looks at the repo's `resources/runtime/` staging
 * directory — while ensure-runtime checked that directory FIRST. The pre-flight could therefore pass on a
 * fresh staged binary while the app ran a stale one from `target/`.
 *
 * And both preferred `target/release` unconditionally, although the app's comment said "whichever profile was
 * built last". A `cargo test` builds debug, so after changing the runtime and testing it, the app went on
 * running the OLD release binary — which looks exactly like the change not working. That cost a wrong sandbox
 * result on 2026-09-21 before anyone noticed which binary was running.
 *
 * Two copies of a rule, kept in step by hand, had drifted twice. One copy cannot.
 *
 * No `electron` import: the scripts load this under plain node.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const RUNTIME_EXE = process.platform === "win32" ? "zeraix-agent-runtime.exe" : "zeraix-agent-runtime";

/**
 * The development builds, newest first. Missing ones are left out.
 *
 * Newest rather than a fixed preference, because the newest is the one that reflects the source a developer
 * just changed — whichever profile produced it.
 */
export function devBinaries(root) {
  return ["release", "debug"]
    .map((profile) => path.join(root, "runtime", "target", profile, RUNTIME_EXE))
    .flatMap((p) => {
      try {
        return [{ path: p, mtimeMs: fs.statSync(p).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((b) => b.path);
}

/**
 * The binary the app will run, or null.
 *
 * In order: an explicit override, the packaged location, then the newest development build. The packaged
 * location only exists in a packaged app — in development `resourcesPath` is Electron's own directory and
 * holds no runtime — so ordering it first costs nothing in development and is decisive when packaged.
 */
export function runtimeBinaryPath({
  resourcesPath = process.resourcesPath,
  root = process.cwd(),
  override = process.env.ZERAIX_RUST_RUNTIME_BIN,
} = {}) {
  if (override) return override;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "runtime", RUNTIME_EXE);
    if (fs.existsSync(packaged)) return packaged;
  }
  return devBinaries(root)[0] ?? null;
}
