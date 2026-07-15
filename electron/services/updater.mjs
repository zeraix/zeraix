/**
 * Auto-update service (electron-updater wrapper).
 *
 * Feed: GitHub Releases, configured by the `publish` block in electron-builder.yml, which is what
 * makes electron-builder emit the latest.yml / latest-mac.yml manifests this reads. The repo is
 * public, so no token ships in the installer.
 *
 * Deliberately contains NO user-facing strings: it only reports state. The renderer owns the UI and
 * localizes it from src/locales/*.json, matching how notifications already work (the main process
 * displays whatever pre-localized title/body the renderer hands it — see adapters/notificationAdapter.mjs).
 *
 * Platform reality:
 *   - Windows (nsis): works on unsigned builds. Users still see SmartScreen on first install.
 *   - macOS: Squirrel.Mac verifies that the update's code signature matches the running app and
 *     refuses otherwise. Without a Developer ID certificate (CSC_LINK) mac updates CANNOT apply —
 *     checking fails with "Could not get code signature for running application". That is reported
 *     as a normal error; there is no bypass.
 */
import { app } from "electron";
import electronUpdater from "electron-updater";

// electron-updater is CJS; destructure after a default import so this stays a real ESM module.
const { autoUpdater } = electronUpdater;

/** @typedef {"idle"|"checking"|"available"|"not-available"|"downloading"|"downloaded"|"error"} UpdaterStatus */

/** Single source of truth, mirrored to the renderer on every transition. */
let state = /** @type {{status: UpdaterStatus, version: string|null, percent: number, error: string|null}} */ ({
  status: "idle",
  version: null,
  percent: 0,
  error: null,
});

let broadcastFn = null;
let wired = false;

function setState(patch) {
  state = { ...state, ...patch };
  broadcastFn?.("updater:state", state);
}

/** Updates only work from a packaged app: unpackaged, electron-updater has no app-update.yml and throws. */
function updatesSupported() {
  return app.isPackaged;
}

function wireEvents() {
  if (wired) return;
  wired = true;

  // The user decides when to download; auto-download would consume bandwidth unannounced.
  autoUpdater.autoDownload = false;
  // Install on quit rather than forcing a restart out from under the user.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setState({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => setState({ status: "available", version: info?.version ?? null, error: null }));
  autoUpdater.on("update-not-available", () => setState({ status: "not-available", version: null, error: null }));
  autoUpdater.on("download-progress", (p) => setState({ status: "downloading", percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (info) => setState({ status: "downloaded", version: info?.version ?? null, percent: 100 }));
  autoUpdater.on("error", (err) => {
    // Raw message: the renderer maps known cases (offline, unsigned mac build) onto localized copy.
    setState({ status: "error", error: String(err?.message ?? err) });
  });
}

/** @param {(channel: string, payload: any) => void} broadcast */
export function initUpdater(broadcast) {
  broadcastFn = broadcast;
  if (!updatesSupported()) return;
  wireEvents();
}

export function getUpdaterState() {
  return { ...state, supported: updatesSupported(), currentVersion: app.getVersion() };
}

/** Check for an update. Resolves {ok} — never throws, so the renderer can render the error state. */
export async function checkForUpdates() {
  if (!updatesSupported()) return { ok: false, supported: false };
  try {
    wireEvents();
    await autoUpdater.checkForUpdates();
    return { ok: true, supported: true };
  } catch (e) {
    setState({ status: "error", error: String(e?.message ?? e) });
    return { ok: false, supported: true, error: String(e?.message ?? e) };
  }
}

/** Download the pending update. Progress arrives via the "updater:state" broadcast. */
export async function downloadUpdate() {
  if (!updatesSupported()) return { ok: false, supported: false };
  try {
    setState({ status: "downloading", percent: 0, error: null });
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    setState({ status: "error", error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Quit and install a downloaded update. No-op unless status is "downloaded". */
export function quitAndInstall() {
  if (state.status !== "downloaded") return { ok: false, error: "no update downloaded" };
  // isSilent=false so the NSIS UI shows; isForceRunAfter=true reopens the app afterwards.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}
