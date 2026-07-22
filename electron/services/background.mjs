/**
 * Background execution (tray-resident mode).
 *
 * Why this exists: the automation scheduler is useless if the process only lives while a window is
 * open -- on Windows/Linux `window-all-closed` quits the app, so every cron trigger would silently
 * do nothing until the user happened to reopen Zeraix.
 *
 * What this does NOT do: guarantee liveness. The user can still quit from the tray, kill the process,
 * or reboot. That is a legitimate instruction and we never fight it (no watchdog, no respawn -- that
 * behavior gets an app flagged by AV vendors and is user-hostile). Correctness must instead come from
 * the scheduler catching up from persisted state on every start, so a 5-second gap and a 5-day gap
 * take the identical code path. Tray mode is a *latency* optimization on top of that, not the
 * mechanism that makes scheduling correct.
 *
 * Preferences live in app.config under [background] so they sit alongside the other user settings
 * and can be hand-edited:
 *   enabled=true|false       keep running after the last window closes
 *   openAtLogin=true|false   start automatically at login (implies a hidden --background launch)
 *   tray_*                   cached translated tray labels (see setTrayLabels)
 */
import { app, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAppConfig, setAppConfig } from "../appConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/** argv flag used by the login item so an autostart launch comes up headless (tray only, no window). */
export const BACKGROUND_FLAG = "--background";

let tray = null;
let paused = false; // runtime only: "pause all automations" is deliberately not persisted
let hooks = { onOpen: () => {}, onQuit: () => {}, getStatusLabel: () => null };
/** Set once ensureTray() has actually failed on this platform (see isTraySupported). */
let trayUnavailable = false;

/* ------------------------------------------------------------------ prefs */

const readBool = (key, fallback = false) => {
  const v = getAppConfig()?.background?.[key];
  return v == null || v === "" ? fallback : v === "true";
};

/** Whether the app should stay alive (tray-resident) after the last window is closed. */
export function isBackgroundEnabled() {
  return readBool("enabled", false);
}

/** Whether the app is registered to launch at login. */
export function isOpenAtLogin() {
  return readBool("openAtLogin", false);
}

/** True when this process was started by the login item (should come up headless). */
export function isBackgroundLaunch() {
  return process.argv.includes(BACKGROUND_FLAG);
}

/** "Pause all automations" -- runtime only, so a restart always resumes a working scheduler. */
export function isPaused() {
  return paused;
}

export function setPaused(on) {
  paused = !!on;
  refreshTrayMenu();
  return paused;
}

/**
 * Enable / disable background mode. Creates or tears down the tray to match, so the tray icon is
 * never present while the setting is off (an orphan tray icon reads as spyware).
 */
export function setBackgroundEnabled(on) {
  const next = !!on;
  if (next) {
    // Enable only if a tray actually materializes -- without one the app would become unreachable
    // once the window closes. Report the real outcome so the UI can correct its optimistic toggle.
    if (!ensureTray()) {
      setAppConfig("background", "enabled", "false");
      return false;
    }
    setAppConfig("background", "enabled", "true");
    return true;
  }
  setAppConfig("background", "enabled", "false");
  destroyTray();
  // Autostart without background mode would launch a process that immediately quits -- pointless.
  if (isOpenAtLogin()) setOpenAtLogin(false);
  return false;
}

/**
 * Register / unregister the login item. `openAsHidden` is macOS-only; Windows and Linux rely on the
 * BACKGROUND_FLAG argv entry instead (see isBackgroundLaunch).
 */
export function setOpenAtLogin(on) {
  const next = !!on;
  setAppConfig("background", "openAtLogin", String(next));
  try {
    app.setLoginItemSettings({
      openAtLogin: next,
      openAsHidden: next, // macOS
      args: next ? [BACKGROUND_FLAG] : [],
    });
  } catch (e) {
    // Login-item registration can fail on locked-down Linux desktops; the preference still sticks.
    console.warn("[background] setLoginItemSettings failed:", e?.message || e);
  }
  return next;
}

/** Re-apply the persisted login-item preference at startup (the OS entry can be removed externally). */
export function syncLoginItem() {
  if (isOpenAtLogin()) setOpenAtLogin(true);
}

/* ------------------------------------------------------------- tray labels */

/**
 * The main process has no i18n runtime (notifications are handed pre-translated strings by the
 * renderer -- see notificationIpc). The tray has the same need but a harder constraint: on a
 * `--background` cold start it must render before any renderer exists. So the renderer pushes its
 * translated labels whenever it loads and we persist them, letting a headless start reuse the
 * user's language from last session. English defaults cover the very first launch.
 */
