/**
 * The skins that ship with the app: the four seasons, the store's catalog, and a preview-only stand-in for the
 * base palette.
 *
 * These are code, so they skip sanitizeSkin at runtime -- but they speak exactly the vocabulary it enforces, and the
 * skin tests run every one of them through the validator anyway.
 *
 * A season is more than a palette. Each sets a corner radius, a display face, a tiled pattern, a motif above the
 * empty-chat greeting, a soft glow behind the app, and its own component details -- how its buttons, fields, cards,
 * headings and navigation are finished, and which small ornament dresses them. None ships a photograph: every piece of art is drawn in code
 * (patterns.ts), which keeps the app free of image licensing and each skin a few kilobytes.
 */
import type { Skin } from "../../../../electron/skins/schema.mjs";

/** The base palette in globals.css: no skin applied. */
export const NO_SKIN = "none";

const DARK_LINES = { line: "rgba(255, 255, 255, 0.12)", "line-strong": "rgba(255, 255, 255, 0.2)" };
const DARK_THUMB = "rgba(255, 255, 255, 0.16)";

/** The base palette, skin-shaped, purely so the Default card can draw a preview. Never applied. */
export const DEFAULT_SKIN_PREVIEW: Skin = {
  id: NO_SKIN,
  builtin: true,
  nameKey: "appearance.skin.none",
  descKey: "appearance.skin.noneDesc",
  light: {
    background: "#f2f0ea", surface: "#fdfcfa", "surface-muted": "#eeece5", sidebar: "#ebe8e0",
    line: "#dcd7cc", ink: "#171614", "ink-subtle": "#8b877e", primary: "#1a1917",
  },
  dark: {
    background: "#121215", surface: "#1a1a1e", "surface-muted": "#222227", sidebar: "#161619",
    line: "rgba(255, 255, 255, 0.13)", ink: "#f0eeeb", "ink-subtle": "#7a7772", primary: "#f0eeeb",
  },
};

/*
 * Palettes keep the base system's discipline: surfaces stay low-chroma so text reads as text, and the season
 * lives in the undertone, the accent and the art. Every light-mode primary clears 4.5:1 against its foreground.
 */
