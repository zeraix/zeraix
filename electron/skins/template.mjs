/**
 * The downloadable skin template: a zip a person unpacks, edits, and imports back.
 *
 * skin.json carries its instructions in a `_help` object -- JSON has no comments, and sanitizeSkin drops unknown
 * fields, so the notes never reach an installed skin. The placeholder images are real PNGs at the suggested sizes,
 * generated here, so the folder imports and previews correctly before anything is replaced and a person can see the
 * shape each slot wants.
 */
import { nativeImage } from "electron";
import { writeZip } from "./zipio.mjs";

const TEMPLATE = {
  _help: {
    about:
      "Edit this file and replace the images, then in Zeraix open Settings > Appearance > Skin store > Import and choose this skin.json (or zip the folder and choose the zip). Fields you delete fall back to defaults; unknown fields, like this _help, are ignored.",
    id: "Lowercase letters, digits and dashes, 2 to 40 characters. If it is taken, the import picks a new one.",
    name: "Required. Up to 40 characters. description (140), author (40) and version (16) are optional.",
    light_dark:
      "Both required, with at least one colour each. Keys: background, surface, surface-muted, surface-hover, surface-active, line, line-strong, ink, ink-muted, ink-subtle, primary, primary-foreground, accent-ink, sidebar, scrollbar-thumb. Values: #rgb, #rrggbb, #rrggbbaa, rgb() or rgba(). Keep primary-foreground readable on primary.",
    radius: "Corner radius in px, 0 to 28.",
    fonts: "display (greeting and headings) and body: system, serif, rounded, script, kai or mono. Fonts already on the computer only.",
    decor:
      "pattern (tiled behind the app) and motif (drawn above the greeting when there is no hero image): none, petals, sparkles, leaves, snow, waves, dots. patternOpacity 0 to 0.6. glow true or false. veil 0.35 to 0.95: how strongly a backdrop image is dimmed so text stays readable. cornerFrame: polaroid, round or plain. motion: none, drift (the pattern slides), fall (petals, snow or leaves fall), twinkle (glyphs fade in and out), sway (illustrations float). Animations always stop when the viewer turns them off or asks their system for reduced motion.",
    images:
      "backdrop.png, hero.png and corner.png beside this file (.jpg, .webp and .gif work too; animated GIFs play). PNG, JPEG, WebP or GIF, 5 MB each. Delete a file to leave that slot empty. Suggested sizes: backdrop 1920x1200, hero 1200x400, corner 600x720.",
    greeting: "Optional. title (60 characters) and subtitle (120) replace the empty-chat greeting.",
    details:
      "How each kind of component is finished. ornament: none, petals, sparkles, leaves, snow, waves, dots, hearts (a small glyph on headings, cards, the composer and the selected nav row). buttons: flat, soft, glow, gradient. fields: outline, soft, underline. cards: flat, soft, lifted, outlined. headings: plain, ornament, underline. nav: pill, bar, glow. accentScrollbar: true or false. Decorative pieces, each true or false: cardCorner (none, sprig or glyph), buttonGlyph (glyph beside button labels), composerSprig (a sprig on the message box edge), sidebarFlourish (a flourish at the foot of the sidebar), dialogLace (a lace edge on dialogs).",
  },
  id: "my-skin",
  name: "My skin",
  description: "A skin made from the Zeraix template.",
  author: "",
  version: "1.0.0",
  radius: 16,
  fonts: { display: "serif", body: "system" },
  light: {
    background: "#f7eff1", surface: "#fffafb", "surface-muted": "#f2e7ea", "surface-hover": "#eadcdf",
    "surface-active": "#dfcdd2", line: "#e6d5da", "line-strong": "#d3bcc3", ink: "#241b1e",
    "ink-muted": "#67585d", "ink-subtle": "#957f86", primary: "#b44a6e", "primary-foreground": "#ffffff",
    "accent-ink": "#9a3c5c", sidebar: "#f3e6ea", "scrollbar-thumb": "rgba(36, 27, 30, 0.18)",
  },
  dark: {
    background: "#171113", surface: "#1f171b", "surface-muted": "#281e23", "surface-hover": "#33272d",
    "surface-active": "#3e3037", line: "rgba(255, 255, 255, 0.12)", "line-strong": "rgba(255, 255, 255, 0.2)",
    ink: "#f5eaee", "ink-muted": "#ac9aa1", "ink-subtle": "#87767d", primary: "#f09ab8",
    "primary-foreground": "#210b13", "accent-ink": "#f4aec6", sidebar: "#1b1418",
    "scrollbar-thumb": "rgba(255, 255, 255, 0.16)",
  },
  decor: { pattern: "petals", patternOpacity: 0.12, motif: "petals", glow: true, motion: "fall", veil: 0.72, cornerFrame: "polaroid" },
  details: { ornament: "hearts", buttons: "glow", fields: "soft", cards: "soft", headings: "ornament", nav: "pill", cardCorner: "sprig", buttonGlyph: true, composerSprig: true, sidebarFlourish: true, dialogLace: true, accentScrollbar: true },
  greeting: { title: "What shall we make today?", subtitle: "Type below to begin." },
};

const README = `Zeraix skin template
====================

1. Unzip this folder anywhere.
2. Edit skin.json. Every field is explained in its "_help" section.
3. Replace backdrop.png, hero.png and corner.png with your own pictures
   (PNG, JPEG, WebP or GIF, up to 5 MB each; animated GIFs play), keeping
   those names (the extension may change).
   Delete a picture to leave that place empty.
   Suggested sizes: backdrop 1920 x 1200, hero 1200 x 400, corner 600 x 720.
4. In Zeraix: Settings > Appearance > Skin store > Import, then choose
   skin.json (or zip the folder again and choose the .zip).

Only use pictures you have the right to use.
`;

/** Paint an RGB bitmap and encode it as PNG through Electron. nativeImage takes the platform's BGRA byte order. */
function nativePng(width, height, paint) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y, width, height);
      const i = (y * width + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width, height }).toPNG();
}

/** A soft two-tone gradient with faint diagonal bands and a border: unmistakably a placeholder, pleasant enough to keep. */
function placeholder([r1, g1, b1], [r2, g2, b2]) {
  return (x, y, w, h) => {
    const t = (x / w + y / h) / 2;
    const band = Math.floor((x + y) / 36) % 2 === 0 ? 0 : 6;
    const edge = x < 6 || y < 6 || x >= w - 6 || y >= h - 6 ? 18 : 0;
    const c = (a, b) => Math.round(a + (b - a) * t) - band - edge;
    return [c(r1, r2), c(g1, g2), c(b1, b2)];
  };
}

export function buildTemplateZip({ makePng = nativePng } = {}) {
  return writeZip([
    { name: "zeraix-skin-template/skin.json", data: Buffer.from(JSON.stringify(TEMPLATE, null, 2)) },
    { name: "zeraix-skin-template/README.txt", data: Buffer.from(README) },
    { name: "zeraix-skin-template/backdrop.png", data: makePng(1600, 1000, placeholder([250, 236, 240], [240, 214, 224])) },
    { name: "zeraix-skin-template/hero.png", data: makePng(1200, 400, placeholder([244, 206, 220], [252, 238, 242])) },
    { name: "zeraix-skin-template/corner.png", data: makePng(600, 720, placeholder([248, 226, 233], [232, 190, 206])) },
  ]);
}

/** Exposed for tests: the manifest a template import must accept. */
export const TEMPLATE_MANIFEST = TEMPLATE;
