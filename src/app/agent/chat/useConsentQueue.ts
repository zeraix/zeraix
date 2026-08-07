/**
 * Sensitive-operation confirmation queue, extracted from page.tsx (self-contained: no component state
 * flows in). When the model requests a sensitive tool (write/delete/run_command, …) the runtime awaits a
 * user decision here. Multiple conversations (including background ones) can request at once, so requests
 * FIFO-queue and pop one at a time — never overwriting each other or deadlocking — and each queued
 * conversation is badged in the sidebar via the store.
 *
 * Returns everything page.tsx needs: the front-of-queue `pending` (for the panel), keyboard nav, the
 * request/answer/drop operations, and `allowedToolsRef` (the per-conversation "don't ask again" set the
 * tool-execution path checks).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { notifyPermissionRequest } from "@/lib/ai/agentNotify";
import { useAgentChatStore } from "@/store/agentChatStore";
import { CONSENT_OPTIONS, type ConsentDecision } from "./constants";
import type { ConsentRequester, PendingConsent } from "./ConsentPanel";

/** A queued request = the panel's display info plus the promise resolver that unblocks the waiting tool call. */
type ConsentQueueItem = {
  convId: string | null;
  name: string;
  args: unknown;
  diff: string | null;
  warning: string | null;
  /** Set when a sub-agent is asking rather than the main agent — see ConsentPanel. */
  requester: ConsentRequester | null;
  resolve: (d: ConsentDecision) => void;
};

export function useConsentQueue() {
  // pending = the display info of the front-of-queue request; consentQueueRef holds the full FIFO queue.
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const [consentSel, setConsentSel] = useState(0); // highlighted option (up/down key navigation)
  const consentQueueRef = useRef<ConsentQueueItem[]>([]);
  const consentPanelRef = useRef<HTMLDivElement>(null); // auto-focus when the panel appears
  // The set of tools allowed via "don't ask again" within this conversation (checked by the tool path).
  const allowedToolsRef = useRef<Set<string>>(new Set());

  // Push the set of conversations that currently have a pending confirmation into the store, so the sidebar
  // can badge them — this is how a request made in a background conversation stays discoverable.
  const syncConsentBadges = () => {
    const ids = new Set<string>();
    for (const r of consentQueueRef.current) if (r.convId) ids.add(r.convId);
    useAgentChatStore.getState().setPendingConsentIds(ids);
  };

  // Sync the front of the confirmation queue to `pending` (for rendering); collapse the panel if empty.
  const showFrontConsent = () => {
    const front = consentQueueRef.current[0];
    if (front) {
      setPending({
        name: front.name,
        args: front.args,
        diff: front.diff,
        warning: front.warning,
        requester: front.requester,
        convId: front.convId,
        queued: consentQueueRef.current.length - 1,
      });
      setConsentSel(0);
    } else {
      setPending(null);
    }
  };

  // Pop the confirmation panel and wait for the user's decision; the first option (Yes) is highlighted by
  // default. convId owns the request so concurrent conversations queue rather than overwrite each other.
  const requestConsent = (
    convId: string | null,
    name: string,
    args: unknown,
    diff: string | null,
    warning: string | null = null,
    requester: ConsentRequester | null = null,
  ) =>
    new Promise<ConsentDecision>((resolve) => {
      const wasEmpty = consentQueueRef.current.length === 0;
      consentQueueRef.current.push({ convId, name, args, diff, warning, requester, resolve });
      syncConsentBadges();
      if (wasEmpty) showFrontConsent(); // queue was empty → show immediately; otherwise wait behind the others
      else setPending((p) => (p ? { ...p, queued: consentQueueRef.current.length - 1 } : p)); // just refresh "N more pending"
      // Permission notification — the AI requests a sensitive operation and awaits authorization (pops when unfocused).
      notifyPermissionRequest(convId, name);
    });

  // The user decides on the front of the queue (click or Enter): resolve its promise, dequeue, show the next.
  const answerConsent = (d: ConsentDecision) => {
    const req = consentQueueRef.current.shift();
    req?.resolve(d);
    // "don't ask again" allows this tool conversation-wide (allowedToolsRef) and clears the queue's remaining
    // requests for the same tool with "allow", to avoid re-prompting right after authorizing it.
    // "don't ask again" clears queued requests for the same tool so the user is not re-prompted straight
    // after authorising it — but only ones from the same requester. A yes given to the main agent must not
    // silently authorise an autonomous sub-agent's queued call for the same tool: the user answered a
    // question about work they asked for, not about work a delegation decided to do.
    if (d === "always" && req) {
      consentQueueRef.current = consentQueueRef.current.filter((r) => {
        if (r.name === req.name && r.requester?.agentId === req.requester?.agentId) {
          r.resolve("yes");
          return false;
        }
        return true;
      });
    }
    syncConsentBadges();
    showFrontConsent();
  };

  // Discard all pending-confirmation requests of a conversation (ending them with "reject"). Used on cancel / clear.
  const dropConsentsFor = (convId: string | null) => {
    let changed = false;
    consentQueueRef.current = consentQueueRef.current.filter((r) => {
      if (r.convId === convId) {
        r.resolve("no");
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) {
      syncConsentBadges();
      showFrontConsent();
    }
  };

  // Auto-focus when the panel appears, so up/down keys and Enter take effect directly.
  useEffect(() => {
    if (pending) consentPanelRef.current?.focus();
  }, [pending]);

  // Keyboard navigation: ↑/↓ cycle options, Enter confirms, Esc is treated as reject.
  const onConsentKey = (e: ReactKeyboardEvent) => {
    const n = CONSENT_OPTIONS.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setConsentSel((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setConsentSel((i) => (i - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      answerConsent(CONSENT_OPTIONS[consentSel].key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      answerConsent("no");
    }
  };

  return {
    pending,
    consentSel,
    setConsentSel,
    consentPanelRef,
    allowedToolsRef,
    requestConsent,
    answerConsent,
    dropConsentsFor,
    onConsentKey,
  };
}
