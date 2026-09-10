/**
 * Helpers for drawing a skin's layers in React: container variables, the glow, and which image addresses may be used.
 * Shared by the app's decoration layer (SkinDecor, SkinGreeting) and the settings previews, so both draw a skin the
 * same way and apply the same checks before anything reaches a style attribute or an <img>.
 */
import type { CSSProperties } from "react";
import {
  isSkinColor,
  parseDraftImageUrl,
  parseStoredImageUrl,
  type SkinTokens,
} from "../../../../electron/skins/schema.mjs";

/** A validated colour, or the fallback. */
export const col = (v: unknown, fallback = "transparent"): string => (isSkinColor(v) ? v : fallback);

/**
 * Custom properties for a container, from a skin's tokens. Tailwind's `@theme inline` makes colour utilities read
 * these variables directly, so every bg-surface / text-ink inside the container follows the skin -- which is what
 * lets a preview show a skin without applying it to the app.
 */
export function tokenStyle(tokens: SkinTokens, radius?: number): CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) if (isSkinColor(v)) style[`--${k}`] = v;
  if (typeof radius === "number" && Number.isFinite(radius)) {
    style["--radius"] = `${Math.min(28, Math.max(0, Math.round(radius)))}px`;
  }
  return style as CSSProperties;
}

/** Only this app's own skin images -- stored, or editor drafts -- may reach an <img> or a style. */
export const safeImage = (url: unknown): string | null =>
  typeof url === "string" && (parseStoredImageUrl(url) || parseDraftImageUrl(url)) ? url : null;

/** The soft accent-coloured light behind a skin with `glow`. */
export function glowBackground(primary: unknown): string | undefined {
  if (!isSkinColor(primary)) return undefined;
  return (
    `radial-gradient(60% 55% at 85% 0%, color-mix(in srgb, ${primary} 22%, transparent), transparent 70%), ` +
    `radial-gradient(55% 50% at 5% 100%, color-mix(in srgb, ${primary} 14%, transparent), transparent 70%)`
  );
}

/** Fallback veil over a backdrop image when a skin does not set one: dim enough for text, light enough to see the picture. */
export const DEFAULT_VEIL = 0.72;
