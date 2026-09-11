/**
 * The renderer-side layout validator (src/components/theme/layout/schema.ts), the visibleWhen
 * language and composite substitution -- the zod twin of native/skin-engine/src/layout.rs.
 *
 * The same attack shapes the Rust suite uses (tests/security.rs) are run here, so the "neither
 * layer relies on the other" rule from the prompt set is a test, not a comment. The worked examples
 * under docs/skin-packages/examples must validate here too; the engine test checks them in Rust.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const { parsePackageLayout, checkComponents, componentsSchema, layoutTreeSchema, isForbiddenPropKey, placeholders, MAX_DEPTH, MAX_NODES } = await import(
  "../src/components/theme/layout/schema.ts"
);
const { parseVisibleWhen, evaluateCondition, isVisible } = await import("../src/components/theme/layout/visibleWhen.ts");
const { instantiate, substituteString } = await import("../src/components/theme/layout/composites.ts");
const { ALLOWED_REFS } = await import("../electron/skins/layoutRefs.mjs");

const examples = path.resolve(import.meta.dirname, "../docs/skin-packages/examples");
const read = (p) => fs.readFileSync(path.join(examples, p), "utf8");
const component = (ref, props) => ({ type: "component", ref, ...(props ? { props } : {}) });
const layout = (node) => JSON.stringify({ version: 1, regions: { greeting: node } });
const nested = (depth, leaf) => {
  let n = leaf;
  for (let i = 0; i < depth; i++) n = { type: "container", direction: "column", children: [n] };
  return n;
};

test("every documented example validates", () => {
  const dir = path.join(examples, "layouts");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".components.json"));
  assert.ok(files.length >= 5, "the prompt set asks for 3-5 layout examples");
  for (const f of files) {
    const comps = f.replace(/\.json$/, ".components.json");
    const r = parsePackageLayout(read(`layouts/${f}`), fs.existsSync(path.join(dir, comps)) ? read(`layouts/${comps}`) : null, ALLOWED_REFS);
    assert.ok(r.ok, `${f}: ${r.ok ? "" : r.message}`);
  }
  const aurora = parsePackageLayout(read("aurora-night/layout.json"), read("aurora-night/components.json"), ALLOWED_REFS);
  assert.ok(aurora.ok, aurora.ok ? "" : aurora.message);
  assert.deepEqual(Object.keys(aurora.tree.regions).sort(), ["greeting", "sidebarFooter"]);
});

test("every documented example's primitive and app props satisfy the component schemas", async () => {
  // The layout validator only checks that props are primitives; a misspelled prop or a value outside a
  // primitive's schema would silently render as the default. Every example must render as written.
  const { PRIMITIVE_SCHEMAS } = await import("../src/components/theme/primitives/schemas.ts");
  const APP_SCHEMAS = {
    greeting: { align: ["left", "center", "right"] },
    greetingTitle: { align: ["left", "center", "right"], size: ["sm", "md", "lg", "xl"] },
    greetingHint: { align: ["left", "center", "right"] },
    brandMark: { size: "number" },
    appVersion: { prefix: "string", align: ["left", "center", "right"] },
    today: { format: ["short", "medium", "long", "full"], align: ["left", "center", "right"] },
  };
  const problems = [];
  const check = (node, where) => {
    if (node.type === "container") return node.children.forEach((c, i) => check(c, `${where}/${i}`));
    const [prefix, key] = node.ref.split(":");
    // A prop carrying a placeholder takes its type from the caller; it is not checked here.
    const props = Object.fromEntries(Object.entries(node.props ?? {}).filter(([, v]) => !(typeof v === "string" && v.includes("{{"))));
    if (prefix === "primitive") {
      const r = PRIMITIVE_SCHEMAS[key].safeParse(props);
      if (!r.success) problems.push(`${where} ${node.ref}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const known = Object.keys(PRIMITIVE_SCHEMAS[key].shape);
      for (const k of Object.keys(props)) if (!known.includes(k)) problems.push(`${where} ${node.ref}: unknown prop "${k}"`);
    } else if (prefix === "app") {
      const shape = APP_SCHEMAS[key];
      for (const [k, v] of Object.entries(props)) {
        if (!shape || !(k in shape)) problems.push(`${where} ${node.ref}: unknown prop "${k}"`);
        else if (Array.isArray(shape[k]) ? !shape[k].includes(v) : typeof v !== shape[k]) problems.push(`${where} ${node.ref}: bad value for "${k}"`);
      }
    }
    (node.children ?? []).forEach((c, i) => check(c, `${where}/${i}`));
  };
  const walkPackage = (dir) => {
    const layoutJson = fs.readFileSync(path.join(dir, "layout.json"), "utf8");
    const compsPath = path.join(dir, "components.json");
    const parsed = parsePackageLayout(layoutJson, fs.existsSync(compsPath) ? fs.readFileSync(compsPath, "utf8") : null, ALLOWED_REFS);
    assert.ok(parsed.ok, `${dir}: ${parsed.ok ? "" : parsed.message}`);
    for (const [region, node] of Object.entries(parsed.tree.regions)) check(node, `${path.basename(dir)}:${region}`);
    for (const [name, def] of Object.entries(parsed.components)) check(def.template, `${path.basename(dir)}:custom:${name}`);
  };
  for (const name of fs.readdirSync(examples)) {
    const dir = path.join(examples, name);
    if (fs.existsSync(path.join(dir, "layout.json"))) walkPackage(dir);
  }
  const layoutsDir = path.join(examples, "layouts");
  for (const f of fs.readdirSync(layoutsDir).filter((n) => n.endsWith(".json") && !n.endsWith(".components.json"))) {
    const comps = path.join(layoutsDir, f.replace(/\.json$/, ".components.json"));
    const parsed = parsePackageLayout(read(`layouts/${f}`), fs.existsSync(comps) ? fs.readFileSync(comps, "utf8") : null, ALLOWED_REFS);
    assert.ok(parsed.ok, f);
    for (const [region, node] of Object.entries(parsed.tree.regions)) check(node, `${f}:${region}`);
    for (const [name, def] of Object.entries(parsed.components)) check(def.template, `${f}:custom:${name}`);
  }
  assert.deepEqual(problems, []);
});

test("structure: unknown node keys, unknown types, bad values", () => {
  for (const [node, why] of [
    [{ type: "script", src: "x" }, "unknown type"],
    [{ ...component("primitive:box"), onClick: "alert(1)" }, "handler at node level"],
    [{ type: "container", direction: "diagonal", children: [] }, "unknown direction"],
    [{ type: "container", direction: "row", gridTemplate: "1fr 1fr", children: [] }, "gridTemplate on a row"],
    [{ type: "container", direction: "grid", gridTemplate: "1fr; background: url(x)", children: [] }, "unsafe gridTemplate"],
    [{ type: "container", direction: "row", gap: -1, children: [] }, "negative gap"],
    [{ ...component("primitive:box"), size: { width: "100px\" onload=\"x" } }, "unsafe width"],
    [{ ...component("primitive:box"), size: { onClick: "x" } }, "handler in size"],
    [component("greeting"), "ref without prefix"],
    [component("javascript:alert"), "bad prefix"],
  ]) {
    const r = parsePackageLayout(layout(node), null, ALLOWED_REFS);
    assert.equal(r.ok, false, why);
  }
});

test("props: primitives only, no handlers or sinks", () => {
  assert.ok(parsePackageLayout(layout(component("primitive:text", { content: "hi", fontSize: 12, bold: true, "data-x": "y" })), null, ALLOWED_REFS).ok);
  // As JSON text, the way a package carries them: `{ __proto__: "x" }` as an object literal is just `{}`,
  // while JSON.parse of the same text yields an own "__proto__" key, which is what the validator must see.
  for (const text of ['{"onClick":"x"}', '{"onclick":"x"}', '{"onLoad":true}', '{"eval":"x"}', '{"__proto__":"x"}', '{"dangerouslySetInnerHTML":"x"}', '{"href":"https://x"}', '{"style":"color:red"}', '{"nested":{"a":1}}', '{"list":[1]}', '{"nil":null}']) {
    const r = parsePackageLayout(`{"version":1,"regions":{"greeting":{"type":"component","ref":"primitive:box","props":${text}}}}`, null, ALLOWED_REFS);
    assert.equal(r.ok, false, text);
  }
  assert.ok(isForbiddenPropKey("__proto__"));
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.equal(componentsSchema.safeParse(JSON.parse(`{"${name}":{"params":[],"template":{"type":"component","ref":"primitive:box"}}}`)).success, false, name);
    assert.equal(layoutTreeSchema.safeParse(JSON.parse(`{"regions":{"${name}":{"type":"component","ref":"primitive:box"}}}`)).success, false, name);
  }
  assert.ok(isForbiddenPropKey("onAnything") && isForbiddenPropKey("on") && isForbiddenPropKey("style"));
  assert.ok(!isForbiddenPropKey("content") && !isForbiddenPropKey("fontSize") && !isForbiddenPropKey("data-x"));
  const long = component("primitive:text", { content: "x".repeat(2001) });
  assert.equal(parsePackageLayout(layout(long), null, ALLOWED_REFS).ok, false);
});

test("refs must be registered (app/primitive) or defined (custom)", () => {
  for (const ref of ["app:weatherCard", "primitive:iframe", "custom:nope"]) {
    const r = parsePackageLayout(layout(component(ref)), null, ALLOWED_REFS);
    assert.equal(r.ok, false, ref);
    assert.equal(r.code, "layoutUnknownRef", ref);
  }
  assert.ok(parsePackageLayout(layout(component("app:greeting")), null, ALLOWED_REFS).ok);
});

test("depth and node caps", () => {
  assert.ok(parsePackageLayout(layout(nested(MAX_DEPTH - 1, component("primitive:box"))), null, ALLOWED_REFS).ok);
  const deep = parsePackageLayout(layout(nested(MAX_DEPTH + 5, component("primitive:box"))), null, ALLOWED_REFS);
  assert.equal(deep.code, "layoutTooDeep");
  const flat = { type: "container", direction: "row", children: Array.from({ length: MAX_NODES + 10 }, () => ({ type: "container", direction: "row", children: [] })) };
  assert.equal(parsePackageLayout(layout(flat), null, ALLOWED_REFS).code, "layoutTooManyNodes");
  // Box children nest like containers.
  let boxes = component("primitive:text");
  for (let i = 0; i < MAX_DEPTH + 2; i++) boxes = { ...component("primitive:box"), children: [boxes] };
  assert.equal(parsePackageLayout(layout(boxes), null, ALLOWED_REFS).code, "layoutTooDeep");
});

test("composites: cycles are named, expansion is capped without expanding, placeholders are declared", () => {
  const cycle = JSON.stringify({
    a: { params: [], template: component("custom:b") },
    b: { params: [], template: component("custom:c") },
    c: { params: [], template: component("custom:a") },
  });
  const r1 = parsePackageLayout(layout(component("custom:a")), cycle, ALLOWED_REFS);
  assert.equal(r1.code, "layoutCircularReference");
  assert.match(r1.message, /a -> b -> c -> a/);

  const defs = { l0: { params: [], template: component("primitive:box") } };
  for (let i = 1; i < 10; i++) defs[`l${i}`] = { params: [], template: { type: "container", direction: "row", children: Array.from({ length: 10 }, () => component(`custom:l${i - 1}`)) } };
  const started = performance.now();
  const r2 = parsePackageLayout(layout(component("custom:l9")), JSON.stringify(defs), ALLOWED_REFS);
  assert.equal(r2.code, "layoutExpansionTooLarge");
  assert.ok(performance.now() - started < 500, "10^10 nodes must be refused by counting, not by expanding");

  const undeclared = JSON.stringify({ c: { params: ["title"], template: component("primitive:text", { content: "{{title}} {{secret}}" }) } });
  assert.equal(parsePackageLayout(layout(component("custom:c")), undeclared, ALLOWED_REFS).code, "layoutUndeclaredParam");
  assert.equal(componentsSchema.safeParse({ "bad name": { params: [], template: component("primitive:box") } }).success, false);
  assert.equal(componentsSchema.safeParse({ c: { params: ["1x"], template: component("primitive:box") } }).success, false);
  assert.throws(() => checkComponents({ c: { params: [], template: component("app:nope") } }, ALLOWED_REFS), /not a registered/);
  assert.equal(layoutTreeSchema.safeParse({ regions: {}, extra: 1 }).success, false);
});

test("visibleWhen: the grammar and its evaluation, no eval", () => {
  for (const ok of ["state.theme === 'dark'", 'state.a.b !== "x"', "state.count > 3", "state.flag == true", "state.x != null", "state.flag", "!state.flag", " state.n <= 2.5 "]) {
    assert.ok(parseVisibleWhen(ok), ok);
  }
  for (const bad of ["", "theme === 'dark'", "state.a === 'x' && state.b", "state.a || state.b", "state.fn() === 1", "eval('x')", "state.a === 'it''s'", "state['a'] === 1", "!state.a === 1", "state === 'x'", "state.a === undefined", "window.location", "state.a.b.c.d.e.f.g === 1"]) {
    assert.equal(parseVisibleWhen(bad), null, bad);
  }
  const state = { theme: "dark", count: 5, flag: false, nested: { x: "y" }, toolsReady: true };
  assert.equal(isVisible("state.theme === 'dark'", state), true);
  assert.equal(isVisible("state.theme === 'light'", state), false);
  assert.equal(isVisible("state.count > 3", state), true);
  assert.equal(isVisible("state.count >= 6", state), false);
  assert.equal(isVisible("!state.flag", state), true);
  assert.equal(isVisible("state.toolsReady", state), true);
  assert.equal(isVisible("state.nested.x == 'y'", state), true);
  assert.equal(isVisible("state.missing == null", state), true);
  assert.equal(isVisible("state.constructor", state), false, "own properties only");
  assert.equal(isVisible("state.a && state.b", state), false, "invalid expressions hide the node");
  assert.equal(isVisible(undefined, state), true);
  assert.equal(evaluateCondition(parseVisibleWhen("state.count == '5'"), state), true, "loose equality compares as strings");
});

test("placeholder substitution is text-only and keeps the argument's type for a whole-value placeholder", () => {
  assert.deepEqual(placeholders("{{a}} and {{ b }} and {{c"), ["a", "b"]);
  assert.equal(substituteString("Hello {{name}}!", { name: "Ada" }, ["name"]), "Hello Ada!");
  assert.equal(substituteString("{{name}} {{undeclared}}", { name: "Ada" }, ["name"]), "Ada {{undeclared}}");
  assert.equal(substituteString("{{missing}}", {}, ["missing"]), "");
  assert.equal(substituteString("{{x}}", { x: "1 + 1" }, ["x"]), "1 + 1", "nothing is evaluated");
  const def = {
    params: ["title", "value"],
    template: { type: "container", direction: "column", children: [component("primitive:text", { content: "{{title}}" }), component("primitive:progressBar", { value: "{{value}}", label: "{{value}}%" })] },
  };
  const out = instantiate(component("custom:card", { title: "Solar", value: 80, extra: "ignored" }), def);
  assert.equal(out.children[0].props.content, "Solar");
  assert.equal(out.children[1].props.value, 80, "a whole-value placeholder takes the number");
  assert.equal(out.children[1].props.label, "80%", "inside text it is text");
  assert.notEqual(out, def.template, "the template is copied, never mutated");
});
