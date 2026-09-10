/**
 * Derive a complete skin palette from the handful of colours a person actually wants to choose.
 *
 * The editor asks for six (background, surface, sidebar, primary, ink, line); the other nine tokens are mixed
 * from those. Mixing toward ink keeps hovers and wells in the same hue family as the surface they sit on, and the
 * two text-on-colour tokens are chosen by contrast rather than by guessing -- `primary-foreground` picks whichever
 * of near-white and near-black reads better on the primary, and `accent-ink` is pushed toward ink until it clears
 * WCAG AA against the surface, because it is used for links on that surface.
 */
import type { SkinTokens } from "../../../../electron/skins/schema.mjs";

export interface KeyColors {
  background: string;
  surface: string;
  sidebar: string;
  primary: string;
  ink: string;
  line: string;
}

export const KEY_COLOR_NAMES: (keyof KeyColors)[] = ["background", "surface", "sidebar", "primary", "ink", "line"];

type RGB = [number, number, number];

/** #rgb or #rrggbb (the editor's colour inputs only ever produce these). */
export function parseHex(hex: string): RGB | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export const toHex = ([r, g, b]: RGB) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** Linear mix in sRGB: `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as RGB);
}

function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, k) => k - m);
  return (hi + 0.05) / (lo + 0.05);
}

const NEAR_WHITE = "#ffffff";
const NEAR_BLACK = "#111111";

export function deriveTokens(k: KeyColors): SkinTokens {
  const [ir, ig, ib] = parseHex(k.ink) ?? [0, 0, 0];
  const onPrimary =
    contrast(k.primary, NEAR_WHITE) >= contrast(k.primary, NEAR_BLACK) ? NEAR_WHITE : NEAR_BLACK;
  // Walk the accent toward ink in small steps until links on the surface are readable. Ten steps reaches ink
  // itself, which always contrasts with a surface the person chose to put ink on.
  let accentInk = k.primary;
  for (let i = 1; i <= 10 && contrast(accentInk, k.surface) < 4.5; i++) accentInk = mix(k.primary, k.ink, i / 10);
  return {
    background: k.background,
    surface: k.surface,
    "surface-muted": mix(k.surface, k.ink, 0.05),
    "surface-hover": mix(k.surface, k.ink, 0.1),
    "surface-active": mix(k.surface, k.ink, 0.15),
    line: k.line,
    "line-strong": mix(k.line, k.ink, 0.15),
    ink: k.ink,
    "ink-muted": mix(k.ink, k.background, 0.38),
    "ink-subtle": mix(k.ink, k.background, 0.55),
    primary: k.primary,
    "primary-foreground": onPrimary,
    "accent-ink": accentInk,
    sidebar: k.sidebar,
    "scrollbar-thumb": `rgba(${ir}, ${ig}, ${ib}, 0.18)`,
  };
}

/** The six editable colours back out of a full palette (hex only; an rgba line falls back to a mix). */
export function keyColorsOf(tokens: SkinTokens, fallback: KeyColors): KeyColors {
  const pick = (name: keyof KeyColors) => {
    const v = tokens[name];
    return v && parseHex(v) ? toHex(parseHex(v)!) : fallback[name];
  };
  return {
    background: pick("background"),
    surface: pick("surface"),
    sidebar: pick("sidebar"),
    primary: pick("primary"),
    ink: pick("ink"),
    line: tokens.line && parseHex(tokens.line) ? pick("line") : mix(pick("surface"), pick("ink"), 0.14),
  };
}
