"use client";

/**
 * Divider -- a rule in either orientation. Solid rules are a plain div; a dashArray switches to an
 * SVG line so the dash pattern comes from stroke-dasharray, which CSS borders cannot express exactly.
 */
import type React from "react";
import { safeProps, type PrimitiveProps } from "./common";
import { dividerSchema } from "./schemas";

export function Divider(props: PrimitiveProps) {
  const { props: p } = safeProps("divider", dividerSchema, props);
  const horizontal = p.orientation === "horizontal";
  const along = p.fill ? "100%" : p.length;
  const box: React.CSSProperties = {
    width: horizontal ? along : p.thickness,
    height: horizontal ? p.thickness : along,
    flexShrink: 0,
    display: "block",
  };
  if (!p.dashArray) {
    return <div role="separator" aria-orientation={p.orientation} style={{ ...box, background: p.color }} />;
  }
  const mid = p.thickness / 2;
  return (
    <svg role="separator" aria-orientation={p.orientation} style={box} width="100%" height="100%">
      <line
        x1={horizontal ? 0 : mid}
        y1={horizontal ? mid : 0}
        x2={horizontal ? "100%" : mid}
        y2={horizontal ? mid : "100%"}
        stroke={p.color}
        strokeWidth={p.thickness}
        strokeDasharray={p.dashArray}
      />
    </svg>
  );
}
Divider.displayName = "Primitive.Divider";