export const BUILTIN_SKINS: Skin[] = [
  {
    id: "spring",
    builtin: true,
    nameKey: "appearance.skin.spring",
    descKey: "appearance.skin.springDesc",
    radius: 16,
    fonts: { display: "serif" },
    decor: { pattern: "petals", patternOpacity: 0.14, motif: "petals", glow: true, motion: "fall", cornerFrame: "round" },
    details: { ornament: "petals", buttons: "soft", fields: "soft", cards: "soft", headings: "ornament", nav: "pill", cardCorner: "sprig", composerSprig: true, accentScrollbar: true },
    light: {
      background: "#f3f4ec", surface: "#fcfdf8", "surface-muted": "#eceee3", "surface-hover": "#e2e6d7",
      "surface-active": "#d6dbc9", line: "#d7dccb", "line-strong": "#c3c9b4", ink: "#1a1f17",
      "ink-muted": "#58604f", "ink-subtle": "#858c7b", primary: "#437a32", "primary-foreground": "#ffffff",
      "accent-ink": "#3a6b2b", sidebar: "#e9ecdf", "scrollbar-thumb": "rgba(26, 31, 23, 0.18)",
    },
    dark: {
      background: "#121510", surface: "#191d16", "surface-muted": "#21261d", "surface-hover": "#2b3126",
      "surface-active": "#363d30", ...DARK_LINES, ink: "#eef1e8", "ink-muted": "#a0a896",
      "ink-subtle": "#7b8372", primary: "#8fcf72", "primary-foreground": "#0f170b", "accent-ink": "#9fd885",
      sidebar: "#151912", "scrollbar-thumb": DARK_THUMB,
    },
  },
  {
    id: "summer",
    builtin: true,
    nameKey: "appearance.skin.summer",
    descKey: "appearance.skin.summerDesc",
    radius: 12,
    fonts: { display: "rounded", body: "rounded" },
    decor: { pattern: "waves", patternOpacity: 0.12, motif: "waves", glow: true, motion: "drift", cornerFrame: "round" },
    details: { ornament: "waves", buttons: "gradient", fields: "soft", cards: "lifted", headings: "underline", nav: "glow", cardCorner: "glyph", sidebarFlourish: true, accentScrollbar: true },
    light: {
      background: "#f4f1e8", surface: "#fffdf7", "surface-muted": "#efebdf", "surface-hover": "#e6e0cf",
      "surface-active": "#dad3be", line: "#ddd5c1", "line-strong": "#c9bfa7", ink: "#1b1a15",
      "ink-muted": "#5e594b", "ink-subtle": "#8c8676", primary: "#0b7a8c", "primary-foreground": "#ffffff",
      "accent-ink": "#09697a", sidebar: "#ece7d9", "scrollbar-thumb": "rgba(27, 26, 21, 0.18)",
    },
    dark: {
      background: "#0f1517", surface: "#161d20", "surface-muted": "#1d262a", "surface-hover": "#263136",
      "surface-active": "#303c42", ...DARK_LINES, ink: "#eaf2f2", "ink-muted": "#97a8aa",
      "ink-subtle": "#748587", primary: "#4fd0e0", "primary-foreground": "#06181b", "accent-ink": "#6fdae8",
      sidebar: "#121a1c", "scrollbar-thumb": DARK_THUMB,
    },
  },
  {
    id: "autumn",
    builtin: true,
    nameKey: "appearance.skin.autumn",
    descKey: "appearance.skin.autumnDesc",
    radius: 10,
    fonts: { display: "serif" },
    decor: { pattern: "leaves", patternOpacity: 0.13, motif: "leaves", glow: true, motion: "fall", cornerFrame: "polaroid" },
    details: { ornament: "leaves", buttons: "soft", fields: "underline", cards: "lifted", headings: "ornament", nav: "bar", cardCorner: "sprig", composerSprig: true },
    light: {
      background: "#f3ede4", surface: "#fdf9f3", "surface-muted": "#eee6da", "surface-hover": "#e5dacb",
      "surface-active": "#d9cbb8", line: "#dccfbd", "line-strong": "#c9b8a1", ink: "#211a14",
      "ink-muted": "#64564a", "ink-subtle": "#8f7f71", primary: "#b5541c", "primary-foreground": "#ffffff",
      "accent-ink": "#9a4515", sidebar: "#ebe2d4", "scrollbar-thumb": "rgba(33, 26, 20, 0.18)",
    },
    dark: {
      background: "#16110d", surface: "#1e1813", "surface-muted": "#271f19", "surface-hover": "#322820",
      "surface-active": "#3d312a", ...DARK_LINES, ink: "#f3ebe3", "ink-muted": "#aa9b8d",
      "ink-subtle": "#85776a", primary: "#f09a5c", "primary-foreground": "#1c0f06", "accent-ink": "#f5ab76",
      sidebar: "#1a140f", "scrollbar-thumb": DARK_THUMB,
    },
  },
  {
    id: "winter",
    builtin: true,
    nameKey: "appearance.skin.winter",
    descKey: "appearance.skin.winterDesc",
    radius: 14,
    fonts: { display: "serif" },
    decor: { pattern: "snow", patternOpacity: 0.16, motif: "snow", glow: true, motion: "fall", cornerFrame: "round" },
    details: { ornament: "snow", buttons: "glow", fields: "outline", cards: "outlined", headings: "ornament", nav: "glow", cardCorner: "glyph", sidebarFlourish: true, dialogLace: true, accentScrollbar: true },
    light: {
      background: "#eef1f4", surface: "#fafbfd", "surface-muted": "#e7ebf0", "surface-hover": "#dce2e9",
      "surface-active": "#cfd7e0", line: "#d2d9e1", "line-strong": "#bcc5d0", ink: "#151a20",
      "ink-muted": "#535d69", "ink-subtle": "#808a96", primary: "#3a6ea5", "primary-foreground": "#ffffff",
      "accent-ink": "#2f5c8c", sidebar: "#e4e9ef", "scrollbar-thumb": "rgba(21, 26, 32, 0.18)",
    },
    dark: {
      background: "#0e1217", surface: "#151a21", "surface-muted": "#1c222b", "surface-hover": "#252d38",
      "surface-active": "#2f3845", ...DARK_LINES, ink: "#e9eef4", "ink-muted": "#97a2b0",
      "ink-subtle": "#737e8c", primary: "#8ab8ec", "primary-foreground": "#0a1522", "accent-ink": "#9dc4f0",
      sidebar: "#11161c", "scrollbar-thumb": DARK_THUMB,
    },
  },
];

