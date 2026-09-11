"use client";

/**
 * Image -- a picture from the active skin package's assets/ directory, and nothing else. The schema
 * only admits `assets/...` paths; assetUrl turns one into a skin://current/ URL that the main process
 * serves from the package. Without a src (or with a rejected one) nothing is drawn.
 */
/* eslint-disable @next/next/no-img-element */
import type React from "react";
import { assetUrl, safeProps, type PrimitiveProps } from "./common";
import { imageSchema } from "./schemas";

export function Image(props: PrimitiveProps) {
  const { props: p } = safeProps("image", imageSchema, props);
  if (!p.src) return null;
  const style: React.CSSProperties = {
    display: "block",
    objectFit: p.fit,
    borderRadius: p.borderRadius,
    width: p.width,
    height: p.height,
    maxWidth: "100%",
    opacity: p.opacity,
  };
  return <img src={assetUrl(p.src)} alt={p.alt} style={style} draggable={false} decoding="async" />;
}
Image.displayName = "Primitive.Image";
