"use client";

/**
 * Icon -- one of the curated lucide icons (icons.ts). The name is a zod enum, so an unknown name
 * falls back to the default icon rather than rendering nothing or reaching into lucide dynamically.
 */
import { safeProps, type PrimitiveProps } from "./common";
import { ICONS } from "./icons";
import { iconSchema } from "./schemas";

export function Icon(props: PrimitiveProps) {
  const { props: p } = safeProps("icon", iconSchema, props);
  const Glyph = ICONS[p.name];
  return <Glyph aria-hidden="true" size={p.size} color={p.color} strokeWidth={p.strokeWidth} />;
}
Icon.displayName = "Primitive.Icon";
