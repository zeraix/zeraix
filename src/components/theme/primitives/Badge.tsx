"use client";

/**
 * Badge -- a small pill of text in one of a few preset schemes. Variants map onto the app's
 * status tokens (globals.css) rather than accepting colors, so badges always sit inside the
 * active palette.
 */
import type React from "react";
import { safeProps, type PrimitiveProps } from "./common";
import { badgeSchema, type BadgeVariant } from "./schemas";

const tint = (token: string) => `color-mix(in srgb, var(${token}) 12%, transparent)`;

const VARIANTS: Readonly<Record<BadgeVariant, React.CSSProperties>> = {
  neutral: { background: "var(--surface-hover)", color: "var(--ink-muted)" },
  primary: { background: tint("--primary"), color: "var(--primary)" },
  success: { background: tint("--success"), color: "var(--success-ink)" },
  warning: { background: tint("--warning"), color: "var(--warning-ink)" },
  danger: { background: tint("--danger"), color: "var(--danger-ink)" },
  info: { background: tint("--info"), color: "var(--info-ink)" },
};

const SIZES = {
  sm: { fontSize: 11, padding: "1px 6px", minHeight: 18 },
  md: { fontSize: 12, padding: "2px 8px", minHeight: 22 },
} as const;

export function Badge(props: PrimitiveProps) {
  const { props: p } = safeProps("badge", badgeSchema, props);
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    fontWeight: 500,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
    ...SIZES[p.size],
    ...VARIANTS[p.variant],
  };
  return <span style={style}>{p.text}</span>;
}
Badge.displayName = "Primitive.Badge";
