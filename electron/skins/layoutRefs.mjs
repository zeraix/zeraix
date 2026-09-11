/**
 * Everything the app renders that a skin package may name: layout refs and regions, the sidebar's
 * nav items, sections, controls and account-menu entries, and the built-in icon names.
 *
 * One list, read by both sides: the Rust engine gets it from the main process at install time
 * (APP_REGISTRY) as its allow list, and the renderer's registries and schemas are typed against it
 * (a registry missing a key here fails to compile). Kept under electron/ for the same reason
 * schema.mjs is: it is the only source tree the packaged main process can load. No imports, so
 * both sides can take it as-is.
 *
 * Adding something: add its key here, implement it where the renderer draws it, done -- the test
 * suite checks the sidebar ids against what AgentSidebar actually renders. Removing one is a
 * breaking change for installed packages that name it: they stop validating on the next reinstall,
 * and the renderer ignores the entry meanwhile.
 */

/** Visual primitives (Stage 6.1), `primitive:<key>`. Implemented in src/components/theme/primitives/. */
export const PRIMITIVE_KEYS = Object.freeze([
  "box",
  "text",
  "icon",
  "image",
  "gradient",
  "progressBar",
  "progressRing",
  "divider",
  "badge",
  "avatar",
  "shape",
  "spacer",
]);

/** The app's own presentational pieces, `app:<key>`. Implemented in src/components/theme/layout/registry.tsx. */
export const APP_COMPONENT_KEYS = Object.freeze([
  "greeting",
  "greetingTitle",
  "greetingHint",
  "brandMark",
  "appVersion",
  "today",
]);

/** Regions the app wraps in <LayoutSlot>; a layout.json names one of these per tree. */
export const LAYOUT_REGIONS = Object.freeze(["greeting", "sidebarHeader", "sidebarFooter"]);

export const REF_PREFIX = Object.freeze({ app: "app:", primitive: "primitive:", custom: "custom:" });

/** Every `app:` and `primitive:` ref, fully spelled -- what the engine's allow list receives. */
export const ALLOWED_REFS = Object.freeze([
  ...PRIMITIVE_KEYS.map((k) => `${REF_PREFIX.primitive}${k}`),
  ...APP_COMPONENT_KEYS.map((k) => `${REF_PREFIX.app}${k}`),
]);

/* ------------------------------------------------------------------ sidebar */

/** Sidebar nav items, in the app's default order. Must match NAV_ITEMS in AgentSidebar.tsx (test/skin-sidebar.test.mjs). */
export const NAV_ITEM_IDS = Object.freeze(["new-chat", "skills", "automation", "models", "plugins", "library"]);

/** Collapsible sections of the sidebar: the project tree. */
export const SIDEBAR_SECTION_IDS = Object.freeze(["projects"]);

/**
 * Icon buttons around the sidebar: `collapse` (in its header), `expand` (floating while it is folded
 * away), `pin` (keep the window on top) and `userMenu` (the chevron on the account row).
 */
export const SIDEBAR_CONTROL_IDS = Object.freeze(["collapse", "expand", "pin", "userMenu"]);

/** Account-menu entries. Icons and labels only: none can be hidden, so Settings is always reachable. */
export const SIDEBAR_MENU_IDS = Object.freeze(["settings", "help", "language", "theme", "wallet", "logout", "signIn"]);

/**
 * The built-in icons a package may name, as `icon:<name>` in sidebar.json or as the Icon primitive's
 * `name`. Keys of lucide-react, mapped to components in src/components/theme/primitives/icons.ts.
 */
export const ICON_NAMES = Object.freeze([
  "sun", "moon", "sun-moon", "moon-star", "zap", "battery", "battery-charging", "cloud", "cloud-sun",
  "sparkles", "heart", "star", "leaf", "snowflake", "flame", "droplet", "wind", "umbrella", "thermometer",
  "bot", "brain", "message-square", "folder", "file-text", "check", "x", "plus", "arrow-right",
  "calendar", "clock", "settings", "user", "users", "house", "search", "bell", "shield", "lock", "key",
  "globe", "map-pin", "compass", "image", "music", "coffee", "gift", "rocket", "trophy", "flag",
  "bookmark", "tag", "layers", "grid-3x3", "cpu", "terminal", "code", "wand-sparkles", "palette",
  "activity", "trending-up", "chart-pie", "chart-bar", "smile", "ghost", "cat", "dog", "bird", "fish",
  "flower", "flower-2", "trees", "mountain", "waves", "anchor", "plane", "car", "bike", "gamepad-2",
  "headphones", "camera", "mic", "video", "lightbulb", "mail", "phone", "link", "external-link",
  "download", "upload", "refresh-cw", "loader", "info", "triangle-alert", "circle-question-mark",
  "wifi", "bluetooth", "volume-2",
]);

/** What the engine checks a package against (native/skin-engine AppRegistry). */
export const APP_REGISTRY = Object.freeze({
  refs: ALLOWED_REFS,
  navItems: NAV_ITEM_IDS,
  sections: SIDEBAR_SECTION_IDS,
  controls: SIDEBAR_CONTROL_IDS,
  menu: SIDEBAR_MENU_IDS,
  icons: ICON_NAMES,
});
