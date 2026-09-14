/**
 * Routing `zeraix://` deep links to the running app (electron/services/deepLink.mjs registers the scheme and parses them).
 *
 * A link can arrive before the app is ready, while the consent screen is up, in a second instance's argv, or through
 * macOS open-url. Until a window can take it, it is stashed; startup hands it over once the window exists.
 */
import { app } from "electron";
import { registerProtocolClient, findDeepLink } from "../services/deepLink.mjs";
import { isLegalAccepted } from "../legal/consentWindow.mjs";
import { focusMainWindow, getMainWindow } from "./window.mjs";

let pendingDeepLink = null;

/** Before app ready: claim the scheme, stash a cold-start link, and listen for the ones that arrive later. */
export function installDeepLinkRouting() {
  // Register as the default handler for the zeraix:// protocol (registered dynamically in dev, declared by electron-builder when packaged).
  registerProtocolClient();

  // Cold start with a deep link (Windows/Linux: clicking a link while the app is not running -> the URL is in argv on first launch).
  // Before app ready we can only stash it and process it once the window is ready. macOS cold start goes through open-url, see the listener below.
  pendingDeepLink = findDeepLink(process.argv);

  // Windows/Linux: a second instance (usually launched by a deep link) starts -> the first instance receives its argv here,
  // extracts the deep link, and brings the window to the foreground.
  app.on("second-instance", (_e, argv) => {
    focusMainWindow();
    handleDeepLink(findDeepLink(argv));
  });

  // macOS: the system delivers deep links via the open-url event (may arrive before app ready; handleDeepLink stashes it internally).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

/** Whether a link is waiting for a window (a background launch with one stays out of headless mode). */
export const hasPendingDeepLink = () => !!pendingDeepLink;

/** A deep link present at cold start (Windows/Linux argv / an early open-url on macOS) is processed once the window is ready. */
export function flushPendingDeepLink() {
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    handleDeepLink(url);
  }
}

/**
 * Handle one `zeraix://…` deep link: bring the app to the foreground and forward the parsed structure to the renderer
 * (for optional in-app routing after login completes). If the app is not ready, stash it first; the startup flow processes it after ready.
 */
function handleDeepLink(url) {
  if (!url) return;
  // Also stashed while the consent screen is up: the window it needs cannot exist yet, and the link is
  // processed once startup resumes (see flushPendingDeepLink).
  if (!app.isReady() || !isLegalAccepted()) {
    pendingDeepLink = url;
    return;
  }
  console.log("[deep-link] launched by:", url);
  focusMainWindow();
  try {
    const u = new URL(url);
    getMainWindow()?.webContents.send("deep-link", {
      url,
      host: u.host,
      pathname: u.pathname,
      params: Object.fromEntries(u.searchParams),
    });
  } catch {
    /* Invalid URL: the window is already in the foreground, ignore the parse failure */
  }
}
