"use client";

/**
 * Usage log section: the switch, a per-day summary, and a viewer for what was actually recorded.
 *
 * The log is OFF by default -- an entry per model call and per tool call is a lot of small writes for
 * something most users never read -- so the toggle is the first thing in the panel and everything below
 * it stays usable while it is off (old days remain readable after switching logging back off).
 *
 * Two views over the same fetched page:
 *  - List: newest first, one row per entry, expandable for arguments / result preview / error.
 *  - Timeline: the same entries grouped by turn (RunCtx.turnId), laid out against wall-clock time.
 *    A delegation's rounds and tool calls sit inside the turn that triggered them, which is the view
 *    that answers "where did this turn's tokens actually go".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Layers,
  ListTree,
  RefreshCw,
  ScrollText,
  Search,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  clearUsageLog,
  getUsageLogDir,
  getUsageLogStats,
  isUsageLogAvailable,
  listUsageLogDays,
  openUsageLogDir,
  primeUsageLog,
  readUsageLog,
  setUsageLogEnabled,
  type UsageLogDay,
  type UsageLogEntry,
  type UsageLogKind,
  type UsageLogStats,
} from "@/lib/ai/usageLog";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "./ToggleSwitch";
import { FIELD_CLS } from "./styles";

/** One page of entries. Big enough that a normal day fits, bounded so a runaway day cannot hang the UI. */
const PAGE = 400;

const KINDS: { value: "" | UsageLogKind; labelKey: string }[] = [
  { value: "", labelKey: "logs.kindAll" },
  { value: "model", labelKey: "logs.kindModel" },
  { value: "tool", labelKey: "logs.kindTool" },
  { value: "subagent", labelKey: "logs.kindSubagent" },
];

