"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useT } from "@/lib/i18n";
import { isGoalActive, type GoalState } from "./goalState";

/**
 * The `/goal` status indicator, pinned above the todo panel.
 *
 * Sits directly on top of TodoPanel because that is the order the layering actually runs in — goal, then the
 * plan's steps as a checklist — so the composer stack reads top-to-bottom as the mechanism works.
 *
 * It carries the state the doc requires `/goal` (with no argument) to be able to show: the condition, how long
 * the run has been going, how many evaluations it has been through, roughly what it has spent, and the
 * evaluator's latest reason. Because all of that is on screen continuously, the bare `/goal` command has
 * nothing to print that is not already here — it just expands this.
 */

/** Elapsed time as m:ss / h:mm:ss. Short enough to sit inline without ever wrapping the summary row. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

export function GoalBar({
  goal,
  running,
  expanded,
  onExpandedChange,
  onClear,
}: {
  goal: GoalState | null;
  /** True while a turn is in flight for this conversation — drives the pulsing dot, nothing else. */
  running: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onClear: () => void;
}) {
  const t = useT();
  // The elapsed clock is the one thing here that changes without a state update, so it gets its own tick. One
  // second is as fine as the display goes, and the interval only exists while a goal is actually running.
  const [now, setNow] = useState(() => Date.now());
  const active = isGoalActive(goal);
  const startedAt = goal?.run.startedAt ?? 0;
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);

  // A cleared goal disappears: the user dropped it, or the loop gave up and said so in a toast. Only a running
  // goal and the record of one that was just met earn space above the composer.
  const visible = !!goal && !!goal.condition && goal.status !== "cleared";
  const run = goal?.run;
  const achieved = goal?.status === "achieved";
  // A restored goal has startedAt 0 — its counters were reset on purpose, so show a dash rather than an
  // elapsed time measured from the epoch.
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "—";
  // The same expo-out curve and duration the consent panel uses, so everything that appears over the
  // composer moves the same way.
  const ease = [0.22, 1, 0.36, 1] as const;

  return (
    // The bar is not always present, and appearing or vanishing between frames right above the input box is
    // exactly the kind of jump that makes a UI feel unstable. It grows from zero height instead, so the
    // transcript above is pushed rather than snapped.
    <AnimatePresence initial={false}>
      {visible && goal && run && (
        <motion.div
          key="goalbar"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease }}
          className="overflow-hidden bg-surface px-4"
        >
          <div
            className={`mx-auto mt-2 w-full max-w-3xl rounded-xl border px-3 py-2 transition-colors duration-300 ${
              achieved
                ? "border-success/30 bg-success/5"
                : run.lastEvalFailed
                  ? "border-warning/30 bg-warning/5"
                  : "border-line bg-surface-muted/40"
            }`}
          >
            {/* Two sibling controls, not one nested inside the other: Clear is a button in its own right, and
                a button inside a button is invalid HTML that browsers and screen readers resolve differently.
                The disclosure toggle takes the remaining width so clicking anywhere along the row opens it. */}
            <div className="flex select-none items-center gap-2">
              <button
                onClick={() => onExpandedChange(!expanded)}
                aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  className={`shrink-0 text-xs font-semibold transition-colors duration-300 ${
                    achieved ? "text-success-ink" : "text-primary"
                  }`}
                >
                  {achieved ? "◉" : "◎"} {achieved ? t("goal.achievedLabel") : t("goal.activeLabel")}
                </span>
                {active && running && (
                  <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
                    {/* Two layers: a steady dot with a ring pulsing out of it. A bare animate-pulse dims the
                        whole dot, which at this size reads as flicker rather than activity. */}
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{goal.condition}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">
                  {t("goal.summary", {
                    rounds: String(run.turnCount),
                    elapsed,
                    tokens: formatTokens(run.tokenSpend),
                  })}
                </span>
              </button>
              {active && (
                <button
                  onClick={onClear}
                  className="shrink-0 rounded px-1 text-[11px] text-ink-subtle transition-colors duration-150 hover:text-ink"
                >
                  {t("goal.clear")}
                </button>
              )}
              <motion.button
                onClick={() => onExpandedChange(!expanded)}
                aria-expanded={expanded}
                aria-label={expanded ? t("goal.collapse") : t("goal.expand")}
                animate={{ rotate: expanded ? 180 : 0 }}
                transition={{ duration: 0.22, ease }}
                className="shrink-0 text-ink-subtle transition-colors duration-150 hover:text-ink"
              >
                ▾
              </motion.button>
            </div>

            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  key="goalbody"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1.5 text-xs">
                    <div className="whitespace-pre-wrap text-ink">{goal.condition}</div>
                    {goal.criteria.length > 0 && (
                      <ul className="space-y-0.5 pl-1 text-ink-muted">
                        {goal.criteria.map((c) => (
                          <li key={c.id}>· {c.text}</li>
                        ))}
                      </ul>
                    )}
                    {goal.blockers.length > 0 && (
                      <div className="text-warning-ink">
                        {t("goal.blockers", { list: goal.blockers.join("; ") })}
                      </div>
                    )}
                    {run.lastReason && (
                      <div className={run.lastEvalFailed ? "text-warning-ink" : "text-ink-subtle"}>
                        {run.lastEvalFailed
                          ? t("goal.evalFailed", { reason: run.lastReason })
                          : t(achieved ? "goal.lastVerdictMet" : "goal.lastVerdict", {
                              reason: run.lastReason,
                            })}
                      </div>
                    )}
                    {!run.lastReason && active && run.turnCount === 0 && (
                      <div className="text-ink-subtle">{t("goal.notCheckedYet")}</div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
