/**
 * PTY backend for the built-in terminal (main process).
 *
 * Uses node-pty to start a "real pseudo-terminal", bridged to xterm.js in the renderer, to achieve interaction
 * identical to the system's native terminal: full-screen TUIs (vim / top / less), true color, signals such as
 * Ctrl-C, Tab completion, line editing, etc. -- things the child_process pipe approach (like run_command) cannot
 * do, which is why the terminal spins up its own PTY instead of reusing the command-execution engine.
 *
 * One auto-incrementing id per session. PTY output is pushed via webContents.send("terminal:data", {id,data}) to
 * "the renderer window that started the session"; exit is pushed via "terminal:exit". Sessions are grouped by the
 * window that started them and cleaned up together when that window is destroyed, to avoid leaking shells.
 *
 * Note: node-pty is a native module that must be bundled with the main process and unpacked from asar (see the
 * files / asarUnpack settings in electron-builder.yml), and recompiled for the target platform's Electron ABI
 * (electron-builder does npmRebuild by default).
 */
import os from "node:os";
import process from "node:process";
import fs from "node:fs";
import nodePty from "node-pty";
import { getWorkingDir } from "./aiToolkit.mjs";

/** id -> { pty, webContents }. All live sessions. */
const sessions = new Map();
let seq = 0;

const isDir = (p) => {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Pick a shell that "actually exists and is executable" to avoid posix_spawnp failing due to an invalid shell path:
 *  - Windows: prefer PowerShell (COMSPEC is usually cmd; here we explicitly pick the more modern PowerShell), resolved via PATH;
 *  - *nix: try $SHELL -> /bin/zsh (macOS default) -> /bin/bash -> /bin/sh in order, taking the first executable that actually exists.
 */
function resolveShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  for (const c of [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (c && isFile(c)) return c;
  }
  return "/bin/sh";
}

/**
 * Pick a working directory that "actually exists": if the target directory does not exist, try creating it first
 * (the default working dir ~/zeraix-workspace may not yet exist on macOS, and spawning directly with it would make
 * posix_spawnp fail); if that still fails, fall back to the user's home directory / cwd.
 */
function resolveCwd(preferred) {
  let dir = preferred || getWorkingDir() || os.homedir();
  if (!isDir(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* no permission / invalid path: fall back below */
    }
  }
  if (!isDir(dir)) dir = os.homedir();
  if (!isDir(dir)) dir = process.cwd();
  return dir;
}

/**
 * Create a new PTY session bound to the starting window's webContents (used to push output back).
 * cwd defaults to the current working directory (consistent with the file tree / AI tools), under the project directory the user selected.
 * Returns the session id for later write / resize / kill references. On spawn failure, throws a clear error (for the renderer to surface, rather than crashing silently).
 */
export function createTerminal(webContents, opts = {}) {
  const shell = opts.shell || resolveShell();
  const cwd = resolveCwd(opts.cwd);
  const cols = Math.max(1, Math.floor(opts.cols) || 80);
  const rows = Math.max(1, Math.floor(opts.rows) || 24);

  let pty;
  try {
    pty = nodePty.spawn(shell, opts.args || [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // Inherit the main process environment and declare a 256-color terminal type so interactive programs output color / take the TUI branch.
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (e) {
    // Throw a readable error (including shell/cwd); the renderer catches it and shows it in the terminal, rather than "Uncaught (in promise)".
    throw new Error(`Failed to start terminal (shell=${shell}, cwd=${cwd}): ${e instanceof Error ? e.message : String(e)}`);
  }

  const id = ++seq;
  sessions.set(id, { pty, webContents });

  pty.onData((data) => {
    if (!webContents.isDestroyed()) webContents.send("terminal:data", { id, data });
  });
  pty.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    if (!webContents.isDestroyed()) webContents.send("terminal:exit", { id, exitCode, signal });
  });
  // Renderer window destroyed (closed / refreshed) -> clean up all sessions under it.
  webContents.once("destroyed", () => killByWebContents(webContents));

  return id;
}

/** Write user input (passed through to the PTY as-is, including control characters / key-combination sequences). */
export function writeTerminal(id, data) {
  const s = sessions.get(id);
  if (s && typeof data === "string") s.pty.write(data);
}

/** Resize the PTY (synced after xterm fit, so TUIs reflow correctly). */
export function resizeTerminal(id, cols, rows) {
  const s = sessions.get(id);
  if (s && cols > 0 && rows > 0) {
    try {
      s.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* invalid size / session already exited, ignore */
    }
  }
}

/** Terminate a single session. */
export function killTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* already exited, ignore */
  }
  sessions.delete(id);
}

/** Terminate all sessions under a given window (called when the window is destroyed). */
export function killByWebContents(wc) {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) {
      try {
        s.pty.kill();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
    }
  }
}

/** Terminate all sessions (cleanup before app exit). */
export function killAllTerminals() {
  for (const [, s] of sessions) {
    try {
      s.pty.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
