/**
 * JSON Schemas for the official skin package template (electron/skins/package-template/schemas/).
 *
 * Editor support only: the Rust installer and the renderer's zod schemas decide whether a package is
 * valid. These give an author completion and inline warnings while writing, so they are generated
 * from what those validators read -- the ids, refs and icon names in electron/skins/layoutRefs.mjs,
 * and every primitive's props from its zod schema. The patterns and limits that live only in Rust
 * (manifest id and semver, layout caps) are restated here with the numbers native/skin-engine uses.
 *
 * Run `npm run gen:skin-schemas` after changing any of them; test/skin-template.test.mjs fails while
 * the committed files are stale.
 */

export const SCHEMA_FILES = Object.freeze(["manifest.schema.json", "layout.schema.json", "components.schema.json", "sidebar.schema.json"]);

const DRAFT = "http://json-schema.org/draft-07/schema#";

const anyCase = (s) => [...s].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("");
const IMAGE_EXT = `(?:${["png", "jpg", "jpeg", "webp", "gif", "svg"].map(anyCase).join("|")})`;

const ASSET_IMAGE = {
  type: "string",
  maxLength: 200,
  pattern: `^assets/[A-Za-z0-9_\\-./]+\\.${IMAGE_EXT}$`,
  not: { pattern: "\\.\\.|//" },
  description: "An image in the package: assets/<path>.png, .jpg, .jpeg, .webp, .gif or .svg.",
};

const PLACEHOLDER = {
  type: "string",
  pattern: "^\\{\\{\\s*[A-Za-z_][A-Za-z0-9_]{0,31}\\s*\\}\\}$",
  description: "In components.json, {{param}} is replaced by the argument a placement passes.",
};

const IDENT = "[A-Za-z_][A-Za-z0-9_]{0,31}";
const STATE_PATH = `state(?:\\.${IDENT}){1,6}`;
const LITERAL = `(?:'[^'"\\\\]*'|"[^'"\\\\]*"|[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?|true|false|null)`;
const VISIBLE_WHEN = `^\\s*(?:!\\s*${STATE_PATH}|${STATE_PATH}(?:\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*${LITERAL})?)\\s*$`;

const PLAIN_CSS = (max, description) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  pattern: "^[A-Za-z0-9 %.,\\-/()+*]+$",
  not: { pattern: `${anyCase("url")}\\(|${anyCase("expression")}\\(` },
  description,
});

const PROTO_NAMES = ["__proto__", "constructor", "prototype"];
const NAME = { pattern: "^[A-Za-z0-9_-]{1,64}$", not: { enum: PROTO_NAMES } };

const FORBIDDEN_PROP_KEYS = [
  "eval", "script", "function", "callback", "handler", "__proto__", "constructor", "prototype",
  "dangerouslySetInnerHTML", "innerHTML", "outerHTML", "href", "action", "formAction", "srcdoc",
  "style", "class", "className", "ref", "key", "children", "is", "as", "html",
];

const TEXT_ALIGN = { enum: ["left", "center", "right"], description: "Text alignment." };

/** Props of the app's own components (src/components/theme/layout/registry.tsx). */
export const APP_COMPONENT_PROPS = Object.freeze({
  greeting: { align: TEXT_ALIGN },
  greetingTitle: { align: TEXT_ALIGN, size: { enum: ["sm", "md", "lg", "xl"], description: "Title size." } },
  greetingHint: { align: TEXT_ALIGN },
  brandMark: { size: { type: "number", minimum: 16, maximum: 160, description: "Width and height in px." } },
  appVersion: { prefix: { type: "string", maxLength: 20, description: "Text before the version number, e.g. \"v\"." }, align: TEXT_ALIGN },
  today: { format: { enum: ["short", "medium", "long", "full"], description: "Date style, in the UI language." }, align: TEXT_ALIGN },
});

const APP_COMPONENT_DESCRIPTIONS = Object.freeze({
  greeting: "The built-in greeting block: brand mark, title and hint.",
  greetingTitle: "The greeting title (\"Good morning, …\" on the home screen).",
  greetingHint: "The line under the greeting title.",
  brandMark: "The app's brand mark (or the skin's brand.mark from sidebar.json).",
  appVersion: "The running app version.",
  today: "Today's date in the UI language.",
});

