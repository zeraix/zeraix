/**
 * The skin-engine addon (native/skin-engine) from Node: the same binary the Electron main process
 * loads, called through the same loader (native/skin-engine/index.js), against packages generated
 * here. This is the JS end of Stage 9 -- the Rust suite covers the rules; this proves the bridge
 * carries them intact: an error arrives as `{ ok: false, error: { code, message, detail } }` with
 * the specific reason, never as a thrown "Error occurred".
 *
 * Skips when no addon is built (a dev machine without Rust). CI sets ZERAIX_REQUIRE_SKIN_ENGINE so
 * the skip is a failure there, the way the sidecar tests work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { writeZip } from "../electron/skins/zipio.mjs";
import { ALLOWED_REFS, APP_REGISTRY } from "../electron/skins/layoutRefs.mjs";

const require = createRequire(import.meta.url);
let engine = null;
let loadError = null;
try {
  engine = require("../native/skin-engine/index.js");
} catch (e) {
  loadError = e;
}
if (!engine && process.env.ZERAIX_REQUIRE_SKIN_ENGINE) {
  throw new Error(`ZERAIX_REQUIRE_SKIN_ENGINE is set but the addon did not load: ${loadError?.message}`);
}
const skip = engine ? false : `skin-engine addon not built (${loadError?.message?.split("\n")[0]}); run npm run build:skin-engine`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-engine-"));
const skins = path.join(root, "skin-packages");
const state = path.join(root, "skin-packages-active.json");
const examples = path.resolve(import.meta.dirname, "../docs/skin-packages/examples");
const refs = [...ALLOWED_REFS];
/** The install-time registry, exactly as electron/skins/engine.mjs builds it. */
const registry = Object.fromEntries(Object.entries(APP_REGISTRY).map(([k, v]) => [k, [...v]]));

const manifest = (id = "probe-skin") => JSON.stringify({ id, name: "Probe", description: "", author: "tests", version: "1.0.0", created_at: "2026-09-11" });
const pkgFile = (name, entries) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, writeZip(entries.map(([n, d]) => ({ name: n, data: Buffer.from(d) }))));
  return p;
};
const good = () => [
  ["manifest.json", manifest()],
  ["tokens.css", ":root[data-skin-package]{--primary:#0af}"],
  ["assets/a.png", "\x89PNG"],
];
const walk = (dir, rel = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), r) : [[r, fs.readFileSync(path.join(dir, e.name))]];
  });

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("ping and the default id", { skip }, () => {
  assert.match(engine.ping(), /^skin-engine \d+\.\d+\.\d+ ok$/);
  assert.equal(engine.defaultSkinId(), "default");
});

test("validateSkinManifest reports every problem", { skip }, () => {
  assert.equal(engine.validateSkinManifest(manifest()).valid, true);
  const bad = engine.validateSkinManifest('{"id":"Bad Id","version":"one"}');
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /created_at/.test(e)) && bad.errors.length >= 4, JSON.stringify(bad.errors));
});

test("a good package installs; the documented example installs with its regions", { skip }, async () => {
  const r = await engine.installSkinPackageAsync(pkgFile("good.skinpkg", good()), skins, registry, "2.0.0");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.skin.id, "probe-skin");
  assert.ok(fs.existsSync(path.join(skins, "probe-skin", "tokens.css")));

  const aurora = await engine.installSkinPackageAsync(pkgFile("aurora.skinpkg", walk(path.join(examples, "aurora-night"))), skins, registry, "2.0.0");
  assert.equal(aurora.ok, true, JSON.stringify(aurora.error));
  assert.deepEqual(aurora.regions, ["greeting", "sidebarFooter"]);
  assert.equal(aurora.skin.preview, "assets/preview.svg");
});

test("every documented layout example passes the Rust validator too", { skip }, () => {
  const dir = path.join(examples, "layouts");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".components.json"))) {
    const comps = path.join(dir, f.replace(/\.json$/, ".components.json"));
    const r = engine.validateLayoutJson(fs.readFileSync(path.join(dir, f), "utf8"), fs.existsSync(comps) ? fs.readFileSync(comps, "utf8") : null, refs);
    assert.equal(r.ok, true, `${f}: ${r.error?.message}`);
  }
});

