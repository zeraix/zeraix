/**
 * The Electron-facing edge of the automation subsystem: the one module here that imports `electron`.
 *
 * Everything else takes its root directory from storage.mjs, so the rest of the subsystem stays
 * loadable (and testable) in a plain Node process. Keep it that way -- adding an `electron` import
 * to db.mjs, definitions.mjs, or a runtime would make that module, and every module importing it,
 * impossible to cover with `npm test`.
 */
import { app } from "electron";
import path from "node:path";
import { setAutomationRoot } from "./storage.mjs";
import { openDb } from "./db.mjs";
import { createExecutionManager } from "./executionManager.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createDispatcher } from "./dispatcher.mjs";
import { registerWorkflowIpc } from "./ipc.mjs";
import { approvalStrings } from "./approvalStrings.mjs";
import { setLlmConfigReader } from "../agent/modelResolver.mjs";
import { getAppConfig } from "../appConfig.mjs";
import { llmChat } from "../llm/proxy.mjs";
import { appendEntry } from "../store/usageLogStore.mjs";
import { listTools, runTool } from "../tools/aiToolkit.mjs";

/** Default location, alongside the conversation store under userData/agent. */
export function defaultAutomationDir() {
  return path.join(app.getPath("userData"), "agent", "automation");
}

let manager = null;
let notifier = null;
let expiryTimer = null;
let scheduler = null;

/** Inject the notification service (created in main.mjs, which owns the window accessors). */
export function setAutomationNotifier(service) {
  notifier = service;
}

/** The Execution Manager singleton, or null before initAutomation() has run. */
export function getExecutionManager() {
  return manager;
}

/**
 * Initialize the automation subsystem: fix the storage root, open/migrate the database, and run
 * crash recovery. Call once during app startup, after `app.whenReady()`.
 * @param {string} [dir] Override the root (used by tests / a future custom-location setting).
 */
export function initAutomation(dir) {
  const root = setAutomationRoot(dir ?? defaultAutomationDir());
  openDb();

  // Agent nodes resolve models from app.config's [llm] section, which the renderer mirrors on every
  // settings change -- the durable copy of what the chat UI keeps in localStorage. Injected rather
  // than imported so the resolver stays loadable outside Electron (§9.1).
  setLlmConfigReader(() => getAppConfig()?.llm ?? {});

  // The agent runtime shares the chat agent's tool registry and LLM transport; only the turn loop
  // is separate (see electron/agent/turn.mjs for why).
  // logEvent records what an unattended node actually did into the usage log (off by default). Model
  // usage is captured inside llmChat itself; this covers the tool calls, which the transport can't see.
  const dispatcher = createDispatcher({ agent: { llmChat, listTools, runTool, logEvent: appendEntry } });

  manager = createExecutionManager({
    dispatcher,
    // No workdir here on purpose: a run's save path is derived from the automation root, per run
    // (storage.mjs runDir), so there is nothing for the wiring layer to choose or get wrong.
    // How the user finds out a run is waiting on them. Deliberately best-effort: an OS notification
    // can only fire while this process is alive, so it is a *nudge*, never the system of record.
    // Pending approvals are also listed in the UI on open, and their deadlines are evaluated by the
    // clock at startup -- so a decision is never lost just because the app was closed.
    notifyApproval: ({ runId, workflowName, deadlineAt }) => {
      try {
        notifier?.send({
          title: approvalStrings().title,
          body: deadlineAt
            ? `${workflowName} — ${approvalStrings().expires} ${new Date(deadlineAt).toLocaleString()}`
            : workflowName,
          type: "warning",
          priority: "high",
          // Clicking routes into the app, creating a window first if none exists (see
          // ensureMainWindow in main.mjs) -- otherwise a click in tray mode would do nothing.
          route: `/agent/automation?run=${encodeURIComponent(runId)}`,
        });
      } catch (e) {
        console.warn("[automation] approval notification failed:", e?.message || e);
      }
    },
  });
  // Reap orphaned processes and mark stranded runs BEFORE anything new is scheduled, so a resumed
  // run never contends with a dead run's leftovers (§5.1).
  manager.recoverInterrupted();
  // Registered after the manager exists so the IPC layer can subscribe to its event bus.
  registerWorkflowIpc({ getManager: () => manager });

  // The scheduler starts AFTER recoverInterrupted() above: catch-up may enqueue runs immediately,
  // and a new run must never contend with a dead run's leftovers (§5.1). Its first act is a catch-up
  // pass for everything that came due while the app was closed, which is the normal case rather than
  // the exception -- see §12.2.
  scheduler = createScheduler({ getManager: () => manager });
  scheduler.start();

  // Deadlines almost always elapse while the app is closed, so recoverInterrupted() already swept
  // them once above. This timer only covers a deadline that falls during a long session.
  clearInterval(expiryTimer);
  expiryTimer = setInterval(() => {
    try {
      manager?.expireOverdueApprovals();
    } catch (e) {
      console.warn("[automation] approval expiry sweep failed:", e?.message || e);
    }
  }, 60_000);
  expiryTimer.unref?.();
  console.log("[automation] storage root:", root);
  return root;
}

/** Abort in-flight runs and release runtime resources (app shutdown). */
export async function shutdownAutomation() {
  clearInterval(expiryTimer);
  expiryTimer = null;
  // Stopped before the manager: a tick landing mid-shutdown would otherwise enqueue a run into an
  // executor that is already tearing down.
  scheduler?.stop();
  scheduler = null;
  await manager?.shutdown();
  manager = null;
}
