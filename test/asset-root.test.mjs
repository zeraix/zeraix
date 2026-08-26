/**
 * The two-root file boundary (electron/tools/paths.mjs).
 *
 * The working directory is read-write; the asset folder holds the media library and is READ-ONLY. The model
 * may read an asset — that is how it composes a clip from footage it generated earlier — and may never alter
 * one, because an original the user cannot get back is not something a tool call should be able to destroy.
 *
 * These tests attempt the escapes rather than asserting the rule, which is the standard the sandbox
 * evaluation already sets for this codebase: a test that checks a policy object certifies a boundary that may
 * not exist. So each case below is a path a confused or hostile caller would actually send.
 *
 * The other half of the boundary is a bind mount (`--ro-bind` in sandbox/qemu.mjs). This half covers the file
 * tools; that half covers `run_command`. Neither is sufficient alone, which is why both exist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { resolvePath, contains } = await import("../electron/tools/paths.mjs");

const WORK = path.resolve("/data/work");
const ASSETS = path.resolve("/data/assets");
const roots = (over = {}) => ({ workdir: WORK, assetDir: ASSETS, ...over });
/** Did this call refuse, and for the stated reason? */
const refuses = (fn, pattern) => assert.throws(fn, pattern);

// ── Reads are allowed from both roots ───────────────────────────────────────────────────────────────────

test("a workspace path resolves as it always did", () => {
  assert.equal(resolvePath("notes.txt", roots()), path.join(WORK, "notes.txt"));
  assert.equal(resolvePath("/workspace/notes.txt", roots()), path.join(WORK, "notes.txt"));
  assert.equal(resolvePath(path.join(WORK, "a/b.txt"), roots()), path.join(WORK, "a/b.txt"));
});

test("an asset resolves by absolute path and through the /assets alias", () => {
  // The alias is what the model is told inside the sandbox; the host tools must accept the same name, or a
  // path it was handed would come back as an escape.
  assert.equal(resolvePath("/assets/clip.mp4", roots()), path.join(ASSETS, "clip.mp4"));
  assert.equal(resolvePath(path.join(ASSETS, "clip.mp4"), roots()), path.join(ASSETS, "clip.mp4"));
});

// ── Writes to the asset folder are refused, by every route ──────────────────────────────────────────────

test("writing to an asset is refused, by alias and by absolute path", () => {
  refuses(() => resolvePath("/assets/clip.mp4", roots({ write: true })), /read-only/);
  refuses(() => resolvePath(path.join(ASSETS, "clip.mp4"), roots({ write: true })), /read-only/);
});

test("the refusal names the reason, so it is actionable rather than looking like a wrong path", () => {
  refuses(() => resolvePath("/assets/index.json", roots({ write: true })), /asset folder is read-only/);
});

test("reading the same path still succeeds — read-only is a restriction, not a ban", () => {
  assert.equal(resolvePath("/assets/index.json", roots()), path.join(ASSETS, "index.json"));
});

// ── Escapes ─────────────────────────────────────────────────────────────────────────────────────────────

test("traversal out of the asset alias is refused", () => {
  refuses(() => resolvePath("/assets/../assets-secrets/key.txt", roots()), /escapes/);
  refuses(() => resolvePath("/assets/../../etc/passwd", roots()), /escapes/);
});

test("a sibling sharing the asset folder's name prefix is NOT inside it", () => {
  // The failure a string-prefix check produces: /data/assets-secrets startsWith /data/assets.
  refuses(() => resolvePath("/data/assets-secrets/key.txt", roots()), /escapes/);
  assert.equal(contains(ASSETS, path.resolve("/data/assets-secrets/key.txt")), false);
});

test("a sibling sharing the WORKSPACE prefix is not inside it either", () => {
  refuses(() => resolvePath("/data/work-backup/secret.txt", roots()), /escapes/);
});

test("anything outside both roots is refused", () => {
  refuses(() => resolvePath("/etc/passwd", roots()), /escapes/);
  refuses(() => resolvePath("../outside.txt", roots()), /escapes/);
  refuses(() => resolvePath("/workspace/../../etc/passwd", roots()), /escapes/);
});

test("a non-string path is rejected before any resolution happens", () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    refuses(() => resolvePath(bad, roots()), /must be a string/);
  }
});

// ── With no asset root configured, nothing changes ──────────────────────────────────────────────────────

test("without an asset folder the guard is single-root, exactly as before", () => {
  const single = { workdir: WORK };
  assert.equal(resolvePath("notes.txt", single), path.join(WORK, "notes.txt"));
  refuses(() => resolvePath(path.join(ASSETS, "clip.mp4"), single), /escapes/);
});

test("the /assets alias is not silently resolved somewhere else when unconfigured", () => {
  // Falling through to the workspace would hand back a path the caller never asked for — a file at
  // <workdir>/clip.mp4 is not the asset the model was referring to.
  refuses(() => resolvePath("/assets/clip.mp4", { workdir: WORK }), /no asset folder/);
});

test("a missing working directory is an error rather than a resolve against the process cwd", () => {
  refuses(() => resolvePath("notes.txt", { workdir: "" }), /no working directory/);
});

// ── contains, directly ──────────────────────────────────────────────────────────────────────────────────

test("a root contains itself, and containment is not fooled by traversal", () => {
  assert.equal(contains(ASSETS, ASSETS), true);
  assert.equal(contains(ASSETS, path.join(ASSETS, "a/b/c")), true);
  assert.equal(contains(ASSETS, path.resolve(ASSETS, "..")), false);
  assert.equal(contains("", "/anything"), false, "an unset root contains nothing");
});
