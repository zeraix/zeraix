/**
 * Decorative artwork for skins, drawn in code.
 *
 * Every piece is vector geometry generated here, in one colour the skin supplies. That colour passes
 * isSkinColor before it is written into the SVG, so nothing a skin carries ever becomes markup. The results
 * are data URIs: a skin's decoration cannot reach the network because it never names anything outside itself.
 *
 * Two forms per key:
 *   - a TILE (120x120), repeated behind the app at low opacity -- texture, not illustration;
 *   - a MOTIF (320x160), a small composed illustration above the empty-chat greeting and in the corner.
 */
import { isSkinColor, type PatternKey } from "../../../../electron/skins/schema.mjs";

type Art = Exclude<PatternKey, "none">;

const n = (v: number) => Math.round(v * 100) / 100;

const blossom = (x: number, y: number, s: number, rot = 0) =>
  `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">` +
  [0, 72, 144, 216, 288].map((a) => `<ellipse cx="0" cy="-7.4" rx="3.7" ry="6.4" transform="rotate(${a})"/>`).join("") +
  `<circle r="2.2" fill-opacity="0.5"/></g>`;

const petal = (x: number, y: number, rot: number, s = 1) =>
  `<ellipse cx="${x}" cy="${y}" rx="${n(2.6 * s)}" ry="${n(4.6 * s)}" transform="rotate(${rot} ${x} ${y})" fill-opacity="0.75"/>`;

const sparkle = (x: number, y: number, s: number) =>
  `<path transform="translate(${x} ${y}) scale(${s})" d="M0-10C1-2 2-1 10 0C2 1 1 2 0 10C-1 2-2 1-10 0C-2-1-1-2 0-10Z"/>`;

const leaf = (x: number, y: number, rot: number, s: number) =>
  `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">` +
  `<path d="M0-12C7-6 7 6 0 12C-7 6-7-6 0-12Z" fill-opacity="0.85"/>` +
  `<path d="M0-10V10" fill="none" stroke-width="0.9" stroke-opacity="0.45"/></g>`;

const snowflake = (x: number, y: number, s: number) =>
  `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke-width="1.4" stroke-linecap="round">` +
  [0, 60, 120]
    .map((a) => `<g transform="rotate(${a})"><path d="M0-10V10M-3-7L0-4L3-7M-3 7L0 4L3 7"/></g>`)
    .join("") +
  `</g>`;

const wave = (y: number, w = 120, amp = 6, sw = 1.6) => {
  const seg = w / 4;
  return `<path fill="none" stroke-width="${sw}" stroke-linecap="round" d="M0 ${y}Q${seg / 2} ${y - amp} ${seg} ${y}T${seg * 2} ${y}T${seg * 3} ${y}T${seg * 4} ${y}"/>`;
};

/** A wave that starts and ends inside the frame, for compositions (tiles use `wave`, which must meet its neighbour). */
const waveSeg = (x0: number, x1: number, y: number, amp: number, sw: number) => {
  const seg = (x1 - x0) / 4;
  return `<path fill="none" stroke-width="${sw}" stroke-linecap="round" d="M${n(x0)} ${y}Q${n(x0 + seg / 2)} ${y - amp} ${n(x0 + seg)} ${y}T${n(x0 + seg * 2)} ${y}T${n(x0 + seg * 3)} ${y}T${n(x1)} ${y}"/>`;
};

const dot = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;

const heart = (x: number, y: number, s: number, rot = 0) =>
  `<path transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" d="M0 6C-4 3-8 0-8-3.5-8-6-6-8-3.8-8-2.2-8-.8-7.2 0-5.8.8-7.2 2.2-8 3.8-8 6-8 8-6 8-3.5 8 0 4 3 0 6Z"/>`;

