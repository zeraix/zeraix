/**
 * Skin schema: the one definition of what a skin may contain, shared by the main process and the renderer.
 *
 * It lives under electron/ because that is the only source tree the packaged main process can load
 * (electron-builder ships electron/** and the static export, never src/). The renderer imports it by relative
 * path and takes its types from schema.d.mts. It imports neither `electron` nor Node built-ins, so both sides
 * can load it -- and so the rules the main process enforces on an imported file are, by construction, the same
 * rules the renderer applies to what it is handed.
 *
 * The security model is the colour-only one, extended to everything a rich skin adds: a skin is DATA drawn from
 * closed vocabularies. Colours pass a strict validator. Fonts, patterns, motifs, frames and image slots are keys
 * into lists defined here. Images are never an address a skin supplies -- only the
 * `app://localhost/__skins/<id>/<slot>.<ext>` URL the main process assigns after checking the bytes itself.
 * Nothing a skin carries can name a remote host, a local path, or a line of CSS.
 */

/** Every palette token a skin may set. */
export const SKIN_TOKENS = Object.freeze([
  "background",
  "surface",
  "surface-muted",
  "surface-hover",
  "surface-active",
  "line",
  "line-strong",
  "ink",
  "ink-muted",
  "ink-subtle",
  "primary",
  "primary-foreground",
  "accent-ink",
  "sidebar",
  "scrollbar-thumb",
]);

/**
 * Font stacks, by key. System fonts only: nothing is downloaded, so a skin cannot use font loading as a beacon,
 * and a skin works offline. Each stack lists macOS, Windows and CJK faces before its generic family, so the
 * character of the choice survives whichever of them the machine actually has.
 */
export const FONT_STACKS = Object.freeze({
  system: "",
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif',
  script: '"Segoe Script", "Snell Roundhand", "Brush Script MT", "STKaiti", "KaiTi", cursive',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "BiauKai", serif',
  mono: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace',
});
export const FONT_KEYS = Object.freeze(Object.keys(FONT_STACKS));

/** Decorative artwork, drawn in code (see src/components/theme/skins/patterns.ts). Used as tiles and as motifs. */
export const PATTERN_KEYS = Object.freeze(["none", "petals", "sparkles", "leaves", "snow", "waves", "dots", "hearts"]);

/** Where a skin's own images go: behind the app, above the empty-chat greeting, and in the corner. */
export const IMAGE_SLOTS = Object.freeze(["backdrop", "hero", "corner"]);
export const IMAGE_EXTS = Object.freeze(["png", "jpg", "webp", "gif"]);
export const CORNER_FRAMES = Object.freeze(["polaroid", "round", "plain"]);

/**
 * How a skin moves. `drift`: the background pattern slides slowly. `fall`: the skin's glyph falls across the app
 * (petals, snow, leaves). `twinkle`: glyphs fade in and out in place (stars). `sway`: only the illustrations float.
 * All of it is CSS transform/opacity on composited layers, and all of it stops for prefers-reduced-motion or when the
 * person turns skin animations off.
 */
export const MOTION_KEYS = Object.freeze(["none", "drift", "fall", "twinkle", "sway"]);

/**
 * Per-component detailing: how a skin finishes each kind of control beyond colour. Every value is a key into these
 * lists. The CSS a key selects lives in globals.css ("skin details"); nothing a skin carries ever reaches that CSS --
 * the key only switches a data attribute on <html>, and the ornament is a glyph drawn in code.
 */
export const DETAIL_OPTIONS = Object.freeze({
  ornament: PATTERN_KEYS,
  buttons: Object.freeze(["flat", "soft", "glow", "gradient"]),
  fields: Object.freeze(["outline", "soft", "underline"]),
  cards: Object.freeze(["flat", "soft", "lifted", "outlined"]),
  headings: Object.freeze(["plain", "ornament", "underline"]),
  nav: Object.freeze(["pill", "bar", "glow"]),
  /** Card corners: a drawn flourish tucked into the top-right, or the small glyph bottom-right. */
  cardCorner: Object.freeze(["none", "sprig", "glyph"]),
});

/** Decorative pieces a skin switches on per component: a glyph beside button labels, a sprig along the composer's
 *  edge, a flourish at the foot of the sidebar, a lace edge along the top of dialogs. */
