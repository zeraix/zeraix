/**
 * The renderer's copy of sub-agent execution state (TODO §12).
 *
 * A store of its own rather than a slice of `useAgentChatStore`: executions are transient and turn-scoped
 * where that store is conversations and messages, and every tool call a fan-out makes would otherwise notify
 * every transcript subscriber in the app. It holds the ONLY copy — the runtime publishes events and keeps
 * nothing, and the reducer that folds them in is the pure one in `src/lib/agent/subagentExecution.ts`, so
 * the state machine is testable without a store or a renderer.
 *
 * ## Batching
 *
 * Events arrive in bursts: ten concurrent sub-agents each finishing a tool call inside the same tick is the
 * normal case, not the stress case. They are queued and folded in on a microtask, so a burst costs one
 * `set` and one render rather than one per event (TODO §26).
 */
import { create } from "zustand";
import {
  applyExecutionEvent,
  clearConversation as clearConversationIn,
  emptyExecutionsState,
  isTerminal,
  pruneExecutions,
  type ExecutionsState,
  type SubAgentEvent,
  type SubAgentExecution,
} from "@/lib/agent/subagentExecution";
import { subscribeExecutionEvents } from "@/lib/agent/executionRegistry";

/**
 * The MAIN agent blocked in `join_subagents`.
 *
 * Deliberately not an execution status: a sub-agent that is running while the agent that spawned it waits
 * for it is not itself waiting, and conflating the two is exactly what TODO §23 warns against.
 */
export interface JoinWait {
  conversationId: string;
  turnId: string;
  /** Execution ids being waited on, when the call named some. Empty means "everything outstanding". */
  executionIds: string[];
  since: number;
}

interface SubAgentExecutionState {
  executions: ExecutionsState;
  /**
   * Blocked `join_subagents` calls, by TURN id.
   *
   * Keyed by turn rather than by conversation because that is the key the caller always holds: the turn's
   * teardown runs from the scheduler's `finally`, which knows its turn and not which conversation it
   * belonged to. The conversation is carried inside, which is what the banner filters on.
   */
  waits: Record<string, JoinWait>;
  /** Fold a batch in under one notification. A single event is the one-element case. */
  applyEvents: (events: SubAgentEvent[]) => void;
  clearConversationExecutions: (conversationId: string) => void;
  beginJoinWait: (wait: JoinWait) => void;
  endJoinWait: (turnId: string) => void;
  /** Ids of this turn's executions that have not settled — what a turn-level cancel has to report. */
  outstandingForTurn: (turnId: string) => string[];
}

export const useSubAgentExecutionStore = create<SubAgentExecutionState>((set, get) => ({
  executions: emptyExecutionsState(),
  waits: {},

  applyEvents: (events) => {
    const before = get().executions;
    let next = before;
    for (const event of events) next = applyExecutionEvent(next, event);
    next = pruneExecutions(next);
    // Identity is the signal the reducer gives for "nothing changed" — a duplicate completion, a late event
    // for an evicted execution. Skipping the set is what keeps those from costing a render.
    if (next !== before) set({ executions: next });
  },

  clearConversationExecutions: (conversationId) => {
    const before = get().executions;
    const after = clearConversationIn(before, conversationId);
    const waits = get().waits;
    const nextWaits: Record<string, JoinWait> = {};
    for (const [turnId, w] of Object.entries(waits)) {
      if (w.conversationId !== conversationId) nextWaits[turnId] = w;
    }
    const waitsChanged = Object.keys(nextWaits).length !== Object.keys(waits).length;
    if (after === before && !waitsChanged) return;
    set({ executions: after, waits: waitsChanged ? nextWaits : waits });
  },

  beginJoinWait: (wait) => set((s) => ({ waits: { ...s.waits, [wait.turnId]: wait } })),

  endJoinWait: (turnId) =>
    set((s) => {
      if (!s.waits[turnId]) return s;
      const waits = { ...s.waits };
      delete waits[turnId];
      return { waits };
    }),

  outstandingForTurn: (turnId) => {
    const { byId, order } = get().executions;
    return order.filter((id) => {
      const ex = byId[id];
      return !!ex && ex.turnId === turnId && !isTerminal(ex.status);
    });
  },
}));

// ── The one subscription ───────────────────────────────────────────────────────────────────────────

let queue: SubAgentEvent[] = [];
let flushing = false;

function flush() {
  flushing = false;
  const batch = queue;
  queue = [];
  useSubAgentExecutionStore.getState().applyEvents(batch);
}

subscribeExecutionEvents((event) => {
  queue.push(event);
  if (flushing) return;
  flushing = true;
  queueMicrotask(flush);
});

/** One execution by id, or undefined once it has been evicted. */
export function selectExecution(id: string | null): (s: SubAgentExecutionState) => SubAgentExecution | undefined {
  return (s) => (id ? s.executions.byId[id] : undefined);
}
