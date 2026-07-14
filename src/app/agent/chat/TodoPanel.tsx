"use client";

import type { Todo } from "./types";

/** Task checklist panel: pinned above the input box, showing a progress bar and each item's status; items can be toggled manually. */
export function TodoPanel({
  todos,
  onToggle,
  onClear,
}: {
  todos: Todo[];
  onToggle: (index: number) => void;
  onClear: () => void;
}) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  const allDone = todos.length > 0 && done === todos.length;

  return (
    <div className="bg-surface px-4 pt-2">
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface-muted/40 px-3 py-2">
        <details open className="group/td">
          <summary className="flex cursor-pointer list-none select-none items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-ink">📋 To-do</span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums ${
                allDone ? "bg-emerald-500/15 text-emerald-600" : "bg-surface-hover text-ink-muted"
              }`}
            >
              {done}/{todos.length}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <div
                className={`h-full rounded-full transition-all ${allDone ? "bg-emerald-500" : "bg-primary"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-ink-subtle">{pct}%</span>
            <button
              onClick={(e) => {
                e.preventDefault();
                onClear();
              }}
              className="shrink-0 rounded px-1 text-[11px] text-ink-subtle transition hover:text-ink-muted"
            >
              Clear
            </button>
            <span className="shrink-0 text-ink-subtle transition group-open/td:rotate-180">▾</span>
          </summary>
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto pr-1">
            {todos.map((t, i) => {
              const icon =
                t.status === "completed" ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white">
                    ✓
                  </span>
                ) : t.status === "in_progress" ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-primary">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  </span>
                ) : (
                  <span className="h-4 w-4 rounded-full border-2 border-line-strong" />
                );
              return (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-md px-1 py-1 text-sm transition hover:bg-surface-hover/60"
                >
                  <button
                    onClick={() => onToggle(i)}
                    title="Click to toggle completion status"
                    className="mt-0.5 shrink-0"
                  >
                    {icon}
                  </button>
                  <span
                    className={
                      t.status === "completed"
                        ? "text-ink-subtle line-through"
                        : t.status === "in_progress"
                          ? "font-medium text-ink"
                          : "text-ink-muted"
                    }
                  >
                    {t.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
    </div>
  );
}