export const DETAIL_FLAGS = Object.freeze(["accentScrollbar", "buttonGlyph", "composerSprig", "sidebarFlourish", "dialogLace"]);

export const LIMITS = Object.freeze({
  /** Per image, as stored. Enough for a sharp 2560px WebP or a short animated GIF; small enough that a folder of
   *  skins stays small. */
  imageBytes: 5 * 1024 * 1024,
  /** A whole package: manifest plus three images plus slack. Also the cap on what a zip may inflate to. */
  packageBytes: 20 * 1024 * 1024,
  radiusMax: 28,
  /** Past this a pattern stops decorating and starts competing with the text on top of it. */
  patternOpacityMax: 0.6,
  /** The veil over a backdrop image. The floor is a readability guarantee: text must never sit on a bare photo. */
  veilMin: 0.35,
  veilMax: 0.95,
  name: 40,
  description: 140,
  author: 40,
  version: 16,
  greetingTitle: 60,
  greetingSubtitle: 120,
});

/** Custom UI font size, in CSS px. The root size every rem-based length scales from. */
export const FONT_PX = Object.freeze({ min: 12, max: 24, default: 16 });

export const SKIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** Built-in ids plus "none". A store or custom skin may not take one, or it would shadow the real skin. */
export const RESERVED_SKIN_IDS = Object.freeze(["none", "spring", "summer", "autumn", "winter"]);

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
const STORED_IMAGE_RE =
  /^app:\/\/localhost\/__skins\/([a-z0-9][a-z0-9-]{1,39})\/(backdrop|hero|corner)\.(png|jpg|webp|gif)(?:\?v=(\d{1,16}))?$/;

/** Hex or numeric rgb()/rgba() only: no names, no functions beyond rgb, nothing that could carry a url(). */
export function isSkinColor(v) {
  return typeof v === "string" && v.length <= 32 && (HEX_RE.test(v) || RGB_RE.test(v));
}

/** A valid id for a store or custom skin (never a reserved one). */
export function isSkinId(v) {
  return typeof v === "string" && SKIN_ID_RE.test(v) && !RESERVED_SKIN_IDS.includes(v);
}

export function isFontPx(v) {
  return Number.isInteger(v) && v >= FONT_PX.min && v <= FONT_PX.max;
}

/** Round and clamp anything numeric into the font-px range; non-numbers fall back to the default. */
export function clampFontPx(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(FONT_PX.max, Math.max(FONT_PX.min, n)) : FONT_PX.default;
}

/** The only image address a stored skin may hold. `version` busts the cache when an image is replaced. */
export function storedImageUrl(id, slot, ext, version) {
  if (!isSkinId(id) || !IMAGE_SLOTS.includes(slot) || !IMAGE_EXTS.includes(ext)) {
    throw new Error("invalid stored image reference");
  }
  const v = Number.isInteger(version) && version >= 0 ? `?v=${version}` : "";
  return `app://localhost/__skins/${id}/${slot}.${ext}${v}`;
}

const DRAFT_IMAGE_RE =
  /^app:\/\/localhost\/__skins\/([a-z0-9][a-z0-9-]{1,39})\/(backdrop|hero|corner)-draft\.(png|jpg|webp|gif)(?:\?v=(\d{1,16}))?$/;

/**
 * An image picked in the editor but not saved yet. Deliberately NOT a stored image: sanitizeSkin refuses it, so no
 * persisted skin can hold one, and only the main process's save step turns a draft into a stored image.
 */
export function draftImageUrl(id, slot, ext, version) {
  if (!isSkinId(id) || !IMAGE_SLOTS.includes(slot) || !IMAGE_EXTS.includes(ext)) {
    throw new Error("invalid draft image reference");
  }
  const v = Number.isInteger(version) && version >= 0 ? `?v=${version}` : "";
  return `app://localhost/__skins/${id}/${slot}-draft.${ext}${v}`;
}

export function parseDraftImageUrl(url) {
  if (typeof url !== "string") return null;
  const m = DRAFT_IMAGE_RE.exec(url);
  if (!m || RESERVED_SKIN_IDS.includes(m[1])) return null;
  return { id: m[1], slot: m[2], ext: m[3] };
}

export function parseStoredImageUrl(url) {
  if (typeof url !== "string") return null;
  const m = STORED_IMAGE_RE.exec(url);
  if (!m || RESERVED_SKIN_IDS.includes(m[1])) return null;
  return { id: m[1], slot: m[2], ext: m[3] };
}

