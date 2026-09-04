/**
 * bringWindowToFront -- the one routine every "come back to the app" path uses (notification click, tray Open,
 * second-instance deep link). On Windows the caller never owns the foreground, so a plain focus() is refused
 * and only flashes the taskbar; the routine works around it by passing through the always-on-top band.
 * These tests pin the contract that makes that safe: the user's own always-on-top pin is never disturbed,
 * a minimized window is restored first, and other platforms get no z-order games at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bringWindowToFront } from "../electron/windowFocus.mjs";

/** A BrowserWindow stand-in that records the sequence of calls. */
function fakeWindow({ minimized = false, alwaysOnTop = false, destroyed = false } = {}) {
  const calls = [];
  let onTop = alwaysOnTop;
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isAlwaysOnTop: () => onTop,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    setAlwaysOnTop: (on) => {
      onTop = on;
      calls.push(`onTop:${on}`);
    },
  };
}

/** Run fn with process.platform reported as `platform`, then put the real value back. */
function onPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

test("Windows: passes through the topmost band so the foreground lock cannot bury the window", () => {
  const win = fakeWindow();
  onPlatform("win32", () => bringWindowToFront(win));
  assert.deepEqual(win.calls, ["show", "onTop:true", "onTop:false", "focus"]);
  assert.equal(win.isAlwaysOnTop(), false);
});

test("Windows: a window the user pinned always-on-top stays pinned", () => {
  const win = fakeWindow({ alwaysOnTop: true });
  onPlatform("win32", () => bringWindowToFront(win));
  assert.deepEqual(win.calls, ["show", "focus"]);
  assert.equal(win.isAlwaysOnTop(), true);
});

test("a minimized window is restored before anything else", () => {
  const win = fakeWindow({ minimized: true });
  onPlatform("darwin", () => bringWindowToFront(win));
  assert.deepEqual(win.calls, ["restore", "show", "focus"]);
});

test("macOS / Linux: no always-on-top round trip", () => {
  for (const platform of ["darwin", "linux"]) {
    const win = fakeWindow();
    onPlatform(platform, () => bringWindowToFront(win));
    assert.deepEqual(win.calls, ["show", "focus"], platform);
  }
});

test("a missing or destroyed window is a no-op", () => {
  assert.doesNotThrow(() => bringWindowToFront(null));
  const win = fakeWindow({ destroyed: true });
  bringWindowToFront(win);
  assert.deepEqual(win.calls, []);
});
