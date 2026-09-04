/**
 * How the OS identifies this app: icons for windows and notifications, the Windows AppUserModelID, and the
 * dev-only Start Menu shortcut that brands toasts. Everything here exists because `electron .` runs the stock
 * Electron binary: without help, Windows/Linux show Electron's atom on the taskbar, macOS shows it in the Dock,
 * and Windows toasts are headed "Electron". A packaged build carries its own icon in the executable / bundle
 * (electron-builder builds resources/icon.png into icon.ico / icon.icns) and its installer writes the shortcut.
 */
import { app, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const projectRoot = path.join(__dirname, "..");

/**
 * Windows AppUserModelID. Packaged: must equal the electron-builder appId (electron-builder.yml), because that is the
 * id the NSIS installer stamps on the Start Menu / desktop shortcuts and Windows brands toasts and groups taskbar
 * buttons by matching the two. Dev: a distinct id, so a dev launch never joins the taskbar group (or the pin) of an
 * installed Zeraix on the same machine; ensureDevStartMenuShortcut() writes the shortcut that gives this id a name and icon.
 */
export function appUserModelId() {
  return isDev ? "com.zeraix.app.dev" : "com.zeraix.app";
}

/**
 * Icon for BrowserWindow `icon` and the macOS Dock while developing, or null when there is nothing to set.
 * Packaged builds return null on purpose: the executable / bundle already carries a proper multi-size icon, and
 * a PNG set here would replace it with a runtime downscale on Windows.
 */
export function windowIconPath() {
  return isDev ? path.join(projectRoot, "resources", "icon.png") : null;
}

/**
 * Notification icon (Windows: the image beside the toast body; Linux: the notification icon; macOS ignores it and
 * shows the bundle icon). The full-size source icon: in dev straight from resources/, when packaged from the copy
 * that electron-builder.yml `extraResources` places at the resources root. The adapter layer silently ignores it if missing.
 */
export function notificationIconPath() {
  return isDev ? path.join(projectRoot, "resources", "icon.png") : path.join(process.resourcesPath, "icon.png");
}

/**
 * Windows dev only: give the toast header the app's name and icon.
 *
 * Windows brands a toast (header name + small icon) from the Start Menu shortcut whose AppUserModelID matches the
 * sender's. The installer writes that shortcut for the packaged app, so there it just works. `electron .` has no
 * shortcut, and Windows then falls back to the process executable: electron.exe, i.e. "Electron" with its atom. So
 * the dev launch writes its own shortcut, under the dev AppUserModelID. Idempotent: rewritten only when the target,
 * arguments, icon or id drift (a moved checkout, an Electron upgrade). Shortcut icons must be .ico -- resources/icon.ico
 * is the multi-size build of resources/icon.png that electron-builder also uses for the Windows installer.
 * The first toast after the shortcut appears can still say "Electron": the shell picks the new shortcut up asynchronously.
 */
export function ensureDevStartMenuShortcut() {
  if (!isDev || process.platform !== "win32") return;
  const lnk = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Zeraix Dev.lnk");
  const want = {
    target: process.execPath,
    args: `"${projectRoot}"`,
    cwd: projectRoot,
    description: "Zeraix (development launch)",
    icon: path.join(projectRoot, "resources", "icon.ico"),
    iconIndex: 0,
    appUserModelId: appUserModelId(),
  };
  try {
    const have = shell.readShortcutLink(lnk); // throws when the shortcut does not exist
    if (["target", "args", "icon", "appUserModelId"].every((k) => have[k] === want[k])) return;
  } catch {
    /* absent or unreadable: (re)write it */
  }
  try {
    shell.writeShortcutLink(lnk, "create", want);
  } catch (e) {
    console.warn("[app] could not write the dev Start Menu shortcut; toasts stay branded as Electron:", e?.message ?? e);
  }
}
