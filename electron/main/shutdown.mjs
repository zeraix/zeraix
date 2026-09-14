/**
 * Quitting: the teardown every quit path runs (tray Quit, macOS Cmd-Q, updater restart, OS shutdown), and whether
 * closing the last window quits at all.
 */
import { app } from "electron";
import * as localLlm from "../llm/localServer.mjs";
import { disposeEngines } from "../tools/aiToolkit.mjs";
import { killAllTerminals } from "../tools/terminal.mjs";
import { shutdown as shutdownRustRuntime } from "../tools/rustRuntime.mjs";
import { flushUsageLog } from "../store/usageLogStore.mjs";
import { releaseSessionLock } from "../store/sessionLock.mjs";
import { disposeMcp } from "../ipc/mcpIpc.mjs";
import { killBrowserAutomation } from "../ipc/browserAutomationIpc.mjs";
import { shutdownAutomation } from "../automation/paths.mjs";
import { shutdownPlugins } from "../plugins/paths.mjs";
import { closeDb } from "../automation/db.mjs";
import { isBackgroundEnabled } from "../services/background.mjs";
import { markQuitting } from "./window.mjs";

export function installQuitHandlers() {
  app.on("before-quit", () => {
    // Let the window `close` handler through: from here on a close is a real teardown, not a hide.
    // Covers every quit path (tray Quit, macOS Cmd-Q, updater restart, OS shutdown).
    markQuitting();
    // Kill the automation child process before quitting to avoid it hanging.
    try {
      killBrowserAutomation();
    } catch {
      /* ignore */
    }
    // Write out whatever the usage log still has buffered, so the last turn of a session is not the
    // one entry missing from it.
    try {
      void flushUsageLog();
    } catch {
      /* ignore */
    }
    // Terminate all built-in terminal PTY sessions before quitting to avoid leftover shell processes.
    try {
      killAllTerminals();
    } catch {
      /* ignore */
    }
    // Kill the local llama-server child process before quitting to avoid a leftover orphan process holding the port.
    try {
      localLlm.stop();
    } catch {
      /* ignore */
    }
    // Kill AI-started background processes (dev server / watcher, etc.) and shut down the sandbox VM (if in use),
    // to avoid leftover orphan processes holding ports after quit.
    try {
      disposeEngines();
    } catch {
      /* ignore */
    }
    // Close MCP connections: a stdio server is a child process we spawned, so quitting without this
    // leaves an orphan holding whatever it had open.
    try {
      void disposeMcp();
    } catch {
      /* ignore */
    }
    // Stop the Rust sidecar. It does exit on its own when stdin reaches EOF, which happens once this
    // process is gone -- but that is the backstop, not the shutdown path. Asking it to stop lets it
    // finish writing its own logs before the pipe closes, and matters more now that a packaged build
    // spawns it for every user rather than only for a developer who opted in.
    try {
      void shutdownRustRuntime();
    } catch {
      /* ignore */
    }
    // Abort in-flight automation runs (killing their child process trees) before closing the database,
    // so a quit does not leave orphaned processes behind.
    try {
      shutdownAutomation();
    } catch {
      /* ignore */
    }
    // Stop the registry refresh timers; nothing to flush, the lockfile is written on every change.
    try {
      shutdownPlugins();
    } catch {
      /* ignore */
    }
    // Close the automation database so WAL is checkpointed rather than left for recovery on next open.
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    // LAST: the session ended cleanly only if everything above ran. A crash anywhere in this handler leaves the
    // lock behind, and the next launch reports an unclean shutdown — which is the truth.
    try {
      releaseSessionLock();
    } catch {
      /* ignore */
    }
  });

  app.on("window-all-closed", () => {
    // Background mode: stay resident so the automation scheduler keeps running with no window open.
    // The tray is the only way back in, so this must never be reached without a tray present
    // (initBackground guarantees one whenever background mode or a --background launch is active).
    if (isBackgroundEnabled()) return;
    // macOS convention: the app stays active after all windows are closed
    if (process.platform !== "darwin") app.quit();
  });
}