/**
 * Identify an image by its bytes, not its name or claimed type. PNG, JPEG, WebP and GIF (animated GIFs play). Never
 * SVG, which can carry script and external references; anything unrecognised is refused.
 */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  return null;
}

const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined);

/** A finite number clamped into range, or undefined. Clamped rather than refused: templates are edited by hand. */
function num(v, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

export function sanitizeTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const token of SKIN_TOKENS) {
    if (isSkinColor(raw[token])) out[token] = raw[token];
  }
  return out;
}

function sanitizeFonts(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const role of ["display", "body"]) {
    if (FONT_KEYS.includes(raw[role]) && raw[role] !== "system") out[role] = raw[role];
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeDecor(raw, id) {
  if (!raw || typeof raw !== "object") return undefined;
  const d = {};
  if (PATTERN_KEYS.includes(raw.pattern) && raw.pattern !== "none") d.pattern = raw.pattern;
  const po = num(raw.patternOpacity, 0, LIMITS.patternOpacityMax);
  if (po !== undefined) d.patternOpacity = Math.round(po * 100) / 100;
  if (PATTERN_KEYS.includes(raw.motif) && raw.motif !== "none") d.motif = raw.motif;
  if (raw.glow === true) d.glow = true;
  if (MOTION_KEYS.includes(raw.motion) && raw.motion !== "none") d.motion = raw.motion;
  const veil = num(raw.veil, LIMITS.veilMin, LIMITS.veilMax);
  if (veil !== undefined) d.veil = Math.round(veil * 100) / 100;
  if (CORNER_FRAMES.includes(raw.cornerFrame)) d.cornerFrame = raw.cornerFrame;
  if (raw.images && typeof raw.images === "object") {
    const images = {};
    for (const slot of IMAGE_SLOTS) {
      const p = parseStoredImageUrl(raw.images[slot]);
      // The image must belong to THIS skin and THIS slot: one skin pointing at another's files is refused.
      if (p && p.id === id && p.slot === slot) images[slot] = raw.images[slot];
    }
    if (Object.keys(images).length) d.images = images;
  }
  return Object.keys(d).length ? d : undefined;
}

function sanitizeDetails(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const [key, allowed] of Object.entries(DETAIL_OPTIONS)) {
    if (allowed.includes(raw[key]) && raw[key] !== "none") out[key] = raw[key];
  }
  for (const flag of DETAIL_FLAGS) {
    if (raw[flag] === true) out[flag] = true;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reduce an untrusted object to a valid store or custom skin, or null.
 *
 * `origin` is decided by the caller, never read from the input: whether a skin is editable is not something
 * the skin gets to claim. Unknown fields are dropped silently, which is what lets a template carry `_help`
 * notes. i18n keys are never accepted from outside -- a non-built-in skin names itself in plain text.
 */
export function sanitizeSkin(raw, { origin = "custom" } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id;
  if (!isSkinId(id)) return null;
  const name = text(raw.name, LIMITS.name);
  if (!name) return null;
  const light = sanitizeTokens(raw.light);
  const dark = sanitizeTokens(raw.dark);
  if (Object.keys(light).length === 0 || Object.keys(dark).length === 0) return null;

  const skin = { id, builtin: false, origin: origin === "store" ? "store" : "custom", name, light, dark };
  const description = text(raw.description, LIMITS.description);
  if (description) skin.description = description;
  const author = text(raw.author, LIMITS.author);
  if (author) skin.author = author;
  const version = text(raw.version, LIMITS.version);
  if (version) skin.version = version;
  const radius = num(raw.radius, 0, LIMITS.radiusMax);
  if (radius !== undefined) skin.radius = Math.round(radius);
  const fonts = sanitizeFonts(raw.fonts);
  if (fonts) skin.fonts = fonts;
  const decor = sanitizeDecor(raw.decor, id);
  if (decor) skin.decor = decor;
  const details = sanitizeDetails(raw.details);
  if (details) skin.details = details;
  if (raw.greeting && typeof raw.greeting === "object") {
    const title = text(raw.greeting.title, LIMITS.greetingTitle);
    const subtitle = text(raw.greeting.subtitle, LIMITS.greetingSubtitle);
    if (title || subtitle) skin.greeting = { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}) };
  }
  return skin;
}
