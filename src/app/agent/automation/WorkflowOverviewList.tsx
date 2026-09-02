"use client";

/**
 * The workflow list, as a status board rather than a set of names.
 *
 * The page already showed runs, approvals and waits — but each as its own flat list, keyed by time.
 * Nothing answered the question a user actually opens this page with: *what do I have automated, and
 * is it working?* With one workflow that is easy to reconstruct by eye; with six scheduled ones it is
 * not, and a schedule that quietly started failing three days ago looks exactly like one that is fine.
 *
 * So each row carries the three facts that make a schedule trustworthy: when it next runs by itself,
 * how it went last time, and how often it succeeds. `nextRunAt` is computed from the same cron walk
 * the scheduler fires on, so the time shown cannot disagree with the time that happens.
 */
import { CalendarClock, Hand, AlertCircle } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { WorkflowOverview, RunState } from "@/lib/workflows";

export default function WorkflowOverviewList({
  rows,
  selectedId,
  onSelect,
  rowBase,
  rowSelected,
  rowIdle,
  listReset,
}: {
  rows: WorkflowOverview[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Row treatments are owned by the page, so this list matches the run list exactly. */
  rowBase: string;
  rowSelected: string;
  rowIdle: string;
  listReset: string;
}) {
  const t = useT();

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <ul className={`${listReset} divide-y divide-line/70`}>
        {rows.map((w) => (
          <li key={w.id}>
            <button
              onClick={() => onSelect(w.id)}
              aria-current={selectedId === w.id}
              className={`${rowBase} px-3 py-2.5 ${selectedId === w.id ? rowSelected : rowIdle}`}
            >
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{w.name}</p>
                {/* Last outcome as a dot: at a glance the column reads as a health strip, and a run
                    that has never happened is visibly different from one that failed. */}
                <Health state={w.lastState} t={t} />
              </div>

              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {w.nextRunAt ? (
                    <>
                      <CalendarClock className="size-3 text-primary" />
                      {t("auto.overview.next", { when: shortTime(w.nextRunAt) })}
                    </>
                  ) : (
                    <>
                      <Hand className="size-3" />
                      {t("auto.overview.manual")}
                    </>
                  )}
                </span>

                {w.total > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">{t("auto.overview.runs", { n: String(w.total) })}</span>
                    {/* Only once something has finished: 0/0 is not "0% successful", it is "no data",
                        and showing 0% for a workflow that has merely never finished is a false alarm. */}
                    {w.finished > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span
                          className={`tabular-nums ${
                            w.succeeded === w.finished ? "text-success-ink" : ""
                          }`}
                        >
                          {t("auto.overview.successRate", {
                            pct: String(Math.round((w.succeeded / w.finished) * 100)),
                          })}
                        </span>
                      </>
                    )}
                  </>
                )}

                {w.total === 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{t("auto.overview.neverRun")}</span>
                  </>
                )}
              </p>

              {/* A failure is worth a line of its own — the whole point of the board is that a broken
                  schedule announces itself instead of being inferred from a success rate. */}
              {w.lastState === "FAILED" && w.lastError && (
                <p className="mt-1 flex items-start gap-1 text-[11px] text-danger-ink">
                  <AlertCircle className="mt-px size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{w.lastError}</span>
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Colour of the last run's outcome. Grey when there has never been one. */
function Health({ state, t }: { state: RunState | null; t: (k: string, v?: Record<string, string>) => string }) {
  const tone =
    state === "SUCCEEDED"
      ? "bg-success"
      : state === "FAILED" || state === "TIMED_OUT"
        ? "bg-danger"
        : state === null
          ? "bg-muted-foreground/30"
          : "bg-warning";
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${tone}`}
      title={state ? t(`auto.state.${state}`) : t("auto.overview.neverRun")}
    />
  );
}

/**
 * A near-future time, said the way a person would.
 *
 * Today and tomorrow are named rather than dated, because "tomorrow 09:00" is instantly checkable
 * against intent and "2026-08-12 09:00" has to be decoded first.
 */
function shortTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(now)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return time;
  if (days === 1) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
