/**
 * Renderer-layer wrapper for accessing window controls.
 *
 * Exposed by preload as `window.windowControls` (see electron/preload.cjs); under the hood it calls the main process
 * to control the window's minimize / resize / close (see registerWindowControls in electron/main.mjs).
 * Only available in Electron; under browser / Web deployments `isWindowControlsAvailable()` is false,
 * and the custom-drawn macOS-style traffic lights degrade to pure decoration.
 */

interface WindowControlsBridge {
  minimize(): Promise<void>;
  /** Toggle maximize / restore; returns the maximized state after toggling. */
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Subscribe to maximize-state changes; returns an unsubscribe function. */
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  /** macOS only: hide / restore the native traffic lights. */
  setNativeButtons(visible: boolean): Promise<void>;
  /** Query whether the window is always-on-top. */
  isAlwaysOnTop(): Promise<boolean>;
  /** Set the window always-on-top; returns the state after setting. */
  setAlwaysOnTop(on: boolean): Promise<boolean>;
  /** Toggle the window always-on-top; returns the state after toggling. */
  toggleAlwaysOnTop(): Promise<boolean>;
  /** Subscribe to always-on-top state changes; returns an unsubscribe function. */
  onAlwaysOnTopChange(cb: (on: boolean) => void): () => void;
}

declare global {
  interface Window {
    windowControls?: WindowControlsBridge;
  }
}

/** Whether the current environment provides window controls (Electron only). */
export function isWindowControlsAvailable(): boolean {
  return typeof window !== "undefined" && !!window.windowControls;
}

/** Minimize the window (no-op outside Electron). */
export function minimizeWindow(): void {
  window.windowControls?.minimize?.();
}

/** Toggle maximize / restore; returns the maximized state after toggling, or false outside Electron. */
export async function toggleMaximizeWindow(): Promise<boolean> {
  return (await window.windowControls?.toggleMaximize?.()) ?? false;
}

/** Close the window (no-op outside Electron). */
export function closeWindow(): void {
  window.windowControls?.close?.();
}

/** Query whether the window is currently maximized (returns false outside Electron). */
export async function isWindowMaximized(): Promise<boolean> {
  return (await window.windowControls?.isMaximized?.()) ?? false;
}

/** Subscribe to maximize-state changes; returns an unsubscribe function (no-op outside Electron). */
export function onWindowMaximizeChange(cb: (maximized: boolean) => void): () => void {
  return window.windowControls?.onMaximizeChange?.(cb) ?? (() => {});
}

/** macOS only: hide / restore the native traffic lights (no-op outside Electron). */
export function setNativeWindowButtons(visible: boolean): void {
  window.windowControls?.setNativeButtons?.(visible);
}

/** Query whether the window is always-on-top (returns false outside Electron). */
export async function isWindowAlwaysOnTop(): Promise<boolean> {
  return (await window.windowControls?.isAlwaysOnTop?.()) ?? false;
}

/** Toggle the window always-on-top; returns the state after toggling (returns false outside Electron). */
export async function toggleWindowAlwaysOnTop(): Promise<boolean> {
  return (await window.windowControls?.toggleAlwaysOnTop?.()) ?? false;
}

/** Subscribe to always-on-top state changes; returns an unsubscribe function (no-op outside Electron). */
export function onWindowAlwaysOnTopChange(cb: (on: boolean) => void): () => void {
  return window.windowControls?.onAlwaysOnTopChange?.(cb) ?? (() => {});
}
