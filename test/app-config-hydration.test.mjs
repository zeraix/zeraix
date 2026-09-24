/**
 * app.config ↔ local storage: the model list must survive in both directions.
 *
 * Found by running the app end to end from a fresh profile (2026-09-23). app.config's `[llm] model_list` was
 * hydrated into the WRONG local key — `agent.llm.models.list` instead of `agent.llm.modelList` — because the
 * INI→dot mapping tried the per-provider `model_<id>` prefix before its own static table, and `model_list`
 * matches that prefix. The app then read an empty list, saved it, and the write-mirror copied `[]` over the
 * file. The durable copy of the user's models was destroyed by the launch that should have restored it — and
 * any hand edit to the file, which its own header invites, was discarded the same way.
 *
 * These drive the real module against a fake `localStorage` and a fake `window.appConfig`, and assert on what
 * reaches the FILE, because the file is the copy that was lost.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./helpers/srcResolve.mjs", import.meta.url);

/** A browser-ish environment: storage the real helper reads, and a config bridge that records every write. */
function environment(fileLlm, local = {}) {
  const store = new Map(Object.entries(local).map(([k, v]) => [k, JSON.stringify(v)]));
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const file = { llm: { ...fileLlm } };
  const writes = [];
  globalThis.window.appConfig = {
    getAllSync: () => JSON.parse(JSON.stringify(file)),
    set: async (section, key, value) => {
      writes.push({ section, key, value });
      (file[section] ??= {})[key] = value;
    },
    remove: async (section, key) => {
      writes.push({ section, key, removed: true });
      delete file[section]?.[key];
    },
  };
  return { file, writes, llm: () => JSON.parse(store.get("agent") ?? "{}").llm ?? {} };
}

/** A fresh copy of the module each time: it keeps a once-per-process `hydrated` flag. */
let n = 0;
async function load() {
  return import(`../src/lib/ai/appConfig.ts?case=${++n}`);
}

const E2E = JSON.stringify([{ id: "custom::e2e", model: "m", endpoint: "http://x", custom: true }]);

test("a fresh profile restores the model list from the file — into the key the app reads", async () => {
  const env = environment({ model_list: E2E, selected_model: "custom::e2e" });
  const { hydrateAppConfig } = await load();
  hydrateAppConfig();
  assert.equal(env.llm().modelList, E2E, "the list must land in agent.llm.modelList, which models.ts reads");
  assert.equal(env.llm().models?.list, undefined, "and not in the per-provider slot `agent.llm.models.list`");
});

test("restoring does not then write an empty list back over the file", async () => {
  const env = environment({ model_list: E2E });
  const { hydrateAppConfig, mirrorConfigWrite } = await load();
  hydrateAppConfig();
  // What the app does at startup: read its list and save it back. With the list in the wrong key that read
  // came back empty, and this save is what destroyed the file.
  mirrorConfigWrite("agent.llm.modelList", env.llm().modelList || "[]");
  assert.equal(env.file.llm.model_list, E2E, "the durable copy must still hold the models after a launch");
});

test("a hand edit to the file wins over the old local copy, as the file's header promises", async () => {
  const edited = JSON.stringify([{ id: "custom::hand", model: "h", endpoint: "http://h", custom: true }]);
  const env = environment({ model_list: edited }, { agent: { llm: { modelList: E2E } } });
  const { hydrateAppConfig } = await load();
  hydrateAppConfig();
  assert.equal(env.llm().modelList, edited);
});

test("a stale stray key left by earlier launches is never mirrored back over the file", async () => {
  // Every existing user has `agent.llm.models.list` from past launches of the buggy mapping, holding whatever
  // the file said back then. Checking the static table first fixes the read, but the provider backfill would
  // then find that stray key unclaimed and map it straight back to `model_list` — overwriting the current
  // list with an old one. The prefix mapping must never be able to produce a static key.
  const stale = JSON.stringify([{ id: "custom::old", model: "o", endpoint: "http://o", custom: true }]);
  const env = environment({ model_list: E2E }, { agent: { llm: { modelList: E2E, models: { list: stale } } } });
  const { hydrateAppConfig } = await load();
  hydrateAppConfig();
  assert.equal(env.file.llm.model_list, E2E, "the stale stray list must not reach the file");
  assert.ok(
    !env.writes.some((w) => w.key === "model_list" && w.value === stale),
    `wrote the stale list: ${JSON.stringify(env.writes)}`,
  );
});

test("a write to the stray key is refused rather than mirrored onto model_list", async () => {
  const env = environment({ model_list: E2E });
  const { mirrorConfigWrite } = await load();
  mirrorConfigWrite("agent.llm.models.list", "[]");
  assert.equal(env.file.llm.model_list, E2E);
});

test("real per-provider entries still map both ways", async () => {
  // The prefix exists for these, and the fix must not break them.
  const env = environment({ model_openai: "gpt-4o", key_openai: "sk-test" });
  const { hydrateAppConfig, mirrorConfigWrite } = await load();
  hydrateAppConfig();
  assert.equal(env.llm().models?.openai, "gpt-4o");
  assert.equal(env.llm().keys?.openai, "sk-test");
  mirrorConfigWrite("agent.llm.models.anthropic", "claude");
  assert.equal(env.file.llm.model_anthropic, "claude");
});
