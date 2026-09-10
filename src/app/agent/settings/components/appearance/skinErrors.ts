import type { TFunc } from "@/lib/i18n";

/** Every code electron/skins/store.mjs can return. Anything else -- including a code a newer main process invents --
 *  gets the generic message rather than a raw key on screen. */
const CODES = new Set([
  "invalid", "needsColors", "storeReadonly", "idTaken", "imageTooLarge", "imageType", "notFile",
  "packageTooLarge", "packageCorrupt", "noManifest", "manifestInvalid", "missing", "failed",
]);

export const skinError = (t: TFunc, code?: string) =>
  t(`appearance.error.${code && CODES.has(code) ? code : "failed"}`);
