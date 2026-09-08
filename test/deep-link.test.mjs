/**
 * Where a zeraix:// link lands (src/lib/deepLink.ts).
 *
 * A deep link is an external input: any process on the machine can fire one at this app, so the
 * mapping is an allow-list and the interesting cases are the ones that must NOT route — an unknown
 * host, a path that climbs out of /agent, a protocol-relative URL smuggled through ?path=.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { resolveDeepLink, parseSettingsHash } = await import("../src/lib/deepLink.ts");

/** What main.mjs sends: the URL, already parsed. */
const link = (url) => {
  const u = new URL(url);
  return { url, host: u.host, pathname: u.pathname, params: Object.fromEntries(u.searchParams) };
};

test("a settings link opens the section, and the group when it names one", () => {
  assert.equal(resolveDeepLink(link("zeraix://settings")), "/agent/settings");
  assert.equal(resolveDeepLink(link("zeraix://settings/general")), "/agent/settings#general");
  assert.equal(
    resolveDeepLink(link("zeraix://settings/general/background")),
    "/agent/settings#general/background",
  );
});

test("?section= still works, and the path wins when both are given", () => {
  assert.equal(resolveDeepLink(link("zeraix://settings?section=models")), "/agent/settings#models");
  assert.equal(resolveDeepLink(link("zeraix://settings/keys?section=models")), "/agent/settings#keys");
});

test("other /agent routes resolve; anything else does not", () => {
  assert.equal(resolveDeepLink(link("zeraix://plugins")), "/agent/plugins");
  assert.equal(resolveDeepLink(link("zeraix://chat")), "/agent/chat");
  assert.equal(resolveDeepLink(link("zeraix://auth-complete?ok=1")), null);
  assert.equal(resolveDeepLink(link("zeraix://nope")), null);
  assert.equal(resolveDeepLink(null), null);
});

test("?path= is confined to /agent", () => {
  assert.equal(resolveDeepLink(link("zeraix://open?path=/agent/plugins")), "/agent/plugins");
  assert.equal(resolveDeepLink(link("zeraix://open?path=/admin")), null);
  assert.equal(resolveDeepLink(link("zeraix://open?path=//evil.example/x")), null);
  assert.equal(resolveDeepLink(link("zeraix://open")), null);
});

test("a path segment cannot be a traversal or a stray slash", () => {
  assert.equal(resolveDeepLink(link("zeraix://settings/..%2Fmodels")), "/agent/settings");
  assert.equal(resolveDeepLink(link("zeraix://settings/")), "/agent/settings");
});

test("the settings hash parses into a section and at most one group", () => {
  assert.deepEqual(parseSettingsHash("#general"), { section: "general", anchor: null });
  assert.deepEqual(parseSettingsHash("#general/background"), {
    section: "general",
    anchor: "general/background",
  });
  // Deeper than a group is still that group; junk is nothing at all.
  assert.deepEqual(parseSettingsHash("#general/background/extra"), {
    section: "general",
    anchor: "general/background",
  });
  assert.deepEqual(parseSettingsHash(""), { section: null, anchor: null });
  assert.deepEqual(parseSettingsHash("#"), { section: null, anchor: null });
  assert.deepEqual(parseSettingsHash("#%E0%A4%A"), { section: null, anchor: null });
});
