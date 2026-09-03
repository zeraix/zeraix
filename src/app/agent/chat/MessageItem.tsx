"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { formatBytes, abbreviateNumber, formatDuration } from "./format";
import { useT } from "@/lib/i18n";
import { useImeGuard } from "@/lib/ime";
import type { ChoiceAnswer, ChoiceMsg, DisplayMsg, Todo } from "./types";
import { CallRows } from "./ProcessStream";
import { UserImageStrip } from "./UserImageStrip";
import { openMediaViewer } from "@/store/mediaViewerStore";

/** Tool-call bubble: collapsed by default, showing only a single status line (icon + tool name + success/failure);
 *  parameters and the full result appear only when expanded, keeping the "final result" (the assistant's reply) the main focus. */
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
          {/* A button: the card already spans the transcript, and what is left to want is a closer look —
              the viewer zooms, and it has the download. */}
          <button
            type="button"
            title={t("viewer.open")}
            onClick={() => openMediaViewer([{ src, kind: "image", name: t("image.alt") }])}
            className="block w-full cursor-zoom-in select-none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- src is a vendor CDN URL or a data: URL, neither of which next/image can optimise */}
            <img
              src={src}
              alt={t("image.alt")}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              className="block h-auto w-full"
              loading="lazy"
            />
          </button>
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

/**
 * A generated video.
 *
 * `controls` and no autoplay, deliberately: a clip that starts playing on its own in the middle of a
 * transcript is startling, and it would play again every time the conversation is reopened. `preload none`
 * for the same reason a long transcript mounts only its tail — the src is a vendor URL, and fetching every
 * video in a reopened conversation would spend the user's bandwidth on clips they are scrolling past.
 */
