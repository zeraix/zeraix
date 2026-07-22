/**
 * Automation workflow IPC. See docs/automation-workflow-design.md §10.
 *
 * Channel prefix is `wf:` and the preload surface is `window.workflows` -- deliberately NOT
 * `automation:` / `window.automation`, which are already taken by the <webview> CDP browser panel
 * (electron/main.mjs registerAutomation). Its `automation:event` channel is broadcast to every
 * window, so reusing the name would deliver workflow events to the browser panel's handler and vice
 * versa.
 *
 * The renderer is a pure projection (§2, principle 4): it holds no execution state. It hydrates from
 * a snapshot query and then applies the streamed event log, which is why every read here is served
 * from SQLite rather than from anything the manager keeps in memory.
 */
import { ipcMain, BrowserWindow, dialog } from "electron";
import {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  listVersions,
} from "./definitions.mjs";
import * as repo from "./repo.mjs";
import { setApprovalStrings } from "./approvalStrings.mjs";
import { TEMPLATE_IDS, buildTemplate } from "./templates.mjs";

/**
 * @param {object} deps
 * @param {() => (object|null)} deps.getManager Execution Manager accessor (null before init / after failure).
 * @param {() => string} [deps.getWorkdir] Where file-touching tools resolve relative paths. Injected
 *   rather than imported so this module keeps its single Electron dependency and nothing more.
 */
export function registerWorkflowIpc({ getManager, getWorkdir }) {
  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  // Live stream: every persisted event is also pushed to open windows. A headless run (no window)
  // simply has no listeners -- the durable log is unaffected, so a window opened later still sees
  // the full history via wf:run-detail.
  const manager = getManager();
  manager?.bus.on("event", (e) => broadcast("wf:event", e));
  manager?.bus.on("state", (s) => broadcast("wf:state", s));

  /** Uniform guard: automation may be unavailable if initAutomation() failed at startup. */
  const withManager = (fn) => (...args) => {
    const mgr = getManager();
    if (!mgr) return { ok: false, error: "automation is unavailable (initialization failed)" };
    return fn(mgr, ...args);
  };

  /* ----------------------------------------------------------------- definitions */

  ipcMain.handle("wf:list", () => safe(() => listWorkflows(), []));
  ipcMain.handle("wf:get", (_e, { id, version } = {}) => safe(() => getWorkflow(id, version), null));
  ipcMain.handle("wf:versions", (_e, id) => safe(() => listVersions(id), []));

  ipcMain.handle("wf:save", (_e, definition) => {
    try {
      return saveWorkflow(definition);
    } catch (e) {
      return { ok: false, errors: [e?.message || String(e)] };
    }
  });

  /** Ids of the starter templates; the renderer owns their translated names/descriptions. */
  ipcMain.handle("wf:templates", () => TEMPLATE_IDS);

  /**
   * Where a step's file tools actually write.
   *
   * Reported rather than assumed: it is the agent toolkit's working directory, which the chat
   * session also sets, so it is whatever it is *now* — the honest answer to "where did my file go",
   * and the only path an Open-folder button can open without lying about it.
   */
  ipcMain.handle("wf:workdir", () => ({ path: getWorkdir?.() ?? null }));

  /**
   * Create a workflow from a template. Built and validated in the main process so the renderer
   * cannot ship a definition the schema would reject.
   */
  ipcMain.handle("wf:create-from-template", (_e, { templateId, name } = {}) => {
    // The id is minted here, not in the renderer: this side owns the namespace and can check it
    // against what already exists, and a renderer generating ids from the clock is both
    // collision-prone and impure (React Compiler rejects it).
    const id = uniqueWorkflowId();
    const def = buildTemplate(templateId, { id, name });
    if (!def) return { ok: false, errors: [`unknown template "${templateId}"`] };
    try {
      const res = saveWorkflow(def);
      return res.ok ? { ...res, id } : res;
    } catch (e) {
      return { ok: false, errors: [e?.message || String(e)] };
    }
  });

  ipcMain.handle("wf:delete", (_e, id) => {
    try {
      return deleteWorkflow(id);
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  /* ------------------------------------------------------------------------ runs */

  /**
   * Start a run and return its id immediately. Execution continues in the background so the UI can
   * follow it through the event stream instead of blocking on a call that may take minutes.
   */
  ipcMain.handle(
    "wf:run",
    withManager((mgr, _e, { workflowId, variables } = {}) => {
      const created = mgr.createRun({ workflowId, triggerType: "manual", variables });
      if (!created.ok) return created;
      // Deliberately not awaited. Failures land in the run record and the event log, which is where
      // the UI reads them from anyway.
      void mgr.executeRun(created.runId).catch((err) => {
        console.error("[automation] run failed unexpectedly:", err);
      });
      return { ok: true, runId: created.runId };
    }),
  );

  ipcMain.handle(
    "wf:cancel",
    withManager((mgr, _e, runId) => ({ ok: mgr.cancelRun(runId) })),
  );

  ipcMain.handle("wf:runs", (_e, query = {}) => safe(() => repo.listRuns(query), []));

  /**
   * Native file picker for a `file` workflow input. Returns the absolute path; the bytes are never
   * copied into the run record, which would bloat storage and duplicate the document into the log.
   */
  ipcMain.handle("wf:pick-file", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openFile"] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || !res.filePaths?.length ? null : res.filePaths[0];
  });

  /* -------------------------------------------------------------------- approvals */

  /** Everything waiting on a human. The UI shows these on open, because the OS notification that
   *  announced them can only have fired if the app happened to be running at the time. */
  ipcMain.handle("wf:approvals", () => safe(() => repo.pendingApprovals(), []));

  ipcMain.handle(
    "wf:decide",
    withManager((mgr, _e, { approvalId, approved, note } = {}) =>
      mgr.decideApproval({ approvalId, approved: !!approved, note: note ?? null }),
    ),
  );

  /* ------------------------------------------------------------------------ waits */

  /** Runs suspended waiting on the outside world — surfaced so a stalled run is visible. */
  ipcMain.handle("wf:waits", () => safe(() => repo.pendingWaits(), []));

  /**
   * Deliver an inbound event, resuming whichever run is waiting on that key. This is the seam a
   * future webhook or deep-link trigger plugs into; today it is driven manually from the UI.
   */
  ipcMain.handle(
    "wf:deliver",
    withManager((mgr, _e, { key, payload } = {}) => mgr.deliverEvent(key, payload ?? {})),
  );

  /** Translated strings for the approval notification (the main process has no i18n runtime). */
  ipcMain.on("wf:approval-strings", (_e, strings) => setApprovalStrings(strings));

  /**
   * Everything a viewer needs for one run, straight from SQLite. `sinceSeq` lets a reconnecting UI
   * fetch only what it missed rather than re-reading the whole log.
   */
  ipcMain.handle("wf:run-detail", (_e, { runId, sinceSeq = 0 } = {}) =>
    safe(
      () => ({
        run: repo.getRun(runId),
        attempts: repo.listAttempts(runId),
        events: repo.readEvents(runId, { sinceSeq }),
        outputs: repo.nodeOutputs(runId),
      }),
      null,
    ),
  );
}

/** A workflow id that is not already taken. */
function uniqueWorkflowId() {
  const taken = new Set(safe(() => listWorkflows(), []).map((w) => w.id));
  for (let i = 1; ; i++) {
    const id = `wf-${i}`;
    if (!taken.has(id)) return id;
  }
}

/** Read helpers must never throw across IPC: a missing database should degrade, not break the page. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.warn("[automation] ipc read failed:", e?.message || e);
    return fallback;
  }
}