const DEFAULT_LABELS = {
  open: "Open Zeraix",
  pause: "Pause all automations",
  quit: "Quit Zeraix",
  running: "Running in the background",
};

export function setTrayLabels(labels) {
  if (!labels || typeof labels !== "object") return;
  for (const key of Object.keys(DEFAULT_LABELS)) {
    if (typeof labels[key] === "string" && labels[key].trim()) {
      setAppConfig("background", `tray_${key}`, labels[key].trim());
    }
  }
  refreshTrayMenu();
}

function label(key) {
  return getAppConfig()?.background?.[`tray_${key}`] || DEFAULT_LABELS[key];
}

/* -------------------------------------------------------------------- tray */

/**
 * Tray icon. macOS wants a small monochrome template image; Windows/Linux take the colored logo.
 * Linux tray support depends on the desktop environment and may be missing entirely, so every step
 * here is best-effort -- a tray failure must never block startup.
 */
function trayImage() {
  const file = isDev
    ? path.join(__dirname, "..", "..", "public", "logo.png")
    : path.join(app.getAppPath(), "Zeraix", "logo.png");
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const sized = img.resize({ width: 16, height: 16 });
  // Template images are rendered as a silhouette by macOS, which is the platform convention and
  // makes the icon adapt to light/dark menu bars.
  if (process.platform === "darwin") sized.setTemplateImage(true);
  return sized;
}

export function refreshTrayMenu() {
  if (!tray) return;
  const status = hooks.getStatusLabel?.() ?? label("running");
  try {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: "separator" },
        { label: label("open"), click: () => hooks.onOpen?.() },
        {
          label: label("pause"),
          type: "checkbox",
          checked: paused,
          click: (item) => setPaused(item.checked),
        },
        { type: "separator" },
        { label: label("quit"), click: () => hooks.onQuit?.() },
      ]),
    );
  } catch (e) {
    console.warn("[background] failed to build tray menu:", e?.message || e);
  }
}

export function ensureTray() {
  if (tray) return tray;
  try {
    const img = trayImage();
    if (!img) {
      console.warn("[background] tray icon asset missing; running without a tray");
      return null;
    }
    tray = new Tray(img);
    tray.setToolTip(app.getName());
    // Left-click opens the window on Windows/Linux; macOS reserves left-click for the menu.
    tray.on("click", () => hooks.onOpen?.());
    refreshTrayMenu();
  } catch (e) {
    // Common on minimal Linux desktops with no StatusNotifier host.
    console.warn("[background] tray unavailable on this platform:", e?.message || e);
    tray = null;
    trayUnavailable = true;
  }
  return tray;
}

/**
 * Whether a tray can be shown. Starts optimistic and flips to false once a creation attempt has
 * actually failed -- a real attempt beats guessing from environment variables, which is why the
 * renderer asks this rather than sniffing the platform itself.
 */
export function isTraySupported() {
  return !trayUnavailable;
}

export function destroyTray() {
  try {
    tray?.destroy();
  } catch {
    /* ignore */
  }
  tray = null;
}

/**
 * Wire up background mode at startup.
 * @param {object} deps
 * @param {() => void} deps.onOpen          Bring the main window to the foreground (creating it if needed).
 * @param {() => void} deps.onQuit          Perform a real quit (must set the isQuitting flag first).
 * @param {() => string|null} [deps.getStatusLabel] Optional first (disabled) tray row, e.g. "2 automations scheduled".
 * @returns {{ active: boolean }} active=false means the caller must show a window: background mode
 *   is either off or impossible on this platform.
 */
export function initBackground(deps) {
  hooks = { ...hooks, ...deps };
  syncLoginItem();
  // A --background launch always needs the tray, otherwise the app would be running with no way to
  // reach it -- an invisible process the user cannot open or quit.
  if (!isBackgroundEnabled() && !isBackgroundLaunch()) return { active: false };

  if (ensureTray()) return { active: true };

  // No tray on this platform. Resident-but-unreachable is strictly worse than not resident, so turn
  // the mode off rather than leaving an invisible process behind. This also clears the login item --
  // otherwise every sign-in would start a process the user can neither see nor quit. The tray is a
  // platform capability, not a transient failure, so persisting the change is correct.
  console.warn("[background] no tray available -- disabling background mode");
  setBackgroundEnabled(false);
  return { active: false };
}