function fmtNum(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/**
 * The token figure for one step, and how sure it is.
 *
 * A model call reports what the provider billed. A tool call bills nothing itself, but its result is
 * carried into every later request of the turn — so its step cost is that result's size, marked "~"
 * because it is tokenized locally rather than reported by the provider.
 */
function stepTokens(e: UsageLogEntry): { text: string; exact: boolean } | null {
  if (e.kind === "tool") {
    return e.resultTokens ? { text: `~${fmtNum(e.resultTokens)}`, exact: false } : null;
  }
  const total = e.totalTokens ?? 0;
  if (!total) return null;
  return { text: fmtNum(total), exact: !e.estimated };
}

/** Human label for an actor id. Sub-agent and automation-node ids are embedded, not enumerable. */
function actorLabel(actor: string, t: TFunc): string {
  if (actor === "main") return t("logs.actorMain");
  if (actor === "compact") return t("logs.actorCompact");
  if (actor === "builder") return t("logs.actorBuilder");
  if (actor.startsWith("sub:")) return t("logs.actorSub", { agent: actor.slice(4) });
  if (actor.startsWith("node:")) return t("logs.actorNode", { node: actor.slice(5) });
  return actor;
}

/** Actor colour, so a delegation is visually separable from the main agent at a glance. */
function actorClass(actor: string): string {
  if (actor.startsWith("sub:")) return "bg-tint-4/15 text-tint-4-ink border-tint-4/30";
  if (actor === "compact") return "bg-warning/15 text-warning-ink border-warning/30";
  if (actor.startsWith("node:")) return "bg-tint-6/15 text-tint-6-ink border-tint-6/30";
  if (actor === "builder") return "bg-surface-hover text-ink-muted border-line-strong";
  return "bg-tint-1/15 text-tint-1-ink border-tint-1/30";
}

function kindIcon(kind: string) {
  if (kind === "model") return Sparkles;
  if (kind === "tool") return Wrench;
  if (kind === "subagent") return Bot;
  if (kind === "context") return Layers;
  return AlertTriangle;
}

const kTok = (n: number | undefined): string => `${((n ?? 0) / 1000).toFixed(1)}K`;

/** The one-line description of an entry: what this row is actually about. */
function entryTitle(e: UsageLogEntry, t: TFunc): string {
  if (e.kind === "model") return e.model || t("logs.kindModel");
  if (e.kind === "tool") return e.name || "tool";
  if (e.kind === "subagent") return t("logs.actorSub", { agent: e.agent ?? "" });
  if (e.kind === "context")
    return `context ${kTok(e.ctxWire)} / ${kTok(e.ctxWindow)}${e.rereads ? ` · ${e.rereads} re-reads` : ""}`;
  return e.error || "notice";
}

export function LogsSection({ t }: { t: TFunc }) {
  const available = isUsageLogAvailable();
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<UsageLogDay[]>([]);
  const [day, setDay] = useState("");
  const [stats, setStats] = useState<UsageLogStats | null>(null);
  const [entries, setEntries] = useState<UsageLogEntry[]>([]);
  const [matched, setMatched] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [kind, setKind] = useState<"" | UsageLogKind>("");
  const [actor, setActor] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "timeline">("list");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // Mount: read the switch, then land on the newest day that has entries (today when none do).
  useEffect(() => {
    if (!available) return;
    void (async () => {
      setEnabled(await primeUsageLog());
      void getUsageLogDir().then(setDir);
      const list = await listUsageLogDays();
      setDays(list);
      setDay(list[0]?.day ?? "");
    })();
  }, [available]);

  const load = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    try {
      const [page, s] = await Promise.all([
        readUsageLog({ day: day || undefined, kind: kind || undefined, actor: actor || undefined, q: query, limit }),
        getUsageLogStats(day || undefined),
      ]);
      setEntries(page.entries);
      setMatched(page.matched);
      setStats(s);
      // The first read of a session creates today's key even when no file exists yet, so the day
      // dropdown is never empty while logging is on.
      if (!day && page.day) setDay(page.day);
    } finally {
      setLoading(false);
    }
  }, [available, day, kind, actor, query, limit]);

  // Debounced: `query` changes on every keystroke and each reload parses the whole day file.
  useEffect(() => {
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [load]);

  const toggle = async (on: boolean) => {
    setEnabled(on); // optimistic; reconciled with what the main process applied
    const applied = await setUsageLogEnabled(on);
    setEnabled(applied);
  };

  const refreshDays = async () => {
    setDays(await listUsageLogDays());
    await load();
  };

  const clear = async (scope: "day" | "all") => {
    setMsg(null);
    const removed = await clearUsageLog(scope === "day" ? day : undefined);
    setMsg(t("logs.cleared", { count: removed }));
    setEntries([]);
    setStats(null);
    const list = await listUsageLogDays();
    setDays(list);
    if (scope === "all" || !list.some((d) => d.day === day)) setDay(list[0]?.day ?? "");
    else await load();
  };

  const openDir = async () => {
    setMsg(null);
    const res = await openUsageLogDir();
    if (!res.ok) setMsg(`${t("logs.openDirFail")}${res.error ?? ""}`);
  };

  // Actor filter options come from the day's own aggregate, so the list only ever offers actors that
  // actually appear in it (sub-agent and node ids are not a fixed set).
  const actorOptions = useMemo(() => Object.keys(stats?.byActor ?? {}).sort(), [stats]);

  if (!available) {
    return (
      <div className="max-w-2xl">
        <h2 className="mb-1 text-xl font-bold text-ink">{t("settings.logs")}</h2>
        <p className="mb-5 text-sm text-ink-subtle">{t("logs.desc")}</p>
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
          {t("logs.unsupported")}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="mb-1 text-xl font-bold text-ink">{t("settings.logs")}</h2>
      <p className="mb-5 text-sm text-ink-subtle">{t("logs.desc")}</p>

      {/* The switch. Off by default: this writes a line per model call and per tool call. */}
      <div className="mb-4 rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{t("logs.enable")}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t("logs.enableDesc")}</p>
          </div>
          <ToggleSwitch on={enabled} onChange={(v) => void toggle(v)} label={t("logs.enable")} />
        </div>
        {dir && (
          <p className="mt-2 break-all font-mono text-[11px] text-ink-subtle">{dir}</p>
        )}
        {!enabled && <p className="mt-2 text-[11px] text-ink-subtle">{t("logs.disabledNote")}</p>}
      </div>

      {/* Controls: day, filters, view switch, folder / clear actions. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={day} onChange={(e) => setDay(e.target.value)} className={cn(FIELD_CLS, "text-xs")} aria-label={t("logs.day")}>
          {days.length === 0 && <option value={day}>{day || t("logs.noDays")}</option>}
          {days.map((d) => (
            <option key={d.day} value={d.day}>
              {d.day} · {fmtBytes(d.bytes)}
            </option>
          ))}
        </select>

        <select value={kind} onChange={(e) => setKind(e.target.value as "" | UsageLogKind)} className={cn(FIELD_CLS, "text-xs")} aria-label={t("logs.filterKind")}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {t(k.labelKey)}
            </option>
          ))}
        </select>

        <select value={actor} onChange={(e) => setActor(e.target.value)} className={cn(FIELD_CLS, "text-xs")} aria-label={t("logs.filterActor")}>
          <option value="">{t("logs.actorAll")}</option>
          {actorOptions.map((a) => (
            <option key={a} value={a}>
              {actorLabel(a, t)}
            </option>
          ))}
        </select>

        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("logs.search")}
            aria-label={t("logs.search")}
            className={cn(FIELD_CLS, "w-full pl-8 text-xs")}
          />
        </div>

        {/* View switch: the same data, laid out flat or against the clock. */}
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-line-strong">
          {(["list", "timeline"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition",
                view === v ? "bg-primary text-primary-foreground" : "bg-surface text-ink-muted hover:bg-surface-muted",
              )}
            >
              {v === "list" ? <ScrollText className="size-3.5" /> : <ListTree className="size-3.5" />}
              {t(v === "list" ? "logs.viewList" : "logs.viewTimeline")}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void refreshDays()}
          title={t("logs.refresh")}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => void openDir()}
          title={t("logs.openDir")}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
        >
          <FolderOpen className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void clear("day")}
          disabled={!day}
          title={t("logs.clearDay")}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition hover:bg-danger/10 hover:text-danger-ink disabled:opacity-40"
        >
          <Trash2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void clear("all")}
          disabled={days.length === 0}
          className="shrink-0 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:bg-danger/10 hover:text-danger-ink disabled:opacity-40"
        >
          {t("logs.clearAll")}
        </button>
      </div>

      {msg && <p className="mb-3 text-[11px] text-warning-ink">{msg}</p>}

      {/* Day summary. */}
      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Displayed exactly like the input stat below: headline is net of cache (tokens actually
              paid for), and the sub-line reports the gross total and how much was served from cache. */}
          <Stat
            label={t("logs.totalTokens")}
            value={fmtNum(Math.max(0, stats.totalTokens - stats.cachedTokens))}
            hint={
              [
                stats.cachedTokens
                  ? t("logs.inputBreakdown", { total: fmtNum(stats.totalTokens), cached: fmtNum(stats.cachedTokens) })
                  : null,
                stats.estimated ? t("logs.estimatedNote") : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          />
          {/* Headline = fresh input (prompt minus what the prefix cache served) — the tokens actually
              paid for. The sub-line still reports the total input and how much of it was cached, so the
              gross figure is not hidden. clamp at 0 in case a provider reports more cached than prompt. */}
          <Stat
            label={t("logs.inputTokens")}
            value={fmtNum(Math.max(0, stats.promptTokens - stats.cachedTokens))}
            hint={
              stats.cachedTokens
                ? t("logs.inputBreakdown", { total: fmtNum(stats.promptTokens), cached: fmtNum(stats.cachedTokens) })
                : undefined
            }
          />
          <Stat label={t("logs.outputTokens")} value={fmtNum(stats.completionTokens)} />
          <Stat label={t("logs.modelCalls")} value={fmtNum(stats.calls)} />
          <Stat
            label={t("logs.toolCalls")}
            value={fmtNum(stats.toolCalls)}
            hint={stats.toolResultTokens ? t("logs.toolTokensHint", { n: fmtNum(stats.toolResultTokens) }) : undefined}
          />
          <Stat label={t("logs.subagentRuns")} value={fmtNum(stats.subagentRuns)} />
          <Stat label={t("logs.errors")} value={fmtNum(stats.errors)} />
          <Stat label={t("logs.entries")} value={fmtNum(stats.entries)} />
        </div>
      )}

      {/* Breakdowns: where the tokens went, and what the agents spent their time doing. */}
      {stats && stats.entries > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Breakdown
            title={t("logs.byModel")}
            rows={Object.entries(stats.byModel)
              .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
              .slice(0, 6)
              .map(([name, v]) => ({ name, value: fmtNum(v.totalTokens), weight: v.totalTokens }))}
          />
          <Breakdown
            title={t("logs.byActor")}
            rows={Object.entries(stats.byActor)
              .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
              .slice(0, 6)
              .map(([name, v]) => ({
                name: actorLabel(name, t),
                value: `${fmtNum(v.totalTokens)} · ${fmtNum(v.toolCalls ?? 0)}⚒`,
                weight: v.totalTokens,
              }))}
          />
          <Breakdown
            title={t("logs.byTool")}
            rows={Object.entries(stats.byTool)
              .sort((a, b) => b[1].calls - a[1].calls)
              .slice(0, 6)
              .map(([name, v]) => ({
                name,
                value: v.resultTokens ? `${fmtNum(v.calls)}× · ~${fmtNum(v.resultTokens)}` : `${fmtNum(v.calls)}×`,
                weight: v.calls,
              }))}
          />
        </div>
      )}

      {entries.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-6 text-center text-xs text-ink-subtle">
          {enabled ? t("logs.empty") : t("logs.emptyDisabled")}
        </p>
      ) : view === "list" ? (
        <EntryList t={t} entries={entries} expanded={expanded} setExpanded={setExpanded} />
      ) : (
        <Timeline t={t} entries={entries} />
      )}

      {/* Paging: matched counts the whole day, entries only what was fetched. */}
      {matched > entries.length && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-3 w-full rounded-lg border border-line-strong bg-surface py-2 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
        >
          {t("logs.loadMore", { shown: entries.length, total: matched })}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <p className="text-[11px] text-ink-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="text-[10px] text-ink-subtle">{hint}</p>}
    </div>
  );
}

