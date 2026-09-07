"use client";

/**
 * The user's side of an interrupted turn (docs/agent-runtime-crash-recovery.md C2 / C10).
 *
 * Shown above the composer when a conversation is opened with a leftover turn checkpoint — the previous reply was
 * cut short by a crash or a forced exit. It states the same facts the model is told on the next send (turnState.ts
 * describeInterruptedTurn) and nothing more: which round, which tools were running, whether they could have changed
 * anything, and what was queued and never sent. It never offers to resume; that is the user's next message.
 */
import { memo } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useT } from "@/lib/i18n";

export interface RecoveryNotice {
  convId: string;
  round: number;
  tools: string[];
  mutating: boolean;
  delegations: number;
  queued: number;
}

function RecoveryBannerInner({ notice, onDismiss }: { notice: RecoveryNotice; onDismiss: () => void }) {
  const t = useT();
  const body = notice.tools.length
    ? t(notice.mutating ? "chat.recovery.bodyMutating" : "chat.recovery.bodyReadOnly", {
        round: String(notice.round),
        tools: notice.tools.join(", "),
      })
    : t("chat.recovery.bodyIdle", { round: String(notice.round) });
  return (
    <div className="px-4 pt-2">
      <div
        role="status"
        className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12.5px] text-ink"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("chat.recovery.title")}</p>
          <p className="text-ink-muted">{body}</p>
          {(notice.delegations > 0 || notice.queued > 0) && (
            <p className="text-ink-muted">
              {notice.delegations > 0 && t("chat.recovery.delegations", { count: String(notice.delegations) })}
              {notice.delegations > 0 && notice.queued > 0 ? " " : ""}
              {notice.queued > 0 && t("chat.recovery.queued", { count: String(notice.queued) })}
            </p>
          )}
          <p className="text-ink-subtle">{t("chat.recovery.next")}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.recovery.dismiss")}
          title={t("chat.recovery.dismiss")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

export const RecoveryBanner = memo(RecoveryBannerInner);
