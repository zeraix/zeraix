"use client";

/**
 * Skin packages (v2 theming): Rust-validated `.skinpkg` archives and built-in presets.
 *
 * `useSkin()` is the one hook the UI needs. Everything under it: builtin.ts (presets), installed.ts
 * (the list from the main process), apply.ts (painting + persistence). The v1 data skins
 * (../skins) are a separate system; ThemeProvider keeps the two from being active at once.
 */
import { useCallback, useSyncExternalStore } from "react";
import { isSkinPackagesAvailable, type SkinManifest } from "@/lib/electron/skinpkg";
import { BUILTIN_SKINS, DEFAULT_SKIN_ID, findBuiltin, isBuiltinSkinId, isPackageSkinId, type BuiltinSkin } from "./builtin";
import { applySkin as apply, useSkinState, type SkinApplyError, type SkinApplyResult } from "./apply";
import { useInstalledSkins } from "./installed";

export interface UseSkin {
  currentSkinId: string;
  installedSkins: SkinManifest[];
  builtinSkins: readonly BuiltinSkin[];
  applySkin: (id: string) => Promise<SkinApplyResult>;
  isApplying: boolean;
  isLoading: boolean;
  lastError: SkinApplyError | null;
  /** False in the web build and when the Rust addon failed to load. */
  available: boolean;
  refresh: () => Promise<void>;
}

const noopSubscribe = () => () => {};

/** Whether the desktop bridge exists. Server snapshot says yes, so the desktop app never hydrates a "web only" frame. */
export const useSkinPackagesAvailable = () => useSyncExternalStore(noopSubscribe, isSkinPackagesAvailable, () => true);

export function useSkin(): UseSkin {
  const { currentSkinId, isApplying, lastError } = useSkinState();
  const { skins, isLoading, refresh } = useInstalledSkins();
  const available = useSkinPackagesAvailable();
  const applySkin = useCallback((id: string) => apply(id), []);
  return {
    currentSkinId,
    installedSkins: skins,
    builtinSkins: BUILTIN_SKINS,
    applySkin,
    isApplying,
    isLoading,
    lastError,
    available,
    refresh,
  };
}

export { BUILTIN_SKINS, DEFAULT_SKIN_ID, findBuiltin, isBuiltinSkinId, isPackageSkinId, type BuiltinSkin };
export { packageErrorKey, packageErrorTitle, packageErrorToast } from "./errors";
export { SKIN_ERROR_EVENT, applySkin, followActiveFromMain, getSkinState, initSkinPackages, subscribeSkinState, useSkinState, type SkinApplyError, type SkinApplyResult } from "./apply";
export { refreshInstalledSkins, subscribeActiveFromMain, useInstalledSkins } from "./installed";
