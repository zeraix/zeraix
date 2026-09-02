"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "framer-motion";
import { useT } from "@/lib/i18n";
import { useAgentChatStore } from "@/store/agentChatStore";
import { DiffView } from "./DiffView";
import { CONSENT_OPTIONS, type ConsentDecision } from "./constants";

/** Who asked for the operation, when it was not the agent the user is talking to. */
export type ConsentRequester = {
  /** `anon-<uuid>` — a sub-agent has no identity beyond its grant. */
  agentId: string;
  /** The subtask it was spawned for. Shown truncated; it is what makes the request legible. */
  task: string;
};

/** A pending sensitive operation (front of the queue) — same shape as the pending state in page.tsx. */
export type PendingConsent = {
  name: string;
  args: unknown;
  diff: string | null; // File change preview (with line numbers); null means no diff (e.g. run_command)
  warning?: string | null; // Provenance warning (§A1): the target's state is only known from compressed history
  convId: string | null; // The conversation that issued this request (used to indicate which conversation is asking)
  queued: number; // Number of requests still queued behind this one (excluding the current one)
  /**
   * Set when a sub-agent is asking rather than the main agent.
   *
   * Worth surfacing prominently: the user did not ask for this call, an autonomous delegation did, and
   * "which of my agents wants to run this" is the first question anyone confronted with the panel has.
   */
  requester?: ConsentRequester | null;
};

/** The single argument most worth showing in the header line, if there is one. */
function primaryArg(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  for (const key of ["path", "destination", "command", "url"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Sensitive-operation confirmation panel: shown when an agent requests a write, a delete, a command, or
 * anything else in SENSITIVE_TOOLS, and blocks that call until the user answers.
 *
 * ## Why it covers the composer
 *
 * The parent positions this as an overlay across the bottom of the chat column, deliberately hiding the
 * input box and the context-usage bar while it is up. Those two are what a user reaches for on reflex, and a
 * blocked tool call is not a moment for reflexes: something is waiting on an answer, and leaving somewhere
 * else to type invites the panel to be scrolled past and left sitting. Taking the input away for the second
 * it takes to answer is the honest representation of the state the app is actually in.
 *
 * Purely presentational. Auto-focused on appearance via the ref the parent holds; ↑/↓ move the selection,
 * Enter confirms, Esc rejects.
 *
 * The styling is deliberately quiet. An earlier version tinted the whole card amber, which made the one
 * genuinely alarming case — an autonomous sub-agent asking to run a command — look exactly like the routine
 * case of the main agent saving a file the user just asked it to save. Colour is spent on the single dot and
 * on the warning row, so that when something *is* unusual it still has somewhere to escalate to.
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
  const t = useT();
  const arg = primaryArg(pending.args);
  const fromTitle =
    pending.convId && pending.convId !== currentConvId
      ? useAgentChatStore.getState().getConversation(pending.convId)?.title?.trim()
      : "";

  return (
    <motion.div
      ref={panelRef}
      tabIndex={0}
      onKeyDown={onKey}
      className="border-t border-line bg-surface/95 px-4 pb-4 pt-3 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] outline-none backdrop-blur-md"
      role="dialog"
      aria-label={t("chat.consent.aria")}
      // Rises from where the composer was rather than fading in place: the movement is what says "this
      // replaced the input box", which a cross-fade would leave the user to work out.
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 16, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-line-strong bg-surface shadow-sm transition focus-within:ring-2 focus-within:ring-brand/40">
        <div className="px-4 pt-3.5 pb-3">
          {/* Header: the one spot of colour, and the queue depth pushed to the far side. */}
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
            <span className="text-[13px] font-semibold text-ink">{t("chat.consent.title")}</span>
            {pending.queued > 0 ? (
              <span className="ml-auto rounded-md bg-surface-muted px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle">
                {t("chat.consent.queued", { count: String(pending.queued) })}
              </span>
            ) : null}
          </div>

          {/* What is being asked for. The tool name carries the weight; the argument sits beside it. */}
          <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-medium text-ink">{pending.name}</span>
            {arg ? (
              <span className="truncate font-mono text-xs text-ink-muted">{arg}</span>
            ) : null}
          </p>

          {/* Attribution. A sub-agent request leads with the agent, because the user did not ask for it. */}
          {pending.requester || fromTitle ? (
            <p className="mt-1 truncate text-[11px] text-ink-subtle">
              {pending.requester ? (
                <>
                  <span className="font-mono">{pending.requester.agentId}</span>
                  <span> · {t("chat.consent.subAgent")}</span>
                  {pending.requester.task ? <span> · “{pending.requester.task}”</span> : null}
                </>
              ) : null}
              {pending.requester && fromTitle ? <span> · </span> : null}
              {fromTitle ? <span>{t("chat.consent.from", { title: fromTitle })}</span> : null}
            </p>
          ) : null}

          {/* Provenance warning (§A1): this operation relies on file state known only from compressed history. */}
          {pending.warning ? (
            <p className="mt-2.5 rounded-lg border border-warning/30 bg-warning/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-warning-ink">
              {pending.warning}
            </p>
          ) : null}

          {/* The change itself: a diff where we could build one, the raw arguments otherwise. */}
          {pending.diff ? (
            <div className="mt-2.5 max-h-56 overflow-auto rounded-lg border border-line">
              <DiffView diff={pending.diff} />
            </div>
          ) : (
            <pre className="mt-2.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-muted px-2.5 py-2 font-mono text-[11px] text-ink-muted">
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

        {/*
          Actions, right-aligned with the affirmative last. Rendered in reverse of CONSENT_OPTIONS so the
          destructive choice sits furthest from the primary one, while the index passed back still refers to
          the canonical order the keyboard navigation counts in.
        */}
        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-muted/60 px-4 py-2.5"
          title={t("chat.consent.hint")}
        >
          {CONSENT_OPTIONS.map((opt, idx) => ({ opt, idx }))
            .reverse()
            .map(({ opt, idx }) => {
              const active = idx === consentSel;
              const primary = opt.key === "yes";
              return (
                <button
                  key={opt.key}
                  onClick={() => onAnswer(opt.key)}
                  onMouseEnter={() => onHover(idx)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    primary
                      ? "bg-brand text-accent-on shadow-sm hover:brightness-110"
                      : "text-ink-muted hover:bg-surface-hover hover:text-ink"
                  } ${active ? "ring-2 ring-brand/50 ring-offset-1 ring-offset-surface" : ""}`}
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
        </div>
      </div>
    </motion.div>
  );
}
