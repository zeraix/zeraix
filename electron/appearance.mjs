/**
 * Appearance: theme mode, accent colour, UI font size and skin, owned by the main process.
 *
 * Why the main process owns settings the renderer is perfectly capable of storing itself:
 *
 *  1. Durability. These live in the [ui] section of app.config (the INI beside the executable),
 *     alongside `locale`, so they survive a cleared renderer profile and can be edited by hand.
 *  2. `nativeTheme.themeSource`. Electron paints window chrome, the background colour behind a
 *     loading page and every native dialog from this, and it is a main-process property. Left at
 *     "system" while the app is pinned to light, a dark-mode machine flashes dark behind every
 *     navigation.
 *  3. One writer, many windows. A setting changed in one window has to land in the others, and a
 *     broadcast from the process that owns the value is the only version of that without a race.
 *
 * What this deliberately does NOT do is drive light/dark in the renderer. Once themeSource is set,
 * Chromium's `prefers-color-scheme` follows it in every window, and next-themes is already listening
 * to that. Pushing a second source of truth at it would mean two mechanisms racing to set the same
 * class. The `resolved-theme` broadcast exists for anything that needs to KNOW the effective theme
 * changed, not to perform the change.
 */
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { getAppConfig, setAppConfig } from "./appConfig.mjs";
import { FONT_PX, isFontPx } from "./skins/schema.mjs";

/** INI keys under [ui]. `locale` already lives in this section; these join it. */
const KEYS = { theme: "theme", accent: "accent", fontSize: "font_size", fontSizePx: "font_size_px", skin: "skin", skinMotion: "skin_motion", skinOnChat: "skin_on_chat" };

const THEMES = ["light", "dark", "system"];
const ACCENTS = ["graphite", "blue", "green", "purple", "rose", "gold"];
/** "custom" means the size is font_size_px, typed by the user. */
const FONT_SIZES = ["sm", "md", "lg", "xl", "custom"];
/** Skin ids are open-ended (store skins), so they are checked by shape rather than against a list. */
const SKIN_ID = /^(none|[a-z0-9][a-z0-9-]{1,39})$/;

export const DEFAULT_APPEARANCE = { theme: "system", accent: "graphite", fontSize: "md", fontSizePx: FONT_PX.default, skin: "none", skinMotion: true, skinOnChat: true };

/** Window background per effective theme, so a reload does not flash white on a dark desktop. */
const BACKGROUND = { light: "#f2f0ea", dark: "#121215" };

const pick = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback);
const pickSkin = (value, fallback) => (typeof value === "string" && SKIN_ID.test(value) ? value : fallback);
/** INI values are strings and IPC values are numbers; both go through Number. The range lives in the shared schema. */
const pickPx = (value, fallback) => (isFontPx(Number(value)) ? Number(value) : fallback);
/** Booleans arrive as true/false over IPC and as "true"/"false" from the INI (setAppConfig stringifies). */
const pickBool = (value, fallback) =>
  value === true || value === "true" ? true : value === false || value === "false" ? false : fallback;

/**
 * Current appearance, read from app.config and validated. A hand-edited file is untrusted input like
 * any other: an unknown accent name would otherwise reach the renderer and select no CSS block at all,
 * leaving the UI with no primary colour.
 */
export function getAppearance() {
  const ui = getAppConfig()?.ui ?? {};
  return {
    theme: pick(THEMES, ui[KEYS.theme], DEFAULT_APPEARANCE.theme),
    accent: pick(ACCENTS, ui[KEYS.accent], DEFAULT_APPEARANCE.accent),
    fontSize: pick(FONT_SIZES, ui[KEYS.fontSize], DEFAULT_APPEARANCE.fontSize),
    fontSizePx: pickPx(ui[KEYS.fontSizePx], DEFAULT_APPEARANCE.fontSizePx),
    skinMotion: pickBool(ui[KEYS.skinMotion], DEFAULT_APPEARANCE.skinMotion),
    skinOnChat: pickBool(ui[KEYS.skinOnChat], DEFAULT_APPEARANCE.skinOnChat),
    skin: pickSkin(ui[KEYS.skin], DEFAULT_APPEARANCE.skin),
  };
}

/**
 * The light/dark Electron is rendering right now.
 *
 * Not "what the OS prefers": `shouldUseDarkColors` reflects `themeSource` whenever that is pinned, and
 * only falls through to the OS in "system" mode. Electron has no way to read the OS preference while
 * pinned -- which is fine, because everything below wants the effective theme anyway.
 */
export const effectiveTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function paintBackgrounds() {
  const bg = BACKGROUND[effectiveTheme()];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(bg);
  }
}

/**
 * Persist a partial change, apply its main-process consequences, and tell every window.
 *
 * `origin` is the webContents id of the window that asked, echoed back in the broadcast. A window
 * that already applied the change optimistically uses it to ignore its own echo -- without it, the
 * round trip lands as a second state write and the control it came from flickers.
 */
export function setAppearance(patch = {}, origin = null) {
  const before = getAppearance();
  const next = {
    theme: pick(THEMES, patch.theme, before.theme),
    accent: pick(ACCENTS, patch.accent, before.accent),
    fontSize: pick(FONT_SIZES, patch.fontSize, before.fontSize),
    fontSizePx: pickPx(patch.fontSizePx, before.fontSizePx),
    skinMotion: pickBool(patch.skinMotion, before.skinMotion),
    skinOnChat: pickBool(patch.skinOnChat, before.skinOnChat),
    skin: pickSkin(patch.skin, before.skin),
  };

  for (const [field, iniKey] of Object.entries(KEYS)) {
    if (next[field] !== before[field]) setAppConfig("ui", iniKey, next[field]);
  }

  if (next.theme !== before.theme) applyThemeSource(next.theme);
  broadcast("appearance:changed", { appearance: next, resolved: effectiveTheme(), origin });
  return next;
}

/** Push the mode into Electron: native dialogs, window chrome, the backdrop behind a load, and
 *  prefers-color-scheme in every renderer. */
function applyThemeSource(mode) {
  nativeTheme.themeSource = mode; // "light" | "dark" | "system" -- Electron's own vocabulary matches ours
  paintBackgrounds(); // after the assignment: shouldUseDarkColors has already moved to match it
}

/**
 * Wire up appearance. Call once during startup, BEFORE the first window is created, so themeSource is
 * already correct when that window picks its background colour.
 */
export function registerAppearance() {
  applyThemeSource(getAppearance().theme);

  // Fires when the effective theme moves -- the OS flipping while we follow it, and also our own
  // themeSource assignments. Both mean the same thing to a listener ("what is on screen changed"), so
  // both are broadcast; a payload that repeats the current value is harmless to ignore.
  nativeTheme.on("updated", () => {
    paintBackgrounds();
    broadcast("appearance:resolved-theme", { resolved: effectiveTheme() });
  });

  ipcMain.handle("appearance:get", () => ({ appearance: getAppearance(), resolved: effectiveTheme() }));

  ipcMain.handle("appearance:set", (e, patch) => setAppearance(patch ?? {}, e.sender.id));

  // Synchronous snapshot: the renderer needs this before first paint to avoid a flash of the wrong
  // theme, and an await there would put it after it. windowId rides along so the renderer can
  // recognise its own change echoing back.
  ipcMain.on("appearance:get-sync", (e) => {
    e.returnValue = { appearance: getAppearance(), resolved: effectiveTheme(), windowId: e.sender.id };
  });
}