/** A small ranked bar list. Bars are relative to the row with the largest weight, not to a total. */
function Breakdown({ title, rows }: { title: string; rows: { name: string; value: string; weight: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.weight));
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <p className="mb-2 text-[11px] font-semibold text-ink-muted">{title}</p>
      {rows.length === 0 && <p className="text-[11px] text-ink-subtle">—</p>}
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.name}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] text-ink" title={r.name}>{r.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-subtle">{r.value}</span>
            </div>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(3, (r.weight / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Flat view, newest first. A row expands to show what the model actually sent / got back. */
function EntryList({
  t,
  entries,
  expanded,
  setExpanded,
}: {
  t: TFunc;
  entries: UsageLogEntry[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
}) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {entries.map((e, i) => {
        const id = e.id ?? `${e.ts}-${i}`;
        const Icon = kindIcon(e.kind);
        const open = expanded === id;
        const detail = e.kind === "tool" ? e.args : e.kind === "subagent" ? e.task : undefined;
        return (
          <div key={id} className={cn("bg-surface", !e.ok && "bg-danger/[0.04]")}>
            <button
              type="button"
              onClick={() => setExpanded(open ? null : id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-muted/60"
            >
              {open ? <ChevronDown className="size-3.5 shrink-0 text-ink-subtle" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-subtle" />}
              <span className="w-[68px] shrink-0 font-mono text-[11px] tabular-nums text-ink-subtle">{fmtTime(e.ts)}</span>
              <Icon className={cn("size-3.5 shrink-0", e.ok ? "text-ink-muted" : "text-danger-ink")} />
              <span className={cn("shrink-0 rounded border px-1.5 py-px text-[10px] font-medium", actorClass(e.actor))}>
                {actorLabel(e.actor, t)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink">
                {entryTitle(e, t)}
                {detail && <span className="ml-1.5 text-ink-subtle">{detail}</span>}
              </span>
              {/* Per-step tokens: what this one step cost (a model call) or added (a tool result). */}
              {(() => {
                const tok = stepTokens(e);
                if (!tok) return null;
                const io =
                  e.kind === "model"
                    ? `${t("logs.inputTokens")} ${fmtNum(e.promptTokens)} · ${t("logs.outputTokens")} ${fmtNum(e.completionTokens)}`
                    : t("logs.resultTokensHint");
                return (
                  <span
                    title={io}
                    className={cn("shrink-0 text-[11px] tabular-nums", tok.exact ? "text-ink-muted" : "text-ink-subtle")}
                  >
                    {tok.text} {t("logs.tok")}
                  </span>
                );
              })()}
              {e.ms != null && <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-ink-subtle">{fmtMs(e.ms)}</span>}
            </button>

            {open && (
              <div className="space-y-1.5 border-t border-line bg-surface-muted/40 px-3 py-2.5 text-[11px]">
                <Row label={t("logs.fieldSource")} value={`${e.source} · ${e.actor}`} />
                {e.kind === "model" && (
                  <>
                    <Row label={t("logs.fieldModel")} value={`${e.model ?? "—"}${e.endpoint ? ` (${e.endpoint})` : ""}`} />
                    <Row
                      label={t("logs.fieldTokens")}
                      value={`${t("logs.inputTokens")} ${fmtNum(e.promptTokens)} · ${t("logs.outputTokens")} ${fmtNum(e.completionTokens)}${
                        e.cachedTokens ? ` · ${t("logs.cached")} ${fmtNum(e.cachedTokens)}` : ""
                      }${e.reasoningTokens ? ` · ${t("logs.reasoning")} ${fmtNum(e.reasoningTokens)}` : ""}${
                        e.estimated ? ` · ${t("logs.estimated")}` : ""
                      }`}
                    />
                  </>
                )}
                {e.kind === "subagent" && (
                  <>
                    <Row label={t("logs.fieldRounds")} value={`${fmtNum(e.rounds)} · ${t("logs.fieldSteps")} ${fmtNum(e.steps)}`} />
                    {e.task && <Row label={t("logs.fieldTask")} value={e.task} pre />}
                  </>
                )}
                {e.kind === "tool" && (
                  <>
                    {e.args && <Row label={t("logs.fieldArgs")} value={e.args} pre />}
                    {e.resultChars != null && (
                      <Row
                        label={t("logs.fieldResult")}
                        value={`${t("logs.chars", { n: fmtNum(e.resultChars) })}${
                          e.resultTokens ? ` · ~${fmtNum(e.resultTokens)} ${t("logs.tok")}` : ""
                        }`}
                      />
                    )}
                    {e.resultPreview && <Row label={t("logs.fieldPreview")} value={e.resultPreview} pre />}
                  </>
                )}
                {e.kind === "context" && (
                  <>
                    <Row
                      label="wire / window"
                      value={`${kTok(e.ctxWire)} / ${kTok(e.ctxWindow)} · ${e.msgCount ?? 0} msgs`}
                    />
                    <Row
                      label="buckets"
                      value={`system ${kTok(e.ctxSystem)} · schemas ${kTok(e.ctxToolSchemas)} · history ${kTok(
                        e.ctxHistory,
                      )} · tools ${kTok(e.ctxToolOutputs)} · subagent ${kTok(e.ctxSubagent)}`}
                    />
                    <Row label="redundant re-reads" value={String(e.rereads ?? 0)} />
                  </>
                )}
                {e.turnId && <Row label={t("logs.fieldTurn")} value={e.turnId} />}
                {e.error && <Row label={t("logs.fieldError")} value={e.error} pre />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-ink-subtle">{label}</span>
      <span className={cn("min-w-0 flex-1 break-words text-ink-muted", pre && "whitespace-pre-wrap font-mono")}>{value}</span>
    </div>
  );
}

/**
 * Timeline: entries grouped by turn, each laid out against the turn's own wall clock.
 *
 * Grouping is by turnId rather than by time bucket because that is the unit a user reasons about --
 * "this question cost this much" -- and it is what makes a sub-agent's rounds legible: they appear
 * nested under the turn that delegated them instead of interleaved with unrelated requests.
 */
function Timeline({ t, entries }: { t: TFunc; entries: UsageLogEntry[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, UsageLogEntry[]>();
    for (const e of entries) {
      // Entries with no turn (a workflow-builder call, a stray notice) share one bucket rather than
      // becoming a hundred single-row groups.
      const key = e.turnId ?? `${e.source}:${e.kind}`;
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return [...map.entries()]
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => a.ts - b.ts);
        const start = sorted[0].ts;
        const end = Math.max(...sorted.map((e) => e.ts + (e.ms ?? 0)));
        return {
          key,
          entries: sorted,
          start,
          end,
          span: Math.max(1, end - start),
          tokens: sorted.reduce((n, e) => n + (e.kind === "model" ? e.totalTokens ?? 0 : 0), 0),
          toolCalls: sorted.filter((e) => e.kind === "tool").length,
          errors: sorted.filter((e) => !e.ok).length,
        };
      })
      .sort((a, b) => b.start - a.start);
  }, [entries]);

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.key} className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-muted/50 px-3 py-2">
            <span className="font-mono text-[11px] tabular-nums text-ink">{fmtTime(g.start)}</span>
            <span className="text-[11px] text-ink-muted">{fmtMs(g.end - g.start)}</span>
            <span className="text-[11px] text-ink-muted">
              {fmtNum(g.tokens)} {t("logs.tok")}
            </span>
            <span className="text-[11px] text-ink-subtle">
              {t("logs.turnSummary", { calls: g.entries.filter((e) => e.kind === "model").length, tools: g.toolCalls })}
            </span>
            {g.errors > 0 && (
              <span className="rounded border border-danger/30 bg-danger/10 px-1.5 py-px text-[10px] text-danger-ink">
                {t("logs.errorCount", { n: g.errors })}
              </span>
            )}
          </div>
          <div className="space-y-1 px-3 py-2">
            {g.entries.map((e, i) => {
              // Bars are positioned within the group's own span, so a 200 ms tool call inside a
              // 40 s turn still renders as a visible sliver rather than disappearing.
              const left = ((e.ts - g.start) / g.span) * 100;
              const width = Math.max(1.5, ((e.ms ?? 0) / g.span) * 100);
              const Icon = kindIcon(e.kind);
              return (
                <div key={e.id ?? `${e.ts}-${i}`} className="flex items-center gap-2">
                  <Icon className={cn("size-3 shrink-0", e.ok ? "text-ink-subtle" : "text-danger-ink")} />
                  <span
                    className={cn("w-24 shrink-0 truncate rounded border px-1.5 py-px text-[10px] font-medium", actorClass(e.actor))}
                    title={actorLabel(e.actor, t)}
                  >
                    {actorLabel(e.actor, t)}
                  </span>
                  <span className="w-40 shrink-0 truncate text-[11px] text-ink" title={entryTitle(e, t)}>
                    {entryTitle(e, t)}
                  </span>
                  <div className="relative h-3 min-w-0 flex-1 rounded bg-line/60">
                    <div
                      className={cn(
                        "absolute top-0 h-full rounded",
                        !e.ok ? "bg-danger/70" : e.kind === "model" ? "bg-primary/80" : e.kind === "tool" ? "bg-success/70" : "bg-tint-4/70",
                      )}
                      style={{ left: `${Math.min(98.5, left)}%`, width: `${Math.min(width, 100 - Math.min(98.5, left))}%` }}
                      title={`${fmtTime(e.ts)} · ${fmtMs(e.ms)}`}
                    />
                  </div>
                  {/* Every step carries its own token figure; duration stays on the bar's tooltip. */}
                  <span className="w-20 shrink-0 text-right text-[10px] tabular-nums text-ink-subtle">
                    {stepTokens(e)?.text ?? fmtMs(e.ms)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
