/**
 * Which sidecar binary runs.
 *
 * The rule used to be written twice — in the app and in the dev pre-flight — "kept in step by hand", and the
 * two had drifted: the pre-flight checked a staging directory the dev app never reads, and both preferred
 * `target/release` over a newer `target/debug`, so a runtime change tested with `cargo test` went on running
 * the old release binary in the app. These pin the single shared rule.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNTIME_EXE, devBinaries, runtimeBinaryPath } from "../electron/tools/runtimeBinary.mjs";

/** A fake checkout with the given profiles built, each at the given mtime (seconds since epoch). */
function checkout(builds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-bin-"));
  for (const [profile, mtime] of Object.entries(builds)) {
    const dir = path.join(root, "runtime", "target", profile);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, RUNTIME_EXE);
    fs.writeFileSync(file, "x");
    fs.utimesSync(file, mtime, mtime);
  }
  return root;
}
const binary = (root, profile) => path.join(root, "runtime", "target", profile, RUNTIME_EXE);

test("the newer development build wins, whichever profile it is", () => {
  // The case that caused the trouble: an old release build and a fresh debug one from `cargo test`.
  const root = checkout({ release: 1_000, debug: 2_000 });
  assert.equal(runtimeBinaryPath({ resourcesPath: null, root, override: undefined }), binary(root, "debug"));

  const other = checkout({ release: 3_000, debug: 2_000 });
  assert.equal(runtimeBinaryPath({ resourcesPath: null, root: other, override: undefined }), binary(other, "release"));
});

test("a single development build is used whichever profile it is", () => {
  const root = checkout({ debug: 1_000 });
  assert.deepEqual(devBinaries(root), [binary(root, "debug")]);
});

test("no build at all is null, not a path that does not exist", () => {
  const root = checkout({});
  assert.equal(runtimeBinaryPath({ resourcesPath: null, root, override: undefined }), null);
});

test("the packaged binary beats any development build", () => {
  const root = checkout({ release: 9_000 });
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-res-"));
  fs.mkdirSync(path.join(resources, "runtime"));
  fs.writeFileSync(path.join(resources, "runtime", RUNTIME_EXE), "x");
  assert.equal(
    runtimeBinaryPath({ resourcesPath: resources, root, override: undefined }),
    path.join(resources, "runtime", RUNTIME_EXE),
  );
});

test("a resources directory with no runtime in it falls through — which is what development looks like", () => {
  // In development `process.resourcesPath` is Electron's own directory. It exists; it holds no runtime.
  const root = checkout({ release: 1_000 });
  const electronResources = fs.mkdtempSync(path.join(os.tmpdir(), "zeraix-electron-res-"));
  assert.equal(
    runtimeBinaryPath({ resourcesPath: electronResources, root, override: undefined }),
    binary(root, "release"),
  );
});

test("an explicit override wins, even over a packaged binary", () => {
  const root = checkout({ release: 1_000 });
  assert.equal(runtimeBinaryPath({ resourcesPath: null, root, override: "/custom/bin" }), "/custom/bin");
});
