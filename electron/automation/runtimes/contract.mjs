/**
 * The NodeRuntime contract. See docs/automation-workflow-design.md §5.
 *
 * This interface is the load-bearing abstraction of the whole subsystem: the Dispatcher, the
 * checkpointing rules and cancellation all depend on it, and the runtimes that do not exist yet
 * (python, browser, mcp, webhook) are only cheap to add because they plug in here.
 *
 *   execute(ctx): AsyncIterable<NodeEvent>
 *     Streams progress and ends with exactly one 'output' event carrying the node's outputs.
 *     MUST stop promptly when ctx.signal aborts, and MUST kill any child process it started rather
 *     than merely stopping iteration.
 *
 *   dispose(): Promise<void>
 *     Release long-lived resources (browser contexts, interpreter pools). Called at shutdown, not
 *     per execution.
 *
 * Deviation from the design doc, deliberate: the doc sketched `cancel(reason)` on the runtime. Using
 * `ctx.signal` instead makes cancellation per-execution and race-free -- a single runtime instance
 * may have several nodes in flight, and a runtime-wide cancel() cannot say which one it means.
 * `dispose()` covers the shutdown case the doc's cancel() was reaching for.
 */

/**
 * @typedef {object} NodeContext
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} attempt
 * @property {object} config           Node config from the definition.
 * @property {Record<string, unknown>} inputs   Already resolved by the Data Bus.
 * @property {AbortSignal} signal      Aborts on cancel, timeout, or app shutdown.
 * @property {string} workdir          Working directory for filesystem-touching runtimes.
 */

/**
 * @typedef {{type:'log', level:'info'|'warn'|'error', message:string}
 *         | {type:'progress', fraction?:number, note?:string}
 *         | {type:'usage', tokens?:number, costUsd?:number, model?:string}
 *         | {type:'artifact', ref:string, mime:string, bytes:number}
 *         | {type:'process', pid:number, kind:string}
 *         | {type:'tool:started', name:string, args?:object}
 *         | {type:'tool:finished', name:string, ok:boolean, ms?:number, chars?:number,
 *            preview?:string, error?:string, blocked?:boolean}
 *         | {type:'output', values:Record<string, unknown>}} NodeEvent
 */

/**
 * Event types a runtime may emit. `output` is terminal and must appear exactly once on success.
 *
 * The `tool:*` pair is a first-class part of the vocabulary rather than a `log` message carrying
 * prose, because the Timeline reads these fields structurally — a log line saying `tool: web_search`
 * cannot answer what was searched for or what came back, and parsing it back out of a sentence would
 * make the wording of that sentence an API.
 */
export const NODE_EVENT_TYPES = Object.freeze([
  "log",
  "progress",
  "usage",
  "artifact",
  "process",
  "tool:started",
  "tool:finished",
  "output",
]);

/**
 * Validate that an object looks like a NodeEvent. Runtimes are the most likely place for a plugin
 * author to get the shape wrong, and a malformed event would otherwise land in the event log and
 * corrupt every projection built from it.
 */
export function isNodeEvent(e) {
  if (!e || typeof e !== "object" || !NODE_EVENT_TYPES.includes(e.type)) return false;
  switch (e.type) {
    case "log":
      return typeof e.message === "string" && ["info", "warn", "error"].includes(e.level);
    case "output":
      return !!e.values && typeof e.values === "object";
    case "process":
      return Number.isInteger(e.pid);
    case "tool:started":
      return typeof e.name === "string";
    // `ok` is required, not optional: a finish event with no verdict would render in the Timeline as
    // a call that neither succeeded nor failed, which is the one thing it cannot have done.
    case "tool:finished":
      return typeof e.name === "string" && typeof e.ok === "boolean";
    default:
      return true;
  }
}

/** Raised when a node exceeds its timeout, so the manager can record TIMED_OUT rather than FAILED. */
export class NodeTimeoutError extends Error {
  constructor(ms) {
    super(`node timed out after ${ms}ms`);
    this.name = "NodeTimeoutError";
  }
}

/** Raised when execution stopped because the run was cancelled. */
export class NodeCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(String(reason));
    this.name = "NodeCancelledError";
  }
}
