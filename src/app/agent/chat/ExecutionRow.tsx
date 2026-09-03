"use client";

/**
 * One sub-agent execution as a row in the Inspector's list, and the run page that opens when it is clicked.
 *
 * The row answers "which delegation is this, and how is it going"; the page answers "what did it actually
 * do" — and it answers it with `ChatTranscript`, the chat page's own renderer, given the delegation's
 * messages instead of the conversation's (see executionTranscript.ts). That is not a resemblance kept up by
 * hand: a change to how a reply or a tool call is drawn reaches both, because there is one renderer.
 *
 * The row recurses, because a nested delegation is the same row one level in (TODO §20, §21).
 */
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type TFunc } from "@/lib/i18n";
import {
  isTerminal,
  type ExecutionStatus,
  type ExecutionsState,
  type SubAgentEvent,
  type SubAgentExecution,
} from "@/lib/agent/subagentExecution";
import { ChatTranscript } from "./ChatTranscript";
import { ExecutionComposer } from "./ExecutionComposer";
import { executionIsRunning, executionTranscript } from "./executionTranscript";
import { formatDuration } from "./format";
import { targetOf } from "./processTrace";

const STATUS_STYLE: Record<
  ExecutionStatus,
  { icon: typeof Circle; tint: string; spin?: boolean }
> = {
  queued: { icon: Circle, tint: "text-ink-subtle" },
  running: { icon: Loader2, tint: "text-primary", spin: true },
  waiting: { icon: CircleDashed, tint: "text-info-ink" },
  completed: { icon: CheckCircle2, tint: "text-success-ink" },
  failed: { icon: XCircle, tint: "text-destructive" },
  cancelled: { icon: Ban, tint: "text-ink-subtle" },
};

/** Re-render once a second while something is live, so an elapsed time is elapsed rather than frozen. */
function useTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/**
 * What this execution is doing, in the user's language (TODO §19).
 *
 * Derived from the runtime's structural `phase` and its active tool call — never from anything the model
 * said, and never from a string the runtime stored, because the runtime has no business knowing which of
 * eleven locales this window is in.
 */
