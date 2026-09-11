# Skin packages (`.skinpkg`)

A skin package is a zip archive that restyles Zeraix and, optionally, rearranges a few regions of
its UI. It contains **no code**: a stylesheet, images, and JSON that describes a layout. Everything
in it is checked by the Rust engine (`native/skin-engine`) before a single file is written to disk.

Install one from **Settings → Appearance → Skin packages → Import package…**. The example in
`examples/aurora-night/` can be packed with:

```sh
npm run pack:skin -- docs/skin-packages/examples/aurora-night   # writes aurora-night.skinpkg
```

## Official template

**Settings → Appearance → Skin packages → Download package template** saves the official starting
point: a ready-to-install `my-skin/` package with every palette token listed, a step-by-step README
with the rules and a table of install errors, and JSON Schemas that give VS Code completion and
inline checks for every file. Its source is `electron/skins/package-template/`. The schemas are
generated from the app's own registries and primitive validators (`npm run gen:skin-schemas`), and
`test/skin-template.test.mjs` fails when they drift or when the template stops installing.

## Files

| File | Required | Purpose |
|---|---|---|
| `manifest.json` | yes | Identity and version (below). Must be at the archive root. |
| `tokens.css` | yes | The stylesheet. Loaded as `skin://current/tokens.css` while the skin is active. |
| `assets/**` | no | Images and fonts the stylesheet and layout may reference. |
| `layout.json` | no | Region layouts (below). |
| `components.json` | no | Composite components the layout may place. |
| `sidebar.json` | no | Brand images, nav order / icons / labels, the project tree, the sidebar's buttons and the account menu (below). |

Allowed file types: `.json .css .png .jpg .jpeg .webp .gif .svg .woff2`. Anything else — a `.js`,
a `.exe`, a file with no extension — rejects the **whole** package. Limits: 10 MB per file, 50 MB
uncompressed in total, 2000 entries. Paths may not contain `..`, start with `/`, or use `\`.
Files that zip tools add on their own (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`)
are skipped: never read, never written.

## manifest.json

```json
{
  "id": "aurora-night",
  "name": "Aurora Night",
  "description": "Deep teal with a green glow.",
  "author": "Zeraix",
  "version": "1.0.0",
  "min_app_version": "2.0.0",
  "preview": "assets/preview.svg",
  "created_at": "2026-09-11T10:00:00Z"
}
```

- `id`: kebab-case, 2–40 characters, unique. It is also the folder the package is installed under.
  `default`, `current`, `none`, `light`, `dark`, `system` and anything starting with `builtin-` are reserved.
- `version`, `min_app_version`, `max_app_version`: [semver](https://semver.org). The app refuses a
  package whose window it falls outside of.
- `preview`: a relative path to a `png / jpg / webp / gif / svg` inside the package, shown in the gallery.
- `created_at`: ISO 8601 (`2026-09-11` or `2026-09-11T10:00:00Z`).
- `name`, `description`, `author` are required (they may be empty strings except `name`).

camelCase spellings (`minAppVersion`, `createdAt`) are accepted too.

## tokens.css

Write ordinary CSS. The app's palette is a set of custom properties on `:root` (see
`src/app/globals.css`); a skin overrides them. While a package is active the document carries
`<html data-skin-package="<id>">`, and the recommended selectors are:

```css
:root[data-skin-package] {            /* light mode */
  --background: #0b1416;
  --surface: #101d20;
  --primary: #37d6b0;
  --primary-foreground: #04110f;
  --ink: #e6f3f0;
  /* … */
}
:root[data-skin-package].dark {       /* dark mode */
  --background: #06100f;
}
```

`[data-skin-package]` gives the rule more weight than the app's own `:root` block and the accent
blocks, so the skin wins without `!important`.

What a stylesheet may **not** do — each of these rejects the package:

- `@import`, `@namespace`, `expression()`, `-moz-binding`, `behavior:`, `javascript:`;
- any `url()` that does not point into `assets/` (`url(assets/bg.png)`, `url(./assets/f.woff2)`
  or `url(skin://current/assets/bg.png)` are the three accepted spellings). No `http(s)://`, no
  `data:`, no `file:`, no `..`.

The same rules apply to every `.css` file in the package. SVG files may not contain `<script>`,
event handler attributes, `<foreignObject>`, or references to remote hosts.

## layout.json

Zeraix wraps a few regions in a layout slot. A package may replace what a region shows with a
declarative tree of containers and components. Regions today:

| Region | Where |
|---|---|
| `greeting` | The home screen's hero and the empty-chat screen (brand mark, title, hint). |
| `sidebarHeader` | Between the sidebar's brand row and its nav. |
| `sidebarFooter` | The strip above the account row at the bottom of the sidebar. |

