"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { DiffView, extractDiff } from "./DiffView";
import { Markdown } from "./Markdown";
import { formatBytes, abbreviateNumber, formatDuration } from "./format";
import { useT } from "@/lib/i18n";
import type { ChoiceMsg, DisplayMsg, Todo } from "./types";

/** A single tool-call message (the tool branch extracted from the DisplayMsg union). */
export type ToolMsg = Extract<DisplayMsg, { kind: "tool" }>;

/** Tool-call bubble: collapsed by default, showing only a single status line (icon + tool name + success/failure);
 *  parameters and the full result appear only when expanded, keeping the "final result" (the assistant's reply) the main focus. */
function ToolCallBubble({
  name,
  args,
  ok,
  result,
}: {
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
}) {
  const t = useT();
  const argStr = (() => {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return "{}";
    }
  })();
  // Split out any diff code block that may be present; the remaining text is shown as a plain result.
  const { before, diff, after } = extractDiff(result);
  // File-type tools: when there is a diff, show only the path instead of piling up huge old_string/new_string parameters.
  const filePath =
    args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
  // Collapsed-state result preview: take the first line (after removing the diff), truncating if it's too long.
  const preview = (before || after || result).replace(/\s+/g, " ").trim();
  const previewShort = preview.length > 48 ? `${preview.slice(0, 48)}…` : preview;

  return (
      <details className="group/tool w-full overflow-hidden rounded-lg border border-line bg-surface-muted text-[11px]">
        <summary className="flex cursor-pointer list-none select-none items-center gap-2 px-3 py-1.5 hover:bg-surface-hover">
          <span
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${
              ok ? "bg-emerald-500" : "bg-destructive"
            }`}
          >
            {ok ? "✓" : "✕"}
          </span>
          <span className="font-mono font-semibold text-ink">{name}</span>
          {previewShort && (
            <span className="truncate font-mono text-ink-subtle">· {previewShort}</span>
          )}
          <span className="ml-auto shrink-0 text-ink-subtle transition group-open/tool:rotate-180">▾</span>
        </summary>
        <div className="space-y-2 border-t border-line px-3 py-2">
          {diff ? (
            <div>
              <div className="mb-0.5 font-semibold text-ink-subtle">{t("chat.file")}</div>
              <p className="font-mono break-all text-ink-muted">
                {filePath ? String(filePath) : t("chat.unknown")}
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-0.5 font-semibold text-ink-subtle">{t("chat.args")}</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ink-muted">
                {argStr}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-0.5 font-semibold text-ink-subtle">{diff ? t("chat.changes") : t("chat.result")}</div>
            {diff ? (
              <div className="space-y-1.5">
                {before && (
                  <p className={`font-mono ${ok ? "text-ink-muted" : "text-destructive"}`}>{before}</p>
                )}
                <DiffView diff={diff} />
                {after && <p className="font-mono text-ink-muted">{after}</p>}
              </div>
            ) : (
              <pre
                className={`max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono ${
                  ok ? "text-ink-muted" : "text-destructive"
                }`}
              >
                {result}
              </pre>
            )}
          </div>
        </div>
      </details>
  );
}

/** File-change card: write_file / edit_file / append_file directly show "path + changes".
 *  When the diff exceeds 100 lines, only the first 100 lines are shown, with a click to expand / collapse. */
const FILE_DIFF_LINE_LIMIT = 100;
/**
 * A generated image (image_generation).
 *
 * The engine line is not decoration: selectEngine may fall back across vendors, so a user chatting
 * on DeepSeek can have their Zhipu key spent. Naming the engine is how that stays honest without
 * interrupting them with a dialog. See docs/generation-capabilities-design.md §3 / §6.1.
 */
function GeneratedImageCard({ src, servedBy }: { src: string; servedBy?: string }) {
  const t = useT();
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[92%]">
        <div className="overflow-hidden rounded-lg border border-border bg-background/60">
          {/* eslint-disable-next-line @next/next/no-img-element -- src is a vendor CDN URL or a data: URL, neither of which next/image can optimise */}
          <img src={src} alt={t("image.alt")} className="block h-auto w-full" loading="lazy" />
          {servedBy ? (
            <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
              {t("image.servedBy", { engine: servedBy })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileChangeCard({
  name,
  args,
  ok,
  result,
}: {
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { before, diff } = extractDiff(result);
  const filePath =
    args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
  const lines = diff ? diff.split("\n") : [];
  const tooLong = lines.length > FILE_DIFF_LINE_LIMIT;
  const shownDiff =
    diff && tooLong && !expanded ? lines.slice(0, FILE_DIFF_LINE_LIMIT).join("\n") : diff;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface-muted text-[11px]">
      {/* Header: status + tool name + summary */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${
            ok ? "bg-emerald-500" : "bg-destructive"
          }`}
        >
          {ok ? "✓" : "✕"}
        </span>
        <span className="font-mono font-semibold text-ink">{name}</span>
        {before && <span className="truncate font-mono text-ink-subtle">· {before}</span>}
      </div>

      <div className="space-y-2 border-t border-line px-3 py-2">
        {/* Path */}
        <div className="flex gap-1.5">
          <span className="shrink-0 font-semibold text-ink-subtle">{t("chat.path")}</span>
          <span className="break-all font-mono text-ink-muted">
            {filePath ? String(filePath) : t("chat.unknown")}
          </span>
        </div>

        {/* Changes */}
        <div>
          <div className="mb-0.5 font-semibold text-ink-subtle">{t("chat.changes")}</div>
          {shownDiff ? (
            <DiffView diff={shownDiff} />
          ) : (
            <pre
              className={`max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono ${
                ok ? "text-ink-muted" : "text-destructive"
              }`}
            >
              {result}
            </pre>
          )}
          {tooLong && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted transition hover:bg-surface-muted"
            >
              {expanded ? t("chat.collapse") : t("chat.expandLines", { n: lines.length - FILE_DIFF_LINE_LIMIT })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Todo-list archive card: after the conversation ends, the list is shown in the chat as a read-only record. */
function TodoRecord({ todos }: { todos: Todo[] }) {
  const t = useT();
  const done = todos.filter((td) => td.status === "completed").length;
  const allDone = done === todos.length;
  return (
    <div className="flex">
      {/* AI avatar removed */}
      <div className="w-full max-w-md rounded-xl border border-line bg-surface-muted/40 px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">📋 {t("chat.todos")}</span>
          <span
            className={`rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums ${
              allDone ? "bg-emerald-500/15 text-emerald-600" : "bg-surface-hover text-ink-muted"
            }`}
          >
            {done}/{todos.length}
          </span>
          {allDone && (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
              {t("chat.allDone")}
            </span>
          )}
          <div className="ml-auto h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
            <div
              className={`h-full rounded-full ${allDone ? "bg-emerald-500" : "bg-primary"}`}
              style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }}
            />
          </div>
        </div>
        <ul className="space-y-1">
          {todos.map((td, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {td.status === "completed" ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white">
                    ✓
                  </span>
                ) : td.status === "in_progress" ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                ) : (
                  <span className="block h-4 w-4 rounded-full border-2 border-line-strong" />
                )}
              </span>
              <span
                className={
                  td.status === "completed" ? "text-ink-subtle line-through" : "text-ink"
                }
              >
                {td.title}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Choice card: renders the AI-recommended options plus an auto-appended "Discuss this question", fed back to the model on click. */
function ChoiceCard({
  msg,
  onPick,
}: {
  msg: ChoiceMsg;
  onPick: (id: number, value: string, discuss: boolean) => void;
}) {
  const t = useT();
  const answered = msg.selected !== null;
  return (
    <div className="flex">
      {/* The AI avatar and outer bubble are both removed: the question and options are shown as plain text + standalone option buttons */}
      <div className="w-full min-w-0 px-1 py-0.5">
        {msg.question && (
          <p className="mb-2.5 text-sm font-medium leading-relaxed text-ink">{msg.question}</p>
        )}
        <div className="flex max-w-md flex-col gap-2">
          {msg.options.map((opt, idx) => {
            const chosen = msg.selected === opt;
            return (
              <button
                key={idx}
                disabled={answered}
                onClick={() => onPick(msg.id, opt, false)}
                className={`group flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-all disabled:cursor-default ${
                  chosen
                    ? "border-primary bg-primary font-medium text-white shadow-sm shadow-primary/25"
                    : answered
                      ? "border-line bg-surface-muted text-ink-subtle"
                      : "border-line bg-surface text-ink hover:-translate-y-px hover:border-primary hover:bg-primary/[0.06] hover:shadow-sm"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors ${
                    chosen
                      ? "bg-white/25 text-white"
                      : answered
                        ? "bg-surface text-ink-subtle"
                        : "bg-surface-muted text-ink-muted group-hover:bg-primary/15 group-hover:text-primary"
                  }`}
                >
                  {chosen ? "✓" : String.fromCharCode(65 + idx)}
                </span>
                <span className="min-w-0 flex-1">{opt}</span>
              </button>
            );
          })}
          {/* Auto-appended: Discuss this question */}
          {(() => {
            const discussLabel = t("chat.discuss");
            const chosen = msg.selected === discussLabel;
            return (
              <button
                disabled={answered}
                onClick={() => onPick(msg.id, discussLabel, true)}
                className={`flex items-center gap-2 rounded-xl border border-dashed px-3.5 py-2.5 text-left text-sm transition-all disabled:cursor-default ${
                  chosen
                    ? "border-neutral-500 bg-neutral-700 font-medium text-white"
                    : answered
                      ? "border-line bg-surface-muted text-ink-subtle"
                      : "border-line-strong bg-surface/60 text-ink-muted hover:border-neutral-400 hover:bg-surface-muted hover:text-ink"
                }`}
              >
                <span className="shrink-0 text-[13px]">💬</span>
                <span className="min-w-0 flex-1">{discussLabel}</span>
              </button>
            );
          })()}
        </div>
        {answered && (
          <p className="mt-2.5 flex items-center gap-1 text-xs text-ink-subtle">
            <span className="text-primary">✓</span>
            {t("chat.selectedLabel")}<span className="font-medium text-ink-muted">{msg.selected}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** Display dispatch for a single tool call: file-type tools use the "path + changes" card, others use a collapsible bubble.
 *  Extracted so the same rendering can be reused in the ToolGroup timeline. */
function ToolEntry({ m }: { m: ToolMsg }) {
  const isFileChange = extractDiff(m.result).diff !== null;
  return isFileChange ? (
    <FileChangeCard name={m.name} args={m.args} ok={m.ok} result={m.result} />
  ) : (
    <ToolCallBubble name={m.name} args={m.args} ok={m.ok} result={m.result} />
  );
}

/**
 * "Executing" tool subgroup: collapses a run of consecutive tool calls into an "Executing · N steps" timeline card.
 * No outer avatar placeholder — alignment is handled uniformly by the parent ProcessGroup, for reuse within it (sitting alongside ReasoningEntry as its own segment).
 * Auto-expands while this turn is still in progress (live) and auto-collapses when it ends; the user can also expand it manually at any time to inspect each step's parameters and result.
 */
function ToolSubGroup({ tools, live = false }: { tools: ToolMsg[]; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) setOpen(true);
    else if (!live && wasLive.current) setOpen(false);
    wasLive.current = live;
  }, [live]);

  const total = tools.length;
  const failed = tools.filter((t) => !t.ok).length;
  // Every tool bubble inside a subgroup is pushed in only after it finishes, so this subgroup's tools are always done — show them directly in the completed state.
  // No longer shows "X in progress…": the tool that is actually running and has no bubble yet has its progress reflected by the bottom status line; otherwise, once a tool finishes,
  // this would stay stuck on "X in progress…" until the AI's next step updated it (a problem users reported).
  const subtitle =
    failed > 0
      ? t("chat.stepsFailed", { n: total, failed })
      : t("chat.stepsAllDone", { n: total });

  return (
    <div
      className={`overflow-hidden rounded-lg border transition-colors ${
        live ? "border-primary/30 bg-primary/[0.03]" : "border-line bg-surface"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-hover/50"
        aria-expanded={open}
      >
        {/* Tools are always done, so use the completed-state icon (no longer a spinning spinner that misleads as "still executing"). */}
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        <span className="shrink-0 text-[12px] font-medium text-ink-muted">{t("chat.executing")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle">· {subtitle}</span>
        {failed > 0 && (
          <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-destructive">
            {t("chat.failedBadge", { failed })}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Body: a vertical timeline, one tool card per step */}
      {open && (
        <div className="space-y-2.5 border-t border-line bg-surface-muted/40 px-3 py-3">
          {tools.map((t, i) => {
            const isLast = i === total - 1;
            return (
              <div key={i} className="relative pl-6">
                {/* Connecting line (the last step no longer extends downward) */}
                {!isLast && <span className="absolute bottom-0 left-[6px] top-4 w-px bg-line" />}
                {/* Node dot: green for success / red for failure */}
                <span
                  className={`absolute left-0 top-[7px] h-3 w-3 rounded-full border-2 border-surface ring-1 ${
                    t.ok ? "bg-emerald-500 ring-emerald-500/30" : "bg-destructive ring-destructive/30"
                  }`}
                />
                <ToolEntry m={t} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Members received by ProcessGroup: a stretch of the AI's "thinking trace" — deep reasoning (reasoning), phase summaries (phase), and tool calls (tool) interleaved. */
export type ProcessItem = Extract<DisplayMsg, { kind: "tool" | "reasoning" | "phase" }>;

/**
 * Thinking-process group: gathers a whole continuous stretch of the AI's "deep reasoning + tool calls" trace into a single collapsible card,
 * keeping the final reply the main focus and avoiding breaking up the conversation with one card per item. It reconstructs items in order of appearance: consecutive tools merge into one
 * "Executing" subgroup, while deep reasoning each forms its own segment. Auto-expands while this turn is in progress (live) and auto-collapses when it ends.
 */
export function ProcessGroup({ items, live = false }: { items: ProcessItem[]; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) setOpen(true);
    else if (!live && wasLive.current) setOpen(false);
    wasLive.current = live;
  }, [live]);

  // Split into segments in order of appearance: consecutive tools go into one "Executing" subgroup, while reasoning / phase each form their own segment.
  const segments: Array<
    | { type: "tools"; tools: ToolMsg[] }
    | { type: "reasoning"; content: string }
    | { type: "phase"; content: string }
  > = [];
  for (const m of items) {
    if (m.kind === "tool") {
      const last = segments[segments.length - 1];
      if (last?.type === "tools") last.tools.push(m);
      else segments.push({ type: "tools", tools: [m] });
    } else if (m.kind === "phase") {
      segments.push({ type: "phase", content: m.content });
    } else {
      segments.push({ type: "reasoning", content: m.content });
    }
  }
  // While in progress, only the "last tool subgroup" auto-expands (so the current action is visible); the rest stay collapsed.
  let lastToolSeg = -1;
  segments.forEach((s, i) => {
    if (s.type === "tools") lastToolSeg = i;
  });

  const failed = items.reduce((n, m) => n + (m.kind === "tool" && !m.ok ? 1 : 0), 0);
  const steps = items.length; // step count = number of deep-reasoning items + number of tool steps
  // While in progress, uniformly show "Thinking…": the tools/reasoning already grouped are done, and the tool actually running now (which has no bubble yet) is reflected by the bottom status line.
  // (This avoids composing "X in progress…" from the last finished tool's name, which would otherwise stay stuck on that text after the tool finishes until the next step.)
  const subtitle = live
    ? t("chat.thinking")
    : failed > 0
      ? t("chat.stepsFailed", { n: steps, failed })
      : t("chat.stepsAllDone", { n: steps });

  return (
    // Left-aligned with the AI reply: reserve a placeholder the same width as the avatar (h-7 w-7 + gap-2.5) so the card's starting position aligns with the AI bubble.
    <div className="flex gap-2.5">
      <div className="h-7 w-7 shrink-0" aria-hidden />
      <div className="min-w-0 max-w-[80%] flex-1">
        <div
          className={`overflow-hidden rounded-lg border transition-colors ${
            live ? "border-primary/30 bg-primary/[0.03]" : "border-line bg-surface"
          }`}
        >
          {/* Header: icon + "Thinking process" + overview + collapse arrow */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-hover/50"
            aria-expanded={open}
          >
            <span className={`shrink-0 ${live ? "text-primary" : "text-ink-subtle"}`}>
              {live ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="shrink-0 text-[12px] font-medium text-ink-muted">{t("chat.process")}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle">· {subtitle}</span>
            {live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />}
            {failed > 0 && (
              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-destructive">
                {t("chat.failedBadge", { failed })}
              </span>
            )}
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-200 ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>

          {/* Body: reconstruct, in order, the deep-reasoning segments and the "Executing" tool subgroups */}
          {open && (
            <div className="space-y-2 border-t border-line bg-surface-muted/40 px-3 py-3">
              {segments.map((seg, si) =>
                seg.type === "reasoning" ? (
                  <ReasoningEntry key={si} content={seg.content} />
                ) : seg.type === "phase" ? (
                  <PhaseSummaryEntry key={si} content={seg.content} />
                ) : (
                  <ToolSubGroup key={si} tools={seg.tools} live={live && si === lastToolSeg} />
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Deep-reasoning entry: the reasoning_content returned by reasoning models (e.g. qwen3), collapsed by default with a first-line preview when collapsed.
 *  No outer avatar placeholder — for reuse inside ProcessGroup as a segment alongside ReasoningEntry. */
function ReasoningEntry({ content }: { content: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const preview = content.replace(/\s+/g, " ").trim();
  return (
    <div className="overflow-hidden rounded-lg border border-line/70 bg-surface-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-hover/50"
        aria-expanded={open}
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        <span className="shrink-0 text-[12px] font-medium text-ink-muted">{t("chat.reasoning")}</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle">· {preview}</span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="whitespace-pre-wrap break-words border-t border-line/70 px-3 py-2.5 text-[12px] leading-relaxed text-ink-muted">
          {content}
        </div>
      )}
    </div>
  );
}

/** Phase-summary entry: in dev mode, the body text of a tool-call round (after cleanup) serves as a plan/summary within the "thinking process" timeline.
 *  Shown inline (the content is usually short and part of the main narrative), tagged "Phase summary", styled like a deep-reasoning entry but visible by default. */
function PhaseSummaryEntry({ content }: { content: string }) {
  const t = useT();
  return (
    <div className="flex gap-2 rounded-lg border border-line/70 bg-surface-muted/30 px-2.5 py-2">
      <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
      <div className="min-w-0 flex-1">
        <span className="text-[12px] font-medium text-ink-muted">{t("chat.phaseSummary")}</span>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
          {content}
        </p>
      </div>
    </div>
  );
}

/** Deep-reasoning block (shown standalone, with an avatar-alignment placeholder): distinct from the tool-trace "thinking process".
 *  Most deep reasoning is now merged into ProcessGroup; this is kept for the fallback reasoning branch in MessageItem. */
function ThinkingBlock({ content }: { content: string }) {
  return (
    // Left-aligned with the AI reply: reserve a placeholder the same width as the (removed) avatar so the starting position matches.
    <div className="flex gap-2.5">
      <div className="h-7 w-7 shrink-0" aria-hidden />
      <div className="min-w-0 max-w-[80%] flex-1">
        <ReasoningEntry content={content} />
      </div>
    </div>
  );
}

/** Icon button in the message action bar (uniform size / hover style); active highlights the currently selected thumbs-up / thumbs-down. */
function ActionIconButton({
  title,
  onClick,
  children,
  active = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-surface-muted active:scale-95 ${
        active ? "text-primary" : "text-ink-subtle hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Copy button: briefly shows a checkmark after writing to the clipboard. Not rendered when the content is empty. */
function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fall back to execCommand when the clipboard is unavailable (non-secure context, etc.).
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <ActionIconButton title={copied ? t("chat.copied") : t("chat.copy")} onClick={copy} active={copied}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </ActionIconButton>
  );
}

/** Action bar for AI replies: copy · thumbs-up / thumbs-down (local rating, front-end only) · regenerate (available only on the last one).
 *  Faded out by default, appearing when hovering the whole message (controlled by the outer group); stays visible once rated / when regeneration is available. */
function AssistantActions({
  content,
  rating = null,
  onRate,
  onRegenerate,
  canRegenerate,
  busy,
}: {
  content: string;
  rating?: "up" | "down" | null;
  onRate?: (rating: "up" | "down" | null) => void;
  onRegenerate?: (rating: "up" | "down" | null) => void;
  canRegenerate?: boolean;
  busy?: boolean;
}) {
  const t = useT();
  // The rating comes from the persisted StoredMessage.rating (passed in via DisplayMsg); clicking toggles it and calls back to persist, rather than using local state.
  const rate = (v: "up" | "down") => onRate?.(rating === v ? null : v);
  return (
    <div
      className={`mt-1 flex items-center gap-0.5 transition-opacity ${
        rating || canRegenerate ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`}
    >
      <CopyButton text={content} />
      <ActionIconButton title={t("chat.helpful")} onClick={() => rate("up")} active={rating === "up"}>
        <ThumbsUp className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton title={t("chat.notHelpful")} onClick={() => rate("down")} active={rating === "down"}>
        <ThumbsDown className="h-3.5 w-3.5" />
      </ActionIconButton>
      {canRegenerate && (
        <ActionIconButton
          title={
            busy
              ? t("chat.generating")
              : rating === "down"
                ? t("chat.regenerateDown")
                : rating === "up"
                  ? t("chat.regenerateUp")
                  : t("chat.regenerate")
          }
          onClick={() => { if (!busy) onRegenerate?.(rating); }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </ActionIconButton>
      )}
    </div>
  );
}

/** Single-message rendering (memo): re-renders only when this message's reference changes,
 *  avoiding recomputing all diffs / Markdown on every append once the conversation grows, which would cause stutter during generation. */
/** One metric in the per-round usage row: label as a light-colored prefix, value in the primary color. Module scope
 *  rather than inline, so it keeps its identity across renders instead of remounting on every one. */
const UsageTag = ({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "strong" | "cache";
}) => (
  <span
    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${
      tone === "cache"
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        : "bg-surface-muted text-ink-subtle"
    }`}
  >
    <span className={tone === "cache" ? "opacity-80" : "opacity-70"}>{label}</span>
    <span
      className={
        tone === "strong" ? "font-medium text-ink" : tone === "cache" ? "font-medium" : "text-ink-muted"
      }
    >
      {value}
    </span>
  </span>
);

export const MessageItem = memo(function MessageItem({
  m,
  index,
  onPick,
  onEditUser,
  onRegenerate,
  onRateMessage,
  canRegenerate,
  busy,
}: {
  m: DisplayMsg;
  index?: number;
  onPick: (id: number, value: string, discuss: boolean) => void;
  onEditUser?: (index: number, newText: string) => void;
  onRegenerate?: (index: number, rating: "up" | "down" | null) => void;
  onRateMessage?: (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => void;
  canRegenerate?: boolean;
  busy?: boolean;
}) {
  const t = useT();
  // Inline-edit state for user messages (no effect on non-user messages, but hooks must be called unconditionally, so it's placed before all branches).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (m.kind === "tool") {
    // A generated image renders as the artifact itself — a collapsed "image_generation ✓" bubble
    // would hide the one thing the user asked for.
    if (m.image) return <GeneratedImageCard src={m.image} servedBy={m.servedBy} />;
    // File-type tools (whose result includes a diff) directly show "path + changes"; other tools use a collapsible bubble.
    const isFileChange = extractDiff(m.result).diff !== null;
    return (
      <div className="flex justify-center">
        <div className="w-full max-w-[92%]">
          {isFileChange ? (
            <FileChangeCard name={m.name} args={m.args} ok={m.ok} result={m.result} />
          ) : (
            <ToolCallBubble name={m.name} args={m.args} ok={m.ok} result={m.result} />
          )}
        </div>
      </div>
    );
  }
  if (m.kind === "choice") {
    return <ChoiceCard msg={m} onPick={onPick} />;
  }
  if (m.kind === "todos") {
    return <TodoRecord todos={m.todos} />;
  }
  if (m.kind === "reasoning") {
    return <ThinkingBlock content={m.content} />;
  }
  if (m.kind === "usage") {
    const approx = m.estimated ? "≈" : "";
    // Hover shows the exact numbers (abbreviation loses precision).
    const exact =
      t("chat.usageExact", { prompt: m.prompt, completion: m.completion, total: m.total }) +
      (m.cached > 0 ? t("chat.usageCachedSuffix", { cached: m.cached }) : "");
    // Each metric becomes its own tag (see UsageTag), together looking like a row of tags.
    return (
      <div className="flex flex-wrap items-center justify-center gap-1 py-0.5" title={exact}>
        <span className="text-[10px] font-medium text-ink-subtle">{t("chat.usageThisTurn")}</span>
        <span className="text-[10px] font-medium text-ink-subtle">
          {t("chat.usageInput")}:{abbreviateNumber(m.prompt)}/{t("chat.usageOutput")}:{abbreviateNumber(m.completion)}
        </span>
        {/* <UsageTag label={t("chat.usageInput")} value={`${approx}${abbreviateNumber(m.prompt)}`} />
        <UsageTag label={t("chat.usageOutput")} value={`${approx}${abbreviateNumber(m.completion)}`} /> */}
        <UsageTag label={t("chat.usageTotal")} value={`${approx}${abbreviateNumber(m.total)}`} tone="strong" />
        {m.cached > 0 && (
          <UsageTag label={t("chat.usageCached")} value={abbreviateNumber(m.cached)} tone="cache" />
        )}
        {!!m.elapsedMs && <UsageTag label={t("chat.usageTime")} value={formatDuration(m.elapsedMs)} />}
        {m.estimated && <span className="text-[10px] text-ink-subtle/70">{t("chat.usageEstimated")}</span>}
      </div>
    );
  }
  const isUser = m.kind === "user";
  // Edit mode: replace the user bubble with an editable text box (on save, truncate from this message onward and resend → handled by the parent's onEditUser).
  // Editing is disallowed while generation is in progress (a resend would be blocked by the parent), avoiding the case where the user edits, clicks send, and gets no response.
  const canEdit = isUser && index != null && !!onEditUser && !busy;
  const startEdit = () => {
    setDraft(m.kind === "user" ? m.content : "");
    setEditing(true);
  };
  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (index != null && next && next !== (m.kind === "user" ? m.content : "")) {
      onEditUser?.(index, next);
    }
  };

  if (isUser && editing) {
    // The edit box fills a wider area on the right, making it easier to edit long messages.
    return (
      <div className="flex flex-row-reverse">
        <div className="w-full max-w-[80%] rounded-2xl rounded-tr-md border border-line-strong bg-surface p-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            className="block w-full resize-none rounded-lg bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink outline-none"
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full px-3 py-1 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
            >
              {t("chat.cancel")}
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={!draft.trim()}
              className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatars removed (neither the user's "Me" nor the assistant's "AI" is shown anymore) */}
      {/* User messages are wrapped in a bubble (a theme-adaptive light bubble); assistant messages are still shown as full-width plain text */}
      <div className={`flex min-w-0 flex-col ${isUser ? "max-w-[80%] items-end" : "w-full items-start"}`}>
        <div
          className={`min-w-0 text-sm text-ink ${
            isUser
              ? "rounded-2xl rounded-tr-md bg-surface-muted px-3.5 py-2"
              : "w-full px-1 py-0.5"
          }`}
        >
          {isUser ? (
            <div className="space-y-2">
              {m.kind === "user" && m.images && m.images.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {m.images.map((src, ii) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={ii}
                      src={src}
                      alt={t("chat.attachmentN", { n: ii + 1 })}
                      className="h-20 w-20 rounded-lg border border-line object-cover"
                    />
                  ))}
                </div>
              )}
              {m.kind === "user" && m.files && m.files.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {m.files.map((f, fi) => (
                    <span
                      key={fi}
                      title={`${f.name} · ${formatBytes(f.size)}${f.embedded ? "" : t("chat.notInlined")}`}
                      className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2 py-1 text-[11px]"
                    >
                      <span className="shrink-0">{f.embedded ? "📄" : "📦"}</span>
                      <span className="truncate">{f.name}</span>
                      <span className="shrink-0 opacity-70">{formatBytes(f.size)}</span>
                    </span>
                  ))}
                </div>
              )}
              {m.content && <span className="whitespace-pre-wrap break-words">{m.content}</span>}
            </div>
          ) : (
            <Markdown content={m.content} />
          )}
        </div>

        {/* Action bar: for user messages (copy · edit) faded out by default, appearing on hover; for AI replies (copy · rate · regenerate) see AssistantActions. */}
        {isUser ? (
          m.content ? (
            <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={m.content} />
              {canEdit && (
                <ActionIconButton title={t("chat.edit")} onClick={startEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                </ActionIconButton>
              )}
            </div>
          ) : null
        ) : (
          <AssistantActions
            content={m.content}
            rating={m.kind === "assistant" ? m.rating : null}
            onRate={
              index != null
                ? (r) => onRateMessage?.(index, m.kind === "assistant" ? m.storedIndex : undefined, r)
                : undefined
            }
            onRegenerate={index != null ? (rating) => onRegenerate?.(index, rating) : undefined}
            canRegenerate={canRegenerate}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
});