function GeneratedVideoCard({ src, servedBy }: { src: string; servedBy?: string }) {
  const t = useT();
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[92%]">
        <div className="overflow-hidden rounded-lg border border-border bg-background/60">
          <video src={src} controls preload="none" className="block h-auto w-full">
            {t("video.unsupported")}
          </video>
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
              allDone ? "bg-success/15 text-success-ink" : "bg-surface-hover text-ink-muted"
            }`}
          >
            {done}/{todos.length}
          </span>
          {allDone && (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success-ink">
              {t("chat.allDone")}
            </span>
          )}
          <div className="ml-auto h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
            <div
              className={`h-full rounded-full ${allDone ? "bg-success" : "bg-primary"}`}
              style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }}
            />
          </div>
        </div>
        <ul className="space-y-1">
          {todos.map((td, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {td.status === "completed" ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success text-[9px] font-bold text-success-on">
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
/**
 * The ask_user card.
 *
 * One card can carry several questions, shown as tabs. Nothing is sent until the user presses submit, which
 * is the whole point of the tabbed form: with a click resolving the tool call immediately, a second question
 * could only ever be asked in a second round trip — the model asks, the user answers, the model asks again —
 * and a decision made of three related choices became three interruptions. Deferring lets the user answer in
 * any order, go back and change their mind, and hand the whole thing over once.
 *
 * A question answered with "Discuss this" is still an answer for submission purposes; it just tells the model
 * to open the topic up rather than treat the matter as settled.
 */
function ChoiceCard({
  msg,
  onSubmit,
}: {
  msg: ChoiceMsg;
  onSubmit: (id: number, answers: ChoiceAnswer[]) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState(0);
  // Draft answers live here, not in the message, so revising a choice does not rewrite the transcript on
  // every click. They are lifted into the message only on submit.
  const [draft, setDraft] = useState<(ChoiceAnswer | null)[]>(() => msg.questions.map(() => null));
  // Typed answers are kept per question so switching tabs does not lose what someone half-wrote.
  const [typed, setTyped] = useState<string[]>(() => msg.questions.map(() => ""));

  const multi = msg.questions.length > 1;
  const answers = msg.submitted ? msg.answers : draft;
  const current = msg.questions[Math.min(tab, msg.questions.length - 1)];
  const chosen = answers[tab] ?? null;
  const answeredCount = answers.filter(Boolean).length;
  const complete = answeredCount === msg.questions.length;
  const discussLabel = t("chat.discuss");

  const isMulti = Boolean(current.multiSelect);
  // Card-level rather than per-question: on a card mixing single- and multi-select tabs, a submit
  // affordance that jumped between the option list and the footer as the user changed tabs would be
  // worse than either placement on its own.
  const anyMulti = msg.questions.some((q) => q.multiSelect);
  /**
   * The offered options ticked in an answer, filtered to what the question actually offered so the typed
   * extra — which lives in `typed` and is appended on compose — cannot be mistaken for a ticked option.
   *
   * Takes the answer rather than reading `chosen`, so the updaters below can derive it from their own
   * previous state: two ticks landing in one React batch would otherwise both read the same render-time
   * selection, and the second would silently drop the first.
   */
  const tickedIn = (a: ChoiceAnswer | null) =>
    a && !a.discuss ? (a.values ?? []).filter((v) => current.options.includes(v)) : [];
  const ticked = isMulti ? tickedIn(chosen) : [];
  // Drives the free-text box's active ring. On a multi-select question `custom` is only set when nothing
  // is ticked, so the flag alone would leave the box looking inert next to a tick plus typed text.
  const textActive = isMulti ? Boolean((typed[tab] ?? "").trim()) : Boolean(chosen?.custom);

  /**
   * Build a multi-select answer from its ticked options plus whatever is typed. Both feed one answer: here
   * the free-text box ADDS an item rather than replacing the selection, because "those two, and also this"
   * is precisely what a multi-select question is for. Nothing ticked and nothing typed is not an answer.
   */
  const composeMulti = (opts: string[], text: string): ChoiceAnswer | null => {
    const extra = text.trim();
    const values = extra ? [...opts, extra] : opts;
    if (values.length === 0) return null;
    return { value: values.join(", "), discuss: false, values, custom: opts.length === 0 };
  };

  const pick = (value: string, discuss: boolean) => {
    if (msg.submitted) return;
    // Choosing an offered option abandons anything typed for this question — two answers to one question
    // is not a state the card should be able to reach.
    setTyped((v) => v.map((x, i) => (i === tab ? "" : x)));
    setDraft((d) => d.map((a, i) => (i === tab ? { value, discuss } : a)));
    // Advance to the next still-unanswered question, so answering several in a row needs no tab clicks.
    // Stays put once everything else is answered — at that point the user is revising, and moving them
    // away from the choice they just changed would fight them.
    const next = msg.questions.findIndex((_, i) => i !== tab && !draft[i]);
    if (multi && next !== -1) setTab(next);
  };

  /** Multi-select: tick or untick one option, preserving the offered order and any typed text. */
  const toggle = (opt: string) => {
    if (msg.submitted) return;
    setDraft((d) =>
      d.map((a, i) => {
        if (i !== tab) return a;
        const prev = tickedIn(a);
        // Re-filtered through the offered order rather than appended, so the answer reads in the order the
        // question asked it, not the order the user happened to click.
        const next = prev.includes(opt)
          ? prev.filter((v) => v !== opt)
          : current.options.filter((o) => o === opt || prev.includes(o));
        return composeMulti(next, typed[tab] ?? "");
      }),
    );
    // Deliberately no auto-advance, unlike pick: on a multi-select question the first tick is rarely the
    // last one, so moving to another tab would interrupt the answer halfway through.
  };

  /** Typing is answering: the text becomes this question's answer, and clearing it un-answers the question. */
  const type = (text: string) => {
    if (msg.submitted) return;
    setTyped((v) => v.map((x, i) => (i === tab ? text : x)));
    setDraft((d) =>
      d.map((a, i) => {
        if (i !== tab) return a;
        // Same reason as toggle: derived from the updater's previous answer, never the render-time value.
        if (isMulti) return composeMulti(tickedIn(a), text);
        return text.trim() ? { value: text.trim(), discuss: false, custom: true } : null;
      }),
    );
    // Deliberately no auto-advance here: moving the tab out from under someone mid-sentence is worse than
    // making them click.
  };

  return (
    <div className="flex">
      <div className="w-full min-w-0 px-1 py-0.5">
        {/* Wider with tabs than without: four tab labels do not fit a single-question card, and the
            overflow has nowhere to go inside a bubble. */}
        <div className={`rounded-2xl border border-line bg-surface/60 p-3 ${multi ? "max-w-xl" : "max-w-md"}`}>
          {/* Tabs, only when there is more than one question — a single question needs no chrome. */}
          {multi && (
            <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-line pb-2">
              {msg.questions.map((q, i) => {
                const active = i === tab;
                const done = Boolean(answers[i]);
                return (
                  <button
                    key={i}
                    onClick={() => setTab(i)}
                    title={q.question}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition ${
                      active ? "bg-surface text-ink shadow-sm" : "text-ink-subtle hover:bg-surface-hover hover:text-ink-muted"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                        done ? "bg-primary text-primary-foreground" : active ? "bg-surface-muted text-ink-muted" : "bg-surface-muted text-ink-subtle"
                      }`}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    <span className="max-w-[8rem] truncate">{q.question}</span>
                  </button>
                );
              })}
            </div>
          )}

          {current.question && (
            <p className="mb-2.5 text-sm font-medium leading-relaxed text-ink">{current.question}</p>
          )}

          <div className="flex flex-col gap-2">
            {current.options.map((opt, idx) => {
              const isChosen = isMulti
                ? ticked.includes(opt)
                : chosen !== null && !chosen.discuss && chosen.value === opt;
              return (
                <button
                  key={idx}
                  disabled={msg.submitted}
                  onClick={() => (isMulti ? toggle(opt) : pick(opt, false))}
                  className={`group flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-all disabled:cursor-default ${
                    isChosen
                      ? "border-primary bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/25"
                      : msg.submitted
                        ? "border-line bg-surface-muted text-ink-subtle"
                        : "border-line bg-surface text-ink hover:-translate-y-px hover:border-primary hover:bg-primary/[0.06] hover:shadow-sm"
                  }`}
                >
                  {/* Square for multi-select, circle for single: the shape is the only thing telling the
                      user whether a second click adds to the answer or replaces it. */}
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center text-[11px] font-semibold transition-colors ${
                      isMulti ? "rounded-md" : "rounded-full"
                    } ${
                      isChosen
                        ? "bg-white/25 text-white"
                        : msg.submitted
                          ? "bg-surface text-ink-subtle"
                          : "bg-surface-muted text-ink-muted group-hover:bg-primary/15 group-hover:text-primary"
                    }`}
                  >
                    {isChosen ? "✓" : String.fromCharCode(65 + idx)}
                  </span>
                  <span className="min-w-0 flex-1">{opt}</span>
                </button>
              );
            })}

            {/* Free text. The offered options are the model's guesses at what the user wants; a card that
                only accepts them turns "pick one of my ideas" into the only possible answer, and options
                like "my first name (type it)" become unanswerable. */}
            <input
              type="text"
              value={typed[tab] ?? ""}
              disabled={msg.submitted}
              onChange={(e) => type(e.target.value)}
              placeholder={t("chat.choice.customPlaceholder")}
              className={`w-full rounded-xl border px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-subtle disabled:cursor-default ${
                textActive
                  ? "border-primary bg-primary/[0.06] text-ink ring-2 ring-primary/25"
                  : msg.submitted
                    ? "border-line bg-surface-muted text-ink-subtle"
                    : "border-line bg-surface text-ink hover:border-primary/50 focus:border-primary"
              }`}
            />

            {/* Auto-appended: discuss this question rather than settle it. */}
            <button
              disabled={msg.submitted}
              onClick={() => pick(discussLabel, true)}
              className={`flex items-center gap-2 rounded-xl border border-dashed px-3.5 py-2.5 text-left text-sm transition-all disabled:cursor-default ${
                chosen?.discuss
                  ? "border-primary bg-primary font-medium text-primary-foreground"
                  : msg.submitted
                    ? "border-line bg-surface-muted text-ink-subtle"
                    : "border-line-strong bg-surface/60 text-ink-muted hover:border-line-strong hover:bg-surface-muted hover:text-ink"
              }`}
            >
              <span className="shrink-0 text-[13px]">💬</span>
              <span className="min-w-0 flex-1">{discussLabel}</span>
            </button>

            {/* Submit, as the last item of the list rather than a footer button. On a single-select card a
                click already says which option you mean and the footer button only confirms it; once a
                question takes several options, clicking one no longer means "done", so the way to finish
                has to sit among the things being clicked — otherwise the last tick looks like the end of
                the interaction and the card just waits. */}
            {!msg.submitted && anyMulti && (
              <>
                <div className="my-0.5 border-t border-line" />
                <button
                  disabled={!complete}
                  onClick={() => onSubmit(msg.id, draft as ChoiceAnswer[])}
                  className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition-all ${
                    complete
                      ? "border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:-translate-y-px hover:brightness-110"
                      : "cursor-not-allowed border-line bg-surface-muted text-ink-subtle"
                  }`}
                >
                  <span className="shrink-0 text-[13px]">➤</span>
                  <span className="min-w-0 flex-1">{t("chat.choice.submit")}</span>
                  {/* The running count is the feedback a checkbox list otherwise lacks: with no single
                      highlighted row to look at, this is how the user sees the answer taking shape. */}
                  <span className={`shrink-0 text-[11px] font-normal ${complete ? "text-white/75" : "text-ink-subtle"}`}>
                    {isMulti
                      ? t("chat.choice.selected", { count: String(chosen?.values?.length ?? 0) })
                      : t("chat.choice.progress", {
                          answered: String(answeredCount),
                          total: String(msg.questions.length),
                        })}
                  </span>
                </button>
              </>
            )}
          </div>

          {/* Submit. Present even for a single question, so the interaction is the same shape either way and
              a misclick is always recoverable before anything reaches the model. The button itself moves
              into the option list on a multi-select card; the hint below stays put in both layouts. */}
          {!msg.submitted && (
            <div className="mt-3 flex items-center gap-2">
              {!anyMulti && (
                <button
                  disabled={!complete}
                  onClick={() => onSubmit(msg.id, draft as ChoiceAnswer[])}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle disabled:shadow-none"
                >
                  {t("chat.choice.submit")}
                </button>
              )}
              <span className="text-[11px] text-ink-subtle">
                {complete
                  ? t("chat.choice.readyHint")
                  : t("chat.choice.progress", {
                      answered: String(answeredCount),
                      total: String(msg.questions.length),
                    })}
              </span>
            </div>
          )}

          {msg.submitted && (
            <div className="mt-2.5 flex flex-col gap-1">
              {msg.questions.map((q, i) => {
                const a = msg.answers[i];
                return (
                  <p key={i} className="flex items-start gap-1 text-xs text-ink-subtle">
                    <span className="text-primary">✓</span>
                    {multi ? <span className="truncate text-ink-subtle">{q.question}</span> : null}
                    <span className="font-medium text-ink-muted">{a?.value ?? "—"}</span>
                  </p>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Deep-reasoning entry: the reasoning_content returned by reasoning models (e.g. qwen3), collapsed by default with a first-line preview when collapsed.
 *  No outer avatar placeholder — the caller (ThinkingBlock) supplies the avatar-alignment gutter. */
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

/** Deep-reasoning block (shown standalone, with an avatar-alignment placeholder): distinct from the tool-trace "thinking process".
 *  Most deep reasoning is narrated by the process stream (see ProcessStream); this is the fallback branch for a
 *  reasoning message that stands on its own. */
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
        ? "bg-success/15 text-success-ink"
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

/**
 * How tall a user message may be before it is folded, in pixels.
 *
 * A pasted log, a stack trace or a spec runs to thousands of pixels and pushes the conversation it belongs to
 * off the screen — the reply the user is waiting for ends up below the message that asked for it. 350px is
 * roughly twenty lines: enough to recognise what was sent without having to scroll past it every time.
 */
const USER_TEXT_MAX_HEIGHT = 350;

/**
 * A user message, folded when it is long.
 *
 * Measured rather than guessed from the character count: what matters is rendered height, and that depends on
 * wrapping, on the bubble's width and on the font — a 2000-character paragraph and a 2000-character column of
 * short lines are wildly different heights. So the toggle appears only when the text ACTUALLY overflows, and a
 * long-but-not-that-long message keeps its plain appearance with no control attached to it.
 */
function UserText({ text }: { text: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The measurement lives entirely in the observer callback, never in the effect body. ResizeObserver fires
    // once on observe, so this still measures immediately — and setting state from a callback is what the
    // `set-state-in-effect` rule asks for, rather than a synchronous set that cascades a second render.
    //
    // `scrollHeight` is the full content height even while `max-height` clamps the box, which is the whole
    // reason it can answer "is there more than we are showing".
    const ro = new ResizeObserver(() => {
      setOverflows(el.scrollHeight > USER_TEXT_MAX_HEIGHT + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const folded = overflows && !expanded;
  return (
    <div className="min-w-0">
      <div className="relative">
        <div
          ref={ref}
          className="whitespace-pre-wrap break-words"
          style={folded ? { maxHeight: USER_TEXT_MAX_HEIGHT, overflow: "hidden" } : undefined}
        >
          {text}
        </div>
        {/* A fade rather than a hard cut, so it reads as "continues below" instead of as a message that ends
            mid-sentence. Tinted to the bubble's own background; pointer-events-none keeps the text under it
            selectable right to the edge. */}
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-muted to-transparent" />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1 text-[11px] font-medium text-ink-subtle underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          {expanded ? t("chat.collapse") : t("chat.expandMessage")}
        </button>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  m,
  index,
  onSubmitChoice,
  onEditUser,
  onRegenerate,
  onRateMessage,
  canRegenerate,
  busy,
}: {
  m: DisplayMsg;
  index?: number;
  /**
   * Optional for the same reason `index` is: a read-only transcript (the Sub-agent Inspector's run view)
   * has nothing to submit an answer to. A sub-agent has no path to a choice card in the first place, so the
   * branch below is unreachable there — but a required callback would have to be faked to satisfy the type,
   * and a fake one is how a card that silently swallows its answer gets shipped.
   */
  onSubmitChoice?: (id: number, answers: ChoiceAnswer[]) => void;
  onEditUser?: (index: number, newText: string) => void;
  onRegenerate?: (index: number, rating: "up" | "down" | null) => void;
  onRateMessage?: (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => void;
  canRegenerate?: boolean;
  busy?: boolean;
}) {
  const t = useT();
  const ime = useImeGuard();
  // Inline-edit state for user messages (no effect on non-user messages, but hooks must be called unconditionally, so it's placed before all branches).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (m.kind === "tool") {
    // A generated image renders as the artifact itself — a collapsed "image_generation ✓" bubble
    // would hide the one thing the user asked for.
    if (m.image) return <GeneratedImageCard src={m.image} servedBy={m.servedBy} />;
    if (m.video) return <GeneratedVideoCard src={m.video} servedBy={m.servedBy} />;
    // Anything else: a tool message only reaches here if it escaped the process stream, which `inProcess`
    // (transcriptRows) currently lets happen for generated artifacts alone. Rendered as the same row the stream would
    // have drawn, so a tool that starts escaping for some new reason still shows up instead of silently vanishing.
    return <CallRows calls={[m]} />;
  }
  if (m.kind === "choice") {
    // Rendered read-only when there is nobody to answer to, rather than with a submit that does nothing.
    return onSubmitChoice ? <ChoiceCard msg={m} onSubmit={onSubmitChoice} /> : null;
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
          {/* The images already attached to this message stay attached when the edit is saved (the parent
              re-sends them, see resendRef), so show them here as read-only thumbnails to make that clear. */}
          {m.kind === "user" && m.images && m.images.length > 0 && (
            <UserImageStrip images={m.images} size="sm" className="mb-1.5" />
          )}
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            {...ime.bind}
            onKeyDown={(e) => {
              // Enter committing an IME composition must not save the edit — see lib/ime.ts. Escape is
              // guarded by the same return: it cancels an IME candidate list before it cancels the edit.
              if (ime.isImeKey(e)) return;
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
              className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105 disabled:opacity-50"
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
                <UserImageStrip images={m.images} />
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
              {m.content && <UserText text={m.content} />}
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
