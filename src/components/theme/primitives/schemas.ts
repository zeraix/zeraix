/**
 * Props schemas for the skin primitive library (Stage 6.1).
 *
 * Kept free of React so `test/skin-primitives.test.mjs` can import it under plain node. Every schema
 * parses `{}` to a complete, safe default -- that is what a primitive renders when a skin package hands
 * it something invalid. Colors take CSS variable references as the preferred form (`var(--primary)`),
 * so primitives inherit whatever tokens.css the active skin provides; nothing here can smuggle a url(),
 * a script, an external image, or an SVG path string. Unknown keys (an `onClick`, say) are stripped,
 * never rejected: this layer is presentational only.
 */
import { z } from "zod";
import { ICON_NAMES, PRIMITIVE_KEYS, type PrimitiveKey } from "../../../../electron/skins/layoutRefs.mjs";

/* ------------------------------------------------------------------------------------------------
 * Shared value schemas
 * ---------------------------------------------------------------------------------------------- */

/** Substrings no color or background value may contain, whatever the surrounding syntax. */
const FORBIDDEN = /url\(|expression|[;<>\\]/i;

const HEX = "#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})";
/** rgb()/rgba()/hsl()/hsla() with 3-4 numeric or percentage arguments, comma, space or slash separated. */
const FUNCTIONAL = "(?:rgba?|hsla?)\\(\\s*-?\\d+(?:\\.\\d+)?%?(?:\\s*[,/]?\\s*-?\\d+(?:\\.\\d+)?%?){2,3}\\s*\\)";
/** `var(--name)` or `var(--name, #hex)`; the fallback is limited to hex so it cannot nest anything. */
const VAR_REF = `var\\(--[a-z0-9-]+(?:\\s*,\\s*${HEX})?\\)`;
const COLOR_KEYWORD = "(?:transparent|currentcolor)";
const COLOR = `(?:${VAR_REF}|${FUNCTIONAL}|${HEX}|${COLOR_KEYWORD})`;
const COLOR_RE = new RegExp(`^${COLOR}$`, "i");

const PERCENT = "\\d+(?:\\.\\d+)?%";
const ANGLE = "-?\\d+(?:\\.\\d+)?(?:deg|turn)";
const GRADIENT_WORD = "(?:to|left|right|top|bottom|center|circle|ellipse|at)";
const GRADIENT_TOKEN = `(?:${COLOR}|${PERCENT}|${ANGLE}|${GRADIENT_WORD})`;
/** A linear/radial gradient whose contents are only colors, percentages, angles, direction words, commas and spaces. */
const GRADIENT_RE = new RegExp(
  `^(?:linear|radial)-gradient\\(\\s*${GRADIENT_TOKEN}(?:(?:\\s*,\\s*|\\s+)${GRADIENT_TOKEN})*\\s*\\)$`,
  "i",
);

const ASSET_RE = /^assets\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|webp|gif|svg)$/i;

export function isCssColor(value: string): boolean {
  return value.length <= 64 && !FORBIDDEN.test(value) && COLOR_RE.test(value);
}

export function isCssGradient(value: string): boolean {
  return value.length <= 400 && !FORBIDDEN.test(value) && GRADIENT_RE.test(value);
}

/** A single color: hex, rgb()/hsl(), `var(--token)`, `transparent` or `currentColor`. */
export const cssColor = z
  .string()
  .max(64)
  .refine(isCssColor, { message: "Expected a hex, rgb()/hsl(), var(--token), transparent or currentColor value" });

/** A cssColor or a linear-/radial-gradient() built only from colors, percentages, angles and direction words. */
export const cssBackground = z
  .string()
  .max(400)
  .refine((v) => isCssColor(v) || isCssGradient(v), {
    message: "Expected a color or a linear-gradient()/radial-gradient() of colors",
  });

/** A file inside the skin package's assets/ directory; served through skin://current/. */
export const assetPath = z
  .string()
  .max(200)
  .regex(ASSET_RE, { message: "Expected assets/<name>.(png|jpg|jpeg|webp|gif|svg)" })
  .refine((v) => !v.includes("..") && !v.includes("//"), { message: "Path may not contain .. or //" });

