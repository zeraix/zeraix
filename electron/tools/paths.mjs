/**
 * The file-tool path boundary: which directories a tool call may touch, and which of them it may write to.
 *
 * Pure path arithmetic, in its own module for one practical reason — `aiToolkit.mjs` imports Electron, so it
 * cannot be loaded outside the app, and a boundary that cannot be tested is a boundary nobody can be sure of.
 * Everything here takes its roots as arguments and holds no state.
 *
 * ── Two roots, not equivalent ───────────────────────────────────────────────────────────────────────────────
 *
 * The WORKING DIRECTORY is read-write: code, scripts, intermediate files, anything a task produces.
 *
 * The ASSET FOLDER is read-only. It holds the media library — generated images and video, and files the user
 * has sent — and the model is expected to READ from it (compose a clip from footage it made earlier, look at
 * a picture it was given) while never altering it. An original the user cannot get back is not something a
 * tool call should be able to destroy, and "the instructions said not to" is not a mechanism.
 *
 * This is only half the boundary. It governs the file tools; `run_command` is governed by the sandbox's bind
 * mounts (`--ro-bind` for the asset folder — see sandbox/qemu.mjs). Both are needed and they must agree:
 * enforcing here alone would leave a shell able to write what the file tools refuse.
 */
import path from "node:path";

/** The name the sandbox mounts the working directory at (GUEST_WORKSPACE in sandbox/qemu.mjs). */
export const WORKSPACE_ALIAS = /^\/workspace(?:\/(.*))?$/;

/** The name the sandbox mounts the asset folder at (GUEST_ASSETS in sandbox/qemu.mjs). */
export const ASSET_ALIAS = /^\/assets(?:\/(.*))?$/;

/**
 * Is `abs` inside `root`?
 *
 * Component-wise via path.relative, never a string prefix: `/data/assets-secrets` starts with
 * `/data/assets` and is a different directory. That is the classic way a containment check leaks, and it
 * leaks in the direction that matters — outward.
 */
export function contains(root, abs) {
  if (!root) return false;
  const rel = path.relative(root, abs);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve a caller-supplied path against the allowed roots, or throw.
 *
 * `write` is what separates the two roots, so every mutating caller has to declare itself. The default is
 * read, which fails safe: a mutating caller that forgets gets its write rejected as an out-of-bounds read,
 * never the other way round.
 *
 * `assetDir` is optional. Absent, this behaves exactly as a single-root guard — which is what every
 * non-Electron caller and every test that does not configure one gets.
 */
export function resolvePath(p, { workdir, assetDir = "", write = false } = {}) {
  if (typeof p !== "string") throw new Error("path must be a string");
  if (!workdir) throw new Error("no working directory is set");

  // The alias is resolved against the asset root FIRST and never falls through to the workspace: `/assets/x`
  // names one specific place, and quietly resolving it somewhere else would hand back a path the caller did
  // not ask for. Unconfigured, it is simply not a valid location.
  const asAsset = ASSET_ALIAS.exec(p);
  if (asAsset) {
    if (!assetDir) throw new Error(`no asset folder is configured: ${p}`);
    const abs = path.resolve(assetDir, asAsset[1] ?? "");
    if (!contains(assetDir, abs)) throw new Error(`path escapes the asset folder: ${p}`);
    if (write) throw new Error(`the asset folder is read-only: ${p}`);
    return abs;
  }

  const alias = WORKSPACE_ALIAS.exec(p);
  const abs = path.resolve(workdir, alias ? (alias[1] ?? "") : p);
  if (contains(workdir, abs)) return abs;

  // An absolute path may legitimately name the asset folder — that is how a model refers to something it was
  // given the full path of. Reads pass; a write is refused BY NAME, so the reason is actionable instead of
  // looking like the path was simply wrong.
  if (contains(assetDir, abs)) {
    if (write) throw new Error(`the asset folder is read-only: ${p}`);
    return abs;
  }
  throw new Error(`path escapes the working directory: ${p}`);
}
