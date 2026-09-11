/**
 * The primitive registry: what `primitive:<key>` in a skin's layout.json resolves to.
 *
 * Keys are fixed by electron/skins/layoutRefs.mjs (shared with the install-time allow list), and the
 * record is typed against them so a key without an implementation fails to compile. Each entry pairs
 * the component with its props schema so the layout renderer and the settings UI can validate and
 * describe a node without rendering it.
 */
import type React from "react";
import type { z } from "zod";
import { PRIMITIVE_KEYS, type PrimitiveKey } from "../../../../electron/skins/layoutRefs.mjs";
import { Avatar } from "./Avatar";
import { Badge } from "./Badge";
import { Box } from "./Box";
import type { PrimitiveProps } from "./common";
import { Divider } from "./Divider";
import { Gradient } from "./Gradient";
import { Icon } from "./Icon";
import { Image } from "./Image";
import { ProgressBar } from "./ProgressBar";
import { ProgressRing } from "./ProgressRing";
import {
  avatarSchema,
  badgeSchema,
  boxSchema,
  dividerSchema,
  gradientSchema,
  iconSchema,
  imageSchema,
  progressBarSchema,
  progressRingSchema,
  shapeSchema,
  spacerSchema,
  textSchema,
} from "./schemas";
import { Shape } from "./Shape";
import { Spacer } from "./Spacer";
import { Text } from "./Text";

export type { PrimitiveProps } from "./common";
export { assetUrl, devWarn, safeProps } from "./common";
export { ICON_NAMES, ICONS, type IconName } from "./icons";
export * from "./schemas";
export { Avatar, Badge, Box, Divider, Gradient, Icon, Image, ProgressBar, ProgressRing, Shape, Spacer, Text };

export interface PrimitiveDef {
  key: PrimitiveKey;
  /** One sentence for the settings UI. */
  description: string;
  /** The props schema; parse output is the validated prop bag the component renders from. */
  schema: z.ZodType<Record<string, unknown>>;
  component: React.ComponentType<PrimitiveProps>;
  /** True only for box: the renderer nests child nodes inside it. */
  acceptsChildren: boolean;
}

export const PRIMITIVE_REGISTRY: Readonly<Record<PrimitiveKey, PrimitiveDef>> = Object.freeze({
  box: {
    key: "box",
    description: "A container with background, border, padding, shadow and blur that holds other nodes.",
    schema: boxSchema,
    component: Box,
    acceptsChildren: true,
  },
  text: {
    key: "text",
    description: "A run of text with size, weight, color, alignment and optional line clamping.",
    schema: textSchema,
    component: Text,
    acceptsChildren: false,
  },
  icon: {
    key: "icon",
    description: "One of the app's built-in icons, in any size and color.",
    schema: iconSchema,
    component: Icon,
    acceptsChildren: false,
  },
  image: {
    key: "image",
    description: "A picture from the skin package's assets folder.",
    schema: imageSchema,
    component: Image,
    acceptsChildren: false,
  },
  gradient: {
    key: "gradient",
    description: "A decorative linear or radial gradient swatch with up to six color stops.",
    schema: gradientSchema,
    component: Gradient,
    acceptsChildren: false,
  },
  progressBar: {
    key: "progressBar",
    description: "A horizontal bar filled to a value between 0 and 100.",
    schema: progressBarSchema,
    component: ProgressBar,
    acceptsChildren: false,
  },
  progressRing: {
    key: "progressRing",
    description: "A circular progress indicator, optionally showing the percentage in the middle.",
    schema: progressRingSchema,
    component: ProgressRing,
    acceptsChildren: false,
  },
  divider: {
    key: "divider",
    description: "A horizontal or vertical rule, solid or dashed.",
    schema: dividerSchema,
    component: Divider,
    acceptsChildren: false,
  },
  badge: {
    key: "badge",
    description: "A small pill of text in one of the app's preset status colors.",
    schema: badgeSchema,
    component: Badge,
    acceptsChildren: false,
  },
  avatar: {
    key: "avatar",
    description: "A round or square avatar showing a package image or initials.",
    schema: avatarSchema,
    component: Avatar,
    acceptsChildren: false,
  },
  shape: {
    key: "shape",
    description: "A basic geometric figure: circle, rectangle, triangle, hexagon or star.",
    schema: shapeSchema,
    component: Shape,
    acceptsChildren: false,
  },
  spacer: {
    key: "spacer",
    description: "Empty space of a fixed size, or a flexible gap that grows to fill its row.",
    schema: spacerSchema,
    component: Spacer,
    acceptsChildren: false,
  },
});

/** The registry as a list, in PRIMITIVE_KEYS order. */
export const PRIMITIVE_LIST: readonly PrimitiveDef[] = Object.freeze(PRIMITIVE_KEYS.map((k) => PRIMITIVE_REGISTRY[k]));