/**
 * The store catalog, typed `unknown[]` on purpose: it is sanitized on the way out exactly as a network response
 * would be (see store.ts), so replacing it with a real fetch changes nothing downstream. Store skins set no
 * greeting text -- that would bypass translation for everyone who installs one.
 */
export const STORE_CATALOG: unknown[] = [
  {
    id: "sakura-dusk",
    name: "Sakura Dusk",
    description: "Falling petals, heart-trimmed buttons, flourished cards, a sprig on the composer and lace-edged dialogs.",
    author: "Zeraix",
    version: "1.2.0",
    radius: 18,
    fonts: { display: "script" },
    decor: { pattern: "petals", patternOpacity: 0.12, motif: "petals", glow: true, motion: "fall", cornerFrame: "polaroid" },
    details: { ornament: "hearts", buttons: "glow", fields: "soft", cards: "soft", headings: "ornament", nav: "pill", cardCorner: "sprig", buttonGlyph: true, composerSprig: true, sidebarFlourish: true, dialogLace: true, accentScrollbar: true },
    light: {
      background: "#f6f0f1", surface: "#fffafb", "surface-muted": "#f0e7e9", "surface-hover": "#e8dcdf",
      "surface-active": "#ddcdd1", line: "#e2d4d8", "line-strong": "#d0bcc2", ink: "#211a1c",
      "ink-muted": "#65585c", "ink-subtle": "#937f85", primary: "#b44a6e", "primary-foreground": "#ffffff",
      "accent-ink": "#9a3c5c", sidebar: "#efe5e8", "scrollbar-thumb": "rgba(33, 26, 28, 0.18)",
    },
    dark: {
      background: "#161113", surface: "#1e171a", "surface-muted": "#271e22", "surface-hover": "#32272c",
      "surface-active": "#3d3036", ...DARK_LINES, ink: "#f4eaed", "ink-muted": "#ab9aa0",
      "ink-subtle": "#86767c", primary: "#f09ab8", "primary-foreground": "#210b13", "accent-ink": "#f4aec6",
      sidebar: "#1a1417", "scrollbar-thumb": DARK_THUMB,
    },
  },
  {
    id: "nordic-night",
    name: "Nordic Night",
    description: "Twinkling starlight over deep slate, star-marked buttons, a starry sidebar foot and lace-edged dialogs.",
    author: "Zeraix",
    version: "1.2.0",
    radius: 8,
    fonts: { display: "rounded" },
    decor: { pattern: "sparkles", patternOpacity: 0.1, motif: "sparkles", glow: true, motion: "twinkle", cornerFrame: "plain" },
    details: { ornament: "sparkles", buttons: "glow", fields: "outline", cards: "outlined", headings: "underline", nav: "bar", cardCorner: "glyph", buttonGlyph: true, sidebarFlourish: true, dialogLace: true, accentScrollbar: true },
    light: {
      background: "#eceff1", surface: "#f9fafb", "surface-muted": "#e4e8eb", "surface-hover": "#d8dde2",
      "surface-active": "#cad1d7", line: "#cfd6dc", "line-strong": "#b8c1c9", ink: "#12181d",
      "ink-muted": "#4e5a63", "ink-subtle": "#7b8790", primary: "#1f7a74", "primary-foreground": "#ffffff",
      "accent-ink": "#1a6660", sidebar: "#e1e6ea", "scrollbar-thumb": "rgba(18, 24, 29, 0.18)",
    },
    dark: {
      background: "#0b1014", surface: "#11181d", "surface-muted": "#172027", "surface-hover": "#1f2a32",
      "surface-active": "#28353e", line: "rgba(255, 255, 255, 0.11)", "line-strong": "rgba(255, 255, 255, 0.19)",
      ink: "#e4ecef", "ink-muted": "#8d9ca5", "ink-subtle": "#6b7a83", primary: "#5fd4c4",
      "primary-foreground": "#06201d", "accent-ink": "#7ddccf", sidebar: "#0e1418",
      "scrollbar-thumb": "rgba(255, 255, 255, 0.15)",
    },
  },
  {
    id: "matcha",
    name: "Matcha",
    description: "Floating tea leaves, brushed kaiti headings, leaf-sprig cards and a quiet underlined ink style.",
    author: "Zeraix",
    version: "1.2.0",
    radius: 20,
    fonts: { display: "kai" },
    decor: { pattern: "dots", patternOpacity: 0.1, motif: "leaves", motion: "sway", cornerFrame: "round" },
    details: { ornament: "leaves", buttons: "flat", fields: "underline", cards: "outlined", headings: "underline", nav: "bar", cardCorner: "sprig", composerSprig: true, dialogLace: true },
    light: {
      background: "#f1f0e6", surface: "#fbfaf3", "surface-muted": "#e9e8dc", "surface-hover": "#dfdecf",
      "surface-active": "#d3d2c1", line: "#d9d8c7", "line-strong": "#c5c4b0", ink: "#1c1d16",
      "ink-muted": "#5b5d4d", "ink-subtle": "#88897a", primary: "#5e7a3a", "primary-foreground": "#ffffff",
      "accent-ink": "#4f6830", sidebar: "#e8e7da", "scrollbar-thumb": "rgba(28, 29, 22, 0.18)",
    },
    dark: {
      background: "#121310", surface: "#191a16", "surface-muted": "#20221c", "surface-hover": "#2a2c25",
      "surface-active": "#34372e", ...DARK_LINES, ink: "#ebecdf", "ink-muted": "#a2a494",
      "ink-subtle": "#7d7f70", primary: "#b3cf85", "primary-foreground": "#141a0a", "accent-ink": "#c1d99a",
      sidebar: "#151612", "scrollbar-thumb": DARK_THUMB,
    },
  },
  {
    id: "firefly-meadow",
    name: "Firefly Meadow",
    description: "A summer night: deep moss, warm lantern light, fireflies that drift in and out, and a glowing composer sprig.",
    author: "Zeraix",
    version: "1.0.0",
    radius: 14,
    fonts: { display: "rounded" },
    decor: { pattern: "dots", patternOpacity: 0.07, motif: "sparkles", glow: true, motion: "twinkle", cornerFrame: "round" },
    details: { ornament: "dots", buttons: "glow", fields: "soft", cards: "lifted", headings: "underline", nav: "glow", cardCorner: "glyph", composerSprig: true, sidebarFlourish: true, accentScrollbar: true },
    light: {
      background: "#f1f3ea", surface: "#fbfcf6", "surface-muted": "#e9ecdf", "surface-hover": "#dee3d1",
      "surface-active": "#d1d8c2", line: "#d4dac6", "line-strong": "#bfc7ae", ink: "#171c12",
      "ink-muted": "#525b47", "ink-subtle": "#7f8873", primary: "#7a5c00", "primary-foreground": "#ffffff",
      "accent-ink": "#6b5000", sidebar: "#e8ebdd", "scrollbar-thumb": "rgba(23, 28, 18, 0.18)",
    },
    dark: {
      background: "#0d110b", surface: "#141a11", "surface-muted": "#1b2317", "surface-hover": "#242e1f",
      "surface-active": "#2e3a28", ...DARK_LINES, ink: "#ecf1e4", "ink-muted": "#9fa994",
      "ink-subtle": "#7b8570", primary: "#f2c94c", "primary-foreground": "#1a1400", "accent-ink": "#f5d470",
      sidebar: "#10150e", "scrollbar-thumb": DARK_THUMB,
    },
  },
];
