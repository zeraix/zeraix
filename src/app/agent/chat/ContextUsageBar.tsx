"use client";

/**
 * Context usage: a frosted-glass bar, sticky-pinned to the bottom of the message area. Messages scroll behind
 * its semi-transparent background and backdrop-filter blurs it, giving a frosted-glass texture.
 *
 * Auto-compaction handles trimming on its own, so the fill bar only carries signal at the limit: it is shown
 * once usage passes the danger threshold (≥90%) or on hover; otherwise the row is just the label, the
 * Compressed badge, the manual "Compress now" button, and the numbers.
 */
import { MANUAL_COMPACT_MIN_PCT } from "./contextCompress";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { abbreviateNumber } from "./format";
import { useT } from "@/lib/i18n";

export function ContextUsageBar(props: {
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
  const { tokens, contextWindow } = props;
  const pct = contextWindow > 0 ? Math.min(100, Math.round((tokens / contextWindow) * 100)) : 0;
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  // Manual compaction is allowed once there's enough to compress: ≥20% of the window, OR — when an absolute
  // budget is set — once context has passed that budget (so a 1M-window model isn't stuck "below 20%" while
  // already carrying 200K). Keep this in sync with compactNow's guard.
  const ctxBudgetK = getContextBudgetK();
  const canCompact = pct >= MANUAL_COMPACT_MIN_PCT * 100 || (ctxBudgetK > 0 && tokens >= ctxBudgetK * 1000);
  const showBar = pct >= 90;

  return (
    <div className="group sticky bottom-0 z-10 mt-auto border-t border-line/70 bg-surface/60 px-4 py-2 backdrop-blur-md supports-[backdrop-filter]:bg-surface/60">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`flex items-center justify-between text-[11px] text-ink-subtle ${showBar ? "mb-1" : "group-hover:mb-1"}`}
        >
          <div className="flex items-center gap-2">
            <span>{t("chat.contextUsage")}</span>
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
              className="rounded px-1 py-px text-[10px] font-medium text-ink-subtle transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={!canCompact ? t("chat.compactMinTitle") : t("chat.compactNowHint")}
            >
              {props.compacting ? t("chat.compacting") : t("chat.compactNow")}
            </button>
          </div>
          <span className="tabular-nums">
            {abbreviateNumber(tokens)} / {abbreviateNumber(contextWindow)} · {pct}%
          </span>
        </div>
        <div
          className={`w-full overflow-hidden rounded-full bg-surface-hover/70 transition-all ${
            showBar ? "h-1.5 opacity-100" : "h-0 opacity-0 group-hover:h-1.5 group-hover:opacity-100"
          }`}
        >
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
