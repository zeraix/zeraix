"use client";

/**
 * Text -- renders `content` verbatim as a React child (never as HTML). Any `{{param}}` placeholders
 * have already been substituted by the layout renderer before the props arrive here.
 */
import type React from "react";
import { cn } from "@/lib/utils";
import { safeProps, type PrimitiveProps } from "./common";
import { textSchema } from "./schemas";

export function Text(props: PrimitiveProps) {
  const { props: p } = safeProps("text", textSchema, props);
  const clamped = p.lineClamp > 0;
  const block = p.block || clamped || p.align !== "left";
  const style: React.CSSProperties = {
    fontSize: p.fontSize,
    fontWeight: p.fontWeight,
    color: p.color,
    textAlign: p.align,
    letterSpacing: p.letterSpacing,
    fontStyle: p.italic ? "italic" : undefined,
    margin: 0,
  };
  if (clamped) {
    style.display = "-webkit-box";
    style.WebkitLineClamp = p.lineClamp;
    style.WebkitBoxOrient = "vertical";
    style.overflow = "hidden";
  }
  const className = cn(p.family === "display" && "skin-display", p.family === "mono" && "font-mono") || undefined;
  if (block) {
    return (
      <p className={className} style={style}>
        {p.content}
      </p>
    );
  }
  return (
    <span className={className} style={style}>
      {p.content}
    </span>
  );
}
Text.displayName = "Primitive.Text";
