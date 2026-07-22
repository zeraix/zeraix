/**
 * Renderer bridge for background / tray mode (see electron/services/background.mjs).
 *
 * Background mode keeps the app resident after the last window closes, so scheduled automations can
 * still fire. It is desktop-only: every function here degrades to a no-op in the Web build, and
 * getBackgroundState() returns null so callers can hide the UI entirely.
 */

export interface BackgroundState {
  /** Stay resident after the last window is closed. */
  enabled: boolean;
  /** Registered as a login item (launches hidden, tray only). */
  openAtLogin: boolean;
  /** "Pause all automations" — runtime only, resets on restart. */
  paused: boolean;
  /** False when the desktop environment provides no system tray (some Linux setups). */
  traySupported: boolean;
}

interface BackgroundBridge {
  get(): Promise<BackgroundState>;
  setEnabled(on: boolean): Promise<boolean>;
  setOpenAtLogin(on: boolean): Promise<boolean>;
  setPaused(on: boolean): Promise<boolean>;
  setTrayLabels(labels: Record<string, string>): void;
}

declare global {
  interface Window {
    background?: BackgroundBridge;
  }
}

function bridge(): BackgroundBridge | null {
  return typeof window !== "undefined" && window.background ? window.background : null;
}

/** Whether the current environment supports background mode (Electron only). */
export function isBackgroundAvailable(): boolean {
  return bridge() !== null;
}

/** Current background state, or null in the Web build (caller should hide the UI). */
export async function getBackgroundState(): Promise<BackgroundState | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.get();
  } catch {
    return null;
  }
}

/**
 * Enable/disable background mode. Returns the state the main process actually settled on — enabling
 * fails (returns false) when no system tray can be created, since a resident app with no tray would
 * be unreachable. Callers must reconcile their optimistic UI with this value.
 */
export async function setBackgroundEnabled(on: boolean): Promise<boolean> {
  return (await bridge()?.setEnabled(on)) ?? false;
}

export async function setBackgroundOpenAtLogin(on: boolean): Promise<void> {
  await bridge()?.setOpenAtLogin(on);
}

export async function setAutomationsPaused(on: boolean): Promise<void> {
  await bridge()?.setPaused(on);
}

/**
 * Hand the main process its translated tray-menu labels.
 *
 * The main process has no i18n runtime, and the tray must render on an autostart launch before any
 * renderer exists — so the labels are persisted and reused on the next headless start. Call this
 * whenever the app loads and whenever the user changes language.
 */
export function syncTrayLabels(labels: {
  open: string;
  pause: string;
  quit: string;
  running: string;
}): void {
  bridge()?.setTrayLabels(labels);
}
