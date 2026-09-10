/**
 * Renderer-layer wrapper for the skin store in the main process (`window.skins`, see electron/preload.cjs and
 * electron/skins/store.mjs). Electron only: outside it `skinsBridge()` is null and callers fall back.
 *
 * Every call resolves -- never rejects -- to `{ ok: true, ... }` or `{ ok: false, code?, canceled? }`. `code` is a
 * stable identifier the UI maps to a translated message (appearance.error.<code>); the main process never sends
 * user-facing prose.
 */
import type { ImageSlot, Skin } from "../../../electron/skins/schema.mjs";

export type SkinFail = { ok: false; code?: string; canceled?: boolean };
export type SkinOk<T extends object = object> = { ok: true } & T;
export type SkinResult<T extends object = object> = SkinOk<T> | SkinFail;

export interface SkinsBridge {
  listSync(): unknown;
  save(skin: unknown): Promise<SkinResult<{ skin: Skin }>>;
  install(skin: unknown): Promise<SkinResult<{ skin: Skin }>>;
  remove(id: string): Promise<SkinResult>;
  pickImage(id: string, slot: ImageSlot): Promise<SkinResult<{ url: string }>>;
  discardDrafts(id: string): Promise<SkinResult>;
  importFile(): Promise<SkinResult<{ skin: Skin }>>;
  exportFile(id: string): Promise<SkinResult<{ path: string }>>;
  downloadTemplate(): Promise<SkinResult<{ path: string }>>;
  onChanged(cb: (list: unknown) => void): () => void;
}

declare global {
  interface Window {
    skins?: SkinsBridge;
  }
}

export const skinsBridge = (): SkinsBridge | null =>
  typeof window !== "undefined" && window.skins ? window.skins : null;

/** Whether custom skins (editor, images, import/export, template) are available -- Electron only. */
export const isSkinStoreAvailable = () => !!skinsBridge();
