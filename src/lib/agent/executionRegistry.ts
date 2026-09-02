/**
 * The execution event bus, and the handle the runtime writes through (TODO §4, §11).
 *
 * Two responsibilities and no more: mint an id that is stable for the life of an execution, and publish
 * frozen events to whoever is listening. It holds NO state — the reducer in subagentExecution.ts does, and
 * the store owns the copy. That separation is what keeps "runtime owns execution truth, frontend owns
 * presentation" true even though both currently run in the renderer (see docs/subagent-observability.md).
 *
 * ## Why a handle rather than an `emit(event)` function
 *
 * Every call site would otherwise have to repeat the execution id, a timestamp and the right event shape on
 * five separate lines spread across three files, and the failure mode of getting one wrong is silent: an
 * event attributed to the wrong execution, or a `completed` for a delegation that never started. A handle
 * closes over the id, so the call sites read as what happened.
 *
 * ## Ids
 *
 * `ex_<n>_<random>`. The counter makes them readable and ordered within a session; the random suffix means
 * a reload cannot mint an id that collides with one already on screen in a background conversation. Never
 * the scheduler's `s1` handle — that restarts every turn — and never an array index (TODO §2).
 */
import {
  freezeEvent,
  type ExecutionOrigin,
  type ExecutionPhase,
  type SubAgentEvent,
} from "./subagentExecution";

export type ExecutionListener = (event: SubAgentEvent) => void;

const listeners = new Set<ExecutionListener>();
let seq = 0;

/** Subscribe to every execution event. Returns the unsubscribe. */
export function subscribeExecutionEvents(listener: ExecutionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Publish one event.
 *
 * Never throws and never lets a listener's throw escape: this is called from inside the tool path and the
 * delegation loop, and observability that can break a turn is worse than none.
 */
export function publishExecutionEvent(event: SubAgentEvent): void {
  const frozen = freezeEvent(event);
  for (const listener of listeners) {
    try {
      listener(frozen);
    } catch (e) {
      console.warn("[subagent-observability] a listener threw:", e);
    }
  }
}

function mintId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `ex_${++seq}_${rand}`;
}

/** What creating an execution needs to know. Everything else is learned from events. */
export interface ExecutionInit {
  agent: string;
  task: string;
  origin: ExecutionOrigin;
  conversationId?: string;
  turnId?: string;
  /** What the user said to start the turn, so the Inspector can name which turn this came from. */
  turnLabel?: string;
  /** The execution that spawned this one, when there is one. Makes the tree (TODO §20). */
  parentExecutionId?: string;
  /** The scheduler's per-turn handle, for display beside the model's own transcript. */
  jobId?: string;
  requestedTools?: string[];
}

/** The runtime's write surface for one execution. Every method is safe to call more than once. */
export interface ExecutionHandle {
  readonly id: string;
  start(): void;
  action(phase: ExecutionPhase): void;
  /** Returns the id to pass back to `toolResult`. */
  toolCall(toolName: string, input: unknown, toolCallId?: string): string;
  toolResult(toolCallId: string, toolName: string, ok: boolean, output?: string, durationMs?: number): void;
  info(patch: { agent?: string; requestedTools?: string[]; grantedTools?: string[] }): void;
  complete(result?: string): void;
  fail(message: string, code?: string): void;
  cancel(reason?: string): void;
}

let toolSeq = 0;

/**
 * Create an execution and announce it.
 *
 * Called at SPAWN time, not at start time: a delegation waiting on a concurrency slot is a thing the user
 * should be able to see, and the whole point of the fan-out path is that the wait is real.
 */
export function beginExecution(init: ExecutionInit): ExecutionHandle {
  const id = mintId();
  publishExecutionEvent({
    type: "spawned",
    executionId: id,
    timestamp: Date.now(),
    agent: init.agent,
    task: init.task,
    origin: init.origin,
    conversationId: init.conversationId,
    turnId: init.turnId,
    turnLabel: init.turnLabel,
    parentExecutionId: init.parentExecutionId,
    jobId: init.jobId,
    requestedTools: init.requestedTools,
  });

  return {
    id,
    start() {
      publishExecutionEvent({ type: "started", executionId: id, timestamp: Date.now() });
    },
    action(phase) {
      publishExecutionEvent({ type: "action", executionId: id, timestamp: Date.now(), phase });
    },
    toolCall(toolName, input, toolCallId) {
      const callId = toolCallId ?? `tc_${++toolSeq}`;
      publishExecutionEvent({
        type: "tool_call",
        executionId: id,
        timestamp: Date.now(),
        toolCallId: callId,
        toolName,
        input,
      });
      return callId;
    },
    toolResult(toolCallId, toolName, ok, output, durationMs) {
      publishExecutionEvent({
        type: "tool_result",
        executionId: id,
        timestamp: Date.now(),
        toolCallId,
        toolName,
        ok,
        output,
        durationMs,
      });
    },
    info(patch) {
      publishExecutionEvent({ type: "info", executionId: id, timestamp: Date.now(), ...patch });
    },
    complete(result) {
      publishExecutionEvent({ type: "completed", executionId: id, timestamp: Date.now(), result });
    },
    fail(message, code) {
      publishExecutionEvent({
        type: "failed",
        executionId: id,
        timestamp: Date.now(),
        error: { message, code },
      });
    },
    cancel(reason) {
      publishExecutionEvent({ type: "cancelled", executionId: id, timestamp: Date.now(), reason });
    },
  };
}

/**
 * Cancel every execution of a turn that has not settled.
 *
 * The scheduler settles a QUEUED job without ever running its body, so nothing else would report it: without
 * this a cancelled fan-out would leave rows sitting at "queued" forever. The store answers the "which are
 * still open" question, because it is the component that holds the state; this only needs the ids.
 */
export function cancelExecutions(ids: string[], reason?: string): void {
  for (const id of ids) {
    publishExecutionEvent({ type: "cancelled", executionId: id, timestamp: Date.now(), reason });
  }
}

/** Test seam: forget every subscriber. Never called by the app. */
export function resetExecutionListenersForTest(): void {
  listeners.clear();
}
