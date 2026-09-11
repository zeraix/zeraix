"use client";

/**
 * Applying a skin package or preset to the document.
 *
 * Two mechanisms, chosen by id:
 *  - a preset (builtin.ts) writes its variables onto <html> with style.setProperty, for the colour mode
 *    currently on, and rewrites them when the `.dark` class flips;
 *  - a package is a <link id="skin-tokens"> to `skin://current/tokens.css`, served by the main process
 *    from the ACTIVE package's directory. `current` is resolved there, which fixes the order of
 *    operations: the choice is persisted (window.skinAPI.setActive) BEFORE the link is pointed at it.
 *
 * Both set `<html data-skin-package="<id>">`, which is the selector a package's tokens.css is told to
 * use (`:root[data-skin-package] { ... }` outranks the app's own `:root` block; see docs/skin-packages).
 *
 * A stylesheet that fails to load falls back to the default and announces it on `window` as a
 * `skinpkg:error` CustomEvent; the settings UI turns that into a toast. This module has no UI of its own.
 *
 * The web build (no window.skinAPI) keeps presets working from localStorage; packages need Electron.
 */
import { useSyncExternalStore } from "react";
import { skinAPI, type EngineError } from "@/lib/electron/skinpkg";
import { BUILTIN_SKINS, DEFAULT_SKIN_ID, findBuiltin, isBuiltinSkinId, isPackageSkinId, type BuiltinSkin } from "./builtin";

export const LINK_ID = "skin-tokens";
export const SKIN_ERROR_EVENT = "skinpkg:error";
const WEB_KEY = "zeraix.skinpkg.active";

export interface SkinApplyError {
  code: string;
  detail?: string | null;
  skinId: string;
}

export interface SkinState {
  currentSkinId: string;
  isApplying: boolean;
  lastError: SkinApplyError | null;
  /** Bumped every time a package's stylesheet finishes loading, so a reinstall of the ACTIVE package
   *  (same id, new files) is seen by everything keyed on the id -- the layout store re-fetches. */
  generation: number;
}

const SERVER_STATE: SkinState = { currentSkinId: DEFAULT_SKIN_ID, isApplying: false, lastError: null, generation: 0 };
let state: SkinState = SERVER_STATE;
const listeners = new Set<() => void>();

function setState(patch: Partial<SkinState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribeSkinState(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const getSkinState = () => state;

export function useSkinState(): SkinState {
  return useSyncExternalStore(subscribeSkinState, getSkinState, () => SERVER_STATE);
}

/* ----------------------------------------------------------------- presets */

let paintedKeys: string[] = [];
let paintedPreset: BuiltinSkin | null = null;
let themeObserver: MutationObserver | null = null;

function clearPreset() {
  paintedPreset = null;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of paintedKeys) root.style.removeProperty(k);
  paintedKeys = [];
}

function paintPreset(preset: BuiltinSkin) {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const tokens = dark ? (preset.tokens.dark ?? preset.tokens.light) : preset.tokens.light;
  for (const k of paintedKeys) root.style.removeProperty(k);
  paintedKeys = [];
  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(k, v);
    paintedKeys.push(k);
  }
  paintedPreset = preset;
  // Re-paint for the other colour mode when next-themes flips the class. One observer for the
  // module's lifetime; it only acts while a preset is on.
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      if (paintedPreset) paintPreset(paintedPreset);
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
  }
}

/* ---------------------------------------------------------------- packages */

function removeLink() {
  if (typeof document === "undefined") return;
  document.getElementById(LINK_ID)?.remove();
}

/** Point the tokens link at the active package; resolves when the stylesheet has loaded. */
function loadPackageStylesheet(skinId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const href = `skin://current/tokens.css?t=${Date.now()}`;
    const old = document.getElementById(LINK_ID);
    // A fresh element each time: swapping href on an existing link reports load/error for the OLD
    // request in some engines, and the old sheet keeps painting until the new one arrives anyway.
    const link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.dataset.skinId = skinId;
    link.onload = () => {
      old?.remove();
      resolve();
    };
    link.onerror = () => {
      link.remove();
      reject(new Error(`tokens.css failed to load for ${skinId}`));
    };
    link.href = href;
    document.head.appendChild(link);
  });
}

function setAttr(id: string | null) {
  if (typeof document === "undefined") return;
  if (id && id !== DEFAULT_SKIN_ID) document.documentElement.dataset.skinPackage = id;
  else delete document.documentElement.dataset.skinPackage;
}

function announce(error: SkinApplyError) {
  setState({ lastError: error });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SKIN_ERROR_EVENT, { detail: error }));
}

