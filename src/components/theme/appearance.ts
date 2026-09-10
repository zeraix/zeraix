"use client";

/**
 * Renderer side of the appearance settings.
 *
 * The division of labour, because it is not obvious from either half alone:
 *
 *  - next-themes owns light/dark/system. It already reads `prefers-color-scheme`, already writes the
 *    `.dark` class, and already ships the blocking script that keeps first paint from flashing. This
 *    module does not re-implement any of it -- it only makes sure next-themes' own localStorage key
 *    holds what app.config says BEFORE next-themes reads it.
 *  - This module owns accent and font size, as `<html data-accent>` / `<html data-font-size>`, both
 *    resolved by CSS variables in globals.css.
 *  - app.config (via the main process) is the durable record and the cross-window channel.
 *
 * Ordering matters and is the whole reason `seedFromConfig` is synchronous and runs at module scope:
 * `window.appearance.getSync` is a sendSync, so the values are in localStorage and on <html> before
 * React renders, which is before next-themes looks. An async read would land a frame late and show
 * the wrong theme in between.
 */
import {
  ACCENT_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  FONT_SIZE_PX_STORAGE_KEY,
  FONT_SIZE_STORAGE_KEY,
  SKIN_MOTION_STORAGE_KEY,
  SKIN_ON_CHAT_STORAGE_KEY,
  SKIN_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isAccentKey,
  isFontPx,
  isFontSizeKey,
  isSkinId,
  isThemeMode,
  type Appearance,
} from "./theme-config";
import { applySkin } from "./skins";

/** The light/dark Electron is actually rendering. Not the OS preference: see effectiveTheme in appearance.mjs. */
type Resolved = "light" | "dark";

interface AppearanceBridge {
  getSync(): { appearance: Appearance; resolved: Resolved; windowId: number };
  get(): Promise<{ appearance: Appearance; resolved: Resolved }>;
  set(patch: Partial<Appearance>): Promise<Appearance>;
  onChanged(cb: (p: { appearance: Appearance; resolved: Resolved; origin: number | null }) => void): () => void;
  /** The effective light/dark changed: the OS flipped while following it, or the mode was switched. */
  onResolvedTheme(cb: (p: { resolved: Resolved }) => void): () => void;
}

declare global {
  interface Window {
    appearance?: AppearanceBridge;
  }
}

export const appearanceBridge = (): AppearanceBridge | null =>
  typeof window !== "undefined" && window.appearance ? window.appearance : null;

/** Whether appearance is backed by app.config (Electron) rather than localStorage alone (web build). */
export const isAppearanceSynced = () => !!appearanceBridge();

/* -------------------------------------------------------------------- reading */

function readLocal<T>(key: string, guard: (v: unknown) => v is T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return guard(v) ? v : fallback;
  } catch {
    return fallback; // private mode / storage disabled
  }
}

/** Current appearance as the renderer sees it. Used for the settings UI's initial state. */
export function readAppearance(): Appearance {
  return {
    theme: readLocal(THEME_STORAGE_KEY, isThemeMode, DEFAULT_APPEARANCE.theme),
    accent: readLocal(ACCENT_STORAGE_KEY, isAccentKey, DEFAULT_APPEARANCE.accent),
    fontSize: readLocal(FONT_SIZE_STORAGE_KEY, isFontSizeKey, DEFAULT_APPEARANCE.fontSize),
    fontSizePx: readFontPx(),
    skin: readLocal(SKIN_STORAGE_KEY, isSkinId, DEFAULT_APPEARANCE.skin),
    skinMotion: readMotion(),
    skinOnChat: readFlag(SKIN_ON_CHAT_STORAGE_KEY, DEFAULT_APPEARANCE.skinOnChat),
  };
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v === "off" ? false : v === "on" ? true : fallback;
  } catch {
    return fallback;
  }
}

function readMotion(): boolean {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE.skinMotion;
  try {
    const v = window.localStorage.getItem(SKIN_MOTION_STORAGE_KEY);
    return v === "off" ? false : v === "on" ? true : DEFAULT_APPEARANCE.skinMotion;
  } catch {
    return DEFAULT_APPEARANCE.skinMotion;
  }
}

