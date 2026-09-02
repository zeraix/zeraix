/**
 * The canonical record of one sub-agent execution, and the pure reducer that events fold into it
 * (TODO §2, §3, §13, §22).
 *
 * This is the Runtime's side of the Runtime/UI split: it knows what happened, and nothing about how any of
 * it is drawn. No React, no translation, no imports beyond redaction — which is why the state machine can be
 * exercised directly in test/subagent-observability.test.mjs instead of through a rendered panel.
 *
 * ## Why the events are stored stripped
 *
 * An event carries its payload to whoever is listening; the reducer stores it WITHOUT one. A `tool_call`
 * event keeps its ids and its tool name in `events`, and its arguments live exactly once, on the matching
 * entry in `toolCalls`. Storing both would put the same (already truncated) file content in two places per
 * call, which is what TODO §26 forbids — and the timeline needs ordering, not payloads, because it renders a
 * tool row by looking the call up.
 *
 * ## Why invalid transitions are dropped rather than throwing
 *
 * Two things can settle a delegation: its own body returning, and the turn being cancelled underneath it.
 * They race by design (see `cancelAll` in subagentScheduler.ts), so a second terminal event is a normal
 * occurrence, not a bug. First one wins; the loser is ignored. The same rule handles a late event arriving
 * after eviction and a duplicate `spawned`.
 */
import { redactArgs, redactOutput } from "./executionRedaction";

/**
 * Where a delegation is in its life.
 *
 * `waiting` is in the set because the state machine needs somewhere to put "started, and now blocked on
 * something else". Nothing emits it today: `join_subagents` blocks the MAIN agent, which is a different fact
 * and is tracked separately (TODO §23). See docs/subagent-observability.md.
 */
export type ExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** What a running delegation is doing, structurally. The UI turns this into localised prose (TODO §19). */
export type ExecutionPhase = "starting" | "thinking" | "tool" | "waiting";

/** Which tool created this execution. Distinguishes the fixed-role paths from the brokered anonymous one. */
export type ExecutionOrigin = "run_subagent" | "spawn_subagents" | "spawn_sub_agent";

export function isTerminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Valid transitions. Anything not listed is refused, including every edge out of a terminal state. */
const TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  queued: ["running", "completed", "failed", "cancelled"],
  running: ["waiting", "completed", "failed", "cancelled"],
  waiting: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return from === to ? false : TRANSITIONS[from].includes(to);
}

/** One tool invocation, paired with its result. The only place a tool payload is stored. */
export interface ExecutionToolCall {
  toolCallId: string;
  name: string;
  /** Redacted and clipped at emission (see executionRedaction.ts). */
  args: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  /** Absent while the call is in flight. */
  ok?: boolean;
  /** Redacted and clipped. Absent while in flight. */
  output?: string;
}

/**
 * Every structured state change the runtime publishes about one execution.
 *
 * Frozen at emission (`freezeEvent`), so a subscriber cannot mutate what a later subscriber receives.
 */
export type SubAgentEvent =
  | {
      type: "spawned";
      executionId: string;
      timestamp: number;
      agent: string;
      task: string;
      origin: ExecutionOrigin;
      conversationId?: string;
      turnId?: string;
      /**
       * What the user said to start the turn, so the Inspector can say WHICH turn a delegation came from.
       *
       * A turn id is a correlation key and means nothing to a person; the message that caused the work is
       * what they recognise. Carried on the event rather than looked up later because the conversation is
       * editable — a turn's text can be rewritten or truncated away, and a label that changed afterwards
       * would relabel history.
       */
      turnLabel?: string;
      parentExecutionId?: string;
      /** The scheduler's per-turn handle (`s1`), when the path has one. Display only — never an id. */
      jobId?: string;
      requestedTools?: string[];
    }
  | { type: "started"; executionId: string; timestamp: number }
  | { type: "status_changed"; executionId: string; timestamp: number; status: ExecutionStatus }
  | { type: "action"; executionId: string; timestamp: number; phase: ExecutionPhase }
  | {
      type: "tool_call";
      executionId: string;
      timestamp: number;
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      type: "tool_result";
      executionId: string;
      timestamp: number;
      toolCallId: string;
      toolName: string;
      ok: boolean;
      output?: string;
      durationMs?: number;
    }
  /** Facts learned after the execution started — a brokered agent's id, and what it was actually granted. */
  | {
      type: "info";
      executionId: string;
      timestamp: number;
      agent?: string;
      requestedTools?: string[];
      grantedTools?: string[];
    }
  | { type: "completed"; executionId: string; timestamp: number; result?: string }
  | { type: "failed"; executionId: string; timestamp: number; error: { message: string; code?: string } }
  | { type: "cancelled"; executionId: string; timestamp: number; reason?: string };

