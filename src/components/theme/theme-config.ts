/**
 * Theme configuration: accent color (accent / primary) presets
 * - Light/dark mode is managed by next-themes (the .dark class)
 * - The accent color is managed by the data-accent attribute; the CSS is defined in globals.css
 */

export const ACCENT_STORAGE_KEY = "zeraix.accent";

export type AccentKey = "gold" | "blue" | "green" | "purple" | "rose";

export interface AccentPreset {
  key: AccentKey;
  /** Display name */
  label: string;
  /** Swatch shown in the picker (the accent's representative color) */
  swatch: string;
}

export const ACCENTS: AccentPreset[] = [
  { key: "gold", label: "Gold", swatch: "#a8841f" },
  { key: "blue", label: "Blue", swatch: "#2563eb" },
  { key: "green", label: "Green", swatch: "#16a34a" },
  { key: "purple", label: "Purple", swatch: "#7c3aed" },
  { key: "rose", label: "Rose", swatch: "#e11d48" },
];

export const DEFAULT_ACCENT: AccentKey = "gold";

export const isAccentKey = (v: unknown): v is AccentKey =>
  typeof v === "string" && ACCENTS.some((a) => a.key === v);
