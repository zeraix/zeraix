/* Type declarations for the skin-engine addon (native/skin-engine/src/bindings.rs). Kept by hand,
 * in step with the #[napi] items there; napi-rs camelCases struct fields, which is why the manifest's
 * `min_app_version` on disk is `minAppVersion` here. */

export interface SkinManifest {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
  preview?: string | null;
  createdAt: string;
}

/** A domain failure: `code` is the stable key the UI translates, `detail` the specific file or value. */
export interface EngineError {
  code: string;
  message: string;
  detail?: string | null;
}

export interface ValidationResult {
  valid: boolean;
  manifest?: SkinManifest | null;
  errors?: string[] | null;
}

export interface InstallResult {
  ok: boolean;
  skin?: SkinManifest | null;
  dir?: string | null;
  files?: string[] | null;
  regions?: string[] | null;
  hasSidebar?: boolean | null;
  error?: EngineError | null;
}

/** What the app renders that a package may name (electron/skins/layoutRefs.mjs APP_REGISTRY). A missing list means none. */
export interface AppRegistry {
  refs?: string[];
  navItems?: string[];
  sections?: string[];
  controls?: string[];
  menu?: string[];
  icons?: string[];
}

export interface StoreResult {
  ok: boolean;
  error?: EngineError | null;
}

export interface TextResult {
  ok: boolean;
  /** The file's text; null when the package has no such file. */
  text?: string | null;
  error?: EngineError | null;
}

export interface LayoutCheck {
  ok: boolean;
  regions?: string[] | null;
  error?: EngineError | null;
}

export function ping(): string;
export function defaultSkinId(): string;
export function validateSkinManifest(jsonStr: string): ValidationResult;
export function validateLayoutJson(layout: string | null | undefined, components: string | null | undefined, allowedRefs: string[]): LayoutCheck;
export function installSkinPackageAsync(sourcePath: string, skinsDir: string, registry: AppRegistry, appVersion?: string | null): Promise<InstallResult>;
export function inspectSkinPackageAsync(sourcePath: string, registry: AppRegistry, appVersion?: string | null): Promise<InstallResult>;
export function listSkins(skinsDir: string): Promise<SkinManifest[]>;
export function getActiveSkinSync(statePath: string): string | null;
export function getActiveSkin(statePath: string): Promise<string | null>;
export function setActiveSkin(statePath: string, skinsDir: string, skinId: string): Promise<StoreResult>;
export function deleteSkin(skinsDir: string, statePath: string, skinId: string): Promise<StoreResult>;
export function writeTextFile(path: string, text: string): Promise<StoreResult>;
export function writeFileBytes(path: string, data: Buffer): Promise<StoreResult>;
export function readSkinText(skinsDir: string, skinId: string, relPath: string): Promise<TextResult>;
