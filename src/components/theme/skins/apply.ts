"use client";

/**
 * Turning a skin into what is on screen.
 *
 * Three outputs: a generated stylesheet (palette, radius, fonts); attributes on <html> that the surface rules in
 * globals.css key off (`data-skin`, `data-skin-backdrop`); and a tiny store React components subscribe to for the
 * layers CSS cannot draw -- the backdrop, pattern and corner art (SkinDecor) and the greeting art (SkinGreeting).
 */
import { useSyncExternalStore } from "react";
import {
  FONT_STACKS,
  SKIN_TOKENS,
  isSkinColor,
  type FontKey,
  type Skin,
  type SkinTokens,
} from "../../../../electron/skins/schema.mjs";
import { BUILTIN_SKINS, NO_SKIN } from "./builtin";
import { loadInstalledSkins, refreshInstalled, subscribeInstalled } from "./installed";
import { cornerUrl, glyphUrl, laceUrl, sprigUrl } from "./patterns";

export { NO_SKIN };

/** Resolve an id to a built-in or installed skin. `none` and unknown ids resolve to null. */
export function findSkin(id: string, installed: Skin[] = loadInstalledSkins()): Skin | null {
  if (id === NO_SKIN) return null;
  return BUILTIN_SKINS.find((s) => s.id === id) ?? installed.find((s) => s.id === id) ?? null;
}

/** Whether a skin paints anything beneath the app -- the condition for the opaque surfaces to go see-through. */
export const hasBackdrop = (s: Skin | null | undefined) =>
  !!(s?.decor?.images?.backdrop || s?.decor?.pattern || s?.decor?.glow);

function declarations(tokens: SkinTokens, radius?: number): string {
  const parts = SKIN_TOKENS.filter((tk) => isSkinColor(tokens[tk])).map((tk) => `--${tk}: ${tokens[tk]};`);
  if (typeof radius === "number" && Number.isFinite(radius)) {
    parts.push(`--radius: ${Math.min(28, Math.max(0, Math.round(radius)))}px;`);
  }
  return parts.join(" ");
}

/**
 * Palette variables that globals.css defines as literal values instead of from the ramp -- so a skin would leave them
 * at the base palette: menus, popovers and toasts (dark), the sidebar's selected row, text on an accent fill, the
 * strong accent ink, and the scrollbar's hover state. Re-derived here from the skin's own tokens. Literals from code,
 * never from the skin; a var() that the skin did not set falls through to the base value, which is still correct.
 */
const derived = (dark: boolean) =>
  [
    `--popover: var(${dark ? "--surface-muted" : "--surface"});`,
    "--sidebar-accent: var(--surface-hover);",
    "--accent-on: var(--primary-foreground);",
    "--accent-ink-strong: color-mix(in srgb, var(--accent-ink) 78%, var(--ink));",
    "--scrollbar-thumb-hover: color-mix(in srgb, var(--ink) 42%, transparent);",
    ...(dark ? ["--input: var(--line-strong);"] : []),
  ].join(" ");

const stack = (key: FontKey | undefined) => (key && key in FONT_STACKS ? FONT_STACKS[key] : "");

/**
 * The skin's drawn pieces in this mode's colours, as variables for skins.css: the glyph (full, soft, and in the
 * on-primary colour for button labels), the card-corner flourish, the composer/sidebar sprig and the dialog lace.
 * The ornament key picks the art; each piece appears only where its own detail flag is on. The strengths here are
 * the design: pieces decorate at a whisper, so text on top of them never has to compete.
 */
function ornament(skin: Skin, tokens: SkinTokens): string {
  const key = skin.details?.ornament;
  if (!key) return "";
  const vars: [string, string | null][] = [
    ["--skin-ornament", glyphUrl(key, tokens.primary)],
    ["--skin-ornament-soft", glyphUrl(key, tokens.primary, 0.42)],
    ["--skin-ornament-on", glyphUrl(key, tokens["primary-foreground"], 0.9)],
    ["--skin-corner", cornerUrl(key, tokens.primary, 0.4)],
    ["--skin-sprig", sprigUrl(key, tokens.primary, 0.62)],
    ["--skin-lace", laceUrl(key, tokens.primary, 0.45)],
  ];
  return vars
    .filter(([, v]) => v)
    .map(([name, v]) => `${name}: ${v};`)
    .join(" ");
}

/** Accent-tinted scrollbars. Declared after `derived`, so within the same rule it wins over the neutral hover value. */
const scrollbar = (skin: Skin) =>
  skin.details?.accentScrollbar
    ? "--scrollbar-thumb: color-mix(in srgb, var(--primary) 38%, transparent); --scrollbar-thumb-hover: color-mix(in srgb, var(--primary) 62%, transparent);"
    : "";

