/**
 * Renderer-layer wrapper for accessing the main process's shell capabilities (see `window.shellApi` in electron/preload.cjs).
 * Only available in Electron; a no-op (returns failure) under browser / Web.
 */
interface ShellBridge {
  /** Open a path (file or folder) in the system file manager / default app. ok=true on success. */
  openPath(path: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    shellApi?: ShellBridge;
  }
}

/** Whether the current environment provides shell capabilities (Electron only). */
export function isShellAvailable(): boolean {
  return typeof window !== "undefined" && !!window.shellApi;
}

/** Open a path in the system file manager / default app (returns failure outside Electron). */
export function openPathInShell(path: string): Promise<{ ok: boolean; error?: string }> {
  if (!path) return Promise.resolve({ ok: false, error: "empty path" });
  return window.shellApi?.openPath?.(path) ?? Promise.resolve({ ok: false, error: "not available" });
}
