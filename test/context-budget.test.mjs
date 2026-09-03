/**
 * The context budget preference, and the one rule its Settings switch depends on.
 *
 * The switch was broken in a way the store's own tests could not see: the component restored
 * `DEFAULT_CONTEXT_BUDGET_K` when the cap was turned on, and that default is **0**, which means off. Ticking
 * the box wrote 0, the store read back 0, and the box un-ticked itself — while the number field beside it
 * stayed disabled, because it keys off the same value. The whole control was inert on a fresh install, which
 * is every install, since the feature ships opt-in.
 *
 * `restoreBudgetK` is that decision pulled out of the component so it can be stated as a property: switching
 * something on must leave it on. The clamping tests below it are the surrounding contract that property has to
 * hold inside — a "restored" value the store would clamp to 0 would reintroduce the same bug by another route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Extensionless bundler-style imports, which node does not resolve on its own.
register("./helpers/srcResolve.mjs", import.meta.url);
const {
  DEFAULT_CONTEXT_BUDGET_K,
  MAX_CONTEXT_BUDGET_K,
  MIN_CONTEXT_BUDGET_K,
  SUGGESTED_CONTEXT_BUDGET_K,
  restoreBudgetK,
  getContextBudgetK,
  setContextBudgetK,
} = await import("../src/lib/ai/contextBudget.ts");

/**
 * The storage the preference lives in, faithfully enough to matter: the library behind get/setStorage keeps
 * dotted keys as one JSON object per top-level key, and — the point of the test below — refuses to write a
 * falsy value at all. Installed on demand, so the pure tests above keep running without a window.
 */
function installLocalStorage() {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  };
  globalThis.window = globalThis;
}

test("turning the cap on always produces a value that is actually on", () => {
  // The regression itself: nothing positive has ever been set, so the component has only the default to
  // offer, and the default is off.
  assert.equal(DEFAULT_CONTEXT_BUDGET_K, 0, "the feature ships opt-in; this test exists because of that");
  assert.ok(restoreBudgetK(DEFAULT_CONTEXT_BUDGET_K) > 0, "restoring the default must not mean 'off'");
  assert.ok(restoreBudgetK(0) > 0);
  assert.equal(restoreBudgetK(0), SUGGESTED_CONTEXT_BUDGET_K);
});

test("a value the user tuned is restored rather than replaced by the suggestion", () => {
  assert.equal(restoreBudgetK(200), 200, "the point of remembering it is to give it back");
  assert.equal(restoreBudgetK(MIN_CONTEXT_BUDGET_K), MIN_CONTEXT_BUDGET_K);
  assert.equal(restoreBudgetK(MAX_CONTEXT_BUDGET_K), MAX_CONTEXT_BUDGET_K);
});

test("a restored value is clamped into the band, never back to off", () => {
  // Below the band: clamped up to the minimum, NOT down to 0 — the latter would be the original bug wearing
  // a different mask, since the switch would again end up in the "on" position meaning off.
  assert.equal(restoreBudgetK(1), MIN_CONTEXT_BUDGET_K);
  assert.equal(restoreBudgetK(MIN_CONTEXT_BUDGET_K - 1), MIN_CONTEXT_BUDGET_K);
  assert.equal(restoreBudgetK(9_999), MAX_CONTEXT_BUDGET_K);
});

test("nonsense in never yields a broken switch", () => {
  // A corrupted preference should still leave a usable control rather than one that cannot be turned on.
  for (const bad of [NaN, Infinity, -Infinity, -50]) {
    assert.ok(restoreBudgetK(bad) > 0, `restoreBudgetK(${bad}) must still enable the cap`);
  }
});

test("the suggestion itself survives the store's clamping", () => {
  // If the suggested value ever drifted outside the band, `restoreBudgetK` would hand the store something it
  // clamps — and the switch would silently land somewhere the user did not choose.
  assert.ok(SUGGESTED_CONTEXT_BUDGET_K >= MIN_CONTEXT_BUDGET_K);
  assert.ok(SUGGESTED_CONTEXT_BUDGET_K <= MAX_CONTEXT_BUDGET_K);
  assert.equal(restoreBudgetK(SUGGESTED_CONTEXT_BUDGET_K), SUGGESTED_CONTEXT_BUDGET_K);
});

test("switching the cap OFF is written, not dropped: 0 reads back as 0", () => {
  // The second way the same switch was inert. Turning it on wrote a positive number and worked; turning it
  // off wrote a numeric 0, which the storage layer treats as "nothing to write". The old budget stayed, the
  // switch read it back and re-ticked itself. Typing 0 into the field failed the same way.
  installLocalStorage();
  setContextBudgetK(150);
  assert.equal(getContextBudgetK(), 150);
  setContextBudgetK(0);
  assert.equal(getContextBudgetK(), 0, "off must survive a storage layer that drops falsy writes");
  setContextBudgetK(200);
  assert.equal(getContextBudgetK(), 200, "and on again must still work after an off");
  setContextBudgetK(-5);
  assert.equal(getContextBudgetK(), 0, "anything non-positive is off");
});
