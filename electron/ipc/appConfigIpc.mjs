/**
 * app.config (an INI file alongside the executable) IPC: renderer window.appConfig.* -> main process reads/writes.
 * get-all-sync uses the synchronous channel, to load file values into the renderer store at startup (avoiding async races).
 */
import { ipcMain, shell } from "electron";
import {
  loadAppConfig,
  getAppConfig,
  setAppConfig,
  removeAppConfig,
  getConfigPath,
  ensureConfigFile,
  ensureAppConfigKeys,
} from "../appConfig.mjs";

export function registerAppConfig() {
  loadAppConfig();
  // Pre-populate the [google] section so users can see and fill in Google login credentials directly in app.config
  // (in dev just override with .env; for packaged distribution fill it in here manually). For a distributed
  // Desktop client, both client_id and client_secret are "not treated as secret" and can be shipped with the package; Google's Desktop-client token exchange requires
  // sending client_secret, so both are pre-populated.
  ensureAppConfigKeys("google", ["client_id", "client_secret"]);
  ipcMain.on("appconfig:get-all-sync", (e) => {
    e.returnValue = getAppConfig();
  });
  ipcMain.handle("appconfig:set", (_e, { section, key, value }) =>
    setAppConfig(section, key, value),
  );
  ipcMain.handle("appconfig:remove", (_e, { section, key }) => removeAppConfig(section, key));
  // Open app.config in the system default editor; if the file does not exist, create it on disk first. Returns { ok, path, error? }.
  ipcMain.handle("appconfig:open-file", async () => {
    const p = ensureConfigFile();
    const error = await shell.openPath(p); // Returns "" on success, an error string on failure
    return { ok: !error, path: p, error: error || undefined };
  });
  // Return the absolute path of app.config (for the renderer to display).
  ipcMain.handle("appconfig:get-path", () => getConfigPath());
}
