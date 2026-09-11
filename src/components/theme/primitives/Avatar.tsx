"use client";

/**
 * Avatar -- a picture from the skin package's assets/ (same rule as Image) or up to three initials
 * on a colored disc or rounded square.
 */
/* eslint-disable @next/next/no-img-element */
import type React from "react";
import { assetUrl, r2, safeProps, type PrimitiveProps } from "./common";
import { avatarSchema } from "./schemas";

export function Avatar(props: PrimitiveProps) {
  const { props: p } = safeProps("avatar", avatarSchema, props);
  const radius = p.shape === "circle" ? "50%" : r2(p.size * 0.2);
  const frame: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: p.size,
    height: p.size,
    borderRadius: radius,
    overflow: "hidden",
    flexShrink: 0,
    background: p.background,
    color: p.color,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: "none",
  };
  if (p.src) {
    return (
      <span style={frame}>
        <img
          src={assetUrl(p.src)}
          alt={p.alt}
          draggable={false}
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </span>
    );
  }
  const initials = (p.initials ?? "").toUpperCase();
  const fontSize = r2(p.size * (initials.length > 2 ? 0.32 : 0.42));
  return (
    <span style={{ ...frame, fontSize }} aria-label={p.alt || undefined}>
      {initials}
    </span>
  );
}
Avatar.displayName = "Primitive.Avatar";
