"use client";

/**
 * The Sub-agent Execution Inspector: what every delegation of this conversation is doing, right now.
 *
 * Fed entirely by runtime events (see src/lib/agent/executionRegistry.ts). Nothing here polls
 * `join_subagents`, nothing reads the transcript, and nothing asks the model to describe itself — the panel
 * would show the same thing with the transcript hidden, which is the property that makes it trustworthy.
 *
 * Two levels, and the second is the point. The panel opens on a LIST of this conversation's delegations;
 * clicking one opens that delegation as a chat page — the task as the turn that opened it, the tool calls as
 * the thinking process, the conclusion as the reply — rendered by `ChatTranscript` itself rather than by a
 * lookalike. See ExecutionRow.tsx.
 *
 * Presentation only: it renders `SubAgentExecution` records and never writes one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Network, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { groupByTurn, summarise, type TurnGroup } from "@/lib/agent/subagentExecution";
import { useSubAgentExecutionStore } from "@/store/subagentExecutionStore";
import { ExecutionRow, ExecutionRunView } from "./ExecutionRow";

/**
 * This conversation's delegations, grouped by the turn that started them (newest turn first).
 *
 * Grouped rather than listed flat because a flat run of agent names cannot answer the first question anyone
 * asks of it — which of my messages started this? Newest first because that is where the running work is;
 * within a group, spawn order, because that is how the model refers to them (`s1`, `s2`).
 */
function useConversationGroups(conversationId: string | null) {
  const executions = useSubAgentExecutionStore((s) => s.executions);
  return useMemo(
    () => ({ state: executions, groups: groupByTurn(executions, conversationId ?? undefined) }),
    [executions, conversationId],
  );
}

/** The message that started a turn, or the time it started when the turn had no text of its own. */
function TurnHeading({ group }: { group: TurnGroup }) {
  const t = useT();
  const total = group.executions.length;
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1 pb-1 pt-2">
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-muted">
        {group.label || t("inspector.turnNoPrompt")}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">
        {new Date(group.at).toLocaleTimeString()}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">
        {t("inspector.turnAgents", { n: total })}
      </span>
    </div>
  );
}

/**
 * The entry point: `Sub-agents · 2 running`.
 *
 * Anchored at the bottom-left of the transcript, above the composer, rather than in the title bar. It belongs
 * to the conversation and changes with it — a badge that appears and starts spinning while the agent works —
 * and the title bar is where the session-level controls live (skills, clear, the environment switch). It also
 * puts the count next to the delegation bubbles it describes instead of a screen away from them.
 *
 * Absent while the conversation has never delegated anything: a control that is permanently there and
 * permanently empty teaches people to stop looking at it (TODO §14).
 */
export function SubAgentInspectorButton({
  conversationId,
  onOpen,
}: {
  conversationId: string | null;
  onOpen: () => void;
}) {
  const t = useT();
  const executions = useSubAgentExecutionStore((s) => s.executions);
  const counts = useMemo(
    () => summarise(executions, conversationId ?? undefined),
    [executions, conversationId],
  );
  if (counts.total === 0) return null;

  const live = counts.running + counts.queued;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("inspector.title")}
      aria-label={t("inspector.title")}
      // Floating over the transcript, so it carries its own surface and border — without them it would read as
      // a stray line of text sitting on top of the last message.
      className="absolute bottom-2 left-3 z-20 flex items-center gap-1.5 rounded-full border border-line-strong bg-surface/95 px-2.5 py-1 text-[11px] text-ink-muted shadow-sm backdrop-blur transition hover:bg-surface-muted hover:text-ink active:scale-95"
    >
      {live > 0 ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <Network className="size-3.5 shrink-0" />
      )}
      <span>{t("inspector.title")}</span>
      {live > 0 && (
        <span className="rounded-full bg-primary/15 px-1.5 py-px font-medium tabular-nums text-primary">
          {t("inspector.entryRunning", { n: live })}
        </span>
      )}
      {counts.failed > 0 && (
        <span className="rounded-full bg-destructive/15 px-1.5 py-px font-medium tabular-nums text-destructive">
          {t("inspector.entryFailed", { n: counts.failed })}
        </span>
      )}
    </button>
  );
}

