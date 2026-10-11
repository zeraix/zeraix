"use client";

import type { QueuedView } from "../hooks/usePerConvState";

/**
 * Queued messages: messages the user sends again while generating are listed here and auto-sent in order after
 * this round ends. Can be removed one by one. Renders nothing while the queue is empty.
 */
export function QueuedMessages({
  queued,
  onRemove,
  t,
}: {
  queued: QueuedView[];
  onRemove: (id: number) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  if (queued.length === 0) return null;
  return (
    <div className="px-4 pt-2">
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface-muted/40 px-3 py-2">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-subtle">
          <span className="font-medium text-ink-muted">{t("chat.queued")}</span>
          <span className="rounded-full bg-surface-hover px-1.5 py-px tabular-nums">{queued.length}</span>
          <span>{t("chat.queuedHint")}</span>
        </div>
        <div className="flex flex-col gap-1">
          {queued.map((m, idx) => (
            <div key={m.id} className="flex items-center gap-2 text-xs text-ink">
              <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-ink-subtle">{idx + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                {m.text || (m.hasAttachments ? t("chat.attachmentLabel") : "")}
              </span>
              <button
                type="button"
                onClick={() => onRemove(m.id)}
                title={t("chat.remove")}
                className="shrink-0 rounded px-1 text-ink-subtle transition hover:text-destructive"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
