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
  // Broadcast the SAME shape the updater:state invoke returns — i.e. including `supported` and
  // `currentVersion`, which live outside `state`. Pushing the bare object instead meant every
  // transition after the initial fetch arrived with supported:undefined, and the renderer (which
  // hides the whole UI when updates are unsupported) blanked the card the instant a download
  // started: progress vanished mid-download, exactly when it mattered most.
  broadcastFn?.("updater:state", getUpdaterState());
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
  // Install on quit rather than forcing a restart out from under the user. This is what makes the
  // renderer's "Install later" work: the staged update is applied when the app quits, so the next
  // launch is already the new version — no further prompting needed.
  autoUpdater.autoInstallOnAppQuit = true;
  // Always fetch the full installer instead of patching the installed one from its blockmap.
  // The differential path is the reason a download could run to completion while emitting no
  // "download-progress" events and, on a blockmap mismatch, finish without ever reporting
  // "update-downloaded" — the UI looked frozen even though bytes were moving. A full download
  // costs bandwidth once and reports progress reliably.
  autoUpdater.disableDifferentialDownload = true;

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

/**
 * Download the pending update. Progress arrives via the "updater:state" broadcast.
 *
 * Resolves only when the download finishes, so a second call while one is in flight would start a
 * parallel download of the same file — hence the guard.
 */
export async function downloadUpdate() {
  if (!updatesSupported()) return { ok: false, supported: false };
  if (state.status === "downloading") return { ok: true, alreadyRunning: true };
  try {
    setState({ status: "downloading", percent: 0, error: null });
    await autoUpdater.downloadUpdate();
    // Belt and braces: if the run emitted no "update-downloaded" (seen on some Windows paths), the
    // download is still finished here — report it rather than leaving the UI spinning forever.
    if (state.status === "downloading") setState({ status: "downloaded", percent: 100 });
    return { ok: true };
  } catch (e) {
    setState({ status: "error", error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Quit and install a downloaded update. No-op unless status is "downloaded".
 *
 * isSilent=true runs the Windows installer with /S: no wizard, no "do you want to install" prompt —
 * the user already consented by clicking Install now, and asking twice is just friction. NSIS reuses
 * the install directory recorded at first install, so nothing needs to be chosen again.
 * isForceRunAfter=true relaunches the app once the swap is done.
 *
 * Both flags are ignored on macOS: Squirrel.Mac always replaces the bundle itself, which is why the
 * Mac side already felt silent. The "Install later" path (autoInstallOnAppQuit) is silent on Windows
 * too — electron-updater's quit handler installs with isSilent=true and no relaunch.
 *
 * One prompt is NOT ours to suppress: if the app was installed per-machine (Program Files), writing
 * there needs elevation and Windows shows a UAC dialog no matter what /S says. A per-user install
 * (%LOCALAPPDATA%, electron-builder's default) updates with no prompt at all.
 */
export function quitAndInstall() {
  if (state.status !== "downloaded") return { ok: false, error: "no update downloaded" };
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}
