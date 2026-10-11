"use client";

import { useEffect, useRef } from "react";
import { resolveContextWindow } from "@/lib/ai/models";
import { countTokens } from "@/lib/ai/tokenizer";
import { simulateBudgets, defaultBudgetCandidates, formatSimulation } from "../context/contextDiag";
import type { ApiMsg } from "../types";

export type DiagSnapshot = { messages: ApiMsg[]; tools: unknown[]; contextWindow: number };

/**
 * Context diagnostics (measurement phase): what the last request actually sent, and the console harness that
 * replays it against other budgets.
 *
 * Read-only with respect to the conversation. The round writes `diagRef` as it sends; everything else here only
 * reads, and only when someone calls the harness from the console.
 */
export function useContextDiagnostics({
  activeModel,
  convoRef,
  composeSystemPrompt,
  buildToolSet,
}: {
  activeModel: { model: string; contextWindow?: number } | null;
  convoRef: React.RefObject<ApiMsg[]>;
  /** The prefix composers, for `__seedPrefix`. Both read what they need through refs (see the harness below). */
  composeSystemPrompt: () => string;
  buildToolSet: () => Promise<unknown[]>;
}): { diagRef: React.RefObject<DiagSnapshot> } {
  // Context diagnostics (measurement phase): the last wire + tool schemas + window actually sent, so the
  // offline budget-replay harness (window.__ctxSim, dev only) can run against a real heavy task on demand.
  const diagRef = useRef<DiagSnapshot>({
    messages: [],
    tools: [],
    contextWindow: 0,
  });

  // Keep the diagnostics' context window current even before the first send of a freshly-loaded
  // conversation, so the harness reports the right window (e.g. 1M) rather than a fallback.
  useEffect(() => {
    diagRef.current.contextWindow =
      activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
  }, [activeModel]);

  // Expose the offline budget-replay harness on the window so a real heavy task can be simulated from
  // the console: `__ctxSim()` (default budget spread) or `__ctxSim(40, 60, 80)` (custom K-token budgets).
  // It RETURNS a structured result — so the numbers are visible even when the console's level filter
  // hides console.log/Info output — and also logs a formatted table. Read-only measurement; deliberately
  // available in every build during this measurement phase (not gated on NODE_ENV), so it works on the
  // packaged app the user actually runs a heavy task in.
  useEffect(() => {

    const w = window as unknown as {
      __ctxSim?: (...budgetsK: number[]) => unknown;
      __seedPrefix?: () => Promise<unknown>;
    };
    // Kept for inspecting a live install ("what is this app actually sending?"). Seed generation no longer needs it: the prefix
    // is static text in promptPrefix.ts, so scripts/capture-prefix.mjs computes it without an app at all.
    w.__seedPrefix = async () => ({ system: composeSystemPrompt(), tools: await buildToolSet() });
    const K = (n: number) => `${(n / 1000).toFixed(1)}K`;
    w.__ctxSim = (...budgetsK: number[]) => {
      try {
        const messages = convoRef.current; // the full verbatim buffer — the simulator does its own compaction
        const { tools, contextWindow } = diagRef.current;
        const userTurns = messages.filter((m) => m.role === "user").length;
        if (userTurns === 0) {
          const note = "[ctxSim] No conversation captured yet — open or send a heavy task first, then re-run __ctxSim().";
          console.log(note);
          return { note };
        }
        const cw = contextWindow || 128000;
        const schemaTokens = tools.length ? countTokens(JSON.stringify(tools)) : 0;
        const candidates = budgetsK.length
        ? [
              { label: "current (window-relative)" },
              ...budgetsK.map((kk) => ({
                label: `${kk}K budget`,
                triggerTokens: Math.min(cw * 0.75, kk * 1000),
                targetTokens: Math.min(cw * 0.5, Math.round(kk * 1000 * 0.65)),
              })),
            ]
            : defaultBudgetCandidates(cw);
        const result = simulateBudgets({ messages, contextWindow: cw, schemaTokens, candidates });
        console.log(formatSimulation(result));
        const b = result.finalBreakdown;
        // A compact, expandable object so the key numbers are legible even with console.log hidden.
        return {
          turns: result.turns,
          window: K(cw),
          buckets: {
            system: K(b.system),
            toolSchemas: schemaTokens ? K(schemaTokens) : "not captured — send once this session",
            history: K(b.history),
            toolOutputs: K(b.toolOutputs),
            subagent: K(b.subagentOutputs),
            messagesTotal: K(b.total),
          },
          dedupReclaim: K(result.dedupReclaimTokens),
          redundantReReads: b.rereads,
          budgets: result.reports.map((r) => ({
            budget: r.label,
            maxWire: K(r.maxWireTokens),
            avgWire: K(r.avgWireTokens),
            summariserCalls: r.summariserCalls,
            coldWrites: r.coldWrites,
            summariserInput: K(r.summariserInputTokens),
          })),
          full: result,
        };
      } catch (err) {
        // Return the failure (filter-proof) as well as logging it — the console level filter was
        // swallowing the throw, which is why __ctxSim() looked like it produced "nothing".
        const e = err as Error;
        console.error("[ctxSim] crashed:", e);
        return { error: e?.message ?? String(err), stack: e?.stack };
      }
    };
    return () => {
      delete w.__ctxSim;
      delete w.__seedPrefix;
    };
  // Mount-only on purpose: this registers window globals and takes them down again on unmount. Listing the two
  // composers as dependencies would tear the harness down and rebuild it on every render, and both read the
  // values they need through refs precisely so the mount-time closure stays correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { diagRef };
}
