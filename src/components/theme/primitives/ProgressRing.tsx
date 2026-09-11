"use client";

/**
 * ProgressRing -- a circular progress indicator drawn with two SVG circles: the track, and the
 * value arc dashed to the right length. The optional label in the middle is the rounded percentage.
 */
import type React from "react";
import { r2, safeProps, type PrimitiveProps } from "./common";
import { progressRingSchema } from "./schemas";

export function ProgressRing(props: PrimitiveProps) {
  const { props: p } = safeProps("progressRing", progressRingSchema, props);
  const value = Math.min(100, Math.max(0, p.value));
  const size = p.size;
  const thickness = Math.min(p.thickness, size / 2);
  const radius = size / 2 - thickness / 2;
  const circumference = r2(2 * Math.PI * radius);
  const offset = r2(circumference * (1 - value / 100));
  const wrapper: React.CSSProperties = {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    flexShrink: 0,
  };
  const label: React.CSSProperties = {
    position: "absolute",
    fontSize: Math.max(9, r2(size * 0.26)),
    fontWeight: 600,
    lineHeight: 1,
    color: "var(--ink)",
    fontVariantNumeric: "tabular-nums",
  };
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} style={wrapper}>
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)", display: "block" }}
      >
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={p.trackColor} strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={p.color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 300ms ease" }}
        />
      </svg>
      {p.showValue ? <span style={label}>{Math.round(value)}%</span> : null}
    </div>
  );
}
ProgressRing.displayName = "Primitive.ProgressRing";
