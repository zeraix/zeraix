"use client";

/**
 * Spacer -- empty space. With `flex` it grows to soak up leftover room in a flex parent; otherwise
 * it is a fixed square that refuses to shrink.
 */
import type React from "react";
import { safeProps, type PrimitiveProps } from "./common";
import { spacerSchema } from "./schemas";

export function Spacer(props: PrimitiveProps) {
  const { props: p } = safeProps("spacer", spacerSchema, props);
  const style: React.CSSProperties =
    p.flex !== undefined ? { flex: `${p.flex} 1 0%` } : { width: p.size, height: p.size, flexShrink: 0 };
  return <div aria-hidden="true" style={style} />;
}
Spacer.displayName = "Primitive.Spacer";