test("rejections arrive with their code and the specific detail, and write nothing", { skip }, async () => {
  const before = fs.readdirSync(skins).sort();
  const cases = [
    [[...good(), ["tools/run.exe", "MZ"]], "disallowedFileType", "tools/run.exe (.exe)"],
    [[...good(), ["../../../etc/passwd.css", "x"]], "pathTraversal", "../../../etc/passwd.css"],
    [[["tokens.css", "x"]], "missingManifest", null],
    [[["manifest.json", manifest().replace("1.0.0", "1.0")], ["tokens.css", "x"]], "manifestInvalidVersion", "1.0"],
    [[["manifest.json", manifest("../evil")], ["tokens.css", "x"]], "manifestInvalidId", "../evil"],
    [[["manifest.json", manifest()], ["tokens.css", "@import url(https://x.example/a.css);"]], "invalidStylesheet", /tokens.css/],
    [[...good(), ["layout.json", JSON.stringify({ regions: { greeting: { type: "component", ref: "app:weatherCard" } } })]], "layoutUnknownRef", /weatherCard/],
    [[...good(), ["layout.json", JSON.stringify({ regions: { greeting: { type: "component", ref: "primitive:box", props: { onClick: "x" } } } })]], "layoutForbiddenProp", /onClick/],
    [
      [...good(), ["layout.json", JSON.stringify({ regions: { greeting: { type: "component", ref: "custom:a" } } })], ["components.json", JSON.stringify({ a: { params: [], template: { type: "component", ref: "custom:b" } }, b: { params: [], template: { type: "component", ref: "custom:a" } } })]],
      "layoutCircularReference",
      /a -> b -> a/,
    ],
  ];
  for (const [entries, code, detail] of cases) {
    const r = await engine.installSkinPackageAsync(pkgFile("bad.skinpkg", entries), skins, registry, "2.0.0");
    assert.equal(r.ok, false, code);
    assert.equal(r.error.code, code, JSON.stringify(r.error));
    if (detail instanceof RegExp) assert.match(r.error.detail ?? r.error.message, detail);
    else if (detail !== null) assert.equal(r.error.detail, detail);
    assert.ok(r.error.message.length > 0);
  }
  assert.deepEqual(fs.readdirSync(skins).sort(), before, "a rejected install left files behind");
  const missing = await engine.installSkinPackageAsync(path.join(root, "nope.skinpkg"), skins, registry, null);
  assert.equal(missing.error.code, "packageUnreadable");
});

test("list, active state, concurrency, delete", { skip }, async () => {
  const list = await engine.listSkins(skins);
  assert.deepEqual(list.map((m) => m.id).sort(), ["aurora-night", "probe-skin"]);
  assert.equal(await engine.getActiveSkin(state), null);
  assert.equal(engine.getActiveSkinSync(state), null);

  // Twenty un-awaited switches: every one resolves ok and the file is whole JSON afterwards.
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => engine.setActiveSkin(state, skins, i % 2 ? "aurora-night" : "probe-skin")));
  assert.ok(results.every((r) => r.ok));
  const parsed = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.ok(["aurora-night", "probe-skin"].includes(parsed.active));
  assert.ok(!fs.readdirSync(root).some((n) => n.endsWith(".tmp")), "no temp files left");

  // Sequential: last call wins.
  await engine.setActiveSkin(state, skins, "probe-skin");
  await engine.setActiveSkin(state, skins, "aurora-night");
  assert.equal(await engine.getActiveSkin(state), "aurora-night");
  assert.equal(engine.getActiveSkinSync(state), "aurora-night");
  assert.equal((await engine.setActiveSkin(state, skins, "builtin-midnight")).ok, true, "presets have no directory and are always accepted");
  const bad = await engine.setActiveSkin(state, skins, "ghost-skin");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "notFound");
  assert.equal(bad.error.detail, "ghost-skin");
  assert.equal((await engine.setActiveSkin(state, skins, "../x")).error.code, "invalidId");

  await engine.setActiveSkin(state, skins, "aurora-night");
  assert.equal((await engine.deleteSkin(skins, state, "aurora-night")).ok, true);
  assert.equal(await engine.getActiveSkin(state), null, "deleting the active skin falls back to default");
  assert.ok(!fs.existsSync(path.join(skins, "aurora-night")));
  assert.equal((await engine.deleteSkin(skins, state, "aurora-night")).error.code, "notFound");

  const w = await engine.writeTextFile(path.join(root, "out", "layout.json"), "{}\n");
  assert.equal(w.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "out", "layout.json"), "utf8"), "{}\n");
});

test("sidebar.json: the showcase installs with it; a bad one is refused with its code and writes nothing", { skip }, async () => {
  const showcase = await engine.installSkinPackageAsync(pkgFile("showcase.skinpkg", walk(path.join(examples, "showcase"))), skins, registry, "2.0.0");
  assert.equal(showcase.ok, true, JSON.stringify(showcase.error));
  assert.equal(showcase.hasSidebar, true);
  assert.deepEqual(showcase.regions, ["greeting", "sidebarFooter", "sidebarHeader"]);

  const before = fs.readdirSync(skins).sort();
  for (const [sidebar, code] of [
    [{ brand: { logo: "assets/missing.svg" } }, "sidebarMissingAsset"],
    [{ nav: { items: { "new-chat": { icon: "../../etc/passwd.svg" } } } }, "sidebarInvalidIcon"],
    [{ nav: { items: { "new-chat": { icon: "icon:definitely-not-an-icon" } } } }, "sidebarInvalidIcon"],
    [{ menu: { settings: { hidden: true } } }, "sidebarNotAllowed"],
    [{ nav: { items: { weather: { icon: "icon:sun" } } } }, "sidebarUnknownId"],
    [{ nav: { items: { skills: { onClick: "x" } } } }, "sidebarMalformed"],
  ]) {
    const r = await engine.installSkinPackageAsync(pkgFile("sidebar-bad.skinpkg", [...good(), ["sidebar.json", JSON.stringify(sidebar)]]), skins, registry, "2.0.0");
    assert.equal(r.ok, false, code);
    assert.equal(r.error.code, code, JSON.stringify(r.error));
    assert.match(r.error.detail ?? "", /sidebar\.json/);
  }
  assert.deepEqual(fs.readdirSync(skins).sort(), before, "a rejected install left files behind");
});
