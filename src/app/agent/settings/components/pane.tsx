"use client";

/**
 * Layout primitives for a settings detail pane.
 *
 * Every section had grown its own version of the same three things — a title block, a labelled group
 * of controls, and a bordered panel — with different margins, type sizes and tints in each file. The
 * result read as nine pages rather than one. These are those three things, once:
 *
 *   <Pane title desc>            the detail column: heading, rule, and the rhythm between groups
 *     <Group title icon desc>    one labelled thing you can change
 *       <div className={PANEL}>  the surface the controls sit on
 *
 * Rules of thumb when using them: a group's description belongs under its heading, not inside the
 * panel; a panel holds controls, not prose; and anything that is "label on the left, control on the
 * right" is a Row, so the switches down a pane line up.
 */

import type React from "react";
import { Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** The bordered surface a group's controls sit on. */
export const PANEL = "rounded-xl border border-line bg-surface-muted/40 px-4 py-3.5";

/** A panel of rows, divided rather than gapped: settings lists read as one object. */
export const LIST = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-muted/40";

/** Standalone explanatory panel — "not available in this build", empty states, hints. */
export const NOTE = "rounded-xl border border-line bg-surface-muted/40 px-4 py-3.5 text-xs text-ink-subtle";

/** Same, in the warning tone: a condition the user may want to act on. */
export const WARN_NOTE = "rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning-ink";

/**
 * One settings section's detail column.
 *
 * `wide` is for panes whose content is tabular (the usage log): everything else stays in the reading
 * column, so switching sections does not shift the page under the pointer.
 */
export function Pane({
  title,
  desc,
  actions,
  wide,
  children,
}: {
  title: string;
  desc?: string;
  actions?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full", wide ? "max-w-4xl" : "max-w-2xl")}>
      <header className="mb-6 flex items-start justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-ink">{title}</h2>
          {desc ? <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{desc}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {/* One rhythm between groups, set here rather than by each group's own margin. */}
      <div className="space-y-7">{children}</div>
    </div>
  );
}

/**
 * One labelled group inside a pane: heading, optional description, optional right-aligned action.
 *
 * `anchor` makes the group addressable — `/agent/settings#general/background` opens General and
 * scrolls here. The id is namespaced by the pane so two sections can both have a "storage" group,
 * and `scroll-mt` keeps the heading clear of the pane's own top edge when it is scrolled to.
 */
export function Group({
  title,
  desc,
  icon: Icon,
  anchor,
  count,
  actions,
  children,
  className,
}: {
  title: string;
  desc?: string;
  icon?: React.ComponentType<{ className?: string }>;
  anchor?: string;
  /** Optional tally beside the heading — how many servers, memories, keys this group holds. */
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={anchor}
      // data-flash is set by the settings page when a link points here; see FLASH_MS there.
      className={cn(
        "scroll-mt-6 rounded-xl transition-colors duration-500",
        "data-[flash]:bg-primary/5 data-[flash]:ring-1 data-[flash]:ring-primary/20",
        className,
      )}
    >
      <div className="group/heading mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            {Icon ? <Icon className="size-4 shrink-0 text-ink-muted" /> : null}
            {title}
            {/* The link to this exact group. Writing the hash is the whole action: the address bar
                then holds something worth copying, and the page scrolls here. */}
            {anchor ? (
              <button
                type="button"
                onClick={() => {
                  window.location.hash = anchor;
                }}
                aria-label={title}
                className="shrink-0 rounded p-0.5 text-ink-subtle opacity-0 transition hover:text-ink-muted focus-visible:opacity-100 group-hover/heading:opacity-100"
              >
                <Link2 className="size-3.5" />
              </button>
            ) : null}
            {count !== undefined ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-ink-subtle">
                {count}
              </span>
            ) : null}
          </h3>
          {desc ? <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-subtle">{desc}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Label (and explanation) on the left, control on the right.
 *
 * `disabled` dims and blocks the row without unmounting it — a dependent setting stays visible so it
 * is clear what turning the parent on would give you.
 */
export function Row({
  title,
  desc,
  disabled,
  className,
  children,
}: {
  title: string;
  desc?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {desc ? <p className="mt-0.5 max-w-prose text-xs text-ink-subtle">{desc}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
