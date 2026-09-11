"use client";

/**
 * Box -- the container primitive. The only primitive that accepts children; everything a skin
 * composes sits inside one. Every style value below comes from the validated props, never from
 * the raw input.
 */
import type React from "react";
import { safeProps, styleFromShadow, type PrimitiveProps } from "./common";
import { boxSchema } from "./schemas";

export function Box(props: PrimitiveProps) {
  const { props: p } = safeProps("box", boxSchema, props);
  const glowAccent = p.borderWidth > 0 ? p.borderColor : "var(--primary)";
  const style: React.CSSProperties = {
    background: p.background,
    borderRadius: p.borderRadius,
    padding: p.padding,
    opacity: p.opacity,
    boxSizing: "border-box",
    ...styleFromShadow(p.shadow, glowAccent),
  };
  if (p.borderWidth > 0) {
    style.borderWidth = p.borderWidth;
    style.borderStyle = "solid";
    style.borderColor = p.borderColor;
  }
  if (p.backdropBlur > 0) {
    style.backdropFilter = `blur(${p.backdropBlur}px)`;
    style.WebkitBackdropFilter = `blur(${p.backdropBlur}px)`;
  }
  return <div style={style}>{props.children}</div>;
}
Box.displayName = "Primitive.Box";