/* ------------------------------------------------------------- persistence */

async function persist(id: string): Promise<EngineError | null> {
  const api = skinAPI();
  if (!api) {
    try {
      window.localStorage.setItem(WEB_KEY, id);
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    return null;
  }
  try {
    const r = await api.setActive(id);
    return r.ok ? null : (r.error ?? { code: "failed", message: "setActive failed" });
  } catch (e) {
    return { code: "failed", message: String((e as Error)?.message ?? e) };
  }
}

/* ---------------------------------------------------------------- applying */

/** Paint `id` without persisting: used at boot and when the main process announces another window's choice. */
async function paintOnly(id: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  if (id === DEFAULT_SKIN_ID) {
    clearPreset();
    removeLink();
    setAttr(null);
    setState({ currentSkinId: DEFAULT_SKIN_ID, isApplying: false });
    return true;
  }
  const preset = findBuiltin(id);
  if (preset) {
    removeLink();
    paintPreset(preset);
    setAttr(id);
    setState({ currentSkinId: id, isApplying: false });
    return true;
  }
  if (!isPackageSkinId(id) || !skinAPI()) return false;
  clearPreset();
  setAttr(id);
  setState({ currentSkinId: id, isApplying: true });
  try {
    await loadPackageStylesheet(id);
    setState({ isApplying: false, generation: state.generation + 1 });
    return true;
  } catch {
    return false;
  }
}

export type SkinApplyResult = { ok: true } | { ok: false; error: SkinApplyError };

/**
 * Switch to a skin: persist the choice, paint it, and fall back to the default if a package's
 * stylesheet cannot be loaded (the error is announced, and the fallback is persisted too, so the next
 * launch does not repeat the failure).
 */
export async function applySkin(id: string): Promise<SkinApplyResult> {
  const target = id === DEFAULT_SKIN_ID || isBuiltinSkinId(id) || isPackageSkinId(id) ? id : DEFAULT_SKIN_ID;
  const isPackage = !isBuiltinSkinId(target);
  if (isPackage && !skinAPI()) {
    const error = { code: "engineUnavailable", skinId: target };
    announce(error);
    return { ok: false, error };
  }
  // The id goes into state before the round trip: the main process answers a persisted choice with a
  // broadcast, and followActiveFromMain would otherwise see a "foreign" change and paint it a second time.
  const previous = state.currentSkinId;
  setState({ currentSkinId: target, isApplying: true, lastError: null });
  // Packages: persist first, because `skin://current` is resolved from the persisted state.
  const persistError = await persist(target);
  if (persistError) {
    setState({ currentSkinId: previous, isApplying: false });
    const error = { code: persistError.code, detail: persistError.detail ?? persistError.message, skinId: target };
    announce(error);
    return { ok: false, error };
  }
  const painted = await paintOnly(target);
  if (painted) return { ok: true };
  // The stylesheet did not load: back to the default, persisted, and say so.
  await persist(DEFAULT_SKIN_ID);
  await paintOnly(DEFAULT_SKIN_ID);
  const error = { code: "tokensLoadFailed", skinId: target };
  announce(error);
  return { ok: false, error };
}

/** The main process says another window (or a delete) changed the active skin: follow it without persisting again. */
export function followActiveFromMain(active: string | null) {
  const id = active ?? DEFAULT_SKIN_ID;
  if (id === state.currentSkinId) return;
  void paintOnly(id).then((ok) => {
    if (!ok) void paintOnly(DEFAULT_SKIN_ID);
  });
}

let initialized = false;

/**
 * First paint. Synchronous as far as the DOM goes: the preset variables or the <link> are in place
 * before React renders, so there is no frame of the default palette. Runs once, client-side only.
 */
export function initSkinPackages(): string {
  if (initialized || typeof window === "undefined") return state.currentSkinId;
  initialized = true;
  const api = skinAPI();
  let id = DEFAULT_SKIN_ID;
  if (api) {
    try {
      id = api.getActiveSync().active ?? DEFAULT_SKIN_ID;
    } catch {
      id = DEFAULT_SKIN_ID;
    }
  } else {
    try {
      const stored = window.localStorage.getItem(WEB_KEY);
      if (stored && isBuiltinSkinId(stored)) id = stored;
    } catch {
      /* no storage */
    }
  }
  void paintOnly(id).then((ok) => {
    if (!ok && id !== DEFAULT_SKIN_ID) {
      void paintOnly(DEFAULT_SKIN_ID);
      announce({ code: "tokensLoadFailed", skinId: id });
    }
  });
  return id;
}

export { BUILTIN_SKINS, DEFAULT_SKIN_ID };
