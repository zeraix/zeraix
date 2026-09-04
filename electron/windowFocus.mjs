/**
 * Bring a window in front of everything else and give it focus: restore if minimized, show if hidden, then focus.
 *
 * Every "come back to the app" path goes through here -- a notification click, a tray "Open", a deep link handed
 * over by a second instance. On Windows all of those arrive while some other process owns the foreground, and
 * Windows then refuses SetForegroundWindow to us (the foreground lock): `focus()` alone only flashes the taskbar
 * button and the window stays buried. Briefly making the window topmost is allowed regardless, and dropping the
 * flag again leaves it at the top of the normal z-order. A window the user pinned always-on-top is left pinned.
 * The state broadcast to the renderer (window:always-on-top-changed) is only sent by the explicit IPC toggles,
 * so this round trip is invisible to it.
 */
export function bringWindowToFront(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === "win32" && !win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  }
  win.focus();
}
