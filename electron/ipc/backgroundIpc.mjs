/**
 * Background / tray mode IPC: renderer window.background.* -> main process.
 * The renderer also pushes its translated tray labels here on load, because the main process has no
 * i18n runtime and the tray must render on a headless start with no renderer at all (see background.mjs).
 *
 * Every handler is currently disabled. Re-enabling them needs `ipcMain` from "electron" and, from
 * ../services/background.mjs: isBackgroundEnabled, setBackgroundEnabled, isOpenAtLogin, setOpenAtLogin,
 * isPaused, setPaused, setTrayLabels, isTraySupported.
 */
export function registerBackground() {
  // ipcMain.handle("background:get", () => ({
  //   enabled: isBackgroundEnabled(),
  //   openAtLogin: isOpenAtLogin(),
  //   paused: isPaused(),
  //   // The tray is the only way back into a windowless app; without it, background mode is unsafe
  //   // to offer at all (common on minimal Linux desktops with no StatusNotifier host).
  //   traySupported: isTraySupported(),
  // }));
  // ipcMain.handle("background:set-enabled", (_e, on) => setBackgroundEnabled(on));
  // ipcMain.handle("background:set-open-at-login", (_e, on) => setOpenAtLogin(on));
  // ipcMain.handle("background:set-paused", (_e, on) => setPaused(on));
  // ipcMain.on("background:set-tray-labels", (_e, labels) => setTrayLabels(labels));
}