const REGION_DESCRIPTIONS = Object.freeze({
  greeting: "The home screen's hero and the empty-chat screen.",
  sidebarHeader: "Between the sidebar's brand row and its nav.",
  sidebarFooter: "The strip above the account row at the bottom of the sidebar.",
});

/**
 * Props a primitive's own schema models as a list, but a layout writes as one string (layout props
 * are text, numbers and true/false only; the primitive parses the string).
 */
const LIST_PROPS_AS_STRING = Object.freeze({
  stops: { type: "string", maxLength: 400, description: "Colour stops as one string, 2 to 6 of them: \"var(--primary) 0%, transparent 100%\"." },
});

/** A primitive's props from its zod schema, with a whole-value {{param}} accepted for every prop. */
function primitiveProps(z, schema, key) {
  let json;
  try {
    json = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" });
  } catch {
    return { type: "object", description: `Props of primitive:${key}.` };
  }
  const properties = {};
  for (const [name, value] of Object.entries(json.properties ?? {})) {
    const structured = value?.type === "array" || value?.type === "object";
    const written = LIST_PROPS_AS_STRING[name] ?? (structured ? { type: "string", description: "Written as one string in a layout." } : value);
    properties[name] = { anyOf: [written, PLACEHOLDER] };
  }
  return { type: "object", description: `Props of primitive:${key}.`, properties, additionalProperties: false };
}

function appProps(key) {
  const properties = {};
  for (const [name, value] of Object.entries(APP_COMPONENT_PROPS[key] ?? {})) properties[name] = { anyOf: [value, PLACEHOLDER] };
  return { type: "object", description: `Props of app:${key}.`, properties, additionalProperties: false };
}

function nodeDefinitions({ z, primitiveSchemas, refs }) {
  const perRef = [
    ...refs.PRIMITIVE_KEYS.map((k) => [`primitive:${k}`, primitiveProps(z, primitiveSchemas[k], k)]),
    ...refs.APP_COMPONENT_KEYS.map((k) => [`app:${k}`, appProps(k)]),
  ];
  return {
    node: {
      description: "A layout node: a container of other nodes, or a component.",
      oneOf: [{ $ref: "#/definitions/container" }, { $ref: "#/definitions/component" }],
    },
    container: {
      type: "object",
      description: "Lays its children out in a row, a column, a grid, or stacked on top of each other.",
      required: ["type", "direction"],
      additionalProperties: false,
      properties: {
        type: { const: "container" },
        direction: { enum: ["row", "column", "grid", "stack"], description: "stack puts every child in the same cell, layered." },
        gap: { type: "number", minimum: 0, maximum: 200, description: "Space between children, px." },
        align: { enum: ["start", "center", "end", "stretch", "baseline"], description: "Cross-axis alignment." },
        justify: { enum: ["start", "center", "end", "space-between", "space-around", "space-evenly"], description: "Main-axis distribution." },
        gridTemplate: PLAIN_CSS(200, "grid-template-columns, e.g. \"repeat(3, minmax(0, 1fr))\". Only with direction: grid."),
        children: { type: "array", items: { $ref: "#/definitions/node" } },
      },
    },
    component: {
      type: "object",
      description: "Places a component: app:<key> (the app's own), primitive:<key> (building blocks) or custom:<name> (from components.json).",
      required: ["type", "ref"],
      additionalProperties: false,
      properties: {
        type: { const: "component" },
        ref: {
          anyOf: [
            ...refs.APP_COMPONENT_KEYS.map((k) => ({ const: `app:${k}`, description: APP_COMPONENT_DESCRIPTIONS[k] })),
            ...refs.PRIMITIVE_KEYS.map((k) => ({ const: `primitive:${k}` })),
            { type: "string", pattern: "^custom:[A-Za-z0-9_-]{1,64}$", description: "A composite defined in components.json." },
          ],
        },
        props: {
          type: "object",
          description: "Text, numbers and true/false only. Keys that name a handler or a sink (on…, style, href, …) are refused.",
          maxProperties: 32,
          propertyNames: { pattern: "^[A-Za-z0-9_-]{1,64}$", not: { anyOf: [{ pattern: "^[oO][nN](?:$|[A-Za-z])" }, { enum: FORBIDDEN_PROP_KEYS }] } },
          additionalProperties: { type: ["string", "number", "boolean"], maxLength: 2000 },
        },
        visibleWhen: {
          type: "string",
          maxLength: 120,
          pattern: VISIBLE_WHEN,
          description: "One comparison: state.theme === 'dark', state.count > 3, state.desktop, !state.toolsReady. No &&, ||, or calls.",
        },
        size: {
          type: "object",
          additionalProperties: false,
          properties: {
            flex: { type: "number", minimum: 0, maximum: 100, description: "flex-grow within a row or column." },
            width: PLAIN_CSS(64, "A CSS length, e.g. \"240px\" or \"50%\"."),
            height: PLAIN_CSS(64, "A CSS length, e.g. \"120px\"."),
          },
        },
        children: { type: "array", description: "Rendered by primitive:box only.", items: { $ref: "#/definitions/node" } },
      },
      allOf: perRef.map(([ref, props]) => ({
        if: { properties: { ref: { const: ref } }, required: ["ref"] },
        then: { properties: { props } },
      })),
    },
  };
}

