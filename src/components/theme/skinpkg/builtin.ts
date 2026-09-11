/**
 * Built-in preset skins: what the gallery offers before any package is installed.
 *
 * A preset is a set of CSS custom properties written straight onto <html> (apply.ts), one set per
 * colour mode, so the light/dark switch keeps working under it. The names are the app's own palette
 * variables (src/app/globals.css); a package's tokens.css sets the same names, which is what makes
 * a preset and a package interchangeable to everything downstream.
 *
 * Ids carry the `builtin-` prefix the engine reserves (native/skin-engine/src/lib.rs), so a package
 * can never shadow one; `default` is the app's own palette and paints nothing.
 */

export const DEFAULT_SKIN_ID = "default";

export type TokenSet = Readonly<Record<string, string>>;

export interface BuiltinSkin {
  id: string;
  /** i18n keys: presets are app code, so they are translated like the rest of the UI. */
  nameKey: string;
  descKey: string;
  /** Gallery swatch: three colours the card draws as a gradient (no preview image to load). */
  swatch: readonly [string, string, string];
  tokens: { light: TokenSet; dark?: TokenSet };
}

const DEFAULT_SKIN: BuiltinSkin = {
  id: DEFAULT_SKIN_ID,
  nameKey: "skinpkg.builtin.default",
  descKey: "skinpkg.builtin.defaultDesc",
  swatch: ["#f2f0ea", "#fdfcfa", "#1a1917"],
  tokens: { light: {} },
};

/** A calm dark preset: near-black surfaces and a cool white ink. Reads the same in both modes. */
const MIDNIGHT: BuiltinSkin = {
  id: "builtin-midnight",
  nameKey: "skinpkg.builtin.midnight",
  descKey: "skinpkg.builtin.midnightDesc",
  swatch: ["#0b0d12", "#151a24", "#8fb4ff"],
  tokens: {
    light: {
      "--background": "#0b0d12",
      "--surface": "#10131a",
      "--surface-muted": "#151a24",
      "--surface-hover": "#1c2330",
      "--surface-active": "#242d3d",
      "--line": "rgba(255, 255, 255, 0.10)",
      "--line-strong": "rgba(255, 255, 255, 0.18)",
      "--ink": "#e9edf5",
      "--ink-muted": "#9aa4b8",
      "--ink-subtle": "#6f7a90",
      "--primary": "#8fb4ff",
      "--primary-foreground": "#0b0d12",
      "--accent-ink": "#8fb4ff",
      "--sidebar": "#0b0d12",
      "--scrollbar-thumb": "rgba(255, 255, 255, 0.22)",
      "--popover": "#151a24",
      "--input": "rgba(255, 255, 255, 0.18)",
    },
  },
};

/** Warm paper: an off-white page with sepia ink and a terracotta accent. Light in both modes. */
const PAPER: BuiltinSkin = {
  id: "builtin-paper",
  nameKey: "skinpkg.builtin.paper",
  descKey: "skinpkg.builtin.paperDesc",
  swatch: ["#f7f1e3", "#fffbf2", "#b5532b"],
  tokens: {
    light: {
      "--background": "#f7f1e3",
      "--surface": "#fffbf2",
      "--surface-muted": "#f1e9d6",
      "--surface-hover": "#e9dfc8",
      "--surface-active": "#dfd2b6",
      "--line": "#e2d7bf",
      "--line-strong": "#cfc0a1",
      "--ink": "#2b2318",
      "--ink-muted": "#6b5d48",
      "--ink-subtle": "#95866d",
      "--primary": "#b5532b",
      "--primary-foreground": "#fff8ef",
      "--accent-ink": "#a04722",
      "--sidebar": "#f2ead8",
      "--scrollbar-thumb": "rgba(43, 35, 24, 0.24)",
      "--popover": "#fffbf2",
    },
  },
};