/**
 * The panel itself: a right-anchored sheet.
 *
 * A sheet rather than a dialog because the conversation behind it stays legible, and this is a thing people
 * watch while the agent works rather than a thing they answer and dismiss.
 */
export function SubAgentInspector({
  open,
  onClose,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string | null;
}) {
  const t = useT();
  const { state, groups } = useConversationGroups(conversationId);
  const waits = useSubAgentExecutionStore((s) => s.waits);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Which run is open, if any. An id rather than the record, so the page follows the live one as it changes. */
  const [openId, setOpenId] = useState<string | null>(null);
  // Resolved from the store every render: an execution that was evicted, or whose conversation was cleared,
  // must fall back to the list rather than leave a page describing something that no longer exists.
  const opened = openId ? state.byId[openId] : undefined;

  /**
   * Close the panel AND forget which run was open, so reopening it lands on the list.
   *
   * Done here rather than in an effect watching `open`: resetting state from an effect is a cascading render
   * for something that has an exact moment — this one — at which it is known.
   */
  const close = () => {
    setOpenId(null);
    onClose();
  };

  // Esc steps BACK one level rather than always closing: a page opened from a list closes to the list, which
  // is what everything else with a back arrow does.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openId) setOpenId(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, openId]);

  const mainWaiting = useMemo(
    () => Object.values(waits).some((w) => !conversationId || w.conversationId === conversationId),
    [waits, conversationId],
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="inspector"
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={close}
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-label={t("inspector.title")}
            // A list is a sheet; a chat page is a page. The width follows what is being shown rather than
            // forcing a transcript into a column too narrow to read it in.
            className={cn(
              "flex h-full w-full flex-col overflow-hidden border-l border-line bg-surface shadow-xl outline-none transition-[max-width] duration-200",
              opened ? "max-w-[min(56rem,100vw)]" : "max-w-[min(30rem,100vw)]",
            )}
            initial={{ x: 24, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ type: "tween", duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
          >
            {opened ? (
              <ExecutionRunView
                execution={opened}
                state={state}
                onBack={() => setOpenId(null)}
                onClose={close}
              />
            ) : (
              <>
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <Network className="size-4 shrink-0 text-ink-muted" />
                <span className="text-sm font-semibold text-ink">{t("inspector.title")}</span>
                <span className="text-[11px] tabular-nums text-ink-subtle">
                  {t("inspector.countTotal", { n: groups.reduce((n, g) => n + g.executions.length, 0) })}
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label={t("inspector.close")}
                  className="ml-auto rounded-md p-1 text-ink-subtle transition hover:bg-surface-muted hover:text-ink"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* The MAIN agent's synchronisation state, which is not a sub-agent state (TODO §23). Its own
                  banner precisely so the two are never read as the same thing. */}
              {mainWaiting && (
                <div className="flex items-center gap-2 border-b border-line bg-info/10 px-4 py-2 text-[11px] text-info-ink">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  {t("inspector.mainWaiting")}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                {groups.length === 0 ? (
                  <div className="px-3 py-8 text-center">
                    <p className="text-xs text-ink-muted">{t("inspector.empty")}</p>
                    <p className="mt-1 text-[11px] text-ink-subtle">{t("inspector.emptyHint")}</p>
                  </div>
                ) : (
                  groups.map((group) => (
                    <section key={group.turnId}>
                      <TurnHeading group={group} />
                      <ul className="flex flex-col gap-1">
                        {group.executions.map((ex) => (
                          <ExecutionRow
                            key={ex.id}
                            execution={ex}
                            state={state}
                            depth={0}
                            onOpen={setOpenId}
                          />
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
