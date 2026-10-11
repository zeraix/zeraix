"use client";

import { getStorage } from "@zzcpt/zztool";
import { AGENT_GOAL_EVALUATOR_MODEL_KEY } from "@/constants/Agent";
import { resolveModelById, resolveContextWindow } from "@/lib/ai/models";
import { isLocalEndpoint, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import type { TFunc } from "@/lib/i18n";
import { createChatRequest, type TurnUsage } from "../turn/chatRequest";
import { createSummarizeHistory } from "../context/summarize";
import { createGoalEvaluator, TRANSCRIPT_BUDGET_FRACTION } from "../goal/goalEvaluator";
import type { ModelSelection } from "./useModelSelection";

export type RequestChat = ReturnType<typeof createChatRequest>["requestChat"];
export type EvaluateGoal = ReturnType<typeof createGoalEvaluator>;

export interface ChatRequests {
  /** The model-request layer for the conversation's own model. */
  requestChat: RequestChat;
  /** History → summary, for the compaction plan. */
  summarizeHistory: ReturnType<typeof createSummarizeHistory>;
  /** The independent judge of whether a goal's condition has been met. */
  evaluateGoal: EvaluateGoal;
}

/**
 * The request functions this render's model settings produce: the chat request itself, the summariser built on
 * it, and the goal evaluator (which may run on a model of its own).
 *
 * A hook only in name — it calls none — so that the refs it is handed cross into it the way they cross into any
 * other hook. Nothing here reads them: each is wrapped in an accessor that runs when a request is issued.
 */
export function useChatRequests({
  model,
  proxyReady,
  turnUsageRef,
  t,
}: {
  model: ModelSelection;
  proxyReady: boolean;
  turnUsageRef: React.RefObject<TurnUsage>;
  t: TFunc;
}): ChatRequests {
  const {
    activeModel,
    endpoint,
    modelName,
    apiKey,
    isLocalModel,
    thinking,
    thinkingUnsupportedRef,
    reasoningContextUnsupportedRef,
  } = model;

  // The model-request layer (transport, streaming reassembly, usage accounting, and the retry fallbacks for
  // models that reject thinking parameters, replayed thinking, or images). See chatRequest.ts.
  //
  // Built on every render so the returned function always sees the current model / key / thinking settings —
  // the same thing the inline closure it replaced did. The factory itself touches none of the accessors it is
  // handed; they are called per request, from the tool loop.
  const { requestChat } = createChatRequest({
    activeModel,
    endpoint,
    modelName,
    apiKey,
    isLocalModel,
    thinking,
    proxyReady,
    // Accessors, not the refs themselves: they are read when a request is actually issued, which is the only
    // moment the answer is meaningful (turnUsage in particular is replaced at the start of every round).
    turnUsage: () => turnUsageRef.current,
    thinkingUnsupported: () => thinkingUnsupportedRef.current,
    reasoningContextUnsupported: () => reasoningContextUnsupportedRef.current,
    t,
  });

  // History → summary, for the compaction plan (useChatCompaction). See summarize.ts.
  const summarizeHistory = createSummarizeHistory(requestChat);

  // ── Goal evaluation ───────────────────────────────────────────────────────────────────
  /**
   * The independent judge of whether a goal's condition has been met (goalEvaluator.ts).
   *
   * Which model it runs on: the conversation's own by default — the same choice the summariser makes, and the
   * one that needs no configuration to work. When AGENT_GOAL_EVALUATOR_MODEL_KEY names a model, a SECOND
   * request function is built for it instead. That matters most on local setups, where the evaluator runs after
   * every round and asking a large model for a yes/no is a stall the user can feel; pointing it at a small fast
   * model (or a cloud one, since the two need not share a provider) makes the loop usable.
   *
   * Built through createChatRequest either way, so the override inherits the proxy transport, the retry ladder,
   * abort handling and usage-log attribution rather than reimplementing any of it.
   */
  const evaluatorModel = (() => {
    const id = getStorage(AGENT_GOAL_EVALUATOR_MODEL_KEY);
    if (!id) return null;
    const m = resolveModelById(id);
    // A model that has since been deleted must not silently disable evaluation — fall back to the
    // conversation's own model, which is what an unset override already does.
    return m && m.id !== activeModel?.id ? m : null;
  })();
  const { requestChat: requestEval } = createChatRequest({
    activeModel: evaluatorModel ?? activeModel,
    endpoint: evaluatorModel?.endpoint ?? endpoint,
    modelName: evaluatorModel?.model ?? modelName,
    apiKey: evaluatorModel?.apiKey ?? apiKey,
    isLocalModel: evaluatorModel
      ? evaluatorModel.providerId === LOCAL_PROVIDER_ID || isLocalEndpoint(evaluatorModel.endpoint ?? "")
      : isLocalModel,
    // The evaluator answers a yes/no from a transcript; a reasoning budget buys nothing and costs latency on
    // every single round, so it is asked without one whatever the conversation is set to.
    thinking: { ...thinking, enabled: false },
    proxyReady,
    turnUsage: () => turnUsageRef.current,
    thinkingUnsupported: () => thinkingUnsupportedRef.current,
    reasoningContextUnsupported: () => reasoningContextUnsupportedRef.current,
    t,
  });
  // The transcript budget is taken from the EVALUATOR's window, not the session model's: the two need not be
  // the same model, and pointing the check at a small fast one is the supported configuration — it would
  // otherwise be handed a transcript sized for a 1M window and fail every round. ~4 chars per token is the
  // usual rough conversion, and half the window leaves room for the condition, criteria and instructions.
  const evalWindow =
    (evaluatorModel ?? activeModel)?.contextWindow ??
    resolveContextWindow((evaluatorModel ?? activeModel)?.model ?? "");
  const evaluateGoal = createGoalEvaluator(requestEval, {
    budgetChars: Math.floor(evalWindow * TRANSCRIPT_BUDGET_FRACTION * 4),
  });

  return { requestChat, summarizeHistory, evaluateGoal };
}
