/**
 * Helpers shared by the primitive components: prop validation with a safe fallback, the skin:// asset
 * URL, and the shadow presets. No JSX here -- the primitives themselves stay one file each.
 */
import type React from "react";
import type { z } from "zod";
import type { ShadowPreset } from "./schemas";

/** What the layout renderer hands a primitive: whatever layout.json said, plus children for Box. */
export type PrimitiveProps = Record<string, unknown> & { children?: React.ReactNode };

/** Warn about rejected props in development only; production renders the fallback silently. */
export function devWarn(name: string, issues: readonly z.ZodIssue[] | string): void {
  if (process.env.NODE_ENV === "production") return;
  const detail =
    typeof issues === "string"
      ? issues
      : issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
  console.warn(`[skin primitive "${name}"] invalid props, rendering defaults -- ${detail}`);
}

/**
 * Validate a primitive's props. On failure the schema's own defaults are returned (every primitive schema
 * parses `{}`), so a bad layout.json degrades to an empty-but-safe element instead of a crash.
 */
export function safeProps<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  schema: S,
  props: unknown,
): { ok: boolean; props: z.output<S> } {
  const result = schema.safeParse(props ?? {});
  if (result.success) return { ok: true, props: result.data as z.output<S> };
  devWarn(name, result.error.issues);
  return { ok: false, props: schema.parse({}) as z.output<S> };
}

/**
 * The only image source a primitive may use: a file inside the active skin package, served by the
 * skin:// protocol. `src` has already passed assetPath, so it is a relative `assets/...` path.
 */
export function assetUrl(src: string): string {
  return `skin://current/${src}`;
}

/** Box shadow for a preset; `glow` uses the accent color (border or primary) at partial alpha. */
export function styleFromShadow(preset: ShadowPreset, accent = "var(--primary)"): React.CSSProperties {
  switch (preset) {
    case "sm":
      return { boxShadow: "0 1px 2px rgba(0, 0, 0, 0.08)" };
    case "md":
      return { boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)" };
    case "lg":
      return { boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)" };
    case "glow":
      return {
        boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 35%, transparent), 0 0 24px color-mix(in srgb, ${accent} 45%, transparent)`,
      };
    default:
      return {};
  }
}

/** Round to two decimals for SVG path data. */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
