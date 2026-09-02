"use client";

/**
 * Context usage as a ring, sitting in the composer beside the send button.
 *
 * It was a full-width bar pinned under the transcript, which spent a row of the window on a number that is almost
 * always "0%" — auto-compaction keeps it there. The ring says the same thing in the corner of the composer, and the
 * detail that used to be printed on that row (exact tokens, the compacted badge, the manual compress action) moved
 * into its tooltip, which is where someone actually looking for it goes.
 */
import { MANUAL_COMPACT_MIN_PCT } from "./contextCompress";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocaleStore, useT } from "@/lib/i18n";

/** Ring geometry: a 20px circle inside a 24px box, stroked at 2.5. */
const R = 8.75;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * Formatters, cached per locale.
 *
 * This component sits inside the composer, so it re-renders on every keystroke, and constructing an
 * Intl.NumberFormat is expensive enough to notice when it happens twice per character. The instances are
 * immutable and depend only on the locale, so one of each per locale is all that is ever needed.
 */
const compactFormatters = new Map<string, Intl.NumberFormat>();
const percentFormatters = new Map<string, Intl.NumberFormat>();
function formatter(cache: Map<string, Intl.NumberFormat>, locale: string, options: Intl.NumberFormatOptions) {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    cache.set(locale, f);
  }
  return f;
}

export function ContextUsageRing(props: {
  /** Input tokens the next request would carry. */
  tokens: number;
  /** The active model's context window; 0 when unknown (the percentage then reads 0). */
  contextWindow: number;
  /** This conversation's history has been compacted at least once. */
  compacted: boolean;
  /** A compaction is running right now. */
  compacting: boolean;
  /** A round of generation is in flight — compaction must not race it. */
  generating: boolean;
  onCompactNow: () => void;
}) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const { tokens, contextWindow } = props;
  const pct = contextWindow > 0 ? Math.min(100, Math.round((tokens / contextWindow) * 100)) : 0;
  const ringColor = pct >= 90 ? "text-danger-ink" : pct >= 70 ? "text-warning-ink" : "text-success-ink";
  const barColor = pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success";
  // Manual compaction is allowed once there's enough to compress: ≥20% of the window, OR — when an absolute
  // budget is set — once context has passed that budget (so a 1M-window model isn't stuck "below 20%" while
  // already carrying 200K). Keep this in sync with compactNow's guard.
  const ctxBudgetK = getContextBudgetK();
  const canCompact = pct >= MANUAL_COMPACT_MIN_PCT * 100 || (ctxBudgetK > 0 && tokens >= ctxBudgetK * 1000);
  // Compact counts in the reader's own numbering system — 225K/1M in English, 22.5万/100万 in Chinese and Japanese,
  // 22.5만/100만 in Korean. Intl does the work; a hand-rolled K/M abbreviation would be English-only.
  const compact = (n: number) =>
    formatter(compactFormatters, locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  // One decimal, and no trailing ".0" — the difference between 22% and 22.5% of a 1M window is 5,000 tokens.
  const pctText = formatter(percentFormatters, locale, { maximumFractionDigits: 1 }).format(
    contextWindow > 0 ? Math.min(100, (tokens / contextWindow) * 100) : 0
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t("chat.contextUsage")}
          className="flex size-6 shrink-0 items-center justify-center"
        >
          <svg viewBox="0 0 24 24" className="size-6 -rotate-90">
            <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" className="stroke-line-strong" />
            <circle
              cx="12"
              cy="12"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              // A zero-length arc still paints a dot under a round cap, which reads as "a little used" on an
              // empty context. Nothing is drawn until there is something to draw.
              strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
              className={`${ringColor} transition-[stroke-dashoffset] duration-500 ${pct === 0 ? "opacity-0" : ""}`}
            />
          </svg>
        </span>
      </TooltipTrigger>
      {/* Hoverable content, not a plain title: the compress action lives in here now.
          Painted in the app's own surface / ink tokens rather than the tooltip default, which inverts to
          foreground-on-background and read as a white card pasted onto a dark UI. --tooltip-bg is the hook the
          shared tooltip leaves for exactly this: the arrow reads it, so it follows the panel instead of staying
          inverted. */}
      <TooltipContent
        side="top"
        align="end"
        style={{ ["--tooltip-bg" as string]: "var(--color-surface)" }}
        className="w-56 border border-line bg-surface px-3 py-2 text-ink shadow-md"
      >
        {/* Label left, counts right, on one line — the numbers are what the eye goes to, so they get the edge. */}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] text-ink-subtle">{t("chat.contextUsage")}</span>
          <span className="text-xs tabular-nums text-ink">
            {compact(tokens)}/{compact(contextWindow)} ({pctText}%)
          </span>
        </div>
        {/* The bar the composer ring replaced, kept here where there is room for it: the ring answers "roughly how
            full", this answers "how full against the whole window" at a glance. */}
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          {props.compacted && (
            <span
              className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary"
              title={t("chat.compactedTip")}
            >
              {t("chat.compacted")}
            </span>
          )}
          {/* Manual "compact now": available only once usage reaches the minimum, letting the user proactively trim before approaching the limit. */}
          <button
            type="button"
            onClick={props.onCompactNow}
            disabled={props.compacting || props.generating || !canCompact}
            className="rounded text-[11px] font-medium text-ink-muted underline underline-offset-2 transition hover:text-primary disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
            title={!canCompact ? t("chat.compactMinTitle") : t("chat.compactNowHint")}
          >
            {props.compacting ? t("chat.compacting") : t("chat.compactNow")}
          </button>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
