"use client";

/**
 * ProgressBar -- a horizontal track with a filled portion. The schema already bounds `value` to
 * 0-100; the clamp below is belt and braces for the fill width.
 */
import type React from "react";
import { safeProps, type PrimitiveProps } from "./common";
import { progressBarSchema } from "./schemas";

export function ProgressBar(props: PrimitiveProps) {
  const { props: p } = safeProps("progressBar", progressBarSchema, props);
  const value = Math.min(100, Math.max(0, p.value));
  const track: React.CSSProperties = {
    width: p.fill ? "100%" : p.width,
    height: p.thickness,
    background: p.trackColor,
    borderRadius: p.borderRadius,
    overflow: "hidden",
    flexShrink: p.fill ? undefined : 0,
  };
  const fill: React.CSSProperties = {
    width: `${value}%`,
    height: "100%",
    background: p.color,
    borderRadius: "inherit",
    transition: "width 300ms ease",
  };
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} style={track}>
      <div style={fill} />
    </div>
  );
}
ProgressBar.displayName = "Primitive.ProgressBar";
