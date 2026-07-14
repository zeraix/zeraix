/**
 * Built-in terminal bridge: Bridges the renderer layer (xterm.js) with the main process (node-pty session).
 * Refer to `electron/tools/terminal.mjs` and `window.terminal` inside `electron/preload.cjs`.
 * Exclusive to the Electron desktop client; falls back to an unsupported state on the Web.
 */

export interface TerminalCreateOpts {
  cols?: number;
  rows?: number;
  /** Initial working directory; defaults to the main process's current working directory (consistent with the file tree / AI tools). */
  cwd?: string;
}

export interface TerminalDataMsg {
  id: number;
  data: string;
}
export interface TerminalExitMsg {
  id: number;
  exitCode: number;
  signal?: number;
}

export interface TerminalBridge {
  create(opts?: TerminalCreateOpts): Promise<number>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  /** Kills all active sessions belonging to the current window. */
  killAll(): void;
  onData(cb: (msg: TerminalDataMsg) => void): () => void;
  onExit(cb: (msg: TerminalExitMsg) => void): () => void;
}

declare global {
  interface Window {
    terminal?: TerminalBridge;
  }
}

/** Retrieves the terminal bridge (or `null` if it is not supported/available). */
export function terminalBridge(): TerminalBridge | null {
  return typeof window !== "undefined" && window.terminal ? window.terminal : null;
}

/** Whether the built-in terminal is available (only Electron). */
export function isTerminalAvailable(): boolean {
  return terminalBridge() !== null;
}
