"use client";

/**
 * The run page's composer slot.
 *
 * A delegation is rendered as the conversation it is (ExecutionRow.tsx), and a conversation ends in a
 * composer. This one cannot take a message yet: talking to a sub-agent directly is the planned next step,
 * and the input lands here when it does. Today it carries the one control a run in flight needs, Stop.
 * Its own component so that step is an addition to this file rather than a rearrangement of the page.
 *
 * Stop is per sub-agent, and that is the whole point of it. The chat composer's Stop ends the turn and takes
 * every delegation with it; this one ends this delegation and leaves the main agent, and its siblings,
 * running. The main agent is told the work was stopped by the user (STOPPED_BY_USER_RESULT), so it does not
 * silently delegate the same task again.
 *
 * The button goes through `cancelExecution`, the runtime's entry point, and reads nothing but the record:
 * "Stopping…" is the record's `cancelRequestedAt`, not a local flag, so reopening the page mid-stop shows
 * the same thing the page showed when the button was pressed.
 */
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cancelExecution } from "@/lib/agent/executionRegistry";
import { isTerminal, type SubAgentExecution } from "@/lib/agent/subagentExecution";

export function ExecutionComposer({ execution: ex }: { execution: SubAgentExecution }) {
  const t = useT();
  // Settled work has nothing to stop, and nothing to say to yet. Nothing rather than a disabled button:
  // a control that is always there and never usable teaches people to stop looking at it.
  if (isTerminal(ex.status)) return null;
  const stopping = ex.cancelRequestedAt !== undefined;

  return (
    // Right-aligned, where the chat composer keeps its Stop, so the hand that knows one finds the other.
    <div className="flex items-center justify-end py-1">
      <button
        type="button"
        onClick={() => cancelExecution(ex.id)}
        disabled={stopping}
        title={t("inspector.stopHint")}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[12px] font-semibold text-primary-foreground shadow-sm transition hover:brightness-110 active:scale-95 disabled:cursor-default disabled:opacity-60 disabled:hover:brightness-100 disabled:active:scale-100"
      >
        {stopping ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <span className="inline-block size-2 rounded-[2px] bg-surface" />
        )}
        {stopping ? t("inspector.stopping") : t("inspector.stop")}
      </button>
    </div>
  );
}
