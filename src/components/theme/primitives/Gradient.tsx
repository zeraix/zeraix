"use client";

/**
 * Gradient -- a decorative swatch. The CSS gradient string is assembled here from validated stops
 * (each a cssColor plus a 0-100 position), so a skin never hands us raw CSS.
 */
import type React from "react";
import { safeProps, type PrimitiveProps } from "./common";
import { gradientSchema, type GradientProps } from "./schemas";

export function gradientCss(p: Pick<GradientProps, "type" | "angle" | "stops">): string {
  const stops = p.stops.map((s) => `${s.color} ${s.position}%`).join(", ");
  return p.type === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${p.angle}deg, ${stops})`;
}

export function Gradient(props: PrimitiveProps) {
  const { props: p } = safeProps("gradient", gradientSchema, props);
  const style: React.CSSProperties = {
    background: gradientCss(p),
    borderRadius: p.borderRadius,
    width: p.fill ? "100%" : p.width,
    height: p.fill ? "100%" : p.height,
    flexShrink: p.fill ? undefined : 0,
  };
  return <div aria-hidden="true" style={style} />;
}
Gradient.displayName = "Primitive.Gradient";
