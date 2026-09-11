/**
 * The official skin package template (electron/skins/package-template, zipped by
 * electron/skins/packageTemplate.mjs).
 *
 * What an author gets must work the first time: my-skin/ installs as it is (through the real engine
 * when the addon is built), passes the renderer's own validators, every image it names ships with
 * it, and the JSON Schemas that drive editor completion are exactly what the generator produces from
 * the app's current registries -- a stale schema would teach authors ids the installer refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { z } = await import("zod");
const primitives = await import("../src/components/theme/primitives/schemas.ts");
const refs = await import("../electron/skins/layoutRefs.mjs");
const { buildSkinSchemas, SCHEMA_FILES } = await import("../scripts/skinTemplateSchemas.mjs");
const { TEMPLATE_DIR, TEMPLATE_PACKAGE_DIR, VSCODE_SETTINGS, buildPackageTemplateZip, templateEntries } = await import("../electron/skins/packageTemplate.mjs");
const { writeZip } = await import("../electron/skins/zipio.mjs");
const { parsePackageLayout } = await import("../src/components/theme/layout/schema.ts");
const { parseSidebarConfig, parseIconValue } = await import("../src/components/theme/skinpkg/sidebarSchema.ts");

const require = createRequire(import.meta.url);
/** An independent zip reader, by full path. zipio.readZip is the v1 skin reader: basenames, one folder deep. */
const AdmZip = require("adm-zip");
const unzip = (buf) => new Map(new AdmZip(buf).getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e.getData()]));
const pkgDir = path.join(TEMPLATE_DIR, TEMPLATE_PACKAGE_DIR);
const readPkg = (rel) => fs.readFileSync(path.join(pkgDir, rel), "utf8");
const ALLOWED_EXT = new Set(["json", "css", "png", "jpg", "jpeg", "webp", "gif", "svg", "woff2"]);

let engine = null;
try {
  engine = require("../native/skin-engine/index.js");
} catch {
  engine = null;
}
if (!engine && process.env.ZERAIX_REQUIRE_SKIN_ENGINE) throw new Error("ZERAIX_REQUIRE_SKIN_ENGINE is set but the addon did not load");

let Ajv = null;
try {
  const mod = require("ajv");
  Ajv = mod.default ?? mod;
} catch {
  Ajv = null;
}

test("the committed schemas are what the generator produces from the current registries", () => {
  const generated = buildSkinSchemas({ z, primitiveSchemas: primitives.PRIMITIVE_SCHEMAS, refs });
  for (const name of SCHEMA_FILES) {
    const committed = fs.readFileSync(path.join(TEMPLATE_DIR, "schemas", name), "utf8");
    assert.equal(committed, `${JSON.stringify(generated[name], null, 2)}\n`, `${name} is out of date: run npm run gen:skin-schemas`);
  }
  // The generator really read the primitives: every one has typed props, not a bare object.
  const component = generated["layout.schema.json"].definitions.component;
  for (const key of refs.PRIMITIVE_KEYS) {
    const rule = component.allOf.find((r) => r.if.properties.ref.const === `primitive:${key}`);
    assert.ok(rule && Object.keys(rule.then.properties.props.properties ?? {}).length > 0, `primitive:${key} has no props in the schema`);
  }
});

