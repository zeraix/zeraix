/**
 * The first-launch consent screen: a window of its own, shown before the app's window exists.
 *
 * The Privacy Policy and the Terms of Service have to be agreed to before the app can be used, so the check
 * runs in the MAIN process at the top of startup, before any service or window. Until it resolves, nothing
 * else opens — createWindow refuses (isLegalAccepted), so a deep link or a tray click arriving while the
 * screen is up cannot get around it. Declining, or closing the screen, ends the launch.
 *
 * A plain static page (consent.html) over a three-call preload, deliberately outside the renderer app: it
 * loads instantly, needs none of the app's services, and can do nothing but answer.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_VERSION, PRIVACY_URL, TERMS_URL, isAccepted, readConsent, writeConsent } from "./consentState.mjs";
import { DEFAULT_LANGUAGE, LANGUAGES, STRINGS } from "./consentStrings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let accepted = false;

/** Whether this launch may open the app. False until ensureLegalConsent has resolved true. */
export const isLegalAccepted = () => accepted;

const consentFile = () => path.join(app.getPath("userData"), "legal-consent.json");

/**
 * Resolve true once the current version of the documents has been agreed to — at once when the record on
 * disk already says so, otherwise after the screen has been answered. Resolves false when it is declined or
 * closed; the caller quits.
 */
export async function ensureLegalConsent({ iconPath } = {}) {
  if (isAccepted(readConsent(consentFile()), LEGAL_VERSION)) {
    accepted = true;
    return true;
  }
  // Every language goes over at once: the page switches between them itself, without a round trip.
  const payload = { languages: LANGUAGES, defaultLanguage: DEFAULT_LANGUAGE, strings: STRINGS, privacyUrl: PRIVACY_URL, termsUrl: TERMS_URL };

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      ipcMain.removeHandler("legal:strings");
      ipcMain.removeHandler("legal:accept");
      ipcMain.removeHandler("legal:decline");
    };
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      accepted = ok;
      resolve(ok);
    };

    const win = new BrowserWindow({
      width: 540,
      height: 500,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "Zeraix",
      autoHideMenuBar: true,
      ...(iconPath && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        preload: path.join(__dirname, "consentPreload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    ipcMain.handle("legal:strings", () => payload);
    ipcMain.handle("legal:accept", () => {
      try {
        writeConsent(consentFile(), LEGAL_VERSION);
      } catch (e) {
        // The agreement was given; a disk that cannot record it means asking again next launch, not refusing now.
        console.warn("[legal] could not record the agreement:", e?.message ?? e);
      }
      settle(true);
      win.close();
    });
    ipcMain.handle("legal:decline", () => {
      settle(false);
      win.close();
    });

    // The two documents open in the system browser; the screen itself never navigates anywhere.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    // Closing the screen is declining. A close that followed an answer is already settled and ignored here.
    win.on("closed", () => settle(false));
    void win.loadFile(path.join(__dirname, "consent.html"));
  });
}
