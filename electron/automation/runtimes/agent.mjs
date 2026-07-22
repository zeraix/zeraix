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
import { resolveChain } from "../../agent/modelResolver.mjs";
import { createEventQueue, anySignal } from "./eventQueue.mjs";

export function createAgentRuntime({ llmChat, listTools, runTool }) {
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
        signal,
        onEvent: (e) => queue.push(e),
      })
        .then((r) => {
          result = r;
        })
        .catch((e) => {
          failure = e;
        })
        .finally(() => queue.close());

      try {
        for await (const event of queue) yield event;

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