export const shadowPreset = z.enum(["none", "sm", "md", "lg", "glow"]);
export type ShadowPreset = z.infer<typeof shadowPreset>;

/** A pixel measure inside [min, max]. */
const px = (min: number, max: number) => z.number().min(min).max(max);
const percent = z.number().min(0).max(100);
const unitInterval = z.number().min(0).max(1);
const borderRadius = px(0, 64);

/* ------------------------------------------------------------------------------------------------
 * Icon names -- the only icons a skin may ask for. The list lives in electron/skins/layoutRefs.mjs,
 * because the engine checks sidebar.json's `icon:<name>` values against the same list; the map to
 * lucide components lives in icons.ts, typed against this tuple so all three stay in step.
 * ---------------------------------------------------------------------------------------------- */

export { ICON_NAMES };
export type IconName = (typeof ICON_NAMES)[number];

/* ------------------------------------------------------------------------------------------------
 * Per-primitive schemas
 * ---------------------------------------------------------------------------------------------- */

export const boxSchema = z.object({
  background: cssBackground.default("transparent"),
  borderRadius: borderRadius.default(12),
  borderWidth: px(0, 8).default(0),
  borderColor: cssColor.default("var(--line)"),
  padding: px(0, 64).default(0),
  shadow: shadowPreset.default("none"),
  backdropBlur: px(0, 20).default(0),
  opacity: unitInterval.default(1),
});

export const textSchema = z.object({
  content: z.string().max(2000).default(""),
  fontSize: px(8, 96).default(14),
  fontWeight: z.number().int().min(100).max(900).multipleOf(100).default(400),
  color: cssColor.default("var(--ink)"),
  align: z.enum(["left", "center", "right"]).default("left"),
  lineClamp: z.number().int().min(0).max(20).default(0),
  letterSpacing: px(-2, 8).default(0),
  italic: z.boolean().default(false),
  family: z.enum(["display", "body", "mono"]).default("body"),
  /** Render as a block (`<p>`) rather than inline; align and lineClamp imply it. */
  block: z.boolean().default(false),
});

export const iconSchema = z.object({
  name: z.enum(ICON_NAMES).default("sparkles"),
  size: px(8, 128).default(20),
  color: cssColor.default("currentColor"),
  strokeWidth: z.number().min(0.5).max(4).default(2),
});

export const imageSchema = z.object({
  /** Optional so `{}` is a valid (empty) image; without a src nothing is drawn. */
  src: assetPath.optional(),
  fit: z.enum(["cover", "contain"]).default("cover"),
  borderRadius: borderRadius.default(0),
  width: px(0, 2000).optional(),
  height: px(0, 2000).optional(),
  alt: z.string().max(200).default(""),
  opacity: unitInterval.default(1),
});

export const gradientStop = z.object({
  color: cssColor,
  position: percent,
});

/**
 * Stops as one string, `"var(--primary) 0%, transparent 100%"`: layout.json props may only be
 * strings, numbers and booleans, so this is how a layout writes what the array form says. Split
 * on commas at parenthesis depth zero, because `rgba(0, 0, 0, 0.5)` has commas of its own.
 */
export function parseGradientStops(text: string): { color: string; position: number }[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((part) => {
    const m = /^\s*(.+?)\s+(-?\d+(?:\.\d+)?)%?\s*$/.exec(part);
    return m ? { color: m[1], position: Number(m[2]) } : { color: part.trim(), position: Number.NaN };
  });
}

export const gradientStops = z.preprocess((v) => (typeof v === "string" ? parseGradientStops(v) : v), z.array(gradientStop).min(2).max(6));

export const gradientSchema = z.object({
  type: z.enum(["linear", "radial"]).default("linear"),
  /** Direction in degrees; linear only. */
  angle: z.number().min(0).max(360).default(180),
  stops: gradientStops.default([
    { color: "var(--primary)", position: 0 },
    { color: "transparent", position: 100 },
  ]),
  borderRadius: borderRadius.default(0),
  width: px(0, 2000).default(96),
  height: px(0, 2000).default(96),
  /** Stretch to 100% x 100% of the parent instead of the fixed width/height. */
  fill: z.boolean().default(false),
});

