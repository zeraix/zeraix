"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAgentChatStore } from "@/store/agentChatStore";
import { DiffView } from "./DiffView";
import { CONSENT_OPTIONS, type ConsentDecision } from "./constants";

/** A pending sensitive operation (front of the queue) — same shape as the pending state in page.tsx. */
export type PendingConsent = {
  name: string;
  args: unknown;
  diff: string | null; // File change preview (with line numbers); null means no diff (e.g. run_command)
  convId: string | null; // The conversation that issued this request (used to indicate which conversation is asking)
  queued: number; // Number of requests still queued behind this one (excluding the current one)
};

/**
 * Sensitive-operation confirmation panel: pops up when the model requests operations such as writing files, deleting, or running commands, and requires user approval.
 * Purely presentational — auto-focuses on appearance (controlled by the panelRef held by the parent), ↑/↓ to select, Enter to confirm, Esc to reject.
 */
export function ConsentPanel({
  pending,
  currentConvId,
  consentSel,
  onHover,
  onAnswer,
  onKey,
  panelRef,
}: {
  pending: PendingConsent;
  /** Current active conversation id: used to determine whether the request comes from a background conversation and to label its source. */
  currentConvId: string | null;
  consentSel: number;
  onHover: (idx: number) => void;
  onAnswer: (d: ConsentDecision) => void;
  onKey: (e: ReactKeyboardEvent) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={onKey}
      className="px-4 pt-2 outline-none"
      role="dialog"
      aria-label="Sensitive operation confirmation"
    >
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/[0.06] shadow-sm transition focus-within:ring-2 focus-within:ring-amber-500/50">
        <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
          <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-[13px]">⚠️</span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-semibold text-amber-800 dark:text-amber-200">
              AI is requesting a sensitive operation
              <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-700 dark:text-amber-300">
                {pending.name}
              </span>
              {(() => {
                const p =
                  pending.args && typeof pending.args === "object"
                    ? (pending.args as Record<string, unknown>).path
                    : undefined;
                return p ? (
                  <span className="font-mono text-xs font-normal text-amber-700/90 dark:text-amber-300/90">· {String(p)}</span>
                ) : null;
              })()}
            </p>
            {/* Owning conversation (if from a background conversation) + how many are still pending in the queue, so the user knows which conversation is asking and how many are queued */}
            {(() => {
              const title =
                pending.convId && pending.convId !== currentConvId
                  ? useAgentChatStore.getState().getConversation(pending.convId)?.title?.trim()
                  : "";
              const parts: string[] = [];
              if (title) parts.push(`From conversation "${title}"`);
              if (pending.queued > 0) parts.push(`${pending.queued} more pending`);
              return parts.length ? (
                <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                  {parts.join(" · ")}
                </p>
              ) : null;
            })()}
            {/* Show the diff if there's a change preview (with line numbers); otherwise fall back to showing the raw arguments */}
            {pending.diff ? (
              <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-amber-500/25">
                <DiffView diff={pending.diff} />
              </div>
            ) : (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-amber-500/25 bg-surface px-2.5 py-2 font-mono text-[11px] text-ink-muted">
                {(() => {
                  try {
                    return JSON.stringify(pending.args, null, 2);
                  } catch {
                    return "{}";
                  }
                })()}
              </pre>
            )}
          </div>
        </div>
        {/* Three options: the currently highlighted item moves with the up/down keys */}
        <div className="flex flex-col gap-1.5 border-t border-amber-500/20 bg-amber-500/[0.04] px-3.5 py-2.5">
          {CONSENT_OPTIONS.map((opt, idx) => {
            const active = idx === consentSel;
            return (
              <button
                key={opt.key}
                onClick={() => onAnswer(opt.key)}
                onMouseEnter={() => onHover(idx)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition ${
                  active
                    ? "border-amber-500 bg-amber-500 text-white shadow-sm shadow-amber-500/25"
                    : "border-line-strong bg-surface text-ink hover:border-amber-500/50 hover:bg-amber-500/10"
                }`}
              >
                <span className={`transition-opacity ${active ? "opacity-100" : "opacity-0"}`}>▸</span>
                {opt.label}
              </button>
            );
          })}
          <p className="mt-0.5 text-[11px] text-amber-700/70 dark:text-amber-300/70">
            ↑/↓ to select · Enter to confirm · Esc to reject
          </p>
        </div>
      </div>
    </div>
  );
}