function manifestSchema() {
  const semver =
    "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$";
  const version = (description) => ({ type: "string", pattern: semver, description });
  return {
    $schema: DRAFT,
    title: "Zeraix skin package manifest",
    type: "object",
    required: ["id", "name", "description", "author", "version", "created_at"],
    properties: {
      id: {
        type: "string",
        minLength: 2,
        maxLength: 40,
        pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
        not: { anyOf: [{ enum: ["default", "current", "none", "light", "dark", "system"] }, { pattern: "^builtin-" }] },
        description: "Unique id: lowercase letters, digits and single hyphens. Installing a package with the same id replaces it.",
      },
      name: { type: "string", minLength: 1, maxLength: 60, pattern: "\\S", description: "Shown in the skin gallery." },
      description: { type: "string", maxLength: 400 },
      author: { type: "string", maxLength: 80 },
      version: version("Semantic version, e.g. 1.0.0."),
      min_app_version: version("The oldest Zeraix version this skin works with."),
      max_app_version: version("The newest Zeraix version this skin works with."),
      preview: {
        type: "string",
        maxLength: 255,
        pattern: `^[A-Za-z0-9_\\-./]+\\.${IMAGE_EXT}$`,
        not: { pattern: "(^|/)\\.\\.?(/|$)|^/|//" },
        description: "A picture of the skin for the gallery, e.g. assets/preview.png.",
      },
      created_at: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$",
        description: "ISO 8601 date, e.g. 2026-09-11 or 2026-09-11T10:00:00Z.",
      },
    },
  };
}

function layoutSchema(deps) {
  return {
    $schema: DRAFT,
    title: "Zeraix skin layout (layout.json)",
    type: "object",
    required: ["regions"],
    additionalProperties: false,
    properties: {
      version: { type: "integer", minimum: 1 },
      regions: {
        type: "object",
        description: "One layout tree per region. A region the package does not define keeps the app's own look.",
        maxProperties: 32,
        propertyNames: NAME,
        properties: Object.fromEntries(deps.refs.LAYOUT_REGIONS.map((r) => [r, { $ref: "#/definitions/node", description: REGION_DESCRIPTIONS[r] }])),
        additionalProperties: { $ref: "#/definitions/node" },
      },
    },
    definitions: nodeDefinitions(deps),
  };
}

function componentsSchema(deps) {
  return {
    $schema: DRAFT,
    title: "Zeraix skin composite components (components.json)",
    description: "Named components built from other nodes, placed in layout.json as custom:<name>.",
    type: "object",
    maxProperties: 200,
    propertyNames: NAME,
    additionalProperties: {
      type: "object",
      required: ["template"],
      additionalProperties: false,
      properties: {
        params: {
          type: "array",
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,31}$" },
          description: "The names a placement may pass; use them in the template as {{name}}.",
        },
        template: { $ref: "#/definitions/node" },
      },
    },
    definitions: nodeDefinitions(deps),
  };
}

