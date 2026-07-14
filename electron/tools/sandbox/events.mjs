/**
 * Hub for background-service start/stop events (shared across the engine layer).
 *
 * Formerly in aiToolkit.mjs: main injects a callback → the engine (native / qemu) broadcasts to the renderer
 * when a background service starts / stops (GlobalNotifications display and stop button).
 * Split into its own small module to avoid a circular dependency between engine.mjs ↔ the individual engine implementations.
 */

let serviceEvents = null;

/** main injects the event callback (evt → broadcast to all windows). Passing a non-function clears it. */
export function setServiceEventHandler(fn) {
  serviceEvents = typeof fn === "function" ? fn : null;
}

/** Engine-side event emission: { type: "started"|"stopped", pid, url?, command? }. */
export function emitService(evt) {
  try {
    serviceEvents?.(evt);
  } catch {
    /* a broadcast failure must not affect the process */
  }
}
