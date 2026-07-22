/**
 * Node Dispatcher. See docs/automation-workflow-design.md §3.1.
 *
 * Two jobs, and the second is the important one:
 *   1. route a node to the runtime that can execute it;
 *   2. be the SINGLE chokepoint every node passes through, whatever its runtime.
 *
 * The Policy Guard lives here rather than inside Agent Runtime on purpose. Shell, Python and Browser
 * nodes are the dangerous ones, so a guard that only wraps the agent leaves the worst hole open. One
 * check, every node type, impossible for a future runtime author to forget.
 *
 * The v1 guard is permissive -- budget ceilings and approval gates arrive in Phase 3 -- but the seam
 * exists now, so adding them is a change in one place instead of an audit of every runtime.
 */
import { createShellRuntime } from "./runtimes/shell.mjs";
import { createAgentRuntime } from "./runtimes/agent.mjs";
import { isNodeEvent } from "./runtimes/contract.mjs";

/**
 * Runtimes implemented so far. The rest of the kinds parse but cannot execute yet (§4.2).
 * The agent runtime is only registered when its transport is supplied, so a test or a headless
 * context without an LLM gets a clear "no runtime registered" instead of a null-dereference.
 */
function defaultRuntimes(agentDeps) {
  const map = new Map([["shell", createShellRuntime()]]);
  if (agentDeps) map.set("agent", createAgentRuntime(agentDeps));
  return map;
}

/**
 * @typedef {(ctx: object) => ({ allow: true } | { allow: false, reason: string })} PolicyGuard
 */

/** Permissive default: allows everything, but is still *called* for every node. */
const allowAll = () => ({ allow: true });

export function createDispatcher({ agent, runtimes = defaultRuntimes(agent), policy = allowAll } = {}) {
  return {
    /** Which runtime kinds can actually execute right now. */
    kinds: () => [...runtimes.keys()],

    /**
     * Execute one node. Returns an async iterable of NodeEvents.
     * @param {import("./runtimes/contract.mjs").NodeContext & {runtime: string}} ctx
     */
    async *dispatch(ctx) {
      const runtime = runtimes.get(ctx.runtime);
      if (!runtime) {
        throw new Error(
          `no runtime registered for "${ctx.runtime}" (available: ${[...runtimes.keys()].join(", ") || "none"})`,
        );
      }

      // The chokepoint. Every node, every runtime, before anything executes.
      // Two guards compose here: the injected `policy` (workflow-independent, e.g. a global kill
      // switch) and the per-run budget guard carried on the context. Both must allow.
      for (const verdict of [policy(ctx), ctx.policy?.beforeNode?.(ctx) ?? { allow: true }]) {
        if (!verdict.allow) {
          const err = new Error(`policy denied node "${ctx.nodeId}": ${verdict.reason}`);
          err.name = "PolicyDeniedError";
          throw err;
        }
      }

      let sawOutput = false;
      for await (const event of runtime.execute(ctx)) {
        // A malformed event would land in the event log and corrupt every projection built from it,
        // so reject it at the boundary rather than storing it.
        if (!isNodeEvent(event)) {
          throw new Error(
            `runtime "${ctx.runtime}" emitted a malformed event: ${JSON.stringify(event)?.slice(0, 200)}`,
          );
        }
        if (event.type === "output") {
          if (sawOutput) throw new Error(`runtime "${ctx.runtime}" emitted more than one output event`);
          sawOutput = true;
        }
        yield event;
      }

      if (!sawOutput) {
        // Without this a runtime that returns quietly would look like a success that produced
        // nothing, and downstream nodes would fail with a confusing "no output" much later.
        throw new Error(`runtime "${ctx.runtime}" finished without emitting an output event`);
      }
    },

    /** Release every runtime's long-lived resources (shutdown). */
    async dispose() {
      for (const runtime of runtimes.values()) {
        try {
          await runtime.dispose?.();
        } catch (e) {
          console.warn(`[automation] runtime ${runtime.kind} dispose failed:`, e?.message || e);
        }
      }
    },
  };
}
