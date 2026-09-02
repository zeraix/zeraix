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
