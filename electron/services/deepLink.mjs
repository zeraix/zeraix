/**
 * Custom protocol (Deep Link) registration and parsing.
 *
 * Purpose: after Google login completes in the system browser, the callback page shows a
 * `zeraix://…` button; when the user clicks it, the OS routes this URL back to this app
 * (bringing the window to the foreground). The RFC 8252 loopback flow has already obtained the
 * id_token inside the app, so the deep link's only job is to "bring the user back from the
 * browser to the app" — it does not carry any token.
 *
 * Platform differences (main.mjs consumes this module's parse result):
 *   - macOS: the system fires an `open-url` event and hands the URL over directly;
 *   - Windows/Linux: the system launches it as a "new process + URL in argv", relying on the
 *     single-instance lock to hand it back to the first instance, then extracts the URL from
 *     argv (see findDeepLink).
 *
 * When packaged for distribution, the protocol is declared in the protocols section of
 * electron-builder.yml (written into Info.plist / the registry); in dev mode (electron .),
 * setAsDefaultProtocolClient registers it dynamically and must be explicitly passed the entry
 * script path, otherwise the system won't know which argument to use to relaunch Electron.
 */
import { app } from "electron";
import path from "node:path";

/** Custom protocol name (without ://). Changing this requires syncing the protocols section of electron-builder.yml. */
export const DEEP_LINK_SCHEME = "zeraix";

/**
 * Register this app as the default handler for `zeraix://`.
 * When packaged, register it directly; in dev mode (process.defaultApp is true, i.e. `electron .`)
 * the entry script path must be passed as an extra argument so the system can relaunch the app in
 * the form "electron <entry>" when a deep link is clicked.
 */
export function registerProtocolClient() {
  if (process.defaultApp) {
    // Dev mode: argv looks like [electron, <entry script>, …]; register the entry script's absolute path.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

/**
 * Find the `zeraix://…` deep link within a set of command-line arguments (on Windows/Linux the
 * URL is right there in argv when launched). Returns null if not found.
 */
export function findDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((a) => typeof a === "string" && a.startsWith(`${DEEP_LINK_SCHEME}://`)) || null;
}
