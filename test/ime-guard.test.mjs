/**
 * Enter vs. the IME.
 *
 * These pin the three clauses of the guard against the event orders real browsers produce. That matters
 * more than usual here: the bug only appears with an input method installed, so it cannot be reproduced
 * on a developer machine that has none, and the regression it causes — sending a half-typed message — is
 * invisible until a user reports it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isImeKey, IME_COMMIT_GRACE_MS } from "../src/lib/ime.ts";

const key = (over = {}) => ({ isComposing: false, keyCode: 13, ...over });
const idle = { composing: false, endedAt: 0 };
const NOW = 1_000_000;

test("a plain Enter with no IME in play submits", () => {
  assert.equal(isImeKey(key(), idle, NOW), false);
});

test("Chromium's order: keydown reports isComposing", () => {
  // The spec-compliant sequence — keydown (isComposing: true) then compositionend.
  assert.equal(isImeKey(key({ isComposing: true }), { composing: true, endedAt: 0 }, NOW), true);
});

test("the legacy 229 sentinel is honoured", () => {
  // Some Windows IMEs report the composition through keyCode alone.
  assert.equal(isImeKey(key({ keyCode: 229 }), idle, NOW), true);
});

test("an active composition counts even if the event says nothing", () => {
  assert.equal(isImeKey(key(), { composing: true, endedAt: 0 }, NOW), true);
});

test("WebKit's order: compositionend already fired, so only the timestamp is left", () => {
  // The macOS case this was reported for. compositionend is dispatched BEFORE the keydown that caused
  // it, so isComposing is false, keyCode is 13, and `composing` has already been torn down. Without the
  // grace window every clause reads "not an IME key" and the message sends mid-composition.
  const justCommitted = { composing: false, endedAt: NOW - 1 };
  assert.equal(isImeKey(key(), justCommitted, NOW), true);
});

test("a deliberate Enter after finishing a composition still submits", () => {
  // The cost of the grace window, bounded: a second, intentional keypress must get through. Any real gap
  // between two human keystrokes is far outside the window.
  const done = { composing: false, endedAt: NOW - 200 };
  assert.equal(isImeKey(key(), done, NOW), false);
});

test("the grace window boundary is exclusive", () => {
  assert.equal(isImeKey(key(), { composing: false, endedAt: NOW - IME_COMMIT_GRACE_MS }, NOW), false);
  assert.equal(isImeKey(key(), { composing: false, endedAt: NOW - IME_COMMIT_GRACE_MS + 1 }, NOW), true);
});

test("a field that has never composed is never grace-guarded", () => {
  // endedAt starts at 0, which is `now - 0` = a huge elapsed time; guard against the opposite mistake of
  // treating the sentinel as a very recent commit.
  assert.equal(isImeKey(key(), { composing: false, endedAt: 0 }, 10), false);
});

test("the window is short enough to be invisible and long enough to cover one keypress", () => {
  assert.ok(IME_COMMIT_GRACE_MS >= 20, "too short to cover a same-keypress event pair reliably");
  assert.ok(IME_COMMIT_GRACE_MS <= 80, "long enough to start swallowing deliberate keystrokes");
});
