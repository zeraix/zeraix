# Zeraix skin package template

This is the official starting point for a Zeraix skin package (`.skinpkg`). The `my-skin` folder is
a complete package that installs as it is. Change it until it is yours.

A skin package contains no code. It is a stylesheet, images, and a few JSON files that describe
layouts. Zeraix checks every file before it installs anything.

## Quick start

1. **Name it.** In `my-skin/manifest.json`, set `id`, `name`, `description` and `author`. The id is
   lowercase letters, digits and hyphens, 2–40 characters. Make it unique: installing a package with
   an id that is already installed replaces that package.
2. **Colour it.** `my-skin/tokens.css` lists every colour the app uses, for light and dark mode.
   Start with the accent at the top of each block.
3. **Arrange it (optional).** `layout.json` rebuilds the home greeting and two sidebar regions from
   the app's components and building blocks. `components.json` defines reusable pieces for it.
   `sidebar.json` changes the sidebar's logo, icons, labels and order. Delete any of the three you
   do not need.
4. **Add images** to `my-skin/assets/`.
5. **Pack it.** Open the `my-skin` folder, select everything inside it, and compress those files
   into a zip. `manifest.json` must be at the top level of the zip: compressing the `my-skin` folder
   itself puts everything one level too deep. Rename the zip to `my-skin.skinpkg`, or keep `.zip`;
   both install.
6. **Install it.** In Zeraix, open **Settings → Appearance → Skin packages → Import package**. To
   try a change, pack again and import again.

Open this whole folder in VS Code to get completion and inline checks in every JSON file. The
`schemas` folder and `.vscode/settings.json` provide them; other editors can use the same schema
files.

## What is in my-skin

| File | Required | Purpose |
|---|---|---|
| `manifest.json` | yes | Id, name, version and the app versions the skin works with. |
| `tokens.css` | yes | Colours, and any other CSS the skin needs. |
| `layout.json` | no | Region layouts: `greeting`, `sidebarHeader`, `sidebarFooter`. |
| `components.json` | no | Composite components the layout places as `custom:<name>`. |
| `sidebar.json` | no | Sidebar logo, nav order, icons and labels, buttons and account menu. |
| `assets/` | no | Images (png, jpg, webp, gif, svg) and fonts (woff2). |

## Rules the installer enforces

- **Files.** Only `.json .css .png .jpg .jpeg .webp .gif .svg .woff2`. Any other file rejects the
  whole package, so do not pack this README. Files that zip tools add on their own (`__MACOSX`,
  `.DS_Store`, `Thumbs.db`) are ignored.
- **Size.** At most 10 MB per file, 50 MB in total, 2000 files.
- **Stylesheets.** `url()` may only point into `assets/`. No `@import`, `expression()`, `behavior`
  or `-moz-binding`.
- **SVG images.** No scripts, no `on…=` attributes, no `<foreignObject>`, no links to other sites.
  Export plain SVG from your design tool.
- **Layouts.** Props are text, numbers and `true`/`false` only. Prop names that look like event
  handlers or style overrides (`onClick`, `style`, `href`) are refused. Nesting is limited to 20
  levels and 500 nodes. Composite components may not reference each other in a loop, and may
  expand to at most 2000 nodes.
- **Sidebar.** Every id, icon name and image path must exist. The sidebar's buttons and the account
  menu can be restyled but never hidden, so Settings stays reachable.

## If the install fails

The message names the problem, and its detail names the file or value.

| Message | What to do |
|---|---|
| manifest.json is missing from the package root. | You compressed the folder. Compress the files inside it. |
| tokens.css is missing from the package root. | Same as above, or put `tokens.css` back. It may be empty, but it must exist. |
| The package contains a file type that is not allowed. | Remove the file the detail names. |
| manifest.json is invalid. | The detail names the field: the id format, a version such as `1.0.0`, or a date such as `2026-09-11`. |
| A stylesheet in the package references something outside it. | Point every `url()` into `assets/` and remove `@import`. |
| An SVG in the package contains script or a remote reference. | Re-export the SVG as a plain image. |
| The layout references a component that does not exist. | Fix the misspelled `ref`; your editor underlines it. |
| The layout contains a prop that is not allowed. | Rename the prop, or use text, numbers or `true`/`false`. |
| The composite components reference each other in a cycle. | The detail shows the loop. Break it. |
| sidebar.json points at an image that is not in the package. | Check the path, including upper and lower case. |
| sidebar.json is invalid. | The detail names the key. |
| This package needs a different app version. | Change `min_app_version` or `max_app_version`. |
| The package is too large. | Shrink the images; WebP is usually smallest. |

## Reference

### Layout nodes

A **container** lays out its `children`: `"direction"` is `row`, `column`, `grid` or `stack`
(children layered in one place), with optional `gap`, `align`, `justify` and, for grids,
`gridTemplate`.

A **component** places one thing by `ref`:

- `app:greeting`, `app:greetingTitle`, `app:greetingHint`, `app:brandMark`, `app:appVersion`,
  `app:today`: the app's own pieces.
- `primitive:box` (the only one that renders `children`), `text`, `icon`, `image`, `gradient`,
  `progressBar`, `progressRing`, `divider`, `badge`, `avatar`, `shape`, `spacer`: building blocks.
  Every prop and its allowed values are in `schemas/layout.schema.json`, and your editor completes
  them.
- `custom:<name>`: a composite from `components.json`. Inside its template, `{{param}}` is replaced
  by what the placement passes.

`size` sets `flex`, `width` or `height`. Colours may be written as `var(--primary)` and the other
tokens, so building blocks follow your palette.

### visibleWhen

Shows a component only when one comparison holds:

```
state.theme === 'dark'     state.locale !== "en"     state.desktop     !state.toolsReady
```

Available: `state.theme` (`light` / `dark`), `state.locale`, `state.edition` (`cn` / `intl`),
`state.platform` (`win32` / `darwin` / `linux` / `web`), `state.desktop`, and, in the greeting,
`state.toolsReady`.

### sidebar.json

| Key | Changes |
|---|---|
| `brand.logo`, `logoDark`, `height`, `hidden` | The wordmark at the top of the sidebar. |
| `brand.mark`, `markDark` | The square app logo on the home screen, the title bar and the sign-in dialog. |
| `nav.order` | The order of the nav items. |
| `nav.items.<id>` | `icon`, `activeIcon`, `iconDark`, `activeIconDark`, `label`, `hidden`. |
| `sections.projects` | The project tree's `label`, or `hidden`. |
| `tree` | `folderIcon`, `folderOpenIcon`. |
| `controls.<id>` | `icon` and `label` of `collapse`, `expand`, `pin`, `userMenu`. |
| `menu.<id>` | `icon` and `label` of `settings`, `help`, `language`, `theme`, `wallet`, `logout`, `signIn`. |

An icon is `"icon:<name>"`, a built-in icon drawn in the current text colour, or an image path such
as `"assets/nav/chat.svg"`. A label is text, or text per language:
`{ "default": "Workspaces", "zh": "工作区" }`. Languages without an entry, and without `default`,
keep the app's own translation.