test("the template zip holds the README, the package, the schemas and the editor settings", () => {
  const entries = templateEntries();
  const names = entries.map((e) => e.name);
  for (const expected of ["README.md", ".vscode/settings.json", `${TEMPLATE_PACKAGE_DIR}/manifest.json`, `${TEMPLATE_PACKAGE_DIR}/tokens.css`, ...SCHEMA_FILES.map((f) => `schemas/${f}`)]) {
    assert.ok(names.includes(expected), `${expected} is missing from the template`);
  }
  const back = unzip(buildPackageTemplateZip());
  assert.equal(back.size, entries.length);
  for (const e of entries) assert.ok(back.get(e.name)?.equals(e.data), `${e.name} did not round-trip`);
  // Every schema file the editor settings point at exists in the zip.
  for (const rule of VSCODE_SETTINGS["json.schemas"]) assert.ok(names.includes(rule.url.replace(/^\.\//, "")), rule.url);
  // Everything inside my-skin/ is a file type the installer accepts, so zipping the folder's contents installs.
  for (const n of names.filter((x) => x.startsWith(`${TEMPLATE_PACKAGE_DIR}/`))) {
    assert.ok(ALLOWED_EXT.has(n.split(".").pop().toLowerCase()), `${n} would be rejected by the installer`);
  }
});

test("my-skin passes the renderer's validators and ships every image it names", () => {
  const manifest = JSON.parse(readPkg("manifest.json"));
  assert.match(manifest.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fs.existsSync(path.join(pkgDir, manifest.preview)), "the preview exists");

  const layout = parsePackageLayout(readPkg("layout.json"), readPkg("components.json"), refs.ALLOWED_REFS);
  assert.ok(layout.ok, layout.ok ? "" : layout.message);
  assert.deepEqual(Object.keys(layout.tree.regions).sort(), ["greeting", "sidebarFooter"]);

  const sidebar = parseSidebarConfig(readPkg("sidebar.json"));
  assert.ok(sidebar.ok, sidebar.ok ? "" : sidebar.message);
  const values = [];
  const walk = (v) => {
    if (typeof v === "string") values.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(sidebar.config);
  for (const v of values.filter((x) => parseIconValue(x)?.kind === "asset")) assert.ok(fs.existsSync(path.join(pkgDir, v)), `${v} is missing`);
});

test("my-skin installs through the engine as it is, and so does a Finder-made zip of it", { skip: engine ? false : "skin-engine addon not built" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skin-template-"));
  try {
    const registry = Object.fromEntries(Object.entries(refs.APP_REGISTRY).map(([k, v]) => [k, [...v]]));
    const files = templateEntries()
      .filter((e) => e.name.startsWith(`${TEMPLATE_PACKAGE_DIR}/`))
      .map((e) => ({ name: e.name.slice(TEMPLATE_PACKAGE_DIR.length + 1), data: e.data }));
    const plain = path.join(root, "my-skin.skinpkg");
    fs.writeFileSync(plain, writeZip(files));
    const r = await engine.installSkinPackageAsync(plain, path.join(root, "skins"), registry, "2.0.0");
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.skin.id, "my-skin");
    assert.equal(r.hasSidebar, true);
    assert.deepEqual(r.regions, ["greeting", "sidebarFooter"]);

    const finder = path.join(root, "finder.zip");
    const junk = files.flatMap((f) => [{ name: `__MACOSX/._${f.name.split("/").pop()}`, data: Buffer.from([0, 5, 22, 7, 0xff]) }]);
    fs.writeFileSync(finder, writeZip([...files, ...junk, { name: ".DS_Store", data: Buffer.from([0, 0, 0, 1]) }]));
    const again = await engine.installSkinPackageAsync(finder, path.join(root, "skins"), registry, "2.0.0");
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.equal(again.files.length, files.length, "the metadata was skipped, not extracted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the schemas accept every example package and reject what the installer rejects", { skip: Ajv ? false : "ajv is not resolvable" }, () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schemas = Object.fromEntries(SCHEMA_FILES.map((f) => [f, ajv.compile(JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, "schemas", f), "utf8")))]));
  const validate = (file, value) => {
    const fn = schemas[file];
    return { ok: fn(value), errors: fn.errors };
  };
  const packages = [pkgDir, ...["showcase", "aurora-night"].map((n) => path.resolve(import.meta.dirname, "../docs/skin-packages/examples", n))];
  for (const dir of packages) {
    for (const [file, schema] of [["manifest.json", "manifest.schema.json"], ["layout.json", "layout.schema.json"], ["components.json", "components.schema.json"], ["sidebar.json", "sidebar.schema.json"]]) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      const r = validate(schema, JSON.parse(fs.readFileSync(full, "utf8")));
      assert.ok(r.ok, `${path.basename(dir)}/${file}: ${JSON.stringify(r.errors?.slice(0, 3))}`);
    }
  }
  const layouts = path.resolve(import.meta.dirname, "../docs/skin-packages/examples/layouts");
  for (const f of fs.readdirSync(layouts)) {
    const schema = f.endsWith(".components.json") ? "components.schema.json" : "layout.schema.json";
    const r = validate(schema, JSON.parse(fs.readFileSync(path.join(layouts, f), "utf8")));
    assert.ok(r.ok, `layouts/${f}: ${JSON.stringify(r.errors?.slice(0, 3))}`);
  }

  const layoutWith = (node) => ({ version: 1, regions: { greeting: node } });
  for (const [schema, value, why] of [
    ["manifest.schema.json", { id: "Bad Id", name: "x", description: "", author: "", version: "1.0.0", created_at: "2026-09-11" }, "bad id"],
    ["manifest.schema.json", { id: "ok-id", name: "x", description: "", author: "", version: "1.0", created_at: "2026-09-11" }, "not semver"],
    ["manifest.schema.json", { id: "current", name: "x", description: "", author: "", version: "1.0.0", created_at: "2026-09-11" }, "reserved id"],
    ["layout.schema.json", layoutWith({ type: "component", ref: "app:weatherCard" }), "unknown ref"],
    ["layout.schema.json", layoutWith({ type: "component", ref: "primitive:box", props: { onClick: "x" } }), "handler prop"],
    ["layout.schema.json", layoutWith({ type: "component", ref: "primitive:box", props: { shadow: "huge" } }), "value outside a primitive's enum"],
    ["layout.schema.json", layoutWith({ type: "component", ref: "primitive:box", props: { bordrRadius: 4 } }), "misspelled primitive prop"],
    ["layout.schema.json", layoutWith({ type: "component", ref: "primitive:text", visibleWhen: "state.a && state.b" }), "combined condition"],
    ["layout.schema.json", layoutWith({ type: "container", direction: "row", onClick: "x", children: [] }), "unknown node key"],
    ["components.schema.json", { __proto__: null, "bad name": { params: [], template: { type: "component", ref: "primitive:box" } } }, "bad composite name"],
    ["sidebar.schema.json", { menu: { settings: { hidden: true } } }, "hidden menu entry"],
    ["sidebar.schema.json", { nav: { items: { weather: {} } } }, "unknown nav id"],
    ["sidebar.schema.json", { tree: { folderIcon: "icon:not-an-icon" } }, "unknown icon"],
    ["sidebar.schema.json", { brand: { logo: "https://tracker.example/logo.svg" } }, "remote logo"],
    ["sidebar.schema.json", { sections: { projects: { label: { EN: "x" } } } }, "bad locale key"],
  ]) {
    assert.equal(validate(schema, value).ok, false, why);
  }
  // A placeholder is fine where a composite passes a number.
  const comp = { card: { params: ["v"], template: { type: "component", ref: "primitive:progressBar", props: { value: "{{v}}" } } } };
  assert.ok(validate("components.schema.json", comp).ok);
});