export const progressBarSchema = z.object({
  value: percent.default(0),
  color: cssColor.default("var(--primary)"),
  trackColor: cssColor.default("var(--surface-muted)"),
  thickness: px(2, 32).default(6),
  borderRadius: borderRadius.default(16),
  width: px(0, 2000).default(160),
  /** Take the full width of the parent instead of the fixed width. */
  fill: z.boolean().default(true),
});

export const progressRingSchema = z.object({
  value: percent.default(0),
  color: cssColor.default("var(--primary)"),
  trackColor: cssColor.default("var(--surface-muted)"),
  size: px(16, 256).default(48),
  thickness: px(1, 24).default(4),
  /** Print the rounded percentage in the middle of the ring. */
  showValue: z.boolean().default(false),
});

export const dividerSchema = z.object({
  orientation: z.enum(["horizontal", "vertical"]).default("horizontal"),
  thickness: px(1, 8).default(1),
  color: cssColor.default("var(--line)"),
  /** SVG stroke-dasharray, e.g. "4 4"; omitted means a solid line. */
  dashArray: z.string().max(32).regex(/^\d+(\s+\d+)*$/).optional(),
  length: px(0, 2000).default(100),
  /** Span the parent along the line's axis instead of the fixed length. */
  fill: z.boolean().default(true),
});

export const badgeVariant = z.enum(["neutral", "primary", "success", "warning", "danger", "info"]);
export type BadgeVariant = z.infer<typeof badgeVariant>;

export const badgeSchema = z.object({
  text: z.string().max(60).default(""),
  variant: badgeVariant.default("neutral"),
  size: z.enum(["sm", "md"]).default("md"),
});

export const avatarSchema = z.object({
  src: assetPath.optional(),
  initials: z.string().min(1).max(3).optional(),
  size: px(16, 256).default(40),
  shape: z.enum(["circle", "square"]).default("circle"),
  background: cssColor.default("var(--primary)"),
  color: cssColor.default("var(--primary-foreground)"),
  alt: z.string().max(200).default(""),
});

export const shapeKind = z.enum(["circle", "rect", "triangle", "hexagon", "star"]);
export type ShapeKind = z.infer<typeof shapeKind>;

export const shapeSchema = z.object({
  kind: shapeKind.default("circle"),
  fill: cssColor.default("var(--primary)"),
  stroke: cssColor.optional(),
  strokeWidth: px(0, 16).default(0),
  size: px(8, 512).default(48),
  rotate: z.number().min(0).max(360).default(0),
});

export const spacerSchema = z.object({
  size: px(0, 512).default(8),
  /** When set, the spacer grows with `flex: <n> 1 0%` instead of taking a fixed size. */
  flex: z.number().min(0).max(100).optional(),
});

export type BoxProps = z.infer<typeof boxSchema>;
export type TextProps = z.infer<typeof textSchema>;
export type IconProps = z.infer<typeof iconSchema>;
export type ImageProps = z.infer<typeof imageSchema>;
export type GradientProps = z.infer<typeof gradientSchema>;
export type ProgressBarProps = z.infer<typeof progressBarSchema>;
export type ProgressRingProps = z.infer<typeof progressRingSchema>;
export type DividerProps = z.infer<typeof dividerSchema>;
export type BadgeProps = z.infer<typeof badgeSchema>;
export type AvatarProps = z.infer<typeof avatarSchema>;
export type ShapeProps = z.infer<typeof shapeSchema>;
export type SpacerProps = z.infer<typeof spacerSchema>;

/** Every primitive key's schema; typed against PRIMITIVE_KEYS so a new key cannot ship without one. */
export const PRIMITIVE_SCHEMAS: Readonly<Record<PrimitiveKey, z.ZodObject<z.ZodRawShape>>> = Object.freeze({
  box: boxSchema,
  text: textSchema,
  icon: iconSchema,
  image: imageSchema,
  gradient: gradientSchema,
  progressBar: progressBarSchema,
  progressRing: progressRingSchema,
  divider: dividerSchema,
  badge: badgeSchema,
  avatar: avatarSchema,
  shape: shapeSchema,
  spacer: spacerSchema,
});

export { PRIMITIVE_KEYS };
export type { PrimitiveKey };
