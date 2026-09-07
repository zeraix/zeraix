/**
 * The in-flight turn's checkpoint, and what to say when one is found after a crash.
 *
 * docs/agent-runtime-crash-recovery.md C2 (turn checkpointing). The loop's own state — which round is running and
 * which tool calls are out — lived only in React refs; a renderer crash, a force-quit or a power loss lost it, and the
 * reopened conversation showed a valid transcript (the repair in turnRound.ts) with no trace that anything had been
 * cut short. This module writes that state to the conversation record at every round boundary and clears it when the
 * turn ends by any route, so a record that is still there on reopen means exactly one thing.
 *
 * The rule that shapes the notice (§5 of the design doc): work that may already have had side effects is never
 * silently re-run. The notice tells the model what was running and whether it could have changed anything, and tells
 * it to check before repeating — it does not resume, and it does not ask the model to.
 */
import type { StoredTurnState } from "@/lib/ai/conversation";
import { PARALLEL_SAFE_TOOLS } from "./constants";

/**
 * Tools whose interrupted execution cannot have changed anything the user owns.
 *
 * The conservative reading: everything not listed is treated as mutating, including MCP tools, `call_tool` (the
 * dispatcher, whose target is unknown here) and sub-agent delegations. The design doc's L3 replaces this set with a
 * flag each tool declares in its registry entry; until then a false "mutating" costs the model one look at the
 * working directory, while a false "read-only" could cost a second `npm install`.
 */
const READ_ONLY_TOOLS = new Set<string>([
  ...PARALLEL_SAFE_TOOLS,
  "load_skill",
  "search_memory",
  "ask_user",
  "update_todos",
  "set_task_state",
  "web_search",
  "fetch_url",
  "check_project",
  "sandbox_tools",
  "openBrowser",
  "browser",
]);

export function isMutatingTool(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}

export interface TurnCheckpoint {
  /** A round is starting: the model is being asked for its next step. */
  roundStarted(): void;
  /** The round's tool calls have been dispatched. `callId` is the transcript's tool_call id, so the notice can name the dangling call. */
  callsStarted(calls: { callId: string; name: string }[]): void;
  /** Every dispatched call has returned (or the batch was abandoned). */
  callsFinished(): void;
  /** The turn is over, by any route. Removes the checkpoint; nothing is left to report. */
  clear(): void;
  /** The current checkpoint, for tests. */
  current(): StoredTurnState | null;
}

/**
 * Build the checkpoint for one turn. `save` is the persistence sink (the chat store's setConversationTurnState); it is
 * called with the new state after every transition and with null on clear. `queued` reads the messages waiting behind
 * this turn at the moment of each write, so the notice can list what was never sent.
 */
export function createTurnCheckpoint(input: {
  turnId: string;
  save: (state: StoredTurnState | null) => void;
  queued?: () => string[];
  /** Outstanding sub-agent delegations right now. Read at each write rather than pushed, so no call site has to remember to report a change. */
  delegations?: () => number;
  now?: () => number;
}): TurnCheckpoint {
  const now = input.now ?? (() => Date.now());
  const queued = input.queued ?? (() => []);
  const delegations = input.delegations ?? (() => 0);
  let state: StoredTurnState | null = null;
  /**
   * Apply one transition.
   *
   * Every failure is swallowed. This is a diagnostic that observes the turn, and it reads two callbacks it does not
   * own (the message queue and the sub-agent scheduler) plus a store write; letting any of them throw would let the
   * crash *reporter* break the turn it exists to report on, which is strictly worse than losing the report. The
   * console line is what makes that loss visible rather than silent.
   */
  const write = (patch: Partial<StoredTurnState>) => {
    try {
      writeUnsafe(patch);
    } catch (e) {
      console.error("[recovery] could not checkpoint the turn:", e);
    }
  };
  const writeUnsafe = (patch: Partial<StoredTurnState>) => {
    const base: StoredTurnState = state ?? {
      turnId: input.turnId,
      startedAt: now(),
      updatedAt: now(),
      round: 0,
      running: [],
      delegations: 0,
      queued: [],
    };
    state = {
      ...base,
      ...patch,
      updatedAt: now(),
      // Both read at write time: the queue and the delegation set change outside this module, and a pushed value
      // would go stale exactly when a crash freezes it.
      queued: queued().slice(0, 20),
      delegations: Math.max(0, delegations()),
    };
    input.save(state);
  };
  return {
    roundStarted: () => write({ round: (state?.round ?? 0) + 1, running: [] }),
    callsStarted: (calls) =>
      write({ running: calls.map((c) => ({ callId: c.callId, name: c.name, mutating: isMutatingTool(c.name) })) }),
    callsFinished: () => write({ running: [] }),
    clear: () => {
      state = null;
      // Same reasoning as write(): this runs in send()'s `finally`, where throwing would replace whatever actually
      // ended the turn — including the user's own error — with a failure from the bookkeeping.
      try {
        input.save(null);
      } catch (e) {
        console.error("[recovery] could not clear the turn checkpoint:", e);
      }
    },
    current: () => state,
  };
}

/** Whether a stored checkpoint is stale: present, and no run in this process owns its turn. */
export function isInterrupted(state: StoredTurnState | undefined, liveTurnIds: Iterable<string>): state is StoredTurnState {
  if (!state) return false;
  for (const id of liveTurnIds) if (id === state.turnId) return false;
  return true;
}

function when(ts: number): string {
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return "an earlier session";
  }
}

/**
 * The change-event line for the model. One sentence per fact, no instruction to resume: the model is told to look
 * before it repeats anything that may have run.
 */
export function describeInterruptedTurn(state: StoredTurnState): string {
  const parts: string[] = [];
  parts.push(
    `RECOVERY NOTICE: your previous turn in this conversation (started ${when(state.startedAt)}) was cut short by an application crash or forced exit at round ${state.round}` +
      (state.running.length ? " while these tool calls were running:" : " while waiting for your reply; no tool call was in flight."),
  );
  if (state.running.length) {
    parts.push(
      state.running
        .map((r) => `${r.name} (tool_call id ${r.callId}${r.mutating ? "; may have had side effects" : "; read-only"})`)
        .join(", ") + ".",
    );
    parts.push(
      "Their results are unknown: each may have completed, partly completed, or never run, and the transcript shows placeholders " +
        "instead of results. Before repeating any call marked as possibly having side effects, inspect the working directory and the " +
        "files or services it would touch and repeat it only if the work is verifiably not done. Read-only calls may simply be repeated.",
    );
  }
  if (state.delegations > 0) {
    parts.push(
      `${state.delegations} delegated sub-agent task(s) were outstanding and were lost with the process; their conclusions never arrived.`,
    );
  }
  if (state.queued.length) {
    parts.push(
      `${state.queued.length} queued user message(s) were never sent: ` +
        state.queued.map((q) => `"${q.length > 80 ? q.slice(0, 80) + "…" : q}"`).join("; ") +
        ". Do not act on them unless the user sends them again.",
    );
  }
  parts.push("Do not resume automatically; first tell the user briefly what was interrupted, then continue with what they ask.");
  return parts.join(" ");
}

/** The facts the banner shows the user. */
export function summarizeInterruptedTurn(state: StoredTurnState): {
  round: number;
  tools: string[];
  mutating: boolean;
  delegations: number;
  queued: number;
} {
  return {
    round: state.round,
    tools: state.running.map((r) => r.name),
    mutating: state.running.some((r) => r.mutating),
    delegations: state.delegations,
    queued: state.queued.length,
  };
}
