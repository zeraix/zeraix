/**
 * Agent node runtime. See docs/automation-workflow-design.md §5.
 *
 * A thin adapter: it maps a NodeDef's agent config onto the headless turn loop in
 * electron/agent/turn.mjs and translates that loop's progress into NodeEvents. All the orchestration
 * lives in turn.mjs so it stays testable and reusable; all the transport (llmChat, runTool,
 * listTools) is injected so this file has no `electron` import.
 *
 * Config: {
 *   model?: string, fallbackModels?: string[],
 *   prompt: string, system?: string,
 *   toolPolicy?: { allow?: string[], deny?: string[] },
 *   maxRounds?: number
 * }
 *
 * The prompt may reference resolved inputs as {{inputs.<name>}} -- substitution rather than string
 * concatenation, so an upstream output cannot silently displace the instruction.
 */
import { runAgentTurn } from "../../agent/turn.mjs";

/** Host only: a full endpoint can carry a key in its query string on some gateways (see llm/proxy.mjs). */
function hostOf(endpoint) {
  try {
    return new URL(String(endpoint)).host;
  } catch {
    return undefined;
  }
}
import { resolveChain } from "../../agent/modelResolver.mjs";
import { createEventQueue, anySignal } from "./eventQueue.mjs";

/**
 * @param {object} deps
 * @param {Function} deps.llmChat / deps.listTools / deps.runTool  Injected transport (see module header).
 * @param {() => string} [deps.getWorkdir]  The workspace an in-runtime turn scopes its file tools to.
 *   Absent, the turn runs on the loop in turn.mjs instead — which is also what happens under `npm test`.
 * @param {() => string} [deps.getAssetDir]  The read-only media root, which travels with the workspace.
 * @param {(entry:object)=>void} [deps.logEvent]  Optional usage-log sink. Injected rather than imported
 *   for the same reason as everything else here: the store needs `electron`, and importing it would
 *   make this module -- and the dispatcher that pulls it in -- unloadable under `npm test`.
 */
export function createAgentRuntime({ llmChat, listTools, runTool, getWorkdir, getAssetDir, logEvent }) {
  if (!llmChat || !listTools || !runTool) {
    throw new Error("agent runtime requires llmChat, listTools and runTool");
  }

  return {
    kind: "agent",

    async *execute(ctx) {
      const cfg = ctx.config ?? {};
      const resolved = resolveChain({ model: cfg.model, fallbackModels: cfg.fallbackModels ?? [] });
      if (!resolved.ok) throw new Error(resolved.error);
      // A typo in a fallback should be visible, not swallowed -- the run still proceeds.
      for (const note of resolved.skipped) {
        yield { type: "log", level: "warn", message: `fallback unavailable -- ${note}` };
      }

      const prompt = interpolate(cfg.prompt, ctx.inputs);
      const system = cfg.system ? interpolate(cfg.system, ctx.inputs) : undefined;

      // Events must STREAM, not be collected and yielded at the end. The Policy Guard inspects each
      // usage report as it arrives and aborts the node the moment a ceiling is crossed; a buffered
      // runtime would report its spending only after every round had already been paid for.
      const queue = createEventQueue();
      // Lets us stop the turn if the consumer stops iterating (e.g. the guard threw).
      const internal = new AbortController();
      const signal = anySignal([ctx.signal, internal.signal]);

      // Attribution for the usage log: a headless run has no conversation, so the node is the actor.
      // Rides along on every request; ignored entirely when logging is off.
      const meta = {
        source: "automation",
        actor: `node:${ctx.nodeId}`,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        turnId: ctx.runId,
      };

      let result = null;
      let failure = null;
      const turn = runAgentTurn({
        prompt,
        system,
        chain: resolved.chain,
        llmChat,
        listTools,
        runTool,
        toolPolicy: cfg.toolPolicy,
        maxRounds: cfg.maxRounds,
        meta,
        signal,
        // Passed through, not resolved here: this file has no `electron` import (see the header), and the
        // workspace is what lets the turn run inside the Rust runtime rather than on the loop in turn.mjs.
        getWorkdir,
        getAssetDir,
        // Model calls made INSIDE the runtime, which never pass through the proxy that logs the others.
        // Written here rather than in turn.mjs for the reason everything else is: the store needs
        // `electron`, and this file must stay loadable without it.
        onModelCall: (call) =>
          logEvent?.({
            kind: "model",
            ...meta,
            model: call.model,
            endpoint: hostOf(call.endpoint),
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            totalTokens: call.promptTokens + call.completionTokens,
            cachedTokens: call.cachedTokens,
            estimated: call.estimated,
            stream: false,
            ms: call.ms,
            ok: call.ok !== false,
            error: call.error,
          }),
        onEvent: (e) => queue.push(e),
      })
        .then((r) => {
          result = r;
        })
        .catch((e) => {
          failure = e;
        })
        .finally(() => queue.close());

      // Pairs tool:started (which carries the arguments) with tool:finished (which carries the outcome)
      // into one log entry. A single slot is enough: turn.mjs runs a round's tool calls strictly in
      // sequence, so a second one never starts before the first has finished.
      let startedTool = null;
      try {
        for await (const event of queue) {
          if (logEvent) {
            if (event.type === "tool:started") {
              startedTool = { name: event.name, args: event.args };
            } else if (event.type === "tool:finished") {
              logEvent({
                kind: "tool",
                ...meta,
                name: event.name,
                args: startedTool?.name === event.name ? startedTool.args : undefined,
                ms: event.ms,
                ok: event.ok !== false,
                blocked: event.blocked,
                resultChars: event.chars,
                resultPreview: event.preview,
                error: event.error,
              });
              startedTool = null;
            }
          }
          yield event;
        }

        if (failure) throw failure;
        if (!result?.ok) throw new Error(result?.error ?? "agent turn produced no result");

        // Note: no aggregate usage event here. Per-round usage was already emitted above, and
        // emitting the total as well would double-count every token against the budget.
        yield {
          type: "output",
          values: { text: result.text, model: result.modelUsed, rounds: result.rounds },
        };
      } finally {
        internal.abort();
        // Releases the turn if it is parked awaiting backpressure from a consumer that has gone
        // away -- otherwise the `await turn` below would never resolve.
        queue.close();
        // Let the turn unwind before returning, so a stopped node leaves no request in flight.
        await turn.catch(() => {});
      }
    },

    /** Nothing pooled: each turn owns only its HTTP requests, which end with the call. */
    async dispose() {},
  };
}

/**
 * Replace {{inputs.name}} placeholders. An unknown placeholder is left untouched rather than
 * replaced with "undefined", so a typo shows up in the prompt instead of silently vanishing.
 */
export function interpolate(template, inputs = {}) {
  return String(template ?? "").replace(/\{\{\s*inputs\.([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key) => {
    if (!(key in inputs)) return whole;
    const v = inputs[key];
    return typeof v === "string" ? v : JSON.stringify(v ?? null);
  });
}