function readFontPx(): number {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE.fontSizePx;
  try {
    const n = Number(window.localStorage.getItem(FONT_SIZE_PX_STORAGE_KEY));
    return isFontPx(n) ? n : DEFAULT_APPEARANCE.fontSizePx;
  } catch {
    return DEFAULT_APPEARANCE.fontSizePx;
  }
}

/* -------------------------------------------------------------------- applying */

/** Paint everything that is not the theme class (that is next-themes' job): accent and font size as
 *  <html> attributes, and the skin as a generated stylesheet plus its attribute. */
export function applyAttributes(a: Pick<Appearance, "accent" | "fontSize" | "fontSizePx" | "skin" | "skinMotion" | "skinOnChat">) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.accent = a.accent;
  root.dataset.fontSize = a.fontSize;
  // A typed px size has no CSS block to select, so its scale goes inline -- where it also outranks the presets.
  // Removed again for a preset, or the inline value would keep overriding it.
  if (a.fontSize === "custom" && isFontPx(a.fontSizePx)) root.style.setProperty("--ui-font-scale", String(a.fontSizePx / 16));
  else root.style.removeProperty("--ui-font-scale");
  // skins.css stops every skin animation under this attribute (and under prefers-reduced-motion regardless).
  if (a.skinMotion === false) root.dataset.skinMotionOff = "";
  else delete root.dataset.skinMotionOff;
  // Read by the "skin on chat" rules in skins.css, which give the conversation a plain surface when this is set.
  if (a.skinOnChat === false) root.dataset.skinChatOff = "";
  else delete root.dataset.skinChatOff;
  applySkin(a.skin);
}

function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a failed write costs persistence, not correctness -- the live UI is already updated */
  }
}

/** Persist locally + paint. Does NOT talk to the main process; callers decide whether to propagate. */
export function applyAppearance(a: Appearance) {
  writeLocal(THEME_STORAGE_KEY, a.theme);
  writeLocal(ACCENT_STORAGE_KEY, a.accent);
  writeLocal(FONT_SIZE_STORAGE_KEY, a.fontSize);
  writeLocal(FONT_SIZE_PX_STORAGE_KEY, String(a.fontSizePx));
  writeLocal(SKIN_MOTION_STORAGE_KEY, a.skinMotion ? "on" : "off");
  writeLocal(SKIN_ON_CHAT_STORAGE_KEY, a.skinOnChat ? "on" : "off");
  writeLocal(SKIN_STORAGE_KEY, a.skin);
  applyAttributes(a);
}

/* --------------------------------------------------------------------- seeding */

let seeded = false;

/**
 * Pull app.config's [ui] values into localStorage and onto <html>, synchronously, once.
 *
 * app.config wins over localStorage here on purpose: it is the record that survives a wiped renderer
 * profile and the one a user can edit by hand, so it is the source of truth at boot. Afterwards the
 * two are kept in step by every write going through `commitAppearance`.
 */
export function seedFromConfig(): Appearance {
  if (seeded || typeof window === "undefined") return readAppearance();
  seeded = true;

  const b = appearanceBridge();
  if (!b) {
    // Web build: localStorage is all there is. Still paint the attributes, or accent and font size
    // only take effect once something happens to re-render.
    const local = readAppearance();
    applyAttributes(local);
    return local;
  }

  try {
    // Merged over the defaults: a main process that predates a setting sends no value for it, and writing
    // "undefined" through would silently turn that setting off.
    const appearance = { ...DEFAULT_APPEARANCE, ...b.getSync().appearance };
    applyAppearance(appearance);
    return appearance;
  } catch {
    const local = readAppearance();
    applyAttributes(local);
    return local;
  }
}

/* ------------------------------------------------------------------ committing */

/**
 * Apply a change locally and push it to the main process, which persists it and tells the other
 * windows. Local-first so the control responds on the same frame rather than after a round trip.
 */
export function commitAppearance(patch: Partial<Appearance>): Appearance {
  const next = { ...readAppearance(), ...patch };
  applyAppearance(next);
  void appearanceBridge()?.set(patch).catch(() => {
    /* persistence failed; the running UI already reflects the change */
  });
  return next;
}
