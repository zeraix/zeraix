/**
 * Renderer-side types for `window.skinAPI` (electron/preload.cjs -> electron/skins/engine.mjs -> native/skin-engine).
 *
 * The `.d.ts` the prompt set asks for, kept as a module so the accessor lives beside it. Every call resolves -- never
 * rejects -- to `{ ok: true, ... }` or `{ ok: false, error, canceled? }`. `error.code` is a stable key the UI maps to a
 * translated message (`skinpkg.error.<code>`); `error.detail` names the file or value that was wrong and is shown as-is.
 * The main process never sends user-facing prose that the UI would have to display untranslated.
 */

/** A package's manifest as the engine returns it (camelCased by napi-rs; `min_app_version` on disk). */
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

export interface EngineError {
  code: string;
  message: string;
  detail?: string | null;
}

export type SkinFail = { ok: false; error?: EngineError; canceled?: boolean };
export type SkinOk<T extends object = object> = { ok: true } & T;
export type SkinResult<T extends object = object> = SkinOk<T> | SkinFail;

export interface InstallResult {
  ok: boolean;
  skin?: SkinManifest | null;
  dir?: string | null;
  files?: string[] | null;
  regions?: string[] | null;
  /** Whether the package customizes the sidebar (sidebar.json). */
  hasSidebar?: boolean | null;
  error?: EngineError | null;
  canceled?: boolean;
}

export interface LayoutCheck {
  ok: boolean;
  regions?: string[] | null;
  error?: EngineError | null;
}

export interface SkinListPayload {
  skins: SkinManifest[];
  /** The active package id, or null for the default / a preset. */
  active: string | null;
}

export interface SkinAPI {
  /** Synchronous, for first paint: which skin is on before the window draws. */
  getActiveSync(): { available: boolean; active: string | null };
  available(): Promise<{ available: boolean; error: string | null }>;
  list(): Promise<SkinResult<SkinListPayload>>;
  getActive(): Promise<SkinResult<{ active: string | null }>>;
  setActive(id: string): Promise<SkinResult>;
  delete(id: string): Promise<SkinResult>;
  install(filePath: string): Promise<InstallResult>;
  inspect(filePath: string): Promise<InstallResult>;
  pick(): Promise<InstallResult>;
  /** A `.json` / `.css` file of an installed package (the active one when `id` is omitted); `text` is null when absent. */
  readText(rel: string, id?: string): Promise<SkinResult<{ text: string | null }>>;
  validateLayout(layout: string | null, components: string | null): Promise<LayoutCheck | SkinFail>;
  exportText(payload: { defaultName: string; text: string }): Promise<SkinResult<{ path: string }>>;
  /** Save the official package template (a zip: README, my-skin/, schemas/). */
  downloadTemplate(): Promise<SkinResult<{ path: string }>>;
  onChanged(cb: (payload: SkinListPayload) => void): () => void;
}

declare global {
  interface Window {
    skinAPI?: SkinAPI;
  }
}

export const skinAPI = (): SkinAPI | null => (typeof window !== "undefined" && window.skinAPI ? window.skinAPI : null);

/** Whether skin packages exist at all in this build (Electron with the preload bridge). */
export const isSkinPackagesAvailable = () => !!skinAPI();
