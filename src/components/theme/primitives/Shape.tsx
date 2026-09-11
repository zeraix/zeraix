"use client";

/**
 * Shape -- a basic geometric figure. The path data is generated here from an enum kind; a skin
 * never supplies SVG path strings, so there is no way to smuggle crafted geometry into the renderer.
 */
import type React from "react";
import { r2, safeProps, type PrimitiveProps } from "./common";
import { shapeSchema, type ShapeKind } from "./schemas";

/** Points on a circle of `radius` around the centre, starting at the top and going clockwise. */
function ring(count: number, radius: number, centre: number, phase = 0): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + phase + (i * 2 * Math.PI) / count;
    return [r2(centre + radius * Math.cos(angle)), r2(centre + radius * Math.sin(angle))];
  });
}

function polygon(points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ") + " Z";
}

/** Path data for `kind` inside a `size` x `size` box, inset by half the stroke so the stroke is not clipped. */
export function shapePath(kind: ShapeKind, size: number, strokeWidth: number): string {
  const inset = strokeWidth / 2;
  const c = size / 2;
  const r = c - inset;
  switch (kind) {
    case "circle":
      return `M${r2(c - r)} ${c} A${r2(r)} ${r2(r)} 0 1 0 ${r2(c + r)} ${c} A${r2(r)} ${r2(r)} 0 1 0 ${r2(c - r)} ${c} Z`;
    case "rect":
      return polygon([
        [r2(inset), r2(inset)],
        [r2(size - inset), r2(inset)],
        [r2(size - inset), r2(size - inset)],
        [r2(inset), r2(size - inset)],
      ]);
    case "triangle":
      return polygon([
        [c, r2(inset)],
        [r2(size - inset), r2(size - inset)],
        [r2(inset), r2(size - inset)],
      ]);
    case "hexagon":
      return polygon(ring(6, r, c));
    case "star": {
      const outer = ring(5, r, c);
      const inner = ring(5, r * 0.382, c, Math.PI / 5);
      return polygon(outer.flatMap((pt, i) => [pt, inner[i]]));
    }
  }
}

export function Shape(props: PrimitiveProps) {
  const { props: p } = safeProps("shape", shapeSchema, props);
  const strokeWidth = p.stroke ? p.strokeWidth : 0;
  const style: React.CSSProperties = {
    display: "block",
    flexShrink: 0,
    transform: p.rotate ? `rotate(${p.rotate}deg)` : undefined,
  };
  return (
    <svg aria-hidden="true" width={p.size} height={p.size} viewBox={`0 0 ${p.size} ${p.size}`} style={style}>
      <path
        d={shapePath(p.kind, p.size, strokeWidth)}
        fill={p.fill}
        stroke={p.stroke}
        strokeWidth={strokeWidth || undefined}
        strokeLinejoin="round"
      />
    </svg>
  );
}
Shape.displayName = "Primitive.Shape";
