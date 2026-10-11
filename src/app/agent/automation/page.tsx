"use client";

/**
 * Automation page (/agent/automation).
 *
 * A viewer over the main-process workflow engine (electron/automation/*), not a second source of
 * truth: it hydrates from SQLite via `wf:*` IPC and then applies the streamed event log. Closing and
 * reopening the window must reconstruct the same view -- the acceptance test in
 * docs/automation-workflow-design.md §2 -- so nothing here keeps run state of its own.
 *
 * Definitions are edited two ways: a visual canvas (WorkflowCanvas, @xyflow/react) for the node
 * graph, and a JSON tab for the workflow-level fields a canvas cannot draw (triggers, limits,
 * variables). Both write the same text, so switching tabs never loses an edit. Validation stays in
 * the main process (schema.mjs) -- the dialog only reports what it says.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { Workflow, Play, Square, Trash2, Plus, Pencil, Loader2, ShieldQuestion, Hourglass, Send, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import { openPathInShell } from "@/lib/electron/shell";
import RunInputsDialog, { askableVariables } from "./RunInputsDialog";
import ApprovalPreview from "./ApprovalPreview";
import WorkflowOverviewList from "./WorkflowOverviewList";
import {
  BTN_BASE,
  BTN_DANGER,
  BTN_FOCUS,
  BTN_PRIMARY,
  BTN_SECONDARY,
  LIST_RESET,
  ROW_BASE,
  ROW_IDLE,
  ROW_SELECTED,
  Callout,
  Count,
  EmptyState,
  EventDetail,
  Notice,
  SectionLabel,
  Shell,
  StateChip,
  formatTime,
  hasDetail,
  summarizeEvent,
} from "./automationUi";
import {
  isWorkflowsAvailable,
  listWorkflows,
  getWorkflow,
  deleteWorkflow,
  runWorkflow,
  cancelRun,
  listRuns,
  getRunDetail,
  subscribeToRuns,
  subscribeToRunState,
  isTerminal,
  eventRunId,
  eventNodeId,
  workflowOverview,
  type WorkflowSummary,
  type WorkflowOverview,
  type RunRow,
  type RunDetail,
  type PendingApproval,
  type PendingWait,
  type WorkflowVariable,
  workflowFolder,
  pendingApprovals,
  pendingWaits,
  deliverWorkflowEvent,
  decideApproval,
  syncApprovalStrings,
} from "@/lib/workflows";

/**
 * Starter templates are built and validated in the main process (electron/automation/templates.mjs).
 * An empty canvas teaches nothing: chaining, fan-out and approval are far easier to read from a
 * working example than to assemble from scratch.
 */

/**
 * How often to re-read while the page is on screen.
 *
 * The live `wf:event` / `wf:state` stream only says something *during* a run, so on its own it leaves
 * everything that changes between runs stale: a workflow edited in another window, a schedule whose
 * fire was skipped, and `nextRunAt` itself, which is a clock reading that goes out of date simply by
 * being looked at later. 30s is well under the resolution of anything shown here and costs one
 * indexed query per tick.
 */
const REFRESH_MS = 30_000;