function sidebarSchema({ refs }) {
  // Shared definitions, referenced from every item: the icon list alone is 97 names, and inlining it
  // into each icon field of each item made the file a quarter of a megabyte.
  const ICON = { $ref: "#/definitions/icon" };
  const LABEL = { $ref: "#/definitions/label" };
  const item = (group) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      icon: ICON,
      iconDark: { ...ICON, description: "Used in dark mode; falls back to icon." },
      ...(group === "nav"
        ? {
            activeIcon: { ...ICON, description: "Used while this item's page is open; falls back to icon." },
            activeIconDark: { ...ICON, description: "Active, in dark mode; falls back to activeIcon, then iconDark, then icon." },
          }
        : {}),
      label: LABEL,
      ...(group === "nav" || group === "sections" ? { hidden: { type: "boolean" } } : {}),
    },
  });
  const group = (ids, definition, description) => ({
    type: "object",
    description,
    additionalProperties: false,
    properties: Object.fromEntries(ids.map((id) => [id, { $ref: `#/definitions/${definition}` }])),
  });
  const icon = { ...ICON };
  return {
    $schema: DRAFT,
    title: "Zeraix skin sidebar (sidebar.json)",
    type: "object",
    additionalProperties: false,
    definitions: {
      icon: {
        description: "icon:<name> (a built-in icon in the current text colour) or an image in the package under assets/.",
        anyOf: [{ enum: refs.ICON_NAMES.map((n) => `icon:${n}`) }, ASSET_IMAGE],
      },
      labelText: { type: "string", minLength: 1, maxLength: 40, pattern: "\\S" },
      label: {
        description: "Plain text, or text per locale with an optional default: { \"default\": \"Chat\", \"zh\": \"对话\" }.",
        anyOf: [
          { $ref: "#/definitions/labelText" },
          {
            type: "object",
            minProperties: 1,
            maxProperties: 16,
            propertyNames: { pattern: "^(default|[a-z]{2}(-[A-Z]{2})?)$" },
            additionalProperties: { $ref: "#/definitions/labelText" },
          },
        ],
      },
      navItem: item("nav"),
      sectionItem: item("sections"),
      fixedItem: item("controls"),
    },
    properties: {
      version: { type: "integer", minimum: 1 },
      brand: {
        type: "object",
        additionalProperties: false,
        properties: {
          logo: { ...ASSET_IMAGE, description: "The wordmark at the top of the sidebar." },
          logoDark: { ...ASSET_IMAGE, description: "The wordmark in dark mode; falls back to logo." },
          mark: { ...ASSET_IMAGE, description: "The square app logo: home screen, title bar, sign-in dialog." },
          markDark: { ...ASSET_IMAGE, description: "The app logo in dark mode; falls back to mark." },
          height: { type: "number", minimum: 12, maximum: 40, description: "Wordmark height, px." },
          hidden: { type: "boolean", description: "Remove the wordmark." },
        },
      },
      nav: {
        type: "object",
        additionalProperties: false,
        properties: {
          order: {
            type: "array",
            uniqueItems: true,
            maxItems: refs.NAV_ITEM_IDS.length,
            items: { enum: [...refs.NAV_ITEM_IDS] },
            description: "Listed items first, in this order; the rest follow in the built-in order.",
          },
          items: group(refs.NAV_ITEM_IDS, "navItem", "Per nav item: icons, label, hidden."),
        },
      },
      sections: group(refs.SIDEBAR_SECTION_IDS, "sectionItem", "The project tree: its title, or hide it."),
      tree: {
        type: "object",
        additionalProperties: false,
        properties: {
          folderIcon: { ...icon, description: "A project row's icon." },
          folderOpenIcon: { ...icon, description: "An expanded project row's icon; falls back to folderIcon." },
        },
      },
      controls: group(refs.SIDEBAR_CONTROL_IDS, "fixedItem", "The sidebar's buttons: icon and tooltip. They cannot be hidden."),
      menu: group(refs.SIDEBAR_MENU_IDS, "fixedItem", "The account menu: icon and label. Entries cannot be hidden, so Settings stays reachable."),
    },
  };
}

/**
 * Build every schema. `z` is zod, `primitiveSchemas` is PRIMITIVE_SCHEMAS from
 * src/components/theme/primitives/schemas.ts, `refs` is electron/skins/layoutRefs.mjs.
 */
export function buildSkinSchemas(deps) {
  return {
    "manifest.schema.json": manifestSchema(),
    "layout.schema.json": layoutSchema(deps),
    "components.schema.json": componentsSchema(deps),
    "sidebar.schema.json": sidebarSchema(deps),
  };
}