```json
{
  "version": 1,
  "regions": {
    "greeting": {
      "type": "container", "direction": "column", "align": "center", "gap": 12,
      "children": [
        { "type": "component", "ref": "app:brandMark", "props": { "size": 56 } },
        { "type": "component", "ref": "app:greetingTitle" },
        { "type": "component", "ref": "primitive:badge", "props": { "text": "Night mode", "variant": "primary" },
          "visibleWhen": "state.theme === 'dark'" }
      ]
    }
  }
}
```

### Nodes

**Container** — `{ "type": "container", "direction": "row" | "column" | "grid" | "stack", "gap"?, "align"?, "justify"?, "gridTemplate"?, "children": [...] }`

- `align`: `start | center | end | stretch | baseline`; `justify`: `start | center | end | space-between | space-around | space-evenly`.
- `gridTemplate` (grid only): a plain track list such as `"repeat(2, minmax(0, 1fr))"`.
- `stack` layers every child in the same cell.

**Component** — `{ "type": "component", "ref": "<prefix>:<key>", "props"?, "visibleWhen"?, "size"?, "children"? }`

- `ref` prefixes: `app:` (the app's own pieces), `primitive:` (the primitive library), `custom:` (a
  composite from `components.json`). The full list of `app:` and `primitive:` keys is shown under
  **Settings → Appearance → Skin packages → Layout reference**, and lives in `electron/skins/layoutRefs.mjs`.
- `props`: strings, numbers and booleans only. Keys that name a handler or a sink are refused:
  anything starting with `on`, and `style`, `class`, `href`, `src…`, `eval`, `script`,
  `dangerouslySetInnerHTML`, `__proto__` and the like.
- `size`: `{ "flex"?: number, "width"?: "240px", "height"?: "50%" }` — plain CSS lengths.
- `children`: only `primitive:box` renders them (it is the container primitive); other components ignore them.
- A prop that is a list in the primitive's own schema is written as one string in a layout, e.g.
  gradient stops: `"stops": "var(--primary) 0%, transparent 100%"`.

Containers nest as deep as you like up to the technical cap, and the same `ref` may appear any
number of times.

### visibleWhen

One comparison, nothing else — no `&&`, `||`, calls or indexing:

```
state.theme === 'dark'      state.locale !== "en"      state.count > 3
state.toolsReady            !state.desktop
```

Operators: `=== !== == != > < >= <=`. Literals: `'text'`, numbers, `true`, `false`, `null`.
Available state: `state.theme` (`light`/`dark`), `state.locale`, `state.edition` (`cn`/`intl`),
`state.platform` (`win32`/`darwin`/`linux`/`web`), `state.desktop`, plus what the region provides
(`state.toolsReady`, `state.title` in the greeting).

### Limits (technical, not artistic)

| | Limit |
|---|---|
| Literal nesting depth | 20 |
| Literal nodes, all regions together | 500 |
| Nodes after expanding composites, per region | 2000 |
| Nesting depth after expanding composites | 32 |
| Props per node / string length | 32 / 2000 |
| Regions | 32 |

## components.json

Composite components: a template over named parameters, placed with `custom:<name>` and reused
with different arguments.

```json
{
  "energyCard": {
    "params": ["title", "value"],
    "template": {
      "type": "component", "ref": "primitive:box",
      "props": { "padding": 12, "borderRadius": 14, "background": "var(--surface)" },
      "children": [
        { "type": "component", "ref": "primitive:text", "props": { "content": "{{title}}", "fontWeight": 600 } },
        { "type": "component", "ref": "primitive:progressBar", "props": { "value": "{{value}}" } }
      ]
    }
  },
  "statRow": {
    "params": ["a", "b"],
    "template": {
      "type": "container", "direction": "row", "gap": 8,
      "children": [
        { "type": "component", "ref": "custom:energyCard", "props": { "title": "{{a}}", "value": 72 } },
        { "type": "component", "ref": "custom:energyCard", "props": { "title": "{{b}}", "value": 40 } }
      ]
    }
  }
}
```

- `{{param}}` is replaced by text substitution inside string props, nothing more. A prop that is
  exactly one placeholder takes the argument's own type (`"value": "{{value}}"` with `72` becomes the
  number 72). Every placeholder must be a declared param.
- Composites may use other composites; cycles are refused by name (`a -> b -> a`), and the expanded
  size of every composite and every region is counted — and refused the moment it passes the cap,
  never after a full expansion. Ten layers of ten references each is a few kilobytes of JSON and
  ten billion nodes; it fails in microseconds.
- Names: letters, digits, `-`, `_`, up to 64 characters; at most 200 composites, 32 params each.

## sidebar.json

Everything the sidebar draws can be reordered, relabelled, re-iconed or hidden — as data. Every key
is optional; whatever a package leaves out keeps the built-in look. A complete example is
`examples/showcase/sidebar.json`.

