/**
 * sidebar.json in the renderer (src/components/theme/skinpkg/sidebarSchema.ts): the zod twin of
 * native/skin-engine/src/sidebar.rs, the pure helpers the sidebar draws with, and the parity checks
 * that keep the registry (electron/skins/layoutRefs.mjs) honest about what the sidebar renders --
 * an id the installer accepts but no component reads would be a silent no-op for skin authors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("./helpers/srcResolve.mjs", import.meta.url);
const S = await import("../src/components/theme/skinpkg/sidebarSchema.ts");
const refs = await import("../electron/skins/layoutRefs.mjs");
const primitives = await import("../src/components/theme/primitives/schemas.ts");

const repo = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
const parse = (value) => S.sidebarConfigSchema.safeParse(value);

test("registry: nav ids match AgentSidebar's NAV_ITEMS, in order", () => {
  const src = read("src/components/layout/agent/AgentSidebar.tsx");
  const start = src.indexOf("const NAV_ITEMS");
  const block = src.slice(start, src.indexOf("\n]", start));
  const ids = [...block.matchAll(/\bid: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...refs.NAV_ITEM_IDS]);
});

test("registry: every control, menu entry and section is rendered, and nothing unregistered is", () => {
  const src = read("src/components/layout/agent/AgentSidebar.tsx") + read("src/components/layout/agent/AgentShell.tsx");
  const used = new Set([
    ...[...src.matchAll(/group="(sections|controls|menu)" id="([A-Za-z-]+)"/g)].map((m) => `${m[1]}.${m[2]}`),
    ...[...src.matchAll(/skinLabel\("(sections|controls|menu)", "([A-Za-z-]+)"/g)].map((m) => `${m[1]}.${m[2]}`),
    ...[...src.matchAll(/useSkinSectionHidden\("([A-Za-z-]+)"\)/g)].map((m) => `sections.${m[1]}`),
  ]);
  const lists = { sections: refs.SIDEBAR_SECTION_IDS, controls: refs.SIDEBAR_CONTROL_IDS, menu: refs.SIDEBAR_MENU_IDS };
  for (const key of used) {
    const [group, id] = key.split(".");
    assert.ok(lists[group].includes(id), `${key} is rendered but not in the registry`);
  }
  for (const [group, ids] of Object.entries(lists)) {
    for (const id of ids) assert.ok(used.has(`${group}.${id}`), `${group}.${id} is registered but never rendered`);
  }
});

test("registry: one icon list for the engine, the Icon primitive and the icon map", () => {
  assert.equal(primitives.ICON_NAMES, refs.ICON_NAMES, "the primitives re-export the shared list");
  assert.equal(refs.APP_REGISTRY.icons, refs.ICON_NAMES);
  const map = read("src/components/theme/primitives/icons.ts");
  const body = map.slice(map.indexOf("export const ICONS"));
  const keys = [...body.matchAll(/^\s+"?([a-z0-9-]+)"?: [A-Z][A-Za-z0-9]*,$/gm)].map((m) => m[1]);
  assert.deepEqual([...keys].sort(), [...refs.ICON_NAMES].sort());
});

const full = {
  version: 1,
  brand: { logo: "assets/brand/logo.svg", logoDark: "assets/brand/logo-dark.svg", mark: "assets/brand/mark.png", height: 20, hidden: false },
  nav: {
    order: ["library", "new-chat"],
    items: {
      "new-chat": { icon: "assets/nav/chat.svg", activeIcon: "icon:sparkles", iconDark: "icon:moon", activeIconDark: "assets/nav/on.webp", label: { default: "Chat", zh: "对话", "zh-TW": "對話" } },
      plugins: { hidden: true },
    },
  },
  sections: { projects: { label: "Workspaces", hidden: false } },
  tree: { folderIcon: "icon:folder", folderOpenIcon: "assets/tree/open.gif" },
  controls: { collapse: { icon: "icon:x", label: "Hide" }, userMenu: { icon: "icon:settings" } },
  menu: { settings: { icon: "icon:palette", label: { default: "Preferences" } }, signIn: { icon: "assets/menu/key.jpg" } },
};

test("schema: a full config parses; every key is optional", () => {
  const r = parse(full);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.ok(parse({}).success);
});

test("schema: what the engine refuses, the renderer refuses too", () => {
  for (const [value, why] of [
    [{ script: "x" }, "unknown top-level key"],
    [{ nav: { items: { "new-chat": { onClick: "alert(1)" } } } }, "handler on an item"],
    [{ brand: { style: "x" } }, "unknown brand key"],
    [{ nav: { items: { weather: {} } } }, "unknown nav id"],
    [{ nav: { order: ["weather"] } }, "unknown id in order"],
    [{ nav: { order: ["skills", "skills"] } }, "duplicate in order"],
    [{ sections: { conversations: {} } }, "unknown section"],
    [{ controls: { close: {} } }, "unknown control"],
    [{ menu: { settings: { hidden: true } } }, "hidden menu entry"],
    [{ controls: { expand: { hidden: false } } }, "hidden control"],
    [{ sections: { projects: { activeIcon: "icon:zap" } } }, "active icon on a section"],
    [{ brand: { logo: "icon:sparkles" } }, "icon name as a logo"],
    [{ brand: { height: 41 } }, "logo too tall"],
    [{ brand: { height: 11 } }, "logo too short"],
    [{ tree: { folderIcon: "icon:not-an-icon" } }, "unknown icon"],
    [{ sections: { projects: { label: "" } } }, "empty label"],
    [{ sections: { projects: { label: "x".repeat(41) } } }, "long label"],
    [{ sections: { projects: { label: "line\nbreak" } } }, "control character"],
    [{ sections: { projects: { label: {} } } }, "empty localized label"],
    [{ sections: { projects: { label: { EN: "x" } } } }, "bad locale key"],
    [{ sections: { projects: { label: { en: 5 } } } }, "non-text localized value"],
  ]) {
    assert.equal(parse(value).success, false, why);
  }
  for (const icon of [
    "assets/../manifest.json",
    "assets/a..b.svg",
    "../assets/a.svg",
    "/assets/a.svg",
    "assets\\a.svg",
    "https://tracker.example/p.svg",
    "data:image/svg+xml,<svg/>",
    "assets/a.exe",
    "assets/.svg",
    "assets/a b.svg",
    "tokens.css",
  ]) {
    assert.equal(parse({ nav: { items: { skills: { icon } } } }).success, false, icon);
  }
  // A __proto__ key never survives a JS object literal, so it goes in as JSON text -- the way a package carries it.
  for (const text of ['{"menu":{"__proto__":{}}}', '{"sections":{"projects":{"label":{"__proto__":"x"}}}}', '{"nav":{"items":{"__proto__":{"hidden":true}}}}']) {
    assert.equal(S.parseSidebarConfig(text).ok, false, text);
  }
  assert.ok(parse({ sections: { projects: { label: "字".repeat(40) } } }).success, "40 characters, not 40 bytes");
  assert.equal(S.parseSidebarConfig("{").ok, false);
});

test("pickIcon: active and dark variants fall back in order, and garbage is no icon", () => {
  const item = { icon: "icon:folder", iconDark: "icon:moon", activeIcon: "assets/on.svg", activeIconDark: "icon:star" };
  assert.deepEqual(S.pickIcon(item), { kind: "icon", name: "folder" });
  assert.deepEqual(S.pickIcon(item, { dark: true }), { kind: "icon", name: "moon" });
  assert.deepEqual(S.pickIcon(item, { active: true }), { kind: "asset", path: "assets/on.svg" });
  assert.deepEqual(S.pickIcon(item, { active: true, dark: true }), { kind: "icon", name: "star" });
  assert.deepEqual(S.pickIcon({ icon: "icon:folder", activeIcon: "assets/on.svg" }, { active: true, dark: true }), { kind: "asset", path: "assets/on.svg" });
  assert.deepEqual(S.pickIcon({ icon: "icon:folder" }, { active: true, dark: true }), { kind: "icon", name: "folder" });
  assert.equal(S.pickIcon(undefined), null);
  assert.equal(S.pickIcon({ label: "x" }), null);
  assert.equal(S.pickIcon({ icon: "https://x.example/a.svg" }), null, "an unparsable value is no icon, never a URL");
});

test("pickLabel: exact locale, then language, then default, else the app's own", () => {
  const l = { default: "Chat", zh: "对话", "zh-TW": "對話" };
  assert.equal(S.pickLabel(l, "zh-TW"), "對話");
  assert.equal(S.pickLabel(l, "zh"), "对话");
  assert.equal(S.pickLabel({ default: "Chat", zh: "对话" }, "zh-TW"), "对话");
  assert.equal(S.pickLabel(l, "de"), "Chat");
  assert.equal(S.pickLabel({ zh: "对话" }, "de"), null);
  assert.equal(S.pickLabel("  Workspaces ", "ja"), "Workspaces");
  assert.equal(S.pickLabel(undefined, "en"), null);
  assert.equal(S.pickLabel({ default: "x" }, "constructor"), "x", "no prototype lookups");
});

test("arrangeNav: listed ids first in their order, the rest in the built-in order, hidden ones gone", () => {
  const items = refs.NAV_ITEM_IDS.map((id) => ({ id }));
  const ids = (config) => S.arrangeNav(items, config).map((x) => x.id);
  assert.deepEqual(ids(null), [...refs.NAV_ITEM_IDS]);
  assert.deepEqual(ids({ nav: { order: ["library", "models"] } }), ["library", "models", "new-chat", "skills", "automation", "plugins"]);
  assert.deepEqual(ids({ nav: { order: ["library"], items: { skills: { hidden: true }, library: { hidden: false } } } }), ["library", "new-chat", "automation", "models", "plugins"]);
  assert.equal(S.arrangeNav(items, { nav: {} })[0], items[0], "the app's own objects come back, not copies");
});

test("brandOf, treeIcon, skinAssetUrl", () => {
  const c = { brand: { logo: "assets/l.svg", logoDark: "assets/ld.svg", mark: "assets/m.svg", height: 22 }, tree: { folderIcon: "icon:folder" } };
  assert.deepEqual(S.brandOf(c, false), { logo: "assets/l.svg", mark: "assets/m.svg", height: 22, hidden: false });
  assert.deepEqual(S.brandOf(c, true), { logo: "assets/ld.svg", mark: "assets/m.svg", height: 22, hidden: false });
  assert.deepEqual(S.brandOf(null, true), { logo: null, mark: null, height: null, hidden: false });
  assert.deepEqual(S.treeIcon(c, false), { kind: "icon", name: "folder" });
  assert.deepEqual(S.treeIcon(c, true), { kind: "icon", name: "folder" }, "open falls back to closed");
  assert.equal(S.treeIcon(null, true), null);
  assert.equal(S.skinAssetUrl("showcase", "assets/nav/chat.svg", 3), "skin://showcase/assets/nav/chat.svg?g=3");
});

test("the showcase package's sidebar.json parses and every image it names ships in the package", () => {
  const dir = path.join(repo, "docs/skin-packages/examples/showcase");
  const r = S.parseSidebarConfig(fs.readFileSync(path.join(dir, "sidebar.json"), "utf8"));
  assert.ok(r.ok, r.ok ? "" : r.message);
  const values = [];
  const walk = (v) => {
    if (typeof v === "string") values.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(r.config);
  const assets = values.filter((v) => v.startsWith("assets/"));
  assert.ok(assets.length >= 8, `only ${assets.length} package images`);
  for (const a of assets) assert.ok(fs.existsSync(path.join(dir, a)), `${a} is missing`);
  assert.equal(S.arrangeNav(refs.NAV_ITEM_IDS.map((id) => ({ id })), r.config)[1].id, "library");
});
