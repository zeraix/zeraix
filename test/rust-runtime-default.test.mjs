/**
 * Which runtime serves a tool call, per build type (see electron/tools/rustRuntime.mjs, `flagState`).
 *
 * The rule is not "on" or "off": a PACKAGED app defaults to the Rust sidecar, while `electron .` and this
 * test suite default to the JS handlers, and `ZERAIX_RUST_RUNTIME` overrides either way. That decision is
 * made by sniffing two process fields rather than by asking Electron -- `rustRuntime.mjs` imports node
 * builtins and nothing else on purpose, because the parity harness and these tests load it outside
 * Electron entirely, and `import { app } from "electron"` there would fail a long way from the decision.
 *
 * Sniffing is exactly the kind of thing that breaks silently. Every failure mode in the bridge is
 * fail-open, so a detection bug does not raise anything: it just means a shipped app quietly runs the JS
 * handlers forever, or a dev build quietly stops exercising them, and both look precisely like working.
 * Hence pinning the truth table here rather than trusting a manual check of one installer.
 *
 * `warmUp()` is the observable: it reports `enabled` straight from the flag, before any spawn is
 * attempted, so these assertions never depend on a built binary. `ZERAIX_RUST_RUNTIME_BIN` points at a
 * path that does not exist so the "enabled" cases have something to fail to spawn rather than a real
 * sidecar to start -- `ready` is therefore false throughout and only `enabled` is asserted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

const { warmUp } = await import("../electron/tools/rustRuntime.mjs");

// Absent on disk, and named so a stray spawn is identifiable if one ever escapes.
process.env.ZERAIX_RUST_RUNTIME_BIN = path.join(os.tmpdir(), "zeraix-agent-runtime-does-not-exist");

/** Run `warmUp` with the process made to look like one of the three environments. */
async function enabledWhen({ electron, defaultApp, flag }) {
  const hadElectron = "electron" in process.versions;
  const priorElectron = process.versions.electron;
  const priorDefaultApp = process.defaultApp;
  const priorFlag = process.env.ZERAIX_RUST_RUNTIME;

  if (electron) process.versions.electron = "38.0.0";
  else delete process.versions.electron;
  if (defaultApp) process.defaultApp = true;
  else delete process.defaultApp;
  if (flag === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
  else process.env.ZERAIX_RUST_RUNTIME = flag;

  try {
    const { enabled } = await warmUp();
    return enabled;
  } finally {
    if (hadElectron) process.versions.electron = priorElectron;
    else delete process.versions.electron;
    if (priorDefaultApp === undefined) delete process.defaultApp;
    else process.defaultApp = priorDefaultApp;
    if (priorFlag === undefined) delete process.env.ZERAIX_RUST_RUNTIME;
    else process.env.ZERAIX_RUST_RUNTIME = priorFlag;
  }
}

test("a packaged app defaults to the Rust runtime", async () => {
  // Under Electron and NOT launched with a path argument -- the one combination a packaged binary has.
  assert.equal(await enabledWhen({ electron: true, defaultApp: false }), true);
});

test("`electron .` defaults to the JS handlers", async () => {
  // process.defaultApp is what separates a dev launch from a packaged one; without this branch,
  // `npm run electron:dev` would stop exercising the handlers the parity harness diffs against.
  assert.equal(await enabledWhen({ electron: true, defaultApp: true }), false);
});

test("plain node defaults to the JS handlers", async () => {
  // The A/B harness and this suite. They drive the sidecar explicitly when they want it.
  assert.equal(await enabledWhen({ electron: false, defaultApp: false }), false);
});

test("ZERAIX_RUST_RUNTIME overrides the default in both directions", async () => {
  // Off in a packaged build is the field switch: it is what makes a bad sidecar recoverable without
  // shipping a new installer, so every spelling of "off" has to actually turn it off.
  for (const off of ["0", "off", "false", "OFF"]) {
    assert.equal(await enabledWhen({ electron: true, defaultApp: false, flag: off }), false, off);
  }
  // On in development is `npm run electron:dev:rust`, and on under plain node is the parity harness.
  for (const on of ["1", "on", "true", "ON"]) {
    assert.equal(await enabledWhen({ electron: true, defaultApp: true, flag: on }), true, on);
    assert.equal(await enabledWhen({ electron: false, defaultApp: false, flag: on }), true, on);
  }
});

test("`shadow` is refused rather than silently meaning `on`", async () => {
  // It was accepted once and described as "run both, compare, return the JS answer". Nothing implemented
  // that, so it behaved exactly like `on` -- a flag whose safest-sounding value quietly enables the thing.
  assert.equal(await enabledWhen({ electron: true, defaultApp: false, flag: "shadow" }), false);
});

test("an unrecognised value falls back to the build-type default, not to on", async () => {
  assert.equal(await enabledWhen({ electron: true, defaultApp: true, flag: "yes-please" }), false);
  assert.equal(await enabledWhen({ electron: true, defaultApp: false, flag: "yes-please" }), true);
});
