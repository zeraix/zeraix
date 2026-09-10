/** Types for schema.mjs. Keep in step with it: the renderer is typed from this file, not from the JS. */

export type SkinToken =
  | "background" | "surface" | "surface-muted" | "surface-hover" | "surface-active"
  | "line" | "line-strong" | "ink" | "ink-muted" | "ink-subtle"
  | "primary" | "primary-foreground" | "accent-ink" | "sidebar" | "scrollbar-thumb";
export type SkinTokens = Partial<Record<SkinToken, string>>;
export type FontKey = "system" | "serif" | "rounded" | "script" | "kai" | "mono";
export type PatternKey = "none" | "petals" | "sparkles" | "leaves" | "snow" | "waves" | "dots" | "hearts";
export type ImageSlot = "backdrop" | "hero" | "corner";
export type ImageExt = "png" | "jpg" | "webp" | "gif";
export type MotionKey = "none" | "drift" | "fall" | "twinkle" | "sway";
export type CornerFrame = "polaroid" | "round" | "plain";

export interface SkinFonts {
  display?: Exclude<FontKey, "system">;
  body?: Exclude<FontKey, "system">;
}

export interface SkinDecor {
  pattern?: Exclude<PatternKey, "none">;
  patternOpacity?: number;
  /** Artwork drawn above the greeting (and in the corner) when the skin has no image for those slots. */
  motif?: Exclude<PatternKey, "none">;
  /** Soft accent-coloured light behind the app. */
  glow?: boolean;
  /** Movement: see MOTION_KEYS. Always subject to the skin-animations setting and prefers-reduced-motion. */
  motion?: Exclude<MotionKey, "none">;
  /** Opacity of the background-coloured veil over a backdrop image. */
  veil?: number;
  cornerFrame?: CornerFrame;
  images?: Partial<Record<ImageSlot, string>>;
}

/** Per-component finish, beyond colour. See DETAIL_OPTIONS and the "skin details" section of globals.css. */
export interface SkinDetails {
  ornament?: Exclude<PatternKey, "none">;
  buttons?: "flat" | "soft" | "glow" | "gradient";
  fields?: "outline" | "soft" | "underline";
  cards?: "flat" | "soft" | "lifted" | "outlined";
  headings?: "plain" | "ornament" | "underline";
  nav?: "pill" | "bar" | "glow";
  cardCorner?: "sprig" | "glyph";
  accentScrollbar?: boolean;
  buttonGlyph?: boolean;
  composerSprig?: boolean;
  sidebarFlourish?: boolean;
  dialogLace?: boolean;
}

export interface Skin {
  id: string;
  builtin: boolean;
  /** Only for non-built-in skins: "custom" skins are editable, "store" skins are not. */
  origin?: "store" | "custom";
  /** i18n keys, built-in skins only. */
  nameKey?: string;
  descKey?: string;
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  light: SkinTokens;
  dark: SkinTokens;
  /** Base corner radius in px; every rounded-* utility derives from it. */
  radius?: number;
  fonts?: SkinFonts;
  decor?: SkinDecor;
  details?: SkinDetails;
  /** Replaces the empty-chat greeting text. Plain text, rendered as text. */
  greeting?: { title?: string; subtitle?: string };
}

export const SKIN_TOKENS: readonly SkinToken[];
export const FONT_STACKS: Readonly<Record<FontKey, string>>;
export const FONT_KEYS: readonly FontKey[];
export const PATTERN_KEYS: readonly PatternKey[];
export const IMAGE_SLOTS: readonly ImageSlot[];
export const IMAGE_EXTS: readonly ImageExt[];
export const CORNER_FRAMES: readonly CornerFrame[];
export const DETAIL_OPTIONS: Readonly<{
  ornament: readonly PatternKey[];
  buttons: readonly NonNullable<SkinDetails["buttons"]>[];
  fields: readonly NonNullable<SkinDetails["fields"]>[];
  cards: readonly NonNullable<SkinDetails["cards"]>[];
  headings: readonly NonNullable<SkinDetails["headings"]>[];
  nav: readonly NonNullable<SkinDetails["nav"]>[];
  cardCorner: readonly ("none" | NonNullable<SkinDetails["cardCorner"]>)[];
}>;
export const DETAIL_FLAGS: readonly ("accentScrollbar" | "buttonGlyph" | "composerSprig" | "sidebarFlourish" | "dialogLace")[];
export const MOTION_KEYS: readonly MotionKey[];
export const LIMITS: Readonly<{
  imageBytes: number; packageBytes: number; radiusMax: number; patternOpacityMax: number;
  veilMin: number; veilMax: number; name: number; description: number; author: number; version: number;
  greetingTitle: number; greetingSubtitle: number;
}>;
export const FONT_PX: Readonly<{ min: number; max: number; default: number }>;
export const SKIN_ID_RE: RegExp;
export const RESERVED_SKIN_IDS: readonly string[];

export function isSkinColor(v: unknown): v is string;
export function isSkinId(v: unknown): v is string;
export function isFontPx(v: unknown): v is number;
export function clampFontPx(v: unknown): number;
export function storedImageUrl(id: string, slot: ImageSlot, ext: ImageExt, version?: number): string;
export function parseStoredImageUrl(url: unknown): { id: string; slot: ImageSlot; ext: ImageExt } | null;
export function draftImageUrl(id: string, slot: ImageSlot, ext: ImageExt, version?: number): string;
export function parseDraftImageUrl(url: unknown): { id: string; slot: ImageSlot; ext: ImageExt } | null;
export function sniffImage(bytes: Uint8Array | null | undefined): ImageExt | null;
export function sanitizeTokens(raw: unknown): SkinTokens;
export function sanitizeSkin(raw: unknown, opts?: { origin?: "store" | "custom" }): Skin | null;