const sun = (x: number, y: number, s: number) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><circle r="4.2"/><g fill="none" stroke-width="1.6" stroke-linecap="round">` +
  [0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => {
      const r = (a * Math.PI) / 180;
      return `<path d="M${n(Math.cos(r) * 6.6)} ${n(Math.sin(r) * 6.6)}L${n(Math.cos(r) * 9.4)} ${n(Math.sin(r) * 9.4)}"/>`;
    })
    .join("") +
  `</g></g>`;

const TILES: Record<Art, string> = {
  petals: blossom(30, 34, 1, 10) + blossom(88, 84, 0.8, 40) + petal(80, 26, 30) + petal(22, 92, -20) + petal(58, 60, 70, 0.8) + dot(104, 46, 1.4),
  sparkles: sparkle(28, 30, 0.9) + sparkle(86, 78, 0.6) + sparkle(98, 24, 0.35) + dot(50, 94, 1.6) + dot(14, 70, 1.1) + dot(66, 48, 1),
  leaves: leaf(30, 36, 35, 1) + leaf(88, 86, -25, 0.8) + leaf(94, 24, 70, 0.5) + dot(40, 96, 1.4),
  snow: snowflake(30, 32, 1) + snowflake(90, 86, 0.7) + dot(90, 28, 1.6) + dot(22, 96, 1.3) + dot(60, 58, 1),
  waves: `<g stroke-opacity="0.9">${wave(40)}</g><g stroke-opacity="0.55">${wave(84)}</g>` + dot(102, 18, 1.4),
  dots: dot(20, 20, 1.8) + dot(80, 20, 1.8) + dot(50, 60, 1.8) + dot(20, 100, 1.8) + dot(80, 100, 1.8),
  hearts: heart(30, 36, 1) + heart(88, 86, 0.75, -12) + heart(94, 26, 0.45, 15) + dot(46, 96, 1.4) + dot(14, 70, 1),
};

const MOTIFS: Record<Art, string> = {
  petals:
    `<path d="M8 152C80 124 118 72 208 52S298 22 316 12" fill="none" stroke-width="3" stroke-linecap="round" stroke-opacity="0.45"/>` +
    blossom(70, 124, 1.8, 12) + blossom(132, 88, 2.2, 38) + blossom(204, 56, 1.7, 5) + blossom(266, 32, 1.3, 50) +
    petal(160, 132, 40, 1.6) + petal(236, 112, -30, 1.3) + petal(96, 58, 60, 1.2) + sparkle(292, 92, 0.7) + sparkle(40, 70, 0.5),
  sparkles:
    sparkle(160, 80, 4) + sparkle(88, 48, 2) + sparkle(238, 112, 1.6) + sparkle(252, 38, 1.1) + sparkle(64, 120, 0.9) +
    dot(120, 132, 2.4) + dot(206, 30, 2) + dot(290, 80, 1.8) + dot(30, 40, 1.6),
  leaves:
    leaf(62, 58, 30, 2.2) + leaf(128, 110, -40, 2.6) + leaf(196, 50, 65, 1.9) + leaf(256, 118, -15, 2.3) + leaf(292, 44, 45, 1.3) +
    dot(98, 140, 2) + dot(226, 146, 1.6),
  // Composed, not cropped: the snowbank is a mound that tapers to the ground inside the frame, so the scene reads as a
  // vignette at any size instead of a strip cut from a wider picture.
  snow:
    `<path d="M34 150C78 122 124 116 160 128C198 140 238 120 286 150Z" fill-opacity="0.2"/>` +
    `<path d="M96 150C130 136 170 134 214 150Z" fill-opacity="0.2"/>` +
    snowflake(92, 62, 2.4) + snowflake(164, 40, 1.6) + snowflake(236, 74, 2.8) + snowflake(284, 30, 1.1) + snowflake(128, 104, 1.1) +
    dot(52, 104, 2) + dot(200, 112, 1.8) + dot(262, 126, 1.6),
  // A sun that reads as a sun at a glance (disc plus rays) over three waves that narrow as they recede. Every stroke
  // starts and ends inside the frame, so nothing is sliced off at the edges.
  waves:
    `<circle cx="236" cy="52" r="26" fill-opacity="0.32"/><circle cx="236" cy="52" r="15" fill-opacity="0.5"/>` +
    `<g fill="none" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.5">` +
    [0, 45, 90, 135, 180, 225, 270, 315]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<path d="M${n(236 + Math.cos(r) * 33)} ${n(52 + Math.sin(r) * 33)}L${n(236 + Math.cos(r) * 43)} ${n(52 + Math.sin(r) * 43)}"/>`;
      })
      .join("") +
    `</g>` +
    sparkle(98, 44, 1.1) + sparkle(146, 24, 0.6) + dot(66, 72, 2) +
    `<g stroke-opacity="0.95">${waveSeg(44, 276, 108, 12, 2.6)}</g><g stroke-opacity="0.6">${waveSeg(74, 246, 128, 9, 2.2)}</g><g stroke-opacity="0.35">${waveSeg(108, 212, 146, 6, 2)}</g>`,
  dots: [0, 1, 2, 3, 4, 5, 6, 7, 8]
    .map((i) => dot(n(40 + i * 30), n(110 - Math.sin((i / 8) * Math.PI) * 70), n(2.5 + Math.sin((i / 8) * Math.PI) * 3)))
    .join(""),
  hearts:
    heart(118, 86, 3.2, -8) + heart(196, 60, 2.2, 12) + heart(254, 110, 1.5, -15) + heart(68, 50, 1.2, 10) +
    sparkle(160, 28, 0.9) + sparkle(284, 52, 0.6) + dot(96, 134, 2) + dot(230, 142, 1.8),
};

/** One small glyph per art key (24x24), for the ornaments that dress headings, cards, fields and the nav. */
const GLYPHS: Record<Art, string> = {
  petals: blossom(12, 12.4, 0.8),
  sparkles: sparkle(12, 12, 1.02),
  leaves: leaf(12, 12, 35, 0.88),
  snow: snowflake(12, 12, 1),
  waves: sun(12, 12, 1.12),
  dots: dot(12, 7, 2.4) + dot(7, 15.5, 2.4) + dot(17, 15.5, 2.4),
  hearts: heart(12, 13, 1.25),
};

/** Corner flourishes (64x64), composed to sit in a card's top-right corner. */
const CORNERS: Record<Art, string> = {
  petals:
    `<path d="M64 2C50 8 40 18 30 34" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-opacity="0.5"/>` +
    blossom(46, 15, 0.85, 20) + blossom(33, 31, 0.62, 50) + petal(22, 45, 30, 0.9) + dot(56, 32, 1.4),
  sparkles: sparkle(46, 18, 1.1) + sparkle(28, 34, 0.6) + sparkle(54, 44, 0.45) + dot(34, 12, 1.3) + dot(58, 8, 1),
  leaves:
    `<path d="M64 0C54 10 44 22 36 38" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.5"/>` +
    leaf(50, 14, 50, 1) + leaf(40, 32, -20, 0.78) + dot(28, 46, 1.3),
  snow: snowflake(46, 16, 1.2) + snowflake(30, 36, 0.7) + dot(55, 38, 1.5) + dot(22, 18, 1.2) + dot(40, 50, 1),
  waves: sun(48, 16, 1.15) + `<g stroke-opacity="0.7">${wave(40, 64, 4, 1.4)}</g>`,
  dots: dot(52, 12, 3) + dot(41, 22, 2.4) + dot(31, 33, 1.8) + dot(23, 45, 1.3),
  hearts: heart(48, 17, 1.1, 12) + heart(33, 33, 0.72, -10) + heart(52, 42, 0.48, 20) + dot(24, 16, 1.4),
};