function actionText(ex: SubAgentExecution, t: TFunc): string | null {
  if (isTerminal(ex.status)) return null;
  if (ex.status === "queued") return t("inspector.phase.queued");
  const activeId = ex.activeToolCallIds[ex.activeToolCallIds.length - 1];
  const call = activeId ? ex.toolCalls.find((c) => c.toolCallId === activeId) : undefined;
  if (call) {
    // Trimmed: a tool with no nameable target ("Running check_project") must not render a dangling space.
    return t("inspector.phase.tool", {
      tool: call.name,
      target: targetOf(call.name, call.args).slice(0, 60),
    }).trim();
  }
  switch (ex.phase) {
    case "starting":
      return t("inspector.phase.starting");
    case "waiting":
      return t("inspector.phase.waiting");
    default:
      return t("inspector.phase.thinking");
  }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString();

// ── The list row ───────────────────────────────────────────────────────────────────────────────────

export function ExecutionRow({
  execution: ex,
  state,
  depth,
  onOpen,
}: {
  execution: SubAgentExecution;
  state: ExecutionsState;
  depth: number;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const live = !isTerminal(ex.status);
  const now = useTick(live);
  const style = STATUS_STYLE[ex.status];
  const Icon = style.icon;
  const elapsed = ex.durationMs ?? now - (ex.startedAt ?? ex.spawnedAt);
  const action = actionText(ex, t);
  const children = ex.childIds.map((id) => state.byId[id]).filter(Boolean) as SubAgentExecution[];

  return (
    <li className={cn(depth > 0 && "ml-3 border-l border-line pl-2")}>
      <button
        type="button"
        onClick={() => onOpen(ex.id)}
        className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-line bg-surface-muted/30 px-2.5 py-2 text-left transition hover:border-line-strong hover:bg-surface-hover/60"
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", style.tint, style.spin && "animate-spin")} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink">{ex.agent}</span>
            <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide", style.tint)}>
              {t(`inspector.status.${ex.status}`)}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-subtle">
            {ex.jobId && <span className="shrink-0 font-mono">{ex.jobId}</span>}
            <span className="shrink-0 tabular-nums">{formatDuration(elapsed)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">
              {t("inspector.toolCalls", { n: ex.toolCallCount })}
            </span>
            {children.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">
                  {t("inspector.children", { n: children.length })}
                </span>
              </>
            )}
          </span>
          {/* The task, one line, so the list answers "which delegation is this" without being opened. */}
          <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{ex.task}</span>
          {action && <span className="mt-0.5 block truncate text-[11px] text-primary">{action}</span>}
          {ex.status === "failed" && ex.error && (
            <span className="mt-0.5 block truncate text-[11px] text-destructive">{ex.error.message}</span>
          )}
        </span>
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
      </button>

      {/* Children are listed under their parent and never at the top level of the panel — that is what keeps
          a nested agent from reading as a root one (TODO §20). */}
      {children.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {children.map((child) => (
            <ExecutionRow key={child.id} execution={child} state={state} depth={depth + 1} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ── The run page ───────────────────────────────────────────────────────────────────────────────────

/** One timeline line's label. Tool results say which tool finished, so a line reads without its neighbour. */
function timelineLabel(e: SubAgentEvent, t: TFunc): string | null {
  switch (e.type) {
    case "spawned":
      return t("inspector.timeline.spawned");
    case "started":
      return t("inspector.timeline.started");
    case "tool_call":
      return e.toolName;
    case "tool_result":
      return e.ok
        ? t("inspector.timeline.toolDone", { tool: e.toolName })
        : t("inspector.timeline.toolFailed", { tool: e.toolName });
    case "completed":
      return t("inspector.timeline.completed");
    case "failed":
      return t("inspector.timeline.failed");
    case "cancelled":
      return t("inspector.timeline.cancelled");
    case "cancel_requested":
      return t("inspector.timeline.stopRequested");
    // `action` and `status_changed` are folded into the rows above: a line per phase change would be most
    // of the timeline and none of its information.
    default:
      return null;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-28 shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink-muted">{children}</span>
    </div>
  );
}

/**
 * The delegation, read as the conversation it was.
 *
 * Laid out like the chat page — a header where the title bar is, a centred `max-w-3xl` transcript, and a
 * strip where the composer is. The strip holds the composer slot (ExecutionComposer.tsx: Stop today, an
 * input for talking to the sub-agent next) above the run's metadata and its timeline (TODO §16, §17).
 */
export function ExecutionRunView({
  execution: ex,
  state,
  onBack,
  onClose,
}: {
  execution: SubAgentExecution;
  state: ExecutionsState;
  onBack: () => void;
  /**
   * Dismiss the panel entirely.
   *
   * Present alongside `onBack` because this view REPLACES the panel's own header, and the close button lived
   * there: drilling into a run took it away, leaving one exit where there had been two and no way to dismiss
   * the panel without first stepping back. Back on the left, close on the right — the arrangement every other
   * drill-down uses, and the one whose absence is immediately felt.
   */
  onClose: () => void;
}) {
  const t = useT();
  const live = !isTerminal(ex.status);
  const now = useTick(live);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const style = STATUS_STYLE[ex.status];
  const Icon = style.icon;
  const elapsed = ex.durationMs ?? now - (ex.startedAt ?? ex.spawnedAt);
  const parent = ex.parentExecutionId ? state.byId[ex.parentExecutionId] : undefined;
  const display = executionTranscript(ex);
  const action = actionText(ex, t);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-ink">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("inspector.back")}
          title={t("inspector.back")}
          className="rounded-md p-1 text-ink-subtle transition hover:bg-surface-muted hover:text-ink"
        >
          <ArrowLeft className="size-4" />
        </button>
        <Icon className={cn("size-4 shrink-0", style.tint, style.spin && "animate-spin")} />
        <span className="min-w-0 truncate text-sm font-semibold">{ex.agent}</span>
        <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide", style.tint)}>
          {t(`inspector.status.${ex.status}`)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-subtle">
          {formatDuration(elapsed)} · {t("inspector.toolCalls", { n: ex.toolCallCount })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("inspector.close")}
          title={t("inspector.close")}
          className="shrink-0 rounded-md p-1 text-ink-subtle transition hover:bg-surface-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {/* The chat page's own transcript, read-only: the task is the user turn, the tool calls are the
              thinking process, the conclusion is the reply. See ChatTranscript's `readOnly`. */}
          <ChatTranscript
            switching={false}
            display={display}
            visibleStart={0}
            hasEarlier={false}
            earlierSentinelRef={{ current: null }}
            loadEarlier={() => {}}
            loading={executionIsRunning(ex)}
            status={action ?? ""}
            error={null}
            toolsReady
            t={t}
            readOnly
          />
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-4 py-2 text-[11px]">
        <div className="mx-auto w-full max-w-3xl">
          <ExecutionComposer execution={ex} />
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
            className="flex w-full items-center gap-1.5 rounded py-1 text-left text-ink-subtle transition hover:text-ink"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", detailsOpen && "rotate-90")} />
            {t("inspector.details")}
          </button>

          {detailsOpen && (
            <div className="flex flex-col gap-3 pb-2 pt-1">
              <div className="flex flex-col gap-1">
                <Field label={t("inspector.origin")}>
                  <span className="font-mono">{ex.origin}</span>
                </Field>
                {ex.jobId && (
                  <Field label={t("inspector.jobId")}>
                    <span className="font-mono">{ex.jobId}</span>
                  </Field>
                )}
                <Field label={t("inspector.started")}>{ex.startedAt ? clock(ex.startedAt) : "—"}</Field>
                {ex.turnLabel && <Field label={t("inspector.fromTurn")}>{ex.turnLabel}</Field>}
                {parent && (
                  <Field label={t("inspector.parent")}>
                    <span className="font-mono">{parent.agent}</span>
                  </Field>
                )}
                {ex.requestedTools && ex.requestedTools.length > 0 && (
                  <Field label={t("inspector.toolsRequested")}>{ex.requestedTools.join(", ")}</Field>
                )}
                {/* Requested and granted are shown separately, and granted only when the runtime actually
                    knows it: printing the request as though it were the grant would overstate what the
                    sub-agent could do — which is exactly the confusion an empty grant caused. */}
                {ex.grantedTools && (
                  <Field label={t("inspector.toolsGranted")}>
                    {ex.grantedTools.length > 0 ? ex.grantedTools.join(", ") : "—"}
                  </Field>
                )}
              </div>

              <div>
                <div className="mb-0.5 font-semibold text-ink-subtle">{t("inspector.timeline")}</div>
                {ex.droppedEvents > 0 && (
                  <p className="mb-1 text-ink-subtle">
                    {t("inspector.eventsDropped", { n: ex.droppedEvents })}
                  </p>
                )}
                <ol className="max-h-56 overflow-y-auto">
                  {ex.events.map((e, i) => {
                    const label = timelineLabel(e, t);
                    if (!label) return null;
                    return (
                      <li key={i} className="flex min-w-0 gap-2 py-px">
                        <span className="shrink-0 tabular-nums text-ink-subtle">{clock(e.timestamp)}</span>
                        <span className="min-w-0 truncate text-ink-muted">{label}</span>
                        {e.type === "tool_result" && e.durationMs !== undefined && (
                          <span className="ml-auto shrink-0 tabular-nums text-ink-subtle">
                            {formatDuration(e.durationMs)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
