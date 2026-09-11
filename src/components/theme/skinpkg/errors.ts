import type { EngineError } from "@/lib/electron/skinpkg";
import type { TFunc } from "@/lib/i18n";

/**
 * Engine error codes -> translated messages (`skinpkg.error.<key>`).
 *
 * The Rust side is precise (a code per validation rule, native/skin-engine); the UI groups the
 * finer ones so the locale files stay tractable, and shows the engine's `detail` -- the offending
 * file or value -- beside the translated line. A code this map does not know gets the generic
 * message rather than a raw key on screen.
 */
const DIRECT = new Set([
  "failed",
  "engineUnavailable",
  "tokensLoadFailed",
  "packageUnreadable",
  "packageCorrupt",
  "pathTraversal",
  "disallowedFileType",
  "sizeLimit",
  "tooManyEntries",
  "missingManifest",
  "missingTokens",
  "invalidStylesheet",
  "invalidSvg",
  "reservedId",
  "incompatible",
  "diskWrite",
  "layoutMalformed",
  "layoutTooDeep",
  "layoutTooManyNodes",
  "layoutUnknownRef",
  "layoutForbiddenProp",
  "layoutCircularReference",
  "layoutExpansionTooLarge",
  "sidebarInvalid",
  "sidebarMissingAsset",
  "notFound",
  "invalidId",
  "io",
]);

const GROUPED: Record<string, string> = {
  manifestMalformed: "manifest",
  manifestMissingField: "manifest",
  manifestInvalidId: "manifest",
  manifestInvalidVersion: "manifest",
  manifestInvalidField: "manifest",
  manifestInvalid: "manifest",
  layoutInvalidRef: "layoutUnknownRef",
  layoutNonPrimitiveProp: "layoutForbiddenProp",
  layoutPropTooLong: "layoutForbiddenProp",
  layoutTooManyProps: "layoutForbiddenProp",
  layoutExpansionTooDeep: "layoutExpansionTooLarge",
  layoutTooManyRegions: "layoutInvalid",
  layoutInvalidVisibleWhen: "layoutInvalid",
  layoutInvalidValue: "layoutInvalid",
  layoutUndeclaredParam: "layoutInvalid",
  layoutInvalidComponentName: "layoutInvalid",
  layoutInvalidParamName: "layoutInvalid",
  layoutTooManyComposites: "layoutInvalid",
  sidebarMalformed: "sidebarInvalid",
  sidebarUnknownId: "sidebarInvalid",
  sidebarNotAllowed: "sidebarInvalid",
  sidebarInvalidIcon: "sidebarInvalid",
  sidebarInvalidValue: "sidebarInvalid",
};

export function packageErrorKey(code?: string | null): string {
  if (!code) return "failed";
  if (DIRECT.has(code)) return code;
  return GROUPED[code] ?? "failed";
}

export const packageErrorTitle = (t: TFunc, code?: string | null) => t(`skinpkg.error.${packageErrorKey(code)}`);

/** Title + detail for a toast. The detail is the engine's own words (a file name, a value), shown as-is. */
export function packageErrorToast(t: TFunc, error?: EngineError | null): { title: string; detail?: string } {
  const title = packageErrorTitle(t, error?.code);
  const detail = error?.detail ?? (error?.code && !DIRECT.has(error.code) && !GROUPED[error.code] ? error.message : undefined);
  return detail ? { title, detail } : { title };
}