/** Sprigs (96x40): horizontal pieces for the composer's edge and the foot of the sidebar. */
const SPRIGS: Record<Art, string> = {
  petals:
    `<path d="M4 34C28 30 52 22 92 8" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.5"/>` +
    blossom(30, 27, 0.75, 10) + blossom(60, 19, 0.9, 40) + blossom(84, 11, 0.55, 5) + petal(46, 33, 60, 0.8),
  sparkles: sparkle(20, 24, 0.7) + sparkle(46, 16, 1.1) + sparkle(74, 24, 0.8) + dot(34, 31, 1.4) + dot(60, 31, 1.2) + dot(88, 13, 1.2),
  leaves:
    `<path d="M4 32C30 32 60 22 92 12" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-opacity="0.5"/>` +
    leaf(28, 25, 60, 0.72) + leaf(52, 21, 120, 0.78) + leaf(78, 14, 70, 0.62),
  snow: `<path d="M4 31H92" fill="none" stroke-width="1" stroke-dasharray="2 5" stroke-opacity="0.5"/>` + snowflake(24, 20, 0.85) + snowflake(52, 16, 1.15) + snowflake(80, 21, 0.75),
  waves: `<g stroke-opacity="0.8">${waveSeg(8, 66, 28, 6, 1.8)}</g>` + sun(80, 14, 0.62),
  dots: [0, 1, 2, 3, 4, 5, 6]
    .map((i) => dot(n(10 + i * 13), n(26 - Math.sin((i / 6) * Math.PI) * 13), n(1.4 + Math.sin((i / 6) * Math.PI) * 1.4)))
    .join(""),
  hearts:
    `<path d="M4 30C30 36 60 14 92 20" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.5"/>` +
    heart(26, 30, 0.68, -10) + heart(54, 22, 0.92, 8) + heart(82, 19, 0.58, 14),
};

