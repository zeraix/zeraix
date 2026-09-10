/**
 * Theme configuration: accent color (accent / primary) presets
 * - Light/dark mode is managed by next-themes (the .dark class)
 * - The accent color is managed by the data-accent attribute; the CSS is defined in globals.css
 */

export const ACCENT_STORAGE_KEY = "zeraix.accent";

export type AccentKey = "graphite" | "blue" | "green" | "purple" | "rose" | "gold";

export interface AccentPreset {
  key: AccentKey;
  /** Display name */
  label: string;
  /** Swatch shown in the picker (the accent's representative color) */
  swatch: string;
  /** Swatch shown in the picker under the dark theme (the presets differ per theme) */
  swatchDark: string;
}

export const ACCENTS: AccentPreset[] = [
  { key: "graphite", label: "Graphite", swatch: "#1c1b19", swatchDark: "#edecea" },
  { key: "blue", label: "Blue", swatch: "#2e5fd6", swatchDark: "#7fa6f0" },
  { key: "green", label: "Green", swatch: "#0f7a50", swatchDark: "#35c48a" },
  { key: "purple", label: "Purple", swatch: "#6d4aa8", swatchDark: "#a98ce0" },
  { key: "rose", label: "Rose", swatch: "#b83a5a", swatchDark: "#e88aa4" },
  { key: "gold", label: "Bronze", swatch: "#96620a", swatchDark: "#e0a93a" },
];

export const DEFAULT_ACCENT: AccentKey = "graphite";

export const isAccentKey = (v: unknown): v is AccentKey =>
  typeof v === "string" && ACCENTS.some((a) => a.key === v);

/* ------------------------------------------------------------------ font size */

/** next-themes' own storage key. Named here because the appearance store seeds it before that
 *  library reads it, so both sides have to agree on the string. */
export const THEME_STORAGE_KEY = "theme";
export const FONT_SIZE_STORAGE_KEY = "zeraix.fontSize";

export type ThemeMode = "light" | "dark" | "system";
/** A preset, or "custom" -- in which case `fontSizePx` holds the size the user typed. */
export type FontSizeKey = "sm" | "md" | "lg" | "xl" | "custom";

export interface FontSizePreset {
  key: FontSizeKey;
  /** i18n key for the display name. */
  labelKey: string;
  /** Multiplier applied to the root font size; mirrors --ui-font-scale in globals.css. */
  scale: number;
}

export const FONT_SIZES: FontSizePreset[] = [
  { key: "sm", labelKey: "appearance.fontSize.sm", scale: 0.875 },
  { key: "md", labelKey: "appearance.fontSize.md", scale: 1 },
  { key: "lg", labelKey: "appearance.fontSize.lg", scale: 1.125 },
  { key: "xl", labelKey: "appearance.fontSize.xl", scale: 1.25 },
];

export const DEFAULT_FONT_SIZE: FontSizeKey = "md";
export const DEFAULT_THEME: ThemeMode = "system";

export const isFontSizeKey = (v: unknown): v is FontSizeKey =>
  v === "custom" || (typeof v === "string" && FONT_SIZES.some((f) => f.key === v));

/** The custom px value lives beside the preset key; its range is defined once, in the shared skin schema,
 *  so the main process validates the same numbers this UI accepts. */
export const FONT_SIZE_PX_STORAGE_KEY = "zeraix.fontSizePx";
/** Whether skins may move (falling petals, drifting patterns). Off overrides every skin; reduced motion always wins. */
export const SKIN_MOTION_STORAGE_KEY = "zeraix.skinMotion";
/** Whether the skin decorates the chat screen. Off keeps the palette but gives conversations a plain surface. */
export const SKIN_ON_CHAT_STORAGE_KEY = "zeraix.skinOnChat";
export { FONT_PX, clampFontPx, isFontPx } from "../../../electron/skins/schema.mjs";

export const isThemeMode = (v: unknown): v is ThemeMode =>
  v === "light" || v === "dark" || v === "system";

/* ----------------------------------------------------------------------- skin */

/** The active skin. "none" is the base palette in globals.css; any other id is a built-in or
 *  installed skin (see skins.ts). Ids are open-ended because store skins are, so they are checked by
 *  shape rather than against a list. */
export const SKIN_STORAGE_KEY = "zeraix.skin";
export const DEFAULT_SKIN = "none";
const SKIN_ID_RE = /^(none|[a-z0-9][a-z0-9-]{1,39})$/;
export const isSkinId = (v: unknown): v is string => typeof v === "string" && SKIN_ID_RE.test(v);

/** The appearance settings as one object -- the shape persisted, broadcast and restored. */
export interface Appearance {
  theme: ThemeMode;
  accent: AccentKey;
  fontSize: FontSizeKey;
  /** Only read when fontSize is "custom". Kept regardless, so switching away and back restores it. */
  fontSizePx: number;
  skin: string;
  skinMotion: boolean;
  skinOnChat: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: DEFAULT_THEME,
  accent: DEFAULT_ACCENT,
  fontSize: DEFAULT_FONT_SIZE,
  fontSizePx: 16,
  skin: DEFAULT_SKIN,
  skinMotion: true,
  skinOnChat: true,
};