/**
 * The stylesheet for a skin.
 *
 * Global form (no `scope`): selectors hang off `:root[data-skin="id"]`. `:not(.dark)` and `.dark` both land at
 * (0,3,0) -- above the base palettes and the accent blocks -- and `:not(.dark)` stops a token the dark half leaves
 * out from inheriting the LIGHT value. Scoped form: the same declarations under a container, for the editor's live
 * preview; `.dark` still lives on <html>, so the theme test moves to the ancestor.
 *
 * Colours are re-validated here although skins arrive sanitized: this string becomes a stylesheet and the check is
 * cheap. Font stacks come from the schema's table, never from the skin. `scope` is only ever a literal from code.
 */
export function skinCss(skin: Skin, scope?: string): string {
  const base = scope ?? `:root[data-skin="${skin.id}"]`;
  const lightSel = scope ? `:root:not(.dark) ${scope}` : `${base}:not(.dark)`;
  const darkSel = scope ? `:root.dark ${scope}` : `${base}.dark`;
  const rules = [
    `${lightSel} { ${declarations(skin.light, skin.radius)} ${derived(false)} ${ornament(skin, skin.light)} ${scrollbar(skin)} }`,
    `${darkSel} { ${declarations(skin.dark, skin.radius)} ${derived(true)} ${ornament(skin, skin.dark)} ${scrollbar(skin)} }`,
  ];
  const body = stack(skin.fonts?.body);
  if (body) rules.push(`${scope ?? `${base} body`} { font-family: ${body}; }`);
  const display = stack(skin.fonts?.display);
  if (display) rules.push(`${base} .skin-display { font-family: ${display}; }`);
  return rules.join("\n");
}

/* ------------------------------------------------------------------ applying */

const STYLE_ID = "zeraix-skin";

/** Skin details, written onto <html> as data attributes the "skin details" rules in globals.css select on. */
const DETAIL_ATTRS = {
  ornament: "skinOrnament",
  buttons: "skinButtons",
  fields: "skinFields",
  cards: "skinCards",
  headings: "skinHeadings",
  nav: "skinNav",
  cardCorner: "skinCardCorner",
} as const;

/** On/off pieces: present as an empty attribute when the skin switches them on. */
const FLAG_ATTRS = {
  buttonGlyph: "skinButtonGlyph",
  composerSprig: "skinComposerSprig",
  sidebarFlourish: "skinSidebarFlourish",
  dialogLace: "skinDialogLace",
} as const;

function paintDetails(root: HTMLElement, skin: Skin | null) {
  for (const [key, attr] of Object.entries(DETAIL_ATTRS)) {
    // Values come from sanitized skins (or built-in code), so each is one of the schema's keys.
    const value = skin?.details?.[key as keyof typeof DETAIL_ATTRS];
    if (typeof value === "string") root.dataset[attr] = value;
    else delete root.dataset[attr];
  }
  for (const [flag, attr] of Object.entries(FLAG_ATTRS)) {
    if (skin?.details?.[flag as keyof typeof FLAG_ATTRS] === true) root.dataset[attr] = "";
    else delete root.dataset[attr];
  }
  // Movement: which kind drives the CSS (drift, float); particles are rendered by SkinDecor.
  if (skin?.decor?.motion) root.dataset.skinMotion = skin.decor.motion;
  else delete root.dataset.skinMotion;
}
/** The id last asked for, kept even when it does not resolve: an install arriving later can then satisfy it. */
let requested = NO_SKIN;
let active: Skin | null = null;
const activeListeners = new Set<() => void>();

function paint(id: string, mayRefresh: boolean) {
  requested = id;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // A skin created in another window can reach us over IPC before its list broadcast does; one fresh read closes
  // that gap. Never from inside the installed-list subscription below, or a missing id would refresh forever.
  const skin = findSkin(id) ?? (mayRefresh && id !== NO_SKIN ? findSkin(id, refreshInstalled()) : null);
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!skin) {
    delete root.dataset.skin;
    delete root.dataset.skinBackdrop;
    el?.remove();
  } else {
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = skinCss(skin);
    root.dataset.skin = skin.id;
    if (hasBackdrop(skin)) root.dataset.skinBackdrop = "";
    else delete root.dataset.skinBackdrop;
  }
  paintDetails(root, skin);
  if (active !== skin) {
    active = skin;
    activeListeners.forEach((l) => l());
  }
}

/** Apply a skin by id, or remove any skin for `none` / an id that does not resolve. */
export function applySkin(id: string) {
  paint(id, true);
}

// An edit to the active custom skin, or an install that finally satisfies `requested`, repaints without anyone
// having to re-select the skin.
if (typeof window !== "undefined") subscribeInstalled(() => paint(requested, false));

const subscribeActive = (l: () => void) => {
  activeListeners.add(l);
  return () => {
    activeListeners.delete(l);
  };
};

/** The skin currently on screen, for components that draw its image and art layers. */
export function useActiveSkin(): Skin | null {
  return useSyncExternalStore(subscribeActive, () => active, () => null);
}
