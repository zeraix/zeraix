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
import { Workflow, Play, Square, Trash2, Plus, Pencil, Loader2, AlertCircle, ShieldQuestion, Hourglass, Send, FolderOpen, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useRouter, useSearchParams } from "next/navigation";
import { openPathInShell } from "@/lib/electron/shell";
import RunInputsDialog, { askableVariables } from "./RunInputsDialog";
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
  type WorkflowSummary,
  type RunRow,
  type RunDetail,
  type RunState,
  type PendingApproval,
  type PendingWait,
  type WorkflowVariable,
  type RunEvent,
  workflowFolder,
  pendingApprovals,
  pendingWaits,
  deliverWorkflowEvent,
  decideApproval,
  syncApprovalStrings,
} from "@/lib/workflows";

/** Colour per run state; failures read red, waiting states amber, in-flight the brand accent. */
const STATE_STYLE: Record<RunState, string> = {
  QUEUED: "bg-muted text-muted-foreground",
  RUNNING: "bg-primary/10 text-primary",
  AWAITING_APPROVAL: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  AWAITING_EVENT: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  AWAITING_RETRY: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  INTERRUPTED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  SUCCEEDED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  FAILED: "bg-red-500/10 text-red-600 dark:text-red-400",
  CANCELLED: "bg-muted text-muted-foreground",
  TIMED_OUT: "bg-red-500/10 text-red-600 dark:text-red-400",
};

/**
 * Starter templates are built and validated in the main process (electron/automation/templates.mjs).
 * An empty canvas teaches nothing: chaining, fan-out and approval are far easier to read from a
 * working example than to assemble from scratch.
 */

