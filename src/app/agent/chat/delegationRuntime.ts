/**
 * One delegation run by the Rust runtime.
 *
 * delegation.ts drives a sub-agent on `runAgentLoop` with a round runner of its own. This hands the sub-agent's
 * whole conversation to the runtime instead — the loop, the stop policy, the loop detector, per-round reasoning,
 * the provider — exactly as runtimeRound.ts does for the main turn, and keeps what a delegation is:
 *
 * - **Its tools run on the delegation's own path.** `hostToolsOnly`, so every call comes back here and goes
 *   through `execToolCall` with the delegation's context: attributed to its execution in the Inspector, asked
 *   about with the sub-agent named, logged as `sub:<label>`, capped before the sub-agent reads it.
 * - **Its conversation is its own.** `[system, task]`, never persisted; only the conclusion leaves.
 * - **Its bookkeeping.** Rounds, steps and usage reach delegation.ts through `progress`, which writes the
 *   delegation's usage line and the Inspector's outcome exactly as it does for a delegation run here.
 *
 * Null when the runtime cannot take it — the caller runs it on `runAgentLoop`. Null only ever comes back before
 * anything ran.
 */
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { OFFICIAL_PROVIDER_ID } from "@/lib/ai/models";
import { linkSignals } from "@/lib/agent/abortSignals";
import type { ExecutionHandle } from "@/lib/agent/executionRegistry";
import { runTurnInRuntime, runtimeChatAvailable, type RuntimeToolCallInfo } from "@/lib/agent/runtimeTurn";
import { useAuthStore } from "@/store/authStore";
import type { StopDecision } from "@/lib/agent/stopPolicy";
import type { TFunc } from "@/lib/i18n";
import { capToolOutput } from "./compress";
import { resolveHybridBudget } from "./contextCompress";
import { PARALLEL_SAFE_TOOLS, UNCAPPED_TOOLS } from "./constants";
import { failureText, rememberLearned, runtimeProvider, type RuntimeModel } from "./runtimeRound";
import type { ApiMsg, RunCtx } from "./types";

/** `execToolCall`, as a delegation calls it. */
type ExecTool = (
  ctx: RunCtx,
  name: string,
  args: Record<string, unknown>,
  displayName: string,
  actor?: string,
  requester?: { agentId: string; task: string } | null,
  onResult?: (ok: boolean) => void,
) => Promise<string>;

export interface DelegationRun {
  model: RuntimeModel;
  sendReasoningContext: () => boolean;
  t: TFunc;
  /** The delegation's context: its execution id, its joined signal, and a sink for pushes. */
  ctx: RunCtx;
  signal: AbortSignal;
  /** `[system, task]`. */
  messages: ApiMsg[];
  /** The delegation's restricted tool set. Absent where there are no local tools. */
  tools: unknown[] | undefined;
  /** `sub:<label>` — the usage log's actor. */
  actor: string;
  /** How a call is named on the delegation's rows: `<label>→<tool>`. */
  displayName: (tool: string) => string;
  /** This delegation's own KV key on a local server. */
  subConvId: string | undefined;
  execToolCall: ExecTool;
  execution?: ExecutionHandle;
  /** A round opened — the delegation is thinking rather than running a tool. */
  onRoundStart: () => void;
  /** What delegation.ts counts, written as the run goes. */
  progress: {
    rounds: number;
    steps: number;
    lastContent: string;
    usage: { prompt: number; completion: number; total: number };
  };
}

