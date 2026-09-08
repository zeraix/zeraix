/**
 * What a plugin refresh tells the user (refreshFeedback, src/lib/plugins/bridge.ts).
 *
 * The page used to hide every feed error behind `!fromCache`, and a failed fetch ALWAYS reports
 * fromCache — so a build pointed at an origin that serves no registry showed an empty marketplace,
 * no explanation, and a Refresh button that changed nothing. The main process had composed the exact
 * diagnosis ("check NEXT_PUBLIC_PLUGIN_ORIGIN") and the renderer dropped it on the floor.
 *
 * The rule these tests pin: silence is only allowed when the user still has a catalogue to look at.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { refreshFeedback } = await import("../src/lib/plugins/bridge.ts");

const entry = { id: "zeraix/git" };

test("a reachable registry says nothing at all", () => {
  assert.deepEqual(refreshFeedback({ entries: [entry], fromCache: false, errors: [] }), {
    error: null,
    offline: false,
  });
});

test("an outage with a cached catalogue is routine: the quiet note, no error", () => {
  assert.deepEqual(
    refreshFeedback({ entries: [entry], fromCache: true, errors: ["index: could not reach the registry"] }),
    { error: null, offline: true },
  );
});

test("an outage with NOTHING to show is reported, fromCache or not", () => {
  // The case that sent a colleague to ask why the page was blank.
  assert.deepEqual(
    refreshFeedback({
      entries: [],
      fromCache: true,
      errors: ["index: this origin serves no plugin registry (HTTP 404 for /plugins/index.json) — check NEXT_PUBLIC_PLUGIN_ORIGIN"],
    }),
    {
      error:
        "index: this origin serves no plugin registry (HTTP 404 for /plugins/index.json) — check NEXT_PUBLIC_PLUGIN_ORIGIN",
      offline: false,
    },
  );
});

test("a feed we reached and refused is always reported", () => {
  // A rolled-back sequence or a wrong document type is not an outage, and never was suppressed.
  assert.deepEqual(refreshFeedback({ entries: [entry], fromCache: false, errors: ["kill-list: sequence went backwards"] }), {
    error: "kill-list: sequence went backwards",
    offline: false,
  });
});

test("several failures are reported together", () => {
  assert.equal(
    refreshFeedback({ entries: [], fromCache: true, errors: ["index: a", "kill-list: b"] }).error,
    "index: a; kill-list: b",
  );
});

test("an empty registry that answered is not an error", () => {
  // Genuinely nothing published yet: the empty state says so, and there is nothing to add.
  assert.deepEqual(refreshFeedback({ entries: [], fromCache: false, errors: [] }), {
    error: null,
    offline: false,
  });
});