export default function AgentAutomationPage() {
  const t = useT();
  const router = useRouter();
  const search = useSearchParams();
  const available = useMemo(() => isWorkflowsAvailable(), []);

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
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

  // Where a step's file tools write. Held only for the tooltip: the click re-reads it, because a
  // chat session can move this folder while the page is open.
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
    // openPath fails when the folder does not exist yet — which is the normal state until a run has
    // written something. Saying which path was tried is the difference between a dead end and an
    // answer, so the message carries it.
    if (!res.ok) setFolderError(`${dir} — ${res.error ?? t("auto.folderUnknown")}`);
  };

  if (!available) {
    return (
      <Shell t={t}>
        <div className="mt-8 flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-line text-center">
          <Workflow className="size-8 text-muted-foreground/60" />
          <p className="mt-3 max-w-sm text-sm text-muted-foreground">{t("auto.desktopOnly")}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      t={t}
      folder={folder}
      onOpenFolder={() => void onOpenFolder()}
      notice={
        folderError && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {folderError}
          </p>
        )
      }
    >
      {approvals.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-600 dark:text-amber-400">
            <ShieldQuestion className="size-4" />
            {t("auto.approval.heading")} ({approvals.length})
          </h2>
          {/* Says plainly how the user will be told about these, and the condition under which a
              system notification cannot reach them. Silently depending on notifications that only
              fire while the app happens to be open would be the worst of both worlds. */}
          <p className="text-xs text-muted-foreground">{t("auto.approval.howNotified")}</p>
          {approvals.map((a) => (
            <div
              key={a.id}
              className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{a.title ?? a.node_id}</p>
                {a.deadline_at && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                    {/* Says what happens if they do nothing — the difference between "waiting" and
                        "this opportunity will be dropped" matters for an unattended pipeline. */}
                    {a.on_timeout === "approve"
                      ? t("auto.approval.autoApprove")
                      : t("auto.approval.autoDrop")}{" "}
                    {new Date(a.deadline_at).toLocaleString()}
                  </span>
                )}
              </div>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-surface p-2 font-mono text-[10px] leading-snug text-muted-foreground">
                {JSON.stringify(a.preview, null, 2)}
              </pre>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void onDecide(a.id, true)}
                  className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
                >
                  {t("auto.approval.approve")}
                </button>
                <button
                  onClick={() => void onDecide(a.id, false)}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1 text-xs text-foreground transition hover:bg-surface-muted"
                >
                  {t("auto.approval.reject")}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {waits.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-sky-600 dark:text-sky-400">
            <Hourglass className="size-4" />
            {t("auto.waits.heading")} ({waits.length})
          </h2>
          <p className="text-xs text-muted-foreground">{t("auto.waits.desc")}</p>
          {waits.map((w) => (
            <div key={w.id} className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-foreground">{w.match_key}</span>
                {w.deadline_at && (
                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                    {/* Says what happens on silence — "waiting" and "this will be dropped" are very
                        different things to leave ambiguous. */}
                    {w.on_timeout === "continue" ? t("auto.waits.dropsAt") : t("auto.waits.failsAt")}{" "}
                    {new Date(w.deadline_at).toLocaleString()}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => setDeliverKey(deliverKey === w.match_key ? null : w.match_key)}
                  className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-xs text-foreground transition hover:bg-surface-muted"
                >
                  <Send className="size-3" />
                  {t("auto.waits.deliver")}
                </button>
              </div>
              {deliverKey === w.match_key && (
                <div className="mt-2 space-y-1.5">
                  <textarea
                    value={deliverText}
                    onChange={(e) => setDeliverText(e.target.value)}
                    placeholder={t("auto.waits.payloadHint")}
                    rows={3}
                    spellCheck={false}
                    className="w-full resize-none rounded-lg border border-line-strong bg-surface px-2 py-1.5 font-mono text-[11px] outline-none focus:border-ring"
                  />
                  <button
                    onClick={() => void onDeliver(w.match_key)}
                    className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition hover:opacity-90"
                  >
                    {t("auto.waits.send")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-2">
          <button
            onClick={onNew}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
          >
            <Plus className="size-4" />
            {t("auto.new")}
          </button>

          {workflows.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t("auto.empty")}</p>
          ) : (
            workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => selectWorkflow(w.id)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                  selectedId === w.id
                    ? "border-primary/40 bg-primary/5"
                    : "border-line bg-surface hover:bg-surface-muted"
                }`}
              >
                <p className="truncate text-sm font-medium text-foreground">{w.name}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("auto.version")} {w.version} · {w.nodeCount} {t("auto.nodes")}
                </p>
              </button>
            ))
          )}
        </aside>

        <section className="min-w-0">
          {!selectedId ? (
            <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-line">
              <p className="text-sm text-muted-foreground">{t("auto.selectHint")}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void onRun()}
                  disabled={busy || !!activeRun}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  {t("auto.run")}
                </button>
                {activeRun && (
                  <button
                    onClick={() => void onCancel(activeRun.id)}
                    className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
                  >
                    <Square className="size-3.5" />
                    {t("auto.cancel")}
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={onEdit}
                  className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
                >
                  <Pencil className="size-3.5" />
                  {t("auto.edit")}
                </button>
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-500/5 dark:text-red-400"
                >
                  <Trash2 className="size-3.5" />
                  {t("auto.delete")}
                </button>
              </div>

              {/* Inline rather than a modal: the thing being deleted stays on screen behind the
                  question, so "delete this one?" is answerable without remembering which one. */}
              {confirmingDelete && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
                  <p className="min-w-0 flex-1 text-xs text-foreground">{t("auto.confirmDelete")}</p>
                  <button
                    onClick={() => void onDelete()}
                    className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
                  >
                    {t("auto.delete")}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded-lg border border-line-strong bg-surface px-3 py-1 text-xs text-foreground transition hover:bg-surface-muted"
                  >
                    {t("auto.cancel")}
                  </button>
                </div>
              )}

              {runError && (
                <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="mt-px size-3.5 shrink-0" />
                  {runError}
                </p>
              )}

              <h2 className="mb-2 mt-6 text-sm font-semibold text-foreground">{t("auto.runs")}</h2>
              {runs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-muted-foreground">
                  {t("auto.noRuns")}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedRunId(r.id)}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                        selectedRunId === r.id
                          ? "border-primary/40 bg-primary/5"
                          : "border-line bg-surface hover:bg-surface-muted"
                      }`}
                    >
                      <StateChip state={r.state} t={t} />
                      <span className="text-xs text-muted-foreground">{formatTime(r.created_at)}</span>
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
                  ))}
                </div>
              )}

              {/* Timeline: a projection over the event log, never stored separately (§8). */}
              {detail?.run && (
                <>
                  <h2 className="mb-2 mt-6 text-sm font-semibold text-foreground">{t("auto.timeline")}</h2>
                  {detail.run.error && (
                    <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                      <AlertCircle className="mt-px size-3.5 shrink-0" />
                      {detail.run.error}
                    </p>
                  )}
                  <div className="max-h-96 overflow-y-auto rounded-xl border border-line bg-surface-muted/40">
                    {detail.events.length === 0 ? (
                      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                        {t("auto.noEvents")}
                      </p>
                    ) : (
                      <ul className="divide-y divide-line/60">
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
                                className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs transition disabled:cursor-default enabled:hover:bg-surface"
                              >
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  {formatTime(e.at)}
                                </span>
                                {eventNodeId(e) && (
                                  <span className="shrink-0 font-mono text-[11px] text-primary">
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
                </>
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

function Shell({
  t,
  folder,
  onOpenFolder,
  notice,
  children,
}: {
  t: (k: string) => string;
  /** Shown as the button's tooltip. Absent outside Electron, where there is no folder to open. */
  folder?: string | null;
  onOpenFolder?: () => void;
  notice?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-foreground">
          <Workflow className="size-5" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("auto.title")}</h1>
        <span className="flex-1" />
        {/* Page-level, not per-workflow: every run writes into the same folder, so hiding this until
            a workflow happens to be selected would put it behind an unrelated choice. */}
        {onOpenFolder && (
          <button
            onClick={onOpenFolder}
            title={folder ?? undefined}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
          >
            <FolderOpen className="size-3.5" />
            {t("auto.openFolder")}
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t("auto.desc")}</p>
      {notice}
      {children}
    </div>
  );
}

function StateChip({ state, t }: { state: RunState; t: (k: string) => string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATE_STYLE[state]}`}>
      {t(`auto.state.${state}`)}
    </span>
  );
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

/** Whether a row has anything worth expanding. A row that opens to nothing is worse than a dead one. */
function hasDetail(e: RunEvent): boolean {
  const payload = e.payload;
  if (!payload || typeof payload !== "object") return false;
  // `type` is already the row's own label, so a payload carrying only that adds nothing.
  return Object.keys(payload).some((k) => k !== "type");
}

/**
 * One-line gist of an event; the full payload is one click away in EventDetail.
 *
 * Tool events get the first string argument verbatim — for a search that is the query, which is the
 * one thing a timeline is read to find out. Truncation happens in CSS, not here, so a long query
 * still expands to its full text rather than being clipped before it is ever stored.
 */
function summarizeEvent(e: RunEvent): string {
  const payload = e.payload;
  if (!payload || typeof payload !== "object") return "";

  if (e.type === "tool:started") {
    const args = (payload.args ?? {}) as Record<string, unknown>;
    const first = Object.entries(args).find(([, v]) => typeof v === "string" && v);
    return [payload.name, first?.[1]].filter(Boolean).join("  ");
  }
  if (e.type === "tool:finished") {
    const secs = typeof payload.ms === "number" ? `${(payload.ms / 1000).toFixed(1)}s` : "";
    if (!payload.ok) return `${payload.name} — ${payload.error ?? "failed"}`;
    const size = typeof payload.chars === "number" ? `${payload.chars} chars` : "";
    return [payload.name, [size, secs].filter(Boolean).join(", ")].filter(Boolean).join(" → ");
  }

  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.values && typeof payload.values === "object") {
    const values = payload.values as Record<string, unknown>;
    const first = Object.entries(values).find(([, v]) => typeof v === "string" && v);
    return first ? `${first[0]}: ${String(first[1]).slice(0, 120)}` : "";
  }
  const keys = Object.keys(payload);
  return keys.length ? keys.map((k) => `${k}=${String(payload[k]).slice(0, 40)}`).join(" ") : "";
}

/**
 * The expanded row: every field of the event, as stored.
 *
 * Field names are printed raw rather than translated. They are the engine's own vocabulary (`args`,
 * `preview`, `chars`) and they are what the design doc and the SQLite rows call them — a localized
 * label would make this view harder to match against the log it is a projection of, not easier.
 */
function EventDetail({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([k]) => k !== "type");
  return (
    <dl className="space-y-1.5 border-t border-line/60 bg-surface px-3 py-2">
      {entries.map(([k, v]) => {
        const isObject = typeof v === "object" && v !== null;
        const text = isObject ? JSON.stringify(v, null, 2) : String(v);
        // Multi-line and long values get a block of their own; a search result rendered inline
        // squeezes into a 20%-wide column and is unreadable.
        const block = isObject || text.includes("\n") || text.length > 80;
        return (
          <div key={k} className={block ? "space-y-0.5" : "flex gap-2"}>
            <dt className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {k}
            </dt>
            <dd className="min-w-0 flex-1">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-foreground">
                {text}
              </pre>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