/** The canonical execution record (TODO §2). */
export interface SubAgentExecution {
  id: string;
  parentExecutionId?: string;
  childIds: string[];
  conversationId?: string;
  turnId?: string;
  /** What the user said to start the turn this delegation belongs to. See the `spawned` event. */
  turnLabel?: string;
  jobId?: string;
  origin: ExecutionOrigin;
  agent: string;
  task: string;
  status: ExecutionStatus;
  phase: ExecutionPhase;
  spawnedAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  toolCallCount: number;
  toolCalls: ExecutionToolCall[];
  /** Ids of the calls still in flight, newest last. Drives the current-action line. */
  activeToolCallIds: string[];
  /** Payload-free timeline, in emission order. See the header. */
  events: SubAgentEvent[];
  /** How many events the per-execution cap discarded, so a truncated timeline says so. */
  droppedEvents: number;
  requestedTools?: string[];
  grantedTools?: string[];
  result?: string;
  error?: { message: string; code?: string };
}

export interface ExecutionsState {
  byId: Record<string, SubAgentExecution>;
  /** Spawn order, which is the order the Inspector lists completed work in. */
  order: string[];
}

export function emptyExecutionsState(): ExecutionsState {
  return { byId: {}, order: [] };
}

/**
 * Events kept per execution.
 *
 * A long-running delegation is dozens of tool calls, not thousands; the cap exists so a wedged one cannot
 * grow without bound, and the count of what was dropped is kept so the timeline can say it is incomplete.
 */
export const MAX_EVENTS_PER_EXECUTION = 400;
/** Tool calls kept per execution. Oldest are evicted; the count in `toolCallCount` stays honest. */
export const MAX_TOOL_CALLS_PER_EXECUTION = 200;

/** Freeze an event so every subscriber sees the same object (TODO §3, "immutable after emission"). */
export function freezeEvent(e: SubAgentEvent): SubAgentEvent {
  return Object.freeze({ ...e }) as SubAgentEvent;
}

/** The timeline copy of an event: identity and ordering, never payload. */
function stripped(e: SubAgentEvent): SubAgentEvent {
  switch (e.type) {
    case "spawned":
      return freezeEvent({ ...e, task: "" });
    case "tool_call":
      return freezeEvent({ ...e, input: undefined });
    case "tool_result":
      return freezeEvent({ ...e, output: undefined });
    case "completed":
      return freezeEvent({ ...e, result: undefined });
    default:
      return freezeEvent(e);
  }
}

function pushEvent(ex: SubAgentExecution, e: SubAgentEvent): void {
  if (ex.events.length >= MAX_EVENTS_PER_EXECUTION) {
    ex.events.shift();
    ex.droppedEvents++;
  }
  ex.events.push(stripped(e));
}

/** Settle an execution once. Returns false when it was already settled — the race described in the header. */
function settle(
  ex: SubAgentExecution,
  status: ExecutionStatus,
  at: number,
): boolean {
  if (!canTransition(ex.status, status)) return false;
  ex.status = status;
  ex.completedAt = at;
  ex.durationMs = at - (ex.startedAt ?? ex.spawnedAt);
  ex.activeToolCallIds = [];
  ex.phase = "thinking";
  return true;
}

/**
 * Fold one event into the state.
 *
 * Returns the SAME state object when the event changed nothing, so a store can skip the notification
 * entirely rather than re-rendering on a duplicate or a late arrival.
 */