```json
{
  "brand": { "logo": "assets/brand/wordmark.svg", "logoDark": "assets/brand/wordmark-dark.svg",
             "mark": "assets/brand/mark.svg", "height": 22 },
  "nav": {
    "order": ["new-chat", "library", "skills"],
    "items": {
      "new-chat": { "icon": "assets/nav/chat.svg", "activeIcon": "assets/nav/chat-active.svg",
                    "label": { "default": "New session", "zh": "新会话" } },
      "skills": { "icon": "icon:wand-sparkles", "activeIcon": "icon:sparkles" },
      "plugins": { "hidden": true }
    }
  },
  "sections": { "projects": { "label": { "default": "Workspaces", "zh": "工作区" } } },
  "tree": { "folderIcon": "icon:bookmark", "folderOpenIcon": "icon:folder" },
  "controls": { "collapse": { "icon": "icon:grid-3x3", "label": "Hide sidebar" } },
  "menu": { "settings": { "icon": "icon:palette", "label": "Preferences" } }
}
```

| Key | What it changes |
|---|---|
| `brand.logo`, `brand.logoDark` | The wordmark at the top of the sidebar. `height` is 12–40 px; `hidden: true` removes it. |
| `brand.mark`, `brand.markDark` | The square app logo on the home screen, in the title bar and in the sign-in dialog. |
| `nav.order` | The order of the nav items. Items it does not list follow the listed ones, in the built-in order. |
| `nav.items.<id>` | `icon`, `activeIcon`, `iconDark`, `activeIconDark`, `label`, `hidden`. Ids: `new-chat`, `skills`, `automation`, `models`, `plugins`, `library`. |
| `sections.projects` | The project tree's title (`label`), or the whole tree (`hidden`). |
| `tree` | `folderIcon` and `folderOpenIcon` for the rows of the project tree. |
| `controls.<id>` | `icon` and `label` (tooltip and accessible name) of `collapse`, `expand` (the button shown while the sidebar is folded away), `pin` and `userMenu` (the chevron on the account row). |
| `menu.<id>` | `icon` and `label` of the account menu: `settings`, `help`, `language`, `theme`, `wallet`, `logout`, `signIn`. |

**Icons** are either a built-in icon, `"icon:<name>"`, drawn in the current text colour (the Icon
primitive's names, listed in `electron/skins/layoutRefs.mjs`), or an image in the package,
`"assets/nav/chat.svg"` (png, jpg, webp, gif or svg). Dark variants are used in dark mode and fall
back to the light ones; active variants are used for the nav item of the current page. Brand images
must be package images.

**Labels** are a string, or a map from locale to string with an optional `default`:
`{ "default": "Workspaces", "zh": "工作区" }`. The UI language is looked up exactly (`zh-TW`), then by
language (`zh`), then `default`; with none of those, the app's own translated label stays. 1–40
characters of plain text.

**What stays reachable.** Nav items and the project tree can be hidden. Controls and account-menu
entries cannot: Settings is always one click away, so a package can never lock anyone into itself.

The installer checks every id against what the app renders, every icon name against the built-in
set, and every image path against the files actually in the package. A path outside `assets/`, a
missing image, an unknown id, an unknown key, or `hidden` on a control or menu entry rejects the
package.

### CSS hooks

The sidebar's parts carry attributes a `tokens.css` can select:

| Selector | Element |
|---|---|
| `[data-skin-slot="sidebar"]` | The whole sidebar. |
| `[data-sidebar-part="header"]` | The top block: window controls, brand and buttons. |
| `[data-sidebar-part="brand"]` | The wordmark image. |
| `[data-sidebar-part="nav"]` | The nav list. |
| `[data-sidebar-part="nav-item"]` | One nav item; add `[data-nav-id="skills"]` for a specific one, `[data-active]` for the current page. |
| `[data-sidebar-part="section"][data-section-id="projects"]` | The project tree section. |
| `[data-sidebar-part="user"]` | The account row at the bottom. |
| `[data-layout-region="sidebarHeader"]`, `[data-layout-region="sidebarFooter"]` | The two sidebar layout regions. |

## What is checked, and where

How the files reach the UI: `tokens.css` is a `<link>` to `skin://current/tokens.css` and images are
`<img>` / `url()` loads from the same protocol; `layout.json`, `components.json` and a preview's
`tokens.css` are read over IPC (`window.skinAPI.readText`) because Chromium does not allow a
renderer to `fetch()` a custom scheme cross-origin.

All of it in Rust, at install time, before anything is written (`native/skin-engine/src/extract.rs`):
archive structure, path safety, file types, declared and actual sizes, the manifest, every
stylesheet and SVG, `components.json` (names, params, placeholders, cycles, expansion), then
`layout.json` against the composites and the app's component registry. A package that fails any
check leaves nothing behind. The renderer validates the same JSON again when it loads it
(`src/components/theme/layout/schema.ts`), and the `skin://` protocol refuses any path that is not a
plain file inside the active package's folder.

## Examples

- `examples/aurora-night/` — a complete package: manifest, tokens, preview, layout and composites.
- `examples/layouts/` — one `layout.json` each for deep nesting, grid layout, component reuse,
  conditional visibility, and composites (with its `components.json`).
