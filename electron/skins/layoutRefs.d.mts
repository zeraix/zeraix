export declare const PRIMITIVE_KEYS: readonly [
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
];
export type PrimitiveKey = (typeof PRIMITIVE_KEYS)[number];

export declare const APP_COMPONENT_KEYS: readonly ["greeting", "greetingTitle", "greetingHint", "brandMark", "appVersion", "today"];
export type AppComponentKey = (typeof APP_COMPONENT_KEYS)[number];

export declare const LAYOUT_REGIONS: readonly ["greeting", "sidebarHeader", "sidebarFooter"];
export type LayoutRegion = (typeof LAYOUT_REGIONS)[number];

export declare const REF_PREFIX: Readonly<{ app: "app:"; primitive: "primitive:"; custom: "custom:" }>;

export declare const ALLOWED_REFS: readonly string[];

export declare const NAV_ITEM_IDS: readonly ["new-chat", "skills", "automation", "models", "plugins", "library"];
export type NavItemId = (typeof NAV_ITEM_IDS)[number];

export declare const SIDEBAR_SECTION_IDS: readonly ["projects"];
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

export declare const SIDEBAR_CONTROL_IDS: readonly ["collapse", "expand", "pin", "userMenu"];
export type SidebarControlId = (typeof SIDEBAR_CONTROL_IDS)[number];

export declare const SIDEBAR_MENU_IDS: readonly ["settings", "help", "language", "theme", "wallet", "logout", "signIn"];
export type SidebarMenuId = (typeof SIDEBAR_MENU_IDS)[number];

export declare const ICON_NAMES: readonly [
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
];
export type IconName = (typeof ICON_NAMES)[number];

export declare const APP_REGISTRY: Readonly<{
  refs: readonly string[];
  navItems: typeof NAV_ITEM_IDS;
  sections: typeof SIDEBAR_SECTION_IDS;
  controls: typeof SIDEBAR_CONTROL_IDS;
  menu: typeof SIDEBAR_MENU_IDS;
  icons: typeof ICON_NAMES;
}>;