export function applyExecutionEvent(state: ExecutionsState, event: SubAgentEvent): ExecutionsState {
  if (event.type === "spawned") {
    if (state.byId[event.executionId]) return state; // duplicate spawn
    const ex: SubAgentExecution = {
      id: event.executionId,
      parentExecutionId: event.parentExecutionId,
      childIds: [],
      conversationId: event.conversationId,
      turnId: event.turnId,
      turnLabel: event.turnLabel,
      jobId: event.jobId,
      origin: event.origin,
      agent: event.agent,
      task: event.task,
      status: "queued",
      phase: "starting",
      spawnedAt: event.timestamp,
      toolCallCount: 0,
      toolCalls: [],
      activeToolCallIds: [],
      events: [],
      droppedEvents: 0,
      requestedTools: event.requestedTools,
    };
    pushEvent(ex, event);
    const byId = { ...state.byId, [ex.id]: ex };
    // A child is listed on its parent so the tree can be rendered without a scan, and never appears at the
    // top level (TODO §20). The parent may have been evicted; a missing one simply leaves it unlisted.
    const parent = event.parentExecutionId ? byId[event.parentExecutionId] : undefined;
    if (parent) byId[parent.id] = { ...parent, childIds: [...parent.childIds, ex.id] };
    return { byId, order: [...state.order, ex.id] };
  }

  const current = state.byId[event.executionId];
  if (!current) return state; // late event for an evicted or unknown execution

  // Copied rather than mutated: the store hands these objects to React, and a component that memoised on
  // identity would never see an in-place edit.
  const ex: SubAgentExecution = {
    ...current,
    toolCalls: [...current.toolCalls],
    activeToolCallIds: [...current.activeToolCallIds],
    events: [...current.events],
  };
  let changed = true;

  switch (event.type) {
    case "started": {
      if (!canTransition(ex.status, "running")) return state;
      ex.status = "running";
      ex.startedAt = event.timestamp;
      ex.phase = "thinking";
      break;
    }
    case "status_changed": {
      if (!canTransition(ex.status, event.status)) return state;
      if (isTerminal(event.status)) settle(ex, event.status, event.timestamp);
      else ex.status = event.status;
      break;
    }
    case "action": {
      if (isTerminal(ex.status)) return state;
      if (ex.phase === event.phase) changed = false;
      ex.phase = event.phase;
      break;
    }
    case "tool_call": {
      if (isTerminal(ex.status)) return state;
      ex.toolCallCount++;
      ex.phase = "tool";
      ex.activeToolCallIds = [...ex.activeToolCallIds, event.toolCallId];
      ex.toolCalls.push({
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: redactArgs(event.input ?? {}),
        startedAt: event.timestamp,
      });
      if (ex.toolCalls.length > MAX_TOOL_CALLS_PER_EXECUTION) ex.toolCalls.shift();
      break;
    }
    case "tool_result": {
      const i = ex.toolCalls.findIndex((c) => c.toolCallId === event.toolCallId);
      ex.activeToolCallIds = ex.activeToolCallIds.filter((id) => id !== event.toolCallId);
      // A result whose call was evicted (or never seen) still moves the execution off "tool", but there is
      // nothing to attach it to.
      if (i >= 0) {
        const call = ex.toolCalls[i];
        ex.toolCalls[i] = {
          ...call,
          ok: event.ok,
          output: event.output === undefined ? undefined : redactOutput(event.output),
          completedAt: event.timestamp,
          durationMs: event.durationMs ?? event.timestamp - call.startedAt,
        };
      }
      if (!isTerminal(ex.status) && ex.activeToolCallIds.length === 0) ex.phase = "thinking";
      break;
    }
    case "info": {
      if (event.agent) ex.agent = event.agent;
      if (event.requestedTools) ex.requestedTools = event.requestedTools;
      if (event.grantedTools) ex.grantedTools = event.grantedTools;
      break;
    }
    case "completed": {
      if (!settle(ex, "completed", event.timestamp)) return state;
      ex.result = event.result;
      break;
    }
    case "failed": {
      if (!settle(ex, "failed", event.timestamp)) return state;
      ex.error = event.error;
      break;
    }
    case "cancelled": {
      if (!settle(ex, "cancelled", event.timestamp)) return state;
      if (event.reason) ex.result = event.reason;
      break;
    }
  }

  if (!changed) return state;
  pushEvent(ex, event);
  return { byId: { ...state.byId, [ex.id]: ex }, order: state.order };
}

/** Terminal executions kept in memory. Running ones are never evicted, however many there are (TODO §13). */
export const MAX_RETAINED_EXECUTIONS = 60;

/**
 * Drop the oldest settled executions once there are more than `max` of them.
 *
 * An execution with a live descendant is kept even when it is settled: evicting a parent out from under its
 * children would leave them orphaned at the top level, which is exactly the "child events appearing as
 * top-level agents" §20 forbids.
 */
export function pruneExecutions(
  state: ExecutionsState,
  max: number = MAX_RETAINED_EXECUTIONS,
): ExecutionsState {
  const settled = state.order.filter((id) => {
    const ex = state.byId[id];
    return ex && isTerminal(ex.status);
  });
  if (settled.length <= max) return state;

  const protectedIds = new Set<string>();
  for (const id of state.order) {
    const ex = state.byId[id];
    if (!ex || isTerminal(ex.status)) continue;
    // Keep every ancestor of a live execution.
    let cursor: SubAgentExecution | undefined = ex;
    while (cursor?.parentExecutionId) {
      protectedIds.add(cursor.parentExecutionId);
      cursor = state.byId[cursor.parentExecutionId];
    }
  }

  const evict = new Set<string>();
  let over = settled.length - max;
  for (const id of settled) {
    if (over <= 0) break;
    if (protectedIds.has(id)) continue;
    evict.add(id);
    over--;
  }
  if (evict.size === 0) return state;

  const byId: Record<string, SubAgentExecution> = {};
  for (const id of state.order) {
    if (evict.has(id)) continue;
    const ex = state.byId[id];
    if (!ex) continue;
    byId[id] = ex.childIds.some((c) => evict.has(c))
      ? { ...ex, childIds: ex.childIds.filter((c) => !evict.has(c)) }
      : ex;
  }
  return { byId, order: state.order.filter((id) => !evict.has(id)) };
}