/** Ocean: the base palettes with a teal accent, tinted surfaces, both modes. */
const OCEAN: BuiltinSkin = {
  id: "builtin-ocean",
  nameKey: "skinpkg.builtin.ocean",
  descKey: "skinpkg.builtin.oceanDesc",
  swatch: ["#e8f2f3", "#f6fbfb", "#0f7b8a"],
  tokens: {
    light: {
      "--background": "#e8f2f3",
      "--surface": "#f6fbfb",
      "--surface-muted": "#dfecee",
      "--surface-hover": "#d2e3e6",
      "--surface-active": "#c2d8dc",
      "--line": "#cfe0e3",
      "--line-strong": "#b3cbd0",
      "--ink": "#0f1d20",
      "--ink-muted": "#4d6468",
      "--ink-subtle": "#7b9094",
      "--primary": "#0f7b8a",
      "--primary-foreground": "#f4fdff",
      "--accent-ink": "#0f7b8a",
      "--sidebar": "#e1eef0",
    },
    dark: {
      "--background": "#0d1719",
      "--surface": "#122023",
      "--surface-muted": "#18292d",
      "--surface-hover": "#1f3439",
      "--surface-active": "#274047",
      "--line": "rgba(170, 220, 230, 0.13)",
      "--line-strong": "rgba(170, 220, 230, 0.22)",
      "--ink": "#e6f2f4",
      "--ink-muted": "#93aeb3",
      "--ink-subtle": "#6d878c",
      "--primary": "#5fc9d8",
      "--primary-foreground": "#07181b",
      "--accent-ink": "#5fc9d8",
      "--sidebar": "#0d1719",
      "--popover": "#18292d",
      "--input": "rgba(170, 220, 230, 0.22)",
    },
  },
};

/** Ember: warm greys with an amber accent, both modes. */
const EMBER: BuiltinSkin = {
  id: "builtin-ember",
  nameKey: "skinpkg.builtin.ember",
  descKey: "skinpkg.builtin.emberDesc",
  swatch: ["#f4efe9", "#fdfaf6", "#c9611f"],
  tokens: {
    light: {
      "--background": "#f4efe9",
      "--surface": "#fdfaf6",
      "--surface-muted": "#efe7de",
      "--surface-hover": "#e6dbcf",
      "--surface-active": "#dbccbd",
      "--line": "#e3d7ca",
      "--line-strong": "#cdbca9",
      "--ink": "#1f1a15",
      "--ink-muted": "#66584c",
      "--ink-subtle": "#918174",
      "--primary": "#c9611f",
      "--primary-foreground": "#fff7f0",
      "--accent-ink": "#b0511a",
      "--sidebar": "#efe8e0",
    },
    dark: {
      "--background": "#161311",
      "--surface": "#1e1a17",
      "--surface-muted": "#27221e",
      "--surface-hover": "#322b26",
      "--surface-active": "#3d352f",
      "--line": "rgba(255, 225, 200, 0.12)",
      "--line-strong": "rgba(255, 225, 200, 0.20)",
      "--ink": "#f3ede6",
      "--ink-muted": "#a89b8f",
      "--ink-subtle": "#7f746a",
      "--primary": "#f0955a",
      "--primary-foreground": "#1a110a",
      "--accent-ink": "#f0955a",
      "--sidebar": "#161311",
      "--popover": "#27221e",
      "--input": "rgba(255, 225, 200, 0.20)",
    },
  },
};

export const BUILTIN_SKINS: readonly BuiltinSkin[] = Object.freeze([DEFAULT_SKIN, MIDNIGHT, PAPER, OCEAN, EMBER]);

export const findBuiltin = (id: string): BuiltinSkin | undefined => BUILTIN_SKINS.find((s) => s.id === id);

/** The default or a `builtin-*` preset: exists without a package directory. Mirrors is_builtin_id in Rust. */
export const isBuiltinSkinId = (id: string) => id === DEFAULT_SKIN_ID || id.startsWith("builtin-");

/** Same shape the engine accepts for a package id (manifest.rs::is_kebab_case, 2-40 chars). */
export const isPackageSkinId = (id: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length >= 2 && id.length <= 40 && !isBuiltinSkinId(id) && id !== "current";
