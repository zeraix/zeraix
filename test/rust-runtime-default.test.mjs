/**
 * Which runtime serves a tool call (see electron/tools/rustRuntime.mjs, `flagState`).
 *
 * **The truth table collapsed at 2.0.** It used to be per build type — a packaged app defaulted to the Rust
 * sidecar while `electron .` and this suite defaulted to the JS handlers — and that mattered because there
 * were two implementations to choose between. Deleting the JS handlers (TODO §0.2 F1) removed the choice: the
 * runtime is on everywhere, because a runtime that is off is an app with no file tools and no commands.
 *
 * What is still worth pinning is the override. `ZERAIX_RUST_RUNTIME=0` is now a debugging switch rather than a
 * supported configuration, and it has to keep working in every spelling — it is what makes a bad sidecar
 * diagnosable without shipping a new installer.
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

test("the runtime is on in every environment, because there is nothing to fall back to", async () => {
  // Packaged, `electron .`, and plain node. All three, because the JS handlers that used to serve two of
  // them no longer exist.
  assert.equal(await enabledWhen({ electron: true, defaultApp: false }), true, "packaged");
  assert.equal(await enabledWhen({ electron: true, defaultApp: true }), true, "electron .");
  assert.equal(await enabledWhen({ electron: false, defaultApp: false }), true, "plain node");
});

test("ZERAIX_RUST_RUNTIME overrides the default in both directions", async () => {
  // Off in a packaged build is the field switch: it is what makes a bad sidecar recoverable without
  // shipping a new installer, so every spelling of "off" has to actually turn it off.
  for (const off of ["0", "off", "false", "OFF"]) {
    assert.equal(await enabledWhen({ electron: true, defaultApp: false, flag: off }), false, off);
  }
  // Explicitly on is still accepted, and still means on.
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

test("an unrecognised value falls back to the default rather than being read as off", async () => {
  // The failure to avoid is a typo in the env var silently disabling every tool the app has.
  assert.equal(await enabledWhen({ electron: true, defaultApp: true, flag: "yes-please" }), true);
  assert.equal(await enabledWhen({ electron: true, defaultApp: false, flag: "yes-please" }), true);
});