/** Forget everything belonging to one conversation — called when it is deleted or cleared. */
export function clearConversation(state: ExecutionsState, conversationId: string): ExecutionsState {
  const drop = new Set(
    state.order.filter((id) => state.byId[id]?.conversationId === conversationId),
  );
  if (drop.size === 0) return state;
  const byId: Record<string, SubAgentExecution> = {};
  for (const id of state.order) {
    if (drop.has(id)) continue;
    const ex = state.byId[id];
    if (ex) byId[id] = ex;
  }
  return { byId, order: state.order.filter((id) => !drop.has(id)) };
}

/** Top-level executions in spawn order — a child is rendered under its parent, never here (TODO §20). */
export function rootExecutions(state: ExecutionsState): SubAgentExecution[] {
  return state.order
    .map((id) => state.byId[id])
    .filter(
      (ex): ex is SubAgentExecution =>
        !!ex && (!ex.parentExecutionId || !state.byId[ex.parentExecutionId]),
    );
}

/** Live / failed counts for the Inspector's entry point, over one conversation or all of them. */
export function summarise(
  state: ExecutionsState,
  conversationId?: string,
): { running: number; queued: number; failed: number; total: number } {
  let running = 0;
  let queued = 0;
  let failed = 0;
  let total = 0;
  for (const id of state.order) {
    const ex = state.byId[id];
    if (!ex) continue;
    if (conversationId && ex.conversationId !== conversationId) continue;
    total++;
    if (ex.status === "queued") queued++;
    else if (ex.status === "running" || ex.status === "waiting") running++;
    else if (ex.status === "failed") failed++;
  }
  return { running, queued, failed, total };
}

/** The delegations one turn started, newest turn first. */
export interface TurnGroup {
  turnId: string;
  /** What the user said to start it. Absent for a turn with no text of its own (attachments only). */
  label?: string;
  /** When this turn's first delegation was spawned — what the group is ordered by. */
  at: number;
  /** Top-level executions in spawn order; nested ones are rendered by their parent. */
  executions: SubAgentExecution[];
}

/**
 * Group a conversation's delegations by the turn that started them (newest turn first).
 *
 * The list is otherwise a flat run of agent names with no way to tell a delegation from this message apart
 * from one three questions ago. Ordered newest-first because that is where the running work is, and within a
 * group in spawn order because that is how the model refers to them (`s1`, `s2`).
 *
 * An execution with no `turnId` is its own group rather than being dropped: the field is optional on the
 * event, and silently hiding a delegation would be the worst possible way to handle one.
 */
export function groupByTurn(state: ExecutionsState, conversationId?: string): TurnGroup[] {
  // Spawn order, as a tiebreak on the timestamp. Two turns CAN start in the same millisecond — a queued
  // message sent the moment the previous turn ends does it, and so does every test — and a tie on `at` would
  // otherwise leave the order to whichever group the map happened to see first, which is the OLDEST.
  const seq = new Map<string, number>();
  state.order.forEach((id, i) => seq.set(id, i));

  const groups = new Map<string, TurnGroup & { seq: number }>();
  for (const ex of rootExecutions(state)) {
    if (conversationId && ex.conversationId !== conversationId) continue;
    const key = ex.turnId ?? `~${ex.id}`;
    const index = seq.get(ex.id) ?? 0;
    const existing = groups.get(key);
    if (existing) {
      existing.executions.push(ex);
      existing.at = Math.min(existing.at, ex.spawnedAt);
      existing.seq = Math.min(existing.seq, index);
      // The label is whichever member has one: a turn's executions all carry the same text, but a record
      // spawned before the host supplied it may carry none.
      existing.label = existing.label ?? ex.turnLabel;
    } else {
      groups.set(key, { turnId: key, label: ex.turnLabel, at: ex.spawnedAt, seq: index, executions: [ex] });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .map(({ turnId, label, at, executions }) => ({ turnId, label, at, executions }));
}