export async function runDelegationInRuntime(run: DelegationRun): Promise<{ stop: StopDecision } | null> {
  if (!runtimeChatAvailable()) return null;
  const { model, ctx, signal, actor, execToolCall, execution, progress } = run;
  // Calls that reached the window, by the model's call id, so a call that did NOT — one whose arguments could not
  // be read, which the runtime reports without running — can still be shown to the Inspector as the failed step
  // it was. By id, not by name: counted by name, a batch of two `search_files` where only the second could be
  // read credited the first with the second's arrival, and the Inspector showed a phantom failure carrying the
  // good call's result while the real parse error never appeared.
  const reachedWindow = new Set<string>();
  // The by-name count this replaced, kept for a sidecar built before `host.tool` carried call ids. Without it, such
  // a runtime would have every call reported to the Inspector a second time, as a failure.
  const reachedByName = new Map<string, number>();

  const contextWindow = model.activeModel?.contextWindow ?? model.capabilities.contextWindow ?? null;
  const result = await runTurnInRuntime(
    {
      // Not streamed: nothing renders a delegation's tokens, as nothing did on the other path.
      provider: runtimeProvider(model, run.subConvId, false),
      messages: run.messages,
      tools: run.tools ?? [],
      contextWindow,
      // A sub-agent's conversation is held to the user's budget like the turn's (see runtimeRound.ts).
      contextBudget: contextWindow ? resolveHybridBudget(contextWindow, getContextBudgetK()) : null,
      meta: { convId: ctx.convId, turnId: ctx.turnId, source: "chat", actor, provider: model.activeModel?.providerId },
      parallelTools: [...PARALLEL_SAFE_TOOLS],
      // applyReasoningPolicy's rule for a delegation's own rounds, which is every round it has.
      replayReasoning: model.isLocalModel || run.sendReasoningContext(),
      hostToolsOnly: true,
      thinking: { enabled: model.thinking.enabled, effort: model.thinking.effort },
    },
    {
      runTool: async (name, rawArgs, call?: RuntimeToolCallInfo) => {
        if (call?.callId) reachedWindow.add(call.callId);
        else reachedByName.set(name, (reachedByName.get(name) ?? 0) + 1);
        const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
        let ok = true;
        // Stopped with the delegation, or when the main process gives up on this one call (see runtimeRound.ts).
        const linked = call ? linkSignals(ctx.signal, call.signal) : null;
        let content: string;
        try {
          content = await execToolCall(
            linked ? { ...ctx, signal: linked.signal } : ctx,
            name,
            args,
            run.displayName(name),
            actor,
            null,
            (v) => {
              ok = v;
            },
          );
        } finally {
          linked?.release();
        }
        // Capped before the sub-agent reads it; read_file is exempt, as everywhere.
        return { ok, content: UNCAPPED_TOOLS.has(name) ? content : capToolOutput(content) };
      },
      onRound: (e) => {
        if (e.phase === "start") {
          run.onRoundStart();
          return;
        }
        if (e.phase !== "response") return;
        progress.rounds += 1;
        const prompt = Number(e.prompt_tokens ?? 0);
        const completion = Number(e.completion_tokens ?? 0);
        progress.usage.prompt += prompt;
        progress.usage.completion += completion;
        progress.usage.total += prompt + completion;
        progress.lastContent = e.content ?? "";
        // And the turn's, which on the other path `requestChat` adds every sub-agent request to.
        const turn = model.turnUsage?.();
        if (turn) {
          turn.prompt += prompt;
          turn.completion += completion;
          turn.total += prompt + completion;
          turn.cached += Number(e.cached_tokens ?? 0);
          if (e.estimated) turn.estimated = true;
        }
        // Official models are billed per request, a delegation's included; throttled in the store.
        if (model.activeModel?.providerId === OFFICIAL_PROVIDER_ID) void useAuthStore.getState().refreshWallet();
      },
      onTool: (e) => {
        // Every call is a step the delegation took, whether or not it could run.
        if (e.phase === "start") {
          progress.steps += 1;
          return;
        }
        if (reachedWindow.delete(e.id)) return;
        const byName = reachedByName.get(e.name) ?? 0;
        if (byName > 0) {
          reachedByName.set(e.name, byName - 1);
          return;
        }
        // Never reached the window: the arguments could not be read, so execToolCall — which reports every
        // other call to the Inspector — never saw it. Reported here, or it would read as a step that did not happen.
        const callId = execution?.toolCall(e.name, {});
        if (callId) execution?.toolResult(callId, e.name, false, String(e.content ?? ""), Number(e.ms ?? 0));
      },
    },
    signal,
  );
  if (result === null) return null;

  rememberLearned(model, result.learned);
  const reason = result.stop_reason;
  if (reason === "completed" || reason === "cancelled" || reason === "doom-loop" || reason === "context-limit") {
    return { stop: { stop: true, reason, detail: result.detail } };
  }
  // A provider failure throws, as requestChat's does on the other path: delegation.ts fails the execution and
  // the scheduler records the job as failed.
  throw new Error(
    reason === "error"
      ? failureText(result.detail ?? "error", model.endpoint, run.t)
      : `${reason}${result.detail ? `: ${result.detail}` : ""}`,
  );
}
