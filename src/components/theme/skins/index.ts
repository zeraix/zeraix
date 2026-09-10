/** Skins: rich, data-only themes. See builtin.ts (what ships), apply.ts (what paints), installed.ts (what is
 *  installed), electron/skins/schema.mjs (what a skin may contain) and electron/skins/store.mjs (where they live). */
export { NO_SKIN, applySkin, findSkin, hasBackdrop, skinCss, useActiveSkin } from "./apply";
export { BUILTIN_SKINS, DEFAULT_SKIN_PREVIEW, STORE_CATALOG } from "./builtin";
export {
  installStoreSkin,
  loadInstalledSkins,
  newCustomSkinId,
  refreshInstalled,
  removeInstalledSkin,
  useInstalledSkins,
  type SkinActionResult,
} from "./installed";
export { downloadSkin, fetchSkinCatalog } from "./store";
export { ART_KEYS, cornerUrl, emblemSrc, glyphUrl, laceUrl, motifSrc, patternTile, sprigUrl } from "./patterns";
export { KEY_COLOR_NAMES, contrast, deriveTokens, keyColorsOf, mix, type KeyColors } from "./derive";
export {
  CORNER_FRAMES,
  DETAIL_FLAGS,
  DETAIL_OPTIONS,
  FONT_KEYS,
  FONT_STACKS,
  IMAGE_SLOTS,
  LIMITS,
  MOTION_KEYS,
  PATTERN_KEYS,
  SKIN_TOKENS,
  isSkinColor,
  parseDraftImageUrl,
  parseStoredImageUrl,
  sanitizeSkin,
  type CornerFrame,
  type FontKey,
  type ImageSlot,
  type MotionKey,
  type PatternKey,
  type Skin,
  type SkinDecor,
  type SkinDetails,
  type SkinTokens,
} from "../../../../electron/skins/schema.mjs";