export default function AgentAutomationPage() {
  const t = useT();
  const router = useRouter();
  const search = useSearchParams();
  const available = useMemo(() => isWorkflowsAvailable(), []);

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [overview, setOverview] = useState<WorkflowOverview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-fetch triggers. Live events bump these rather than pushing payloads into state, keeping the
  // view a projection of storage: everything on screen came from a query, never from an event body.
  const [workflowsKey, bumpWorkflows] = useReducer((n: number) => n + 1, 0);
  const [runsKey, bumpRuns] = useReducer((n: number) => n + 1, 0);
  const [detailKey, bumpDetail] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const list = await listWorkflows();
      if (ignore) return;
      setWorkflows(list);
      // Prefer a workflow named in ?selected= (returning from the editor), else keep the current
      // selection, else fall back to the first.
      const wanted = search.get("selected");
      setSelectedId((cur) => cur ?? (wanted && list.some((w) => w.id === wanted) ? wanted : list[0]?.id ?? null));
    })();
    return () => {
      ignore = true;
    };
  }, [available, workflowsKey, search]);

  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const rows = selectedId ? await listRuns({ workflowId: selectedId, limit: 25 }) : [];
      if (!ignore) setRuns(rows);
    })();
    return () => {
      ignore = true;
    };
  }, [available, selectedId, runsKey]);

  // The overview is keyed off the same bumps as the run list: a run finishing changes a workflow's
  // success rate and its last-run dot, so the board would otherwise go stale exactly when it matters.
  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const rows = await workflowOverview();
      if (!ignore) setOverview(rows);
    })();
    return () => {
      ignore = true;
    };
  }, [available, workflowsKey, runsKey]);

  // `ignore` matters here: switching runs quickly would otherwise let a slower earlier response
  // land after a newer one and show the wrong run's timeline.
  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const d = selectedRunId ? await getRunDetail(selectedRunId) : null;
      if (!ignore) setDetail(d);
    })();
    return () => {
      ignore = true;
    };
  }, [available, selectedRunId, detailKey]);

  // Live stream. An event only says *that* something changed; the re-read above is what actually
  // updates the view, so it can never drift from what is stored.
  useEffect(() => {
    if (!available) return;
    const offEvent = subscribeToRuns((e) => {
      if (eventRunId(e) === selectedRunId) bumpDetail();
    });
    const offState = subscribeToRunState((s) => {
      bumpRuns();
      if (s.runId === selectedRunId) bumpDetail();
    });
    return () => {
      offEvent();
      offState();
    };
  }, [available, selectedRunId]);

  /**
   * The other half of staying current: re-read on a timer, and on the way back to the app.
   *
   * The subscription above is necessary but not sufficient. It is a *run* stream — it fires while a
   * run is executing and says nothing at any other time — so on its own this page went stale for
   * every change that happens between runs: a workflow added or renamed in another window, a
   * scheduled fire the policy skipped (which produces no run and therefore no event), and `nextRunAt`,
   * which is a computed clock reading that becomes wrong just by sitting on screen past it.
   *
   * Gated on visibility so a backgrounded window costs nothing, and paired with a focus listener
   * because returning after a while is exactly when the screen is most likely to be out of date —
   * and the moment a poll interval alone would leave the user staring at old numbers until it ticks.
   */
  useEffect(() => {
    if (!available) return;
    const isVisible = () => document.visibilityState === "visible";

    // Cheap sweep: the list, the run rows and the overview board.
    const poll = () => {
      if (!isVisible()) return;
      bumpWorkflows();
      bumpRuns();
    };
    // Coming back also re-reads the open run's timeline, since any events broadcast while this
    // window was away are simply gone — the durable log is the only way to recover them.
    const onReturn = () => {
      if (!isVisible()) return;
      bumpWorkflows();
      bumpRuns();
      bumpDetail();
    };

    const timer = setInterval(poll, REFRESH_MS);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [available]);

  /**
   * The list the sidebar draws: every workflow, enriched with its stats where those are available.
   *
   * Driven by `workflows`, never by `overview`. The stats are a separate IPC call that can legitimately
   * return nothing — outside Electron, or before a restart picks up a new `wf:*` handler — and a
   * decoration failing must not empty the list the whole page navigates by. Missing stats degrade a
   * row to its name; they never remove it.
   */
  const overviewRows = useMemo<WorkflowOverview[]>(() => {
    const byId = new Map(overview.map((o) => [o.id, o]));
    return workflows.map(
      (w) =>
        byId.get(w.id) ?? {
          id: w.id,
          name: w.name,
          version: w.version,
          nodeCount: w.nodeCount,
          total: 0,
          succeeded: 0,
          failed: 0,
          finished: 0,
          costUsd: 0,
          lastRunAt: null,
          lastState: null,
          lastError: null,
          nextRunAt: null,
        },
    );
  }, [workflows, overview]);

  /** Selecting a workflow clears the run selection — done here, not in an effect. */
  const selectWorkflow = (id: string) => {
    setSelectedId(id);
    setSelectedRunId(null);
    setDetail(null);
  };

  // Pending approvals are shown for ALL workflows, not just the selected one, and pinned above the
  // fold. The OS notification that announced them can only have fired if the app happened to be
  // running at that moment, so this list — not the notification — is the reliable entry point.
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [waits, setWaits] = useState<PendingWait[]>([]);
  const [deliverKey, setDeliverKey] = useState<string | null>(null);
  const [deliverText, setDeliverText] = useState("");
  const [inputsOpen, setInputsOpen] = useState(false);
  const [inputVars, setInputVars] = useState<WorkflowVariable[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const list = await pendingApprovals();
      if (!ignore) setApprovals(list);
    })();
    return () => {
      ignore = true;
    };
  }, [available, runsKey, detailKey]);

  // Waits are fetched alongside approvals: a run suspended on an external event looks frozen
  // otherwise, with nothing on screen explaining what it is blocked on.
  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const list = await pendingWaits();
      if (!ignore) setWaits(list);
    })();
    return () => {
      ignore = true;
    };
  }, [available, runsKey, detailKey]);

  // The main process has no i18n runtime, and the approval notification may fire with no window
  // open, so the translated strings are cached there (same pattern as the tray labels).
  const approvalTitle = t("auto.approval.notifyTitle");
  const approvalExpires = t("auto.approval.expires");
  useEffect(() => {
    syncApprovalStrings({ title: approvalTitle, expires: approvalExpires });
  }, [approvalTitle, approvalExpires]);

  const onDeliver = async (key: string) => {
    let payload: unknown = {};
    if (deliverText.trim()) {
      try {
        payload = JSON.parse(deliverText);
      } catch {
        setRunError(t("auto.waits.badJson"));
        return;
      }
    }
    const res = await deliverWorkflowEvent(key, payload);
    if (!res.ok) setRunError(res.error ?? null);
    setDeliverKey(null);
    setDeliverText("");
    bumpRuns();
  };

  const onDecide = async (approvalId: string, approved: boolean) => {
    await decideApproval(approvalId, approved);
    bumpRuns();
  };

  const activeRun = runs.find((r) => !isTerminal(r.state));

  /** Actually start the run, with whatever inputs were collected. */
  const startRun = async (variables?: Record<string, unknown>) => {
    if (!selectedId) return;
    setBusy(true);
    const res = await runWorkflow(selectedId, variables);
    setBusy(false);
    if (res.ok && res.runId) setSelectedRunId(res.runId);
    else if (!res.ok && res.error) setRunError(res.error);
    bumpRuns();
  };

  /**
   * A workflow may declare inputs. Ask for them first rather than letting the engine refuse the run
   * with "missing required input(s)" and leave the user no way to supply them.
   */
  const onRun = async () => {
    if (!selectedId) return;
    setRunError(null);
    const def = await getWorkflow(selectedId);
    const askable = askableVariables(def?.variables);
    if (askable.length > 0) {
      setInputVars(askable);
      setInputsOpen(true);
      return;
    }
    await startRun();
  };

  const onCancel = async (runId: string) => {
    await cancelRun(runId);
    bumpRuns();
  };

  // Creating and editing both happen on their own pages now, not in a dialog.
  const onNew = () => router.push("/agent/automation/new");
  const onEdit = () => {
    if (selectedId) router.push(`/agent/automation/edit?id=${encodeURIComponent(selectedId)}`);
  };

  // Confirmation is in-page, not window.confirm(): the native dialog is a modal OS window that
  // freezes the whole renderer, ignores the app's theme, and on Linux can open behind the window —
  // a destructive action confirmed through a box the user may not even see.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setConfirmingDelete(false), [selectedId]);

  const onDelete = async () => {
    if (!selectedId) return;
    setConfirmingDelete(false);
    await deleteWorkflow(selectedId);
    setSelectedId(null);
    bumpWorkflows();
  };

  // Which timeline row is expanded. One at a time: the detail of a web_search result is tall, and a
  // list where several are open at once stops being scannable as a sequence.
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  // The root every run's save folder sits under (<automation root>/runs). Held only for the tooltip.
  // Unlike the chat session's workspace, this cannot move while the page is open -- it is derived
  // from the automation root, which is fixed at startup. The click still re-reads it, because this
  // value is null if the page mounted before that root was configured, and a button that is dead for
  // the rest of the session is a worse failure than one extra IPC call.
  const [folder, setFolder] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  useEffect(() => {
    if (!available) return;
    let ignore = false;
    void (async () => {
      const dir = await workflowFolder();
      if (!ignore) setFolder(dir);
    })();
    return () => {
      ignore = true;
    };
  }, [available]);

  const onOpenFolder = async () => {
    setFolderError(null);
    const dir = await workflowFolder();
    setFolder(dir);
    if (!dir) return setFolderError(t("auto.folderUnknown"));
    const res = await openPathInShell(dir);
    // openPath fails when the folder does not exist yet — which is the normal state until the first
    // run writes something, since the manager creates it when a run's first node executes. Saying
    // which path was tried is the difference between a dead end and an answer, so the message
    // carries it.
    if (!res.ok) setFolderError(`${dir} — ${res.error ?? t("auto.folderUnknown")}`);
  };

  if (!available) {
    return (
      <Shell t={t}>
        <div className="mt-8 flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line text-center">
          <Workflow className="size-7 text-muted-foreground/50" />
          <p className="max-w-sm text-sm text-muted-foreground">{t("auto.desktopOnly")}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      t={t}
      folder={folder}
      onOpenFolder={() => void onOpenFolder()}
      notice={folderError && <Notice className="mt-4">{folderError}</Notice>}
    >
      {/* Both blocks stay pinned above the grid: they are the two states where the engine is waiting
          on a human, and burying them beside a workflow selection would hide the one thing on this
          page that is actually blocked. */}
      {approvals.length > 0 && (
        <Callout
          tone="amber"
          icon={<ShieldQuestion className="size-4" />}
          title={t("auto.approval.heading")}
          count={approvals.length}
          /* Says plainly how the user will be told about these, and the condition under which a
             system notification cannot reach them. Silently depending on notifications that only
             fire while the app happens to be open would be the worst of both worlds. */
          desc={t("auto.approval.howNotified")}
        >
          {approvals.map((a) => (
            <div key={a.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{a.title ?? a.node_id}</p>
                {a.deadline_at && (
                  <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning-ink">
                    {/* Says what happens if they do nothing — the difference between "waiting" and
                        "this opportunity will be dropped" matters for an unattended pipeline. */}
                    {a.on_timeout === "approve"
                      ? t("auto.approval.autoApprove")
                      : t("auto.approval.autoDrop")}{" "}
                    {new Date(a.deadline_at).toLocaleString()}
                  </span>
                )}
              </div>
              <ApprovalPreview preview={a.preview} />
              <div className="mt-2.5 flex gap-2">
                <button
                  onClick={() => void onDecide(a.id, true)}
                  className={`${BTN_BASE} bg-success px-3 py-1.5 text-xs text-success-on shadow-sm hover:opacity-90`}
                >
                  {t("auto.approval.approve")}
                </button>
                <button
                  onClick={() => void onDecide(a.id, false)}
                  className={`${BTN_SECONDARY} px-3 py-1.5 text-xs`}
                >
                  {t("auto.approval.reject")}
                </button>
              </div>
            </div>
          ))}
        </Callout>
      )}

      {waits.length > 0 && (
        <Callout
          tone="sky"
          icon={<Hourglass className="size-4" />}
          title={t("auto.waits.heading")}
          count={waits.length}
          desc={t("auto.waits.desc")}
        >
          {waits.map((w) => (
            <div key={w.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-foreground">{w.match_key}</span>
                {w.deadline_at && (
                  <span className="rounded-md bg-info/15 px-1.5 py-0.5 text-[10px] text-info-ink">
                    {/* Says what happens on silence — "waiting" and "this will be dropped" are very
                        different things to leave ambiguous. */}
                    {w.on_timeout === "continue" ? t("auto.waits.dropsAt") : t("auto.waits.failsAt")}{" "}
                    {new Date(w.deadline_at).toLocaleString()}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => setDeliverKey(deliverKey === w.match_key ? null : w.match_key)}
                  className={`${BTN_SECONDARY} px-2.5 py-1 text-xs`}
                >
                  <Send className="size-3" />
                  {t("auto.waits.deliver")}
                </button>
              </div>
              {deliverKey === w.match_key && (
                <div className="mt-2.5 space-y-2">
                  <textarea
                    value={deliverText}
                    onChange={(e) => setDeliverText(e.target.value)}
                    placeholder={t("auto.waits.payloadHint")}
                    rows={3}
                    spellCheck={false}
                    className="w-full resize-none rounded-lg border border-line-strong bg-surface px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                  <button
                    onClick={() => void onDeliver(w.match_key)}
                    className={`${BTN_PRIMARY} px-3 py-1.5 text-xs`}
                  >
                    {t("auto.waits.send")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </Callout>
      )}

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[264px_1fr]">
        <aside className="space-y-3">
          <button onClick={onNew} className={`${BTN_SECONDARY} w-full px-3 py-2 text-sm`}>
            <Plus className="size-4" />
            {t("auto.new")}
          </button>

          {workflows.length === 0 ? (
            <EmptyState icon={<Workflow className="size-5" />} text={t("auto.empty")} />
          ) : (
            <WorkflowOverviewList
              rows={overviewRows}
              selectedId={selectedId}
              onSelect={selectWorkflow}
              rowBase={ROW_BASE}
              rowSelected={ROW_SELECTED}
              rowIdle={ROW_IDLE}
              listReset={LIST_RESET}
            />
          )}
        </aside>

        <section className="min-w-0 space-y-5">
          {!selectedId ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line text-center">
              <Workflow className="size-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t("auto.selectHint")}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void onRun()}
                  disabled={busy || !!activeRun}
                  className={`${BTN_PRIMARY} px-3.5 py-1.5 text-sm`}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  {t("auto.run")}
                </button>
                {activeRun && (
                  <button
                    onClick={() => void onCancel(activeRun.id)}
                    className={`${BTN_SECONDARY} px-3 py-1.5 text-sm`}
                  >
                    <Square className="size-3.5" />
                    {t("auto.cancel")}
                  </button>
                )}
                <div className="flex-1" />
                <button onClick={onEdit} className={`${BTN_SECONDARY} px-3 py-1.5 text-sm`}>
                  <Pencil className="size-3.5" />
                  {t("auto.edit")}
                </button>
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className={`${BTN_DANGER} px-3 py-1.5 text-sm`}
                >
                  <Trash2 className="size-3.5" />
                  {t("auto.delete")}
                </button>
              </div>

              {/* Inline rather than a modal: the thing being deleted stays on screen behind the
                  question, so "delete this one?" is answerable without remembering which one. */}
              {confirmingDelete && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
                  <p className="min-w-0 flex-1 text-xs text-foreground">{t("auto.confirmDelete")}</p>
                  <button
                    onClick={() => void onDelete()}
                    className={`${BTN_BASE} bg-danger px-3 py-1.5 text-xs text-danger-on shadow-sm hover:opacity-90`}
                  >
                    {t("auto.delete")}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className={`${BTN_SECONDARY} px-3 py-1.5 text-xs`}
                  >
                    {t("auto.cancel")}
                  </button>
                </div>
              )}

              {runError && <Notice>{runError}</Notice>}

              <div>
                <SectionLabel>
                  {t("auto.runs")}
                  {runs.length > 0 && <Count n={runs.length} />}
                </SectionLabel>
                {runs.length === 0 ? (
                  <EmptyState text={t("auto.noRuns")} />
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line bg-surface">
                    <ul className={`${LIST_RESET} divide-y divide-line/70`}>
                      {runs.map((r) => (
                        <li key={r.id}>
                          <button
                            onClick={() => setSelectedRunId(r.id)}
                            aria-current={selectedRunId === r.id}
                            className={`${ROW_BASE} flex items-center gap-3 px-3 py-2.5 ${
                              selectedRunId === r.id ? ROW_SELECTED : ROW_IDLE
                            }`}
                          >
                            <StateChip state={r.state} t={t} />
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {formatTime(r.created_at)}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {t("auto.version")} {r.definition_version}
                            </span>
                            <span className="flex-1" />
                            {r.ended_at && r.started_at && (
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                {((r.ended_at - r.started_at) / 1000).toFixed(1)}s
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Timeline: a projection over the event log, never stored separately (§8). */}
              {detail?.run && (
                <div>
                  <SectionLabel>
                    {t("auto.timeline")}
                    {detail.events.length > 0 && <Count n={detail.events.length} />}
                  </SectionLabel>
                  {detail.run.error && <Notice className="mb-2">{detail.run.error}</Notice>}
                  {/* Capped and scrolled rather than left to run the length of the page: a long run
                      would otherwise push the run list it belongs to entirely out of view. */}
                  <div className="max-h-96 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface">
                    {detail.events.length === 0 ? (
                      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                        {t("auto.noEvents")}
                      </p>
                    ) : (
                      <ul className={`${LIST_RESET} divide-y divide-line/60`}>
                        {detail.events.map((e) => {
                          const expandable = hasDetail(e);
                          const open = openSeq === e.seq;
                          return (
                            <li key={e.seq}>
                              <button
                                type="button"
                                disabled={!expandable}
                                aria-expanded={expandable ? open : undefined}
                                onClick={() => setOpenSeq(open ? null : e.seq)}
                                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition disabled:cursor-default enabled:hover:bg-surface-hover/60 ${BTN_FOCUS} focus-visible:z-10 ${
                                  open ? "bg-surface-hover/40" : ""
                                }`}
                              >
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  {formatTime(e.at)}
                                </span>
                                {eventNodeId(e) && (
                                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                                    {eventNodeId(e)}
                                  </span>
                                )}
                                <span className="shrink-0 font-medium text-foreground">{e.type}</span>
                                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                  {summarizeEvent(e)}
                                </span>
                                {expandable && (
                                  <ChevronRight
                                    className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                                  />
                                )}
                              </button>
                              {open && <EventDetail payload={e.payload} />}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <RunInputsDialog
        open={inputsOpen}
        onOpenChange={setInputsOpen}
        variables={inputVars}
        onRun={startRun}
      />
    </Shell>
  );
}
