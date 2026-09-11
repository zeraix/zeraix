/**
 * The main-process bridge (electron/skins/engine.mjs) driven through its real IPC handlers, with the
 * real addon behind it and `electron` stubbed just enough to capture what it registers.
 *
 * This is the layer the prompt set warns about -- "error-handling detail getting lost across the
 * async boundary" -- so every assertion here is about what the RENDERER receives: the structured
 * `{ ok, error: { code, detail } }` shapes, the sync first-paint answer, the last-call-wins ordering
 * of two un-awaited setActive calls (which the addon alone does not promise; the bridge's promise
 * chain does), and the skin:// handler as registered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, register } from "node:module";
import { writeZip } from "../electron/skins/zipio.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-ipc-"));
process.env.ZERAIX_STUB_USERDATA = path.join(root, "userData");
fs.mkdirSync(process.env.ZERAIX_STUB_USERDATA, { recursive: true });
register("./helpers/electronStub.mjs", import.meta.url);

const engine = await import("../electron/skins/engine.mjs");
const stub = globalThis.__electronStub;

let addon = engine.isEngineAvailable();
if (!addon && process.env.ZERAIX_REQUIRE_SKIN_ENGINE) throw new Error("ZERAIX_REQUIRE_SKIN_ENGINE is set but the addon did not load");
const skip = addon ? false : "skin-engine addon not built; run npm run build:skin-engine";

const manifest = (id) => JSON.stringify({ id, name: `Skin ${id}`, description: "", author: "t", version: "1.0.0", created_at: "2026-09-11" });
const pkg = (name, entries) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, writeZip(entries.map(([n, d]) => ({ name: n, data: Buffer.from(d) }))));
  return p;
};
const good = (id) => [["manifest.json", manifest(id)], ["tokens.css", `:root[data-skin-package]{--primary:#0af;--skin:${id}}`], ["layout.json", JSON.stringify({ regions: { greeting: { type: "component", ref: "app:greeting" } } })]];
const event = { sender: { id: 1 } };
const call = (channel, ...args) => stub.handlers[channel](event, ...args);

engine.registerSkinPackages();
engine.registerSkinProtocol();

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("registration: every channel the preload invokes has a handler, and skin:// is handled", () => {
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("(skinpkg:[a-z-]+)"/g)].map((m) => m[1]);
  const sync = [...preload.matchAll(/ipcRenderer\.sendSync\("(skinpkg:[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 9);
  for (const c of invoked) assert.equal(typeof stub.handlers[c], "function", c);
  for (const c of sync) assert.equal(typeof stub.syncHandlers[c], "function", c);
  assert.equal(typeof stub.protocols.skin, "function");
  assert.deepEqual(engine.SKIN_SCHEME_PRIVILEGES.privileges, { standard: true, secure: true, supportFetchAPI: true });
});

test("availability and first paint before anything is installed", { skip }, async () => {
  assert.deepEqual(await call("skinpkg:available"), { available: true, error: null });
  const e = { returnValue: undefined };
  stub.syncHandlers["skinpkg:get-active-sync"](e);
  assert.deepEqual(e.returnValue, { available: true, active: null });
  const list = await call("skinpkg:list");
  assert.deepEqual(list, { ok: true, skins: [], active: null });
});

test("install: success, and a rejection with its code and detail intact", { skip }, async () => {
  const r = await call("skinpkg:install", pkg("a.skinpkg", good("alpha")));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.skin.id, "alpha");
  assert.deepEqual(r.regions, ["greeting"]);
  assert.ok(fs.existsSync(path.join(process.env.ZERAIX_STUB_USERDATA, "skin-packages", "alpha", "tokens.css")));

  const bad = await call("skinpkg:install", pkg("bad.skinpkg", [...good("beta"), ["evil.exe", "MZ"]]));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "disallowedFileType");
  assert.equal(bad.error.detail, "evil.exe (.exe)");
  assert.match(bad.error.message, /evil\.exe/);
  assert.ok(!fs.existsSync(path.join(process.env.ZERAIX_STUB_USERDATA, "skin-packages", "beta")));

  const unreadable = await call("skinpkg:install", path.join(root, "missing.skinpkg"));
  assert.equal(unreadable.error.code, "packageUnreadable");
  assert.equal((await call("skinpkg:install", 42)).error.code, "packageUnreadable");

  const inspect = await call("skinpkg:inspect", pkg("c.skinpkg", good("gamma")));
  assert.equal(inspect.ok, true);
  assert.ok(!fs.existsSync(path.join(process.env.ZERAIX_STUB_USERDATA, "skin-packages", "gamma")), "inspect installs nothing");
});

test("the file picker path: cancel is not an error, a choice installs", { skip }, async () => {
  stub.dialog.open = null;
  assert.deepEqual(await call("skinpkg:pick"), { ok: false, canceled: true });
  stub.dialog.open = pkg("g.skinpkg", good("gamma"));
  const r = await call("skinpkg:pick");
  assert.equal(r.ok, true);
  assert.equal(r.skin.id, "gamma");
});

test("setActive is serialized so two un-awaited calls land in call order", { skip }, async () => {
  const [a, b] = await Promise.all([call("skinpkg:set-active", "alpha"), call("skinpkg:set-active", "gamma")]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(await call("skinpkg:get-active"), { ok: true, active: "gamma" });
  const rounds = [];
  for (let i = 0; i < 10; i++) rounds.push(call("skinpkg:set-active", i % 2 ? "alpha" : "gamma"));
  await Promise.all(rounds);
  assert.equal((await call("skinpkg:get-active")).active, "alpha", "the last call wins");
  const e = { returnValue: undefined };
  stub.syncHandlers["skinpkg:get-active-sync"](e);
  assert.equal(e.returnValue.active, "alpha");

  const missing = await call("skinpkg:set-active", "nope-skin");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "notFound");
  assert.equal((await call("skinpkg:set-active", "builtin-midnight")).ok, true);
  assert.equal((await call("skinpkg:set-active", "alpha")).ok, true);
});

test("skin:// serves the active package and refuses traversal, as registered", { skip }, async () => {
  const serve = (url) => stub.protocols.skin({ url });
  const ok = await serve("skin://current/tokens.css?t=1");
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /--skin:alpha/);
  assert.equal((await serve("skin://gamma/tokens.css")).status, 200);
  assert.equal((await serve("skin://current/layout.json")).status, 200);
  for (const bad of ["skin://current/../../../../etc/passwd", "skin://current/%2e%2e/x.css", "skin://current/manifest.exe", "skin://nope-skin/tokens.css", "skin://current/"]) {
    assert.equal((await serve(bad)).status, 404, bad);
  }
});

test("read-text: the renderer's way to layout.json (fetch to skin:// is CORS-blocked in Chromium)", { skip }, async () => {
  assert.equal((await call("skinpkg:set-active", "alpha")).ok, true);
  const active = await call("skinpkg:read-text", "layout.json");
  assert.equal(active.ok, true);
  assert.deepEqual(JSON.parse(active.text), { regions: { greeting: { type: "component", ref: "app:greeting" } } });
  const byId = await call("skinpkg:read-text", "tokens.css", "gamma");
  assert.match(byId.text, /--skin:gamma/);
  // napi leaves an Option::None field absent (undefined), the JS shortcut sets null: both read as "no file".
  const absent = await call("skinpkg:read-text", "components.json");
  assert.equal(absent.ok, true, "absent file is not an error");
  assert.equal(absent.text ?? null, null, "absent file reads as null");
  assert.ok(!absent.error);
  const preset = await call("skinpkg:read-text", "layout.json", "builtin-midnight");
  assert.equal(preset.ok && (preset.text ?? null) === null, true, "presets have no files");
  const traversal = await call("skinpkg:read-text", "../../skin-packages-active.json");
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, "invalidPath");
  assert.equal((await call("skinpkg:read-text", "manifest.json", "nope-skin")).error.code, "notFound");
  assert.equal((await call("skinpkg:read-text", "assets/x.png", "alpha")).error.code, "invalidPath", "only json/css");
});

test("validate-layout and export-text round trip through the engine", { skip }, async () => {
  const okLayout = await call("skinpkg:validate-layout", JSON.stringify({ regions: { greeting: { type: "component", ref: "primitive:box" } } }), null);
  assert.equal(okLayout.ok, true);
  assert.deepEqual(okLayout.regions, ["greeting"]);
  const badLayout = await call("skinpkg:validate-layout", JSON.stringify({ regions: { greeting: { type: "component", ref: "app:nope" } } }), null);
  assert.equal(badLayout.error.code, "layoutUnknownRef");

  stub.dialog.save = null;
  assert.deepEqual(await call("skinpkg:export-text", { defaultName: "layout.json", text: "{}\n" }), { ok: false, canceled: true });
  stub.dialog.save = path.join(root, "exported", "layout.json");
  const w = await call("skinpkg:export-text", { defaultName: "layout.json", text: "{}\n" });
  assert.equal(w.ok, true);
  assert.equal(fs.readFileSync(stub.dialog.save, "utf8"), "{}\n");
  assert.equal((await call("skinpkg:export-text", { defaultName: "x.json" })).ok, false, "nothing to export");
});

test("delete falls back to default and reports a missing package", { skip }, async () => {
  assert.equal((await call("skinpkg:set-active", "alpha")).ok, true);
  assert.equal((await call("skinpkg:delete", "alpha")).ok, true);
  assert.deepEqual(await call("skinpkg:get-active"), { ok: true, active: null });
  const list = await call("skinpkg:list");
  assert.deepEqual(list.skins.map((s) => s.id), ["gamma"]);
  const gone = await call("skinpkg:delete", "alpha");
  assert.equal(gone.error.code, "notFound");
  assert.equal(gone.error.detail, "alpha");
});

test("download-template saves the official template, and its my-skin/ installs as it is", { skip }, async () => {
  stub.dialog.save = null;
  assert.deepEqual(await call("skinpkg:download-template"), { ok: false, canceled: true });
  const out = path.join(root, "downloads", "zeraix-skin-package-template.zip");
  stub.dialog.save = out;
  const r = await call("skinpkg:download-template");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.path, out);
  // By full path, with an independent zip library: the template nests folders, which zipio.readZip (the v1 basename reader) does not read.
  const AdmZip = createRequire(import.meta.url)("adm-zip");
  const entries = new Map(new AdmZip(fs.readFileSync(out)).getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e.getData()]));
  for (const name of ["README.md", ".vscode/settings.json", "schemas/sidebar.schema.json", "my-skin/manifest.json"]) assert.ok(entries.has(name), name);
  const inner = [...entries].filter(([n]) => n.startsWith("my-skin/")).map(([n, d]) => [n.slice("my-skin/".length), d]);
  const installed = await call("skinpkg:install", pkg("from-template.skinpkg", inner));
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  assert.equal(installed.skin.id, "my-skin");
  assert.equal(installed.hasSidebar, true);
});
