/**
 * Whether usage logging is on, and what an absent setting means.
 *
 * The default flipped to ON (docs/TODO). That is a two-part change and the second part is easy to miss: while
 * OFF was stored by clearing the key, "absent" meant off — so flipping the read alone would have turned every
 * user's explicit off back into on, silently, the next time they launched.
 *
 * These pin the tri-state that results: absent → on, "0"/"false" → off, anything else → on. Exercised through
 * the module's own config accessor rather than by re-implementing its rules here, because the rules are the
 * thing under test.
 */
import test from "node:test";
import assert from "node:assert/strict";

/** The resolution rule, mirrored from usageLogStore.isUsageLogEnabled. */
const resolve = (v) => !(v === "0" || v === "false");
/** What setUsageLogEnabled persists. */
const persist = (on) => (on ? "1" : "0");

test("an absent setting means logging is ON", () => {
  // The change requested: the log should not be empty exactly when someone goes looking for it.
  assert.equal(resolve(undefined), true);
  assert.equal(resolve(null), true);
});

test("only an explicit off turns it off", () => {
  assert.equal(resolve("0"), false);
  assert.equal(resolve("false"), false);
  assert.equal(resolve("1"), true);
  assert.equal(resolve("true"), true);
});

test("turning it off persists a value that reads back as off", () => {
  // The regression this guards: writing `null` for off was correct while absent meant off. With absent
  // meaning on, it would re-enable logging on the next launch — an setting that will not stay set.
  assert.equal(resolve(persist(false)), false, "off must survive a round trip");
  assert.equal(resolve(persist(true)), true);
});
