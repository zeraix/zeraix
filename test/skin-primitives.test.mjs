/**
 * The skin primitive schemas (src/components/theme/primitives/schemas.ts).
 *
 * Skin packages hand these props straight from layout.json, so the schemas are the whole defence:
 * every color must be a token reference or a plain literal, every image must live in the package's
 * assets/, an icon must come from the curated list, and a shape is an enum -- never a path string.
 * Only schemas.ts is imported: node cannot strip JSX, and the schemas are deliberately React-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const S = await import("../src/components/theme/primitives/schemas.ts");
const { PRIMITIVE_KEYS } = await import("../electron/skins/layoutRefs.mjs");

const ok = (schema, input) => {
  const r = schema.safeParse(input);
  assert.ok(r.success, `expected to accept ${JSON.stringify(input)}: ${r.error?.message ?? ""}`);
  return r.data;
};
const bad = (schema, input) => {
  const r = schema.safeParse(input);
  assert.ok(!r.success, `expected to reject ${JSON.stringify(input)}`);
};

test("every PRIMITIVE_KEY has a schema, and each schema parses {} to a complete default", () => {
  assert.deepEqual(Object.keys(S.PRIMITIVE_SCHEMAS).sort(), [...PRIMITIVE_KEYS].sort());
  for (const key of PRIMITIVE_KEYS) {
    const schema = S.PRIMITIVE_SCHEMAS[key];
    assert.ok(schema, `missing schema for ${key}`);
    ok(schema, {});
    // Non-object input fails validation; the component then falls back to parse({}).
    bad(schema, null);
    bad(schema, "text");
  }
});

test("cssColor: token references, hex, rgb()/hsl() and keywords pass; anything else fails", () => {
  for (const v of [
    "var(--primary)",
    "var(--surface-muted, #fff)",
    "#abc",
    "#abcd",
    "#a1b2c3",
    "#a1b2c3d4",
    "rgb(1, 2, 3)",
    "rgba(1,2,3,0.5)",
    "rgb(255 0 0 / 50%)",
    "hsl(120, 50%, 50%)",
    "hsla(120 50% 50% / 0.2)",
    "transparent",
    "currentColor",
  ]) ok(S.cssColor, v);
  for (const v of [
    "url(https://x.test/a.png)",
    "var(--x); background: url(x)",
    "red",
    "#ggg",
    "rgb(a, b, c)",
    "var(--a, url(x))",
    "<script>",
    "expression(alert(1))",
    "var(--x)\\",
    "var(--" + "x".repeat(70) + ")",
  ]) bad(S.cssColor, v);
});

test("cssBackground: gradients of colors only", () => {
  ok(S.cssBackground, "var(--surface)");
  ok(S.cssBackground, "linear-gradient(135deg, var(--primary) 0%, transparent 100%)");
  ok(S.cssBackground, "linear-gradient(to right, #fff, rgba(0,0,0,0.5))");
  ok(S.cssBackground, "radial-gradient(circle at center, var(--primary) 0%, transparent 70%)");
  bad(S.cssBackground, "linear-gradient(135deg, url(x.png), #fff)");
  bad(S.cssBackground, "linear-gradient(135deg, red, blue)");
  bad(S.cssBackground, "conic-gradient(#fff, #000)");
  bad(S.cssBackground, "linear-gradient(calc(1deg), #fff, #000)");
});

test("box", () => {
  const p = ok(S.boxSchema, { background: "var(--surface)", borderRadius: 8, shadow: "glow", padding: 12 });
  assert.equal(p.shadow, "glow");
  assert.equal(S.boxSchema.parse({}).borderRadius, 12);
  bad(S.boxSchema, { borderRadius: -1 });
  bad(S.boxSchema, { borderRadius: 65 });
  bad(S.boxSchema, { background: "url(x)" });
  bad(S.boxSchema, { shadow: "huge" });
  bad(S.boxSchema, { backdropBlur: 21 });
  bad(S.boxSchema, { opacity: 1.5 });
});

test("text", () => {
  const p = ok(S.textSchema, { content: "Hello {{name}}", fontSize: 18, fontWeight: 600, align: "center", lineClamp: 2 });
  assert.equal(p.content, "Hello {{name}}");
  assert.equal(p.color, "var(--ink)");
  bad(S.textSchema, { fontWeight: 650 });
  bad(S.textSchema, { fontSize: 4 });
  bad(S.textSchema, { lineClamp: 21 });
  bad(S.textSchema, { content: "x".repeat(2001) });
  bad(S.textSchema, { family: "serif" });
});

test("icon: only curated names", () => {
  ok(S.iconSchema, { name: "sun", size: 24, color: "var(--primary)", strokeWidth: 1.5 });
  assert.equal(S.iconSchema.parse({}).name, "sparkles");
  bad(S.iconSchema, { name: "not-an-icon" });
  bad(S.iconSchema, { name: "Sun" });
  bad(S.iconSchema, { strokeWidth: 0.25 });
  bad(S.iconSchema, { strokeWidth: 5 });
  bad(S.iconSchema, { size: 200 });
  assert.ok(S.ICON_NAMES.length >= 70);
  assert.equal(new Set(S.ICON_NAMES).size, S.ICON_NAMES.length, "icon names must be unique");
});

test("image: only assets/ inside the package", () => {
  ok(S.imageSchema, { src: "assets/hero.png", fit: "contain", borderRadius: 8, width: 200, height: 100 });
  ok(S.imageSchema, { src: "assets/deep/dir/pic.WEBP" });
  ok(S.imageSchema, {});
  bad(S.imageSchema, { src: "https://example.com/a.png" });
  bad(S.imageSchema, { src: "http://example.com/a.png" });
  bad(S.imageSchema, { src: "assets/../secrets.png" });
  bad(S.imageSchema, { src: "assets//a.png" });
  bad(S.imageSchema, { src: "/etc/passwd.png" });
  bad(S.imageSchema, { src: "data:image/png;base64,AAAA" });
  bad(S.imageSchema, { src: "assets/a.exe" });
  bad(S.imageSchema, { src: "assets/a.png?x=1" });
  bad(S.imageSchema, { fit: "fill" });
  bad(S.imageSchema, { width: 2001 });
});

test("gradient: 2 to 6 stops of validated colors", () => {
  const stops = (n) => Array.from({ length: n }, (_, i) => ({ color: "var(--primary)", position: (100 * i) / (n - 1) }));
  ok(S.gradientSchema, { type: "radial", stops: stops(2) });
  ok(S.gradientSchema, { type: "linear", angle: 45, stops: stops(6), fill: true });
  assert.equal(S.gradientSchema.parse({}).stops.length, 2);
  bad(S.gradientSchema, { stops: stops(1) });
  bad(S.gradientSchema, { stops: stops(7) });
  bad(S.gradientSchema, { stops: [{ color: "url(x)", position: 0 }, { color: "#fff", position: 100 }] });
  bad(S.gradientSchema, { stops: [{ color: "#fff", position: -5 }, { color: "#000", position: 100 }] });
  bad(S.gradientSchema, { angle: 361 });
  bad(S.gradientSchema, { type: "conic" });
});

test("progress: value is 0-100", () => {
  ok(S.progressBarSchema, { value: 42, color: "var(--success)", thickness: 8 });
  ok(S.progressRingSchema, { value: 100, size: 64, thickness: 6, showValue: true });
  bad(S.progressBarSchema, { value: 150 });
  bad(S.progressRingSchema, { value: 150 });
  bad(S.progressBarSchema, { value: -1 });
  bad(S.progressBarSchema, { thickness: 1 });
  bad(S.progressRingSchema, { size: 8 });
  bad(S.progressRingSchema, { thickness: 25 });
});

test("divider", () => {
  ok(S.dividerSchema, { orientation: "vertical", thickness: 2, dashArray: "4 4", length: 40, fill: false });
  ok(S.dividerSchema, { dashArray: "6" });
  bad(S.dividerSchema, { dashArray: "4,4" });
  bad(S.dividerSchema, { dashArray: "4 4;" });
  bad(S.dividerSchema, { dashArray: "1 ".repeat(20) });
  bad(S.dividerSchema, { thickness: 9 });
  bad(S.dividerSchema, { orientation: "diagonal" });
});

test("badge: preset variants only", () => {
  ok(S.badgeSchema, { text: "New", variant: "success", size: "sm" });
  bad(S.badgeSchema, { variant: "purple" });
  bad(S.badgeSchema, { text: "x".repeat(61) });
  bad(S.badgeSchema, { size: "lg" });
});

test("avatar", () => {
  ok(S.avatarSchema, { src: "assets/me.jpg", size: 32 });
  ok(S.avatarSchema, { initials: "ZX", shape: "square", background: "var(--info)" });
  bad(S.avatarSchema, { src: "https://x.test/me.jpg" });
  bad(S.avatarSchema, { initials: "" });
  bad(S.avatarSchema, { initials: "ABCD" });
  bad(S.avatarSchema, { size: 8 });
});

test("shape: enum kinds only, never a path", () => {
  ok(S.shapeSchema, { kind: "star", fill: "var(--warning)", stroke: "#000", strokeWidth: 2, size: 64, rotate: 45 });
  bad(S.shapeSchema, { kind: "path" });
  bad(S.shapeSchema, { kind: "M0 0 L10 10" });
  bad(S.shapeSchema, { d: "M0 0", kind: "blob" });
  bad(S.shapeSchema, { strokeWidth: 17 });
  bad(S.shapeSchema, { strokeWidth: -1 });
  bad(S.shapeSchema, { size: 4 });
  bad(S.shapeSchema, { rotate: 400 });
});

test("spacer", () => {
  ok(S.spacerSchema, { size: 16 });
  ok(S.spacerSchema, { flex: 1 });
  bad(S.spacerSchema, { size: 513 });
  bad(S.spacerSchema, { flex: 101 });
});

test("parsing strips unknown keys such as event handlers", () => {
  const p = ok(S.boxSchema, { padding: 4, onClick: "alert(1)", onMouseEnter: () => {}, dangerouslySetInnerHTML: { __html: "x" } });
  assert.deepEqual(Object.keys(p).sort(), Object.keys(S.boxSchema.parse({})).sort());
  assert.ok(!("onClick" in p));
  assert.ok(!("dangerouslySetInnerHTML" in p));
  const t = ok(S.textSchema, { content: "hi", onClick: "x" });
  assert.ok(!("onClick" in t));
});
