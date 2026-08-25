/**
 * The transcript — everything between the header and the composer.
 *
 * Presentational, and deliberately so: it renders the message window and nothing else decides anything
 * here. What it owns is one real piece of logic, `groupTranscript`, and that is why it is worth being a
 * module rather than another 100 lines of JSX inside the page.
 *
 * The grouping is the part that is easy to get wrong. A turn's reasoning, its phase summaries and its tool
 * calls are a trace, not a conversation: shown one bubble at a time they bury the answer the user asked for
 * under twenty steps of machinery. So consecutive trace entries collapse into a single "thinking process"
 * card, while everything the user actually talks to — their own turns, the reply, the usage line, the todo
 * list, a choice card — renders on its own. One exception, and it is load-bearing: a tool call carrying a
 * generated image is the deliverable, not a step, so it stays out of the card where nobody would find it.
 *
 * Indices stay ABSOLUTE into `display` even though only a window is mounted. Edit, regenerate and rating
 * all resolve against that index, and so do the React keys — renumbering per window would silently retarget
 * them at whatever happened to be in that slot.
 */
import React from "react";
import { MessageItem, ProcessGroup } from "./MessageItem";
import { TranscriptSkeleton } from "./TranscriptSkeleton";
import type { ChoiceAnswer, DisplayMsg } from "./types";
import { groupTranscript, lastAssistantIndex } from "./transcriptRows";

export interface ChatTranscriptProps {
  /** Mid-switch: the skeleton stands in, so the previous conversation is never left on screen. */
  switching: boolean;
  display: DisplayMsg[];
  /** Start of the mounted window. Everything before it exists but is not rendered. */
  visibleStart: number;
  hasEarlier: boolean;
  /** Attached to the "load earlier" row; scrolling it into view pulls in the next batch. */
  earlierSentinelRef: React.RefObject<HTMLDivElement | null>;
  loadEarlier: () => void;
  /** A turn is in flight: drives the thinking dots and the auto-expanded trailing card. */
  loading: boolean;
  /** What the turn is currently doing, shown beside the dots. */
  status: string;
  error: string | null;
  toolsReady: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
  onSubmitChoice: (id: number, answers: ChoiceAnswer[]) => void;
  onEditUser: (displayIndex: number, newText: string) => void;
  onRegenerate: (assistantIndex: number, rating?: "up" | "down" | null) => void;
  /** The stored index is how a rating survives a reload; MessageItem supplies it from the message. */
  onRateMessage: (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => void;
}

export function ChatTranscript({
  switching,
  display,
  visibleStart,
  hasEarlier,
  earlierSentinelRef,
  loadEarlier,
  loading,
  status,
  error,
  toolsReady,
  t,
  onSubmitChoice,
  onEditUser,
  onRegenerate,
  onRateMessage,
}: ChatTranscriptProps) {
  const lastAssistant = lastAssistantIndex(display);
  return (
    <>
      {/* Switching conversations: a skeleton stands in for the message area, so the previous conversation's
          messages are not left on screen (or the "start a conversation" placeholder flashed) mid-swap. */}
      {switching && <TranscriptSkeleton label={t("chat.loadingConversation")} />}

      {!switching && display.length === 0 && (
        <div className="mt-16 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-lg font-bold text-white shadow-lg shadow-primary/25">
            AI
          </div>
          <p className="text-sm font-medium text-ink-muted">{t("chat.emptyTitle")}</p>
          <p className="mt-1 text-xs text-ink-subtle">
            {t("chat.emptyHint")}
            {toolsReady ? t("chat.emptyHintTools") : ""}
          </p>
        </div>
      )}

      {/* Earlier turns exist but are not mounted: the sentinel pulls in the next batch as it scrolls into view,
          and the button does the same for a transcript too short to scroll (or with the observer unavailable). */}
      {!switching && hasEarlier && (
        <div ref={earlierSentinelRef} className="flex justify-center py-1">
          <button
            type="button"
            onClick={loadEarlier}
            className="rounded-full border border-line/60 px-3 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
          >
            {t("chat.loadEarlier")}
          </button>
        </div>
      )}

      {!switching &&
        groupTranscript(display, visibleStart).map((row) =>
          row.kind === "group" ? (
            <ProcessGroup
              key={`pg-${row.start}`}
              items={row.items}
              // At the tail of a running turn the card is "in progress", so it stays open. `turnActive`
              // separates "this group is no longer last" from "the turn ended" — only the second should
              // auto-collapse it. See ProcessGroup.
              live={loading && row.trailing}
              turnActive={loading}
            />
          ) : (
            <MessageItem
              key={row.index}
              index={row.index}
              m={display[row.index]}
              onSubmitChoice={onSubmitChoice}
              onEditUser={onEditUser}
              onRegenerate={onRegenerate}
              onRateMessage={onRateMessage}
              // Regenerating discards everything after the reply, so only the last one offers it.
              canRegenerate={!loading && row.index === lastAssistant}
              busy={loading}
            />
          ),
        )}

      {/* The skeleton already reads as "loading"; the outgoing conversation's thinking dots would double up on it. */}
      {!switching && loading && !display.some((m) => m.kind === "choice" && !m.submitted) && (
        <div className="flex items-center gap-2 px-1 py-0.5">
          <span className="flex shrink-0 items-center gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
          </span>
          <span className="text-sm text-ink-muted">{status || t("chat.thinking")}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </>
  );
}