/**
 * Emblems (96x96): one compact subject per art key, composed for a square slot beside text -- where the home page shows
 * its logo. The wide motifs are scenes; squeezed into a logo's footprint they read as a clipped strip. Everything keeps
 * a margin from the frame.
 */
const EMBLEMS: Record<Art, string> = {
  petals:
    `<path d="M14 82C30 70 44 58 70 22" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.45"/>` +
    blossom(58, 34, 1.5, 12) + blossom(32, 62, 1.05, 40) + petal(74, 64, 30, 1.3) + dot(20, 40, 2),
  sparkles: sparkle(46, 48, 3) + sparkle(76, 20, 1.2) + sparkle(20, 78, 0.9) + dot(80, 72, 2.4) + dot(18, 24, 2),
  leaves: leaf(40, 44, 35, 2.5) + leaf(66, 64, -30, 1.8) + dot(80, 20, 2.2) + dot(18, 82, 1.8),
  snow: snowflake(48, 48, 3.1) + snowflake(80, 18, 1) + snowflake(16, 80, 0.8) + dot(20, 20, 2) + dot(80, 78, 1.8),
  waves:
    sun(60, 32, 1.9) +
    `<g stroke-opacity="0.95">${waveSeg(12, 84, 66, 7, 3.2)}</g><g stroke-opacity="0.55">${waveSeg(24, 72, 80, 5, 2.6)}</g>`,
  dots: dot(48, 48, 5.2) + dot(48, 18, 3.6) + dot(74, 34, 3.2) + dot(74, 62, 2.8) + dot(48, 78, 2.4) + dot(22, 62, 2) + dot(22, 34, 1.6),
  hearts: heart(46, 52, 3.5, -8) + heart(76, 22, 1.4, 14) + heart(20, 80, 1, -12) + sparkle(80, 74, 0.7),
};

const svg = (w: number, h: number, color: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="${color}" stroke="${color}">${body}</svg>`;

/** encodeURIComponent escapes the double quote, so the result is safe inside url("…"). */
const dataUri = (markup: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

const isArt = (key: unknown): key is Art => typeof key === "string" && key !== "none" && key in TILES;

/** A repeatable tile as a CSS value (`url("data:…")`), or null for an unknown key or an invalid colour. */
export function patternTile(key: unknown, color: unknown): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return `url("${dataUri(svg(120, 120, color, TILES[key]))}")`;
}

/** A composed illustration as an <img> src, or null for an unknown key or an invalid colour. */
export function motifSrc(key: unknown, color: unknown): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return dataUri(svg(320, 160, color, MOTIFS[key]));
}

/** A small glyph as a CSS value (`url("data:…")`), or null. `opacity` is a number clamped to 0..1, never text. */
/** Opacity as a number in 0..1 -- never text, so nothing but a digit string reaches the markup. */
const clamp01 = (v: number) => n(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1)));

export function glyphUrl(key: unknown, color: unknown, opacity = 1): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return `url("${dataUri(svg(24, 24, color, `<g opacity="${clamp01(opacity)}">${GLYPHS[key]}</g>`))}")`;
}

/** A corner flourish as a CSS value, or null. */
export function cornerUrl(key: unknown, color: unknown, opacity = 1): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return `url("${dataUri(svg(64, 64, color, `<g opacity="${clamp01(opacity)}">${CORNERS[key]}</g>`))}")`;
}

/** A sprig as a CSS value, or null. */
export function sprigUrl(key: unknown, color: unknown, opacity = 1): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return `url("${dataUri(svg(96, 40, color, `<g opacity="${clamp01(opacity)}">${SPRIGS[key]}</g>`))}")`;
}

/** A lace strip (40x12) -- the glyph small between two dots -- repeated along an edge. */
export function laceUrl(key: unknown, color: unknown, opacity = 1): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  const body = `<g transform="translate(20 6) scale(0.4) translate(-12 -12)">${GLYPHS[key]}</g>` + dot(4, 6, 1) + dot(36, 6, 1);
  return `url("${dataUri(svg(40, 12, color, `<g opacity="${clamp01(opacity)}">${body}</g>`))}")`;
}

/** A square emblem as an <img> src, or null for an unknown key or an invalid colour. */
export function emblemSrc(key: unknown, color: unknown): string | null {
  if (!isArt(key) || !isSkinColor(color)) return null;
  return dataUri(svg(96, 96, color, EMBLEMS[key]));
}

export const ART_KEYS = Object.keys(TILES) as Art[];
