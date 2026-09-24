/**
 * A chat turn run by the Rust runtime, with everything the chat page does around a round kept exactly as it was.
 *
 * `runAgentLoop` + `createRoundRunner` (turnRound.ts) drive a turn from here, one round at a time. This hands the
 * whole turn to the runtime instead (src/lib/agent/runtimeTurn.ts) — the loop, the stop policy, the loop
 * detector, context management and the provider transport — and answers what only this window can:
 *
 * - **Every tool call.** The run is started with `hostToolsOnly`, so each call comes back to `runTool` below and
 *   takes the path it always took: the renderer's own tools, or `execToolCall` with its consent prompt, its row
 *   on screen and its log entry. That path already ends in the runtime's registry, through `tool.call`.
 * - **Between rounds.** The nudges the chat page writes into the tool result the model is about to read — the
 *   review and project-memory reminders, the loop detector's warnings — and the two reasons a final answer is
 *   not one: a turn that did work and then said nothing, and one that is ending with its delegations running.
 * - **What a person sees and what is kept.** Deltas, the reply, the thinking timeline, the tool results, the
 *   crash checkpoint, the context meter and the turn's usage, each written where `createRoundRunner` writes it.
 *
 * Returns null when the runtime cannot take the turn — the caller runs it on `runAgentLoop`. Null only ever
 * comes back before anything ran, so falling back cannot repeat a round.
 */
import { isLocalEndpoint } from "@/lib/ai/localModel";
import { markVisionUnsupported, OFFICIAL_PROVIDER_ID, resolveContextWindow, type ResolvedModel } from "@/lib/ai/models";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { thinkingParams, type ThinkingConfig } from "@/lib/ai/thinking";
import type { ModelCapabilities } from "@/lib/agent/modelAdapter";
import { countTokens } from "@/lib/ai/tokenizer";
import { isUsageLogEnabledSync, logToolCall } from "@/lib/ai/usageLog";
import { prepareWire } from "@/lib/agent/contextManager";
import type { StopDecision } from "@/lib/agent/stopPolicy";
import { dueReminders, noObligations, recordTool, unansweredCalls } from "@/lib/agent/toolRuntime";
import {
  runTurnInRuntime,
  runtimeChatAvailable,
  type RuntimeProvider,
  type RuntimeQuirks,
  type RuntimeRoundInfo,
  type RuntimeRoundAnswer,
  type RuntimeRoundSummary,
  type RuntimeToolCall,
} from "@/lib/agent/runtimeTurn";
import { useAgentChatStore } from "@/store/agentChatStore";
import { useAuthStore } from "@/store/authStore";
import { describeHttpFailure, type TurnUsage } from "./chatRequest";
import { capToolOutput } from "./compress";
import {
  DELEGATION_TOOLS,
  FINALIZE_NUDGE,
  FORCE_REVIEW_NUDGE,
  PARALLEL_SAFE_TOOLS,
  PENDING_DELEGATION_NUDGE,
  RECORD_MEMORY_NUDGE,
  RENDERER_HANDLED_TOOLS,
  UNCAPPED_TOOLS,
  equivalentCallNudge,
  repeatedCallNudge,
  repeatedFailureNudge,
  repeatedResourceNudge,
} from "./constants";
import { resultCeilingTokens } from "./contextCompress";
import { isGoalActive, recordEvidence } from "./goalState";
import { wrapReminder } from "./reminders";
import { createRoundView, snapshotContext, storeToolResult, type RoundRunnerDeps } from "./turnRound";
import type { ApiMsg } from "./types";
import { phaseSummaryText, thinkingProcessText } from "./wireHelpers";

/**
 * What a run in the runtime needs to know about the model: the pieces `requestChat` closes over. Built once per
 * turn by the page and shared by the turn and its delegations, so both reach the provider the same way.
 */
export interface RuntimeModel {
  endpoint: string;
  apiKey: string;
  modelName: string;
  isLocalModel: boolean;
  activeModel: ResolvedModel | null;
  /** The user's thinking setting. */
  thinking: ThinkingConfig;
  /** What this model can do — whether its effort can vary per request, above all. */
  capabilities: ModelCapabilities;
  /** Models known to refuse the thinking switch, and a replayed thinking block — told to the runtime up front. */
  thinkingUnsupported: () => Set<string>;
  reasoningContextUnsupported: () => Set<string>;
}

/** Everything `createRoundRunner` is given, plus what `requestChat` held that the runtime now needs directly. */
export interface RuntimeTurnDeps extends RoundRunnerDeps, RuntimeModel {
  /** This turn's running token total, as `requestChat` adds to it. */
  turnUsage: () => TurnUsage;
}

/**
 * The provider, as `requestChat` would reach it. `conversationId` is the local server's KV key — the turn's, or a
 * delegation's own — and is sent only to a local endpoint, as requestChat sends it.
 */
export function runtimeProvider(m: RuntimeModel, conversationId: string | undefined, stream: boolean): RuntimeProvider {
  const local = isLocalEndpoint(m.endpoint);
  // The thinking fields for a round at `effort`, as requestChat spells them. The runtime economises routine
  // rounds exactly as runAgentLoop does; this is how its choice reaches a provider in that provider's terms.
  const at = (effort: ThinkingConfig["effort"]) =>
    m.thinkingUnsupported().has(m.modelName)
      ? {}
      : thinkingParams({ ...m.thinking, enabled: true, effort }, { local: m.isLocalModel, model: m.modelName });
  return {
    endpoint: m.endpoint,
    // What the proxy sends a local server when there is no key.
    apiKey: local ? m.apiKey.trim() || "local" : m.apiKey.trim(),
    model: m.modelName,
    thinkingParams: m.thinkingUnsupported().has(m.modelName)
      ? {}
      : thinkingParams(m.thinking, { local: m.isLocalModel, model: m.modelName }),
    supportsPerTurnReasoningEffort: m.capabilities.supportsPerTurnReasoningEffort,
    thinkingByEffort: { low: at("low"), medium: at("medium"), high: at("high") },
    stream,
    headers: local && conversationId ? { "X-Conversation-Id": conversationId } : undefined,
    known: {
      thinking_unsupported: m.thinkingUnsupported().has(m.modelName),
      reasoning_context_unsupported: m.reasoningContextUnsupported().has(m.modelName),
    },
  };
}

/** What a run learned about this model, kept for every later request — as requestChat keeps it. */
export function rememberLearned(m: RuntimeModel, learned: RuntimeQuirks | undefined): void {
  if (learned?.thinking_unsupported) m.thinkingUnsupported().add(m.modelName);
  if (learned?.reasoning_context_unsupported) m.reasoningContextUnsupported().add(m.modelName);
  if (learned?.vision_unsupported && m.activeModel?.id) markVisionUnsupported(m.activeModel.id);
}

/** What `page.tsx` reads from a finished loop. */
export interface RuntimeTurnOutcome {
  stop: StopDecision;
}

/** The loop detector's diagnosis, worded the way `onDoomSignal` in page.tsx words it. */
function doomNudge(s: RuntimeRoundSummary["signals"][number]): string | null {
  if (s.signal === "identical") return repeatedCallNudge(s.name, s.repeat);
  if (s.signal === "equivalent") return equivalentCallNudge(s.name, s.repeat);
  if (s.signal === "failing") return repeatedFailureNudge(s.name, s.failStreak);
  if (s.signal === "resource") return repeatedResourceNudge(s.name, s.resourceHits);
  return null;
}

/** A provider failure, worded as `requestChat` words one — including the local-model rewordings. */
export function failureText(detail: string, endpoint: string, t: RoundRunnerDeps["t"]): string {
  const http = /^HTTP (\d{3})(?: — ([\s\S]*))?$/.exec(detail.trim());
  return http ? describeHttpFailure(Number(http[1]), http[2], endpoint, t) : detail;
}

/**
 * Run one chat turn in the runtime. Null means "not served here": run it on `runAgentLoop` instead.
 */
export async function runChatTurnInRuntime(deps: RuntimeTurnDeps): Promise<RuntimeTurnOutcome | null> {
  if (!runtimeChatAvailable()) return null;
  const {
    checkpoint, convId, turnId, signal, active, t, buf, compaction, log,
    activeModel, modelName, isLocalModel, sendReasoningContext, wireSteps, tools, ctx,
    rendererTools, execToolCall, toolRules, drainDelegations, drainJobEvents,
    setCtxTokens, schedulerRef, awaitingJobsRef, tagLastAssistantStoredIndex, goalFor, setGoalFor,
    endpoint, thinking, turnUsage,
  } = deps;
  const store = useAgentChatStore.getState();

  // The conversation as the first request sends it, built exactly as a round of the TypeScript loop builds it.
  // Every later round is the runtime's: this conversation plus what the turn appended.
  const wire = prepareWire(buf.messages, compaction, {
    model: {
      isLocal: isLocalModel,
      acceptsImages: !!activeModel?.multimodal,
      sendReasoningContext: sendReasoningContext(),
      modelId: activeModel?.model,
      resultCeilingTokens: resultCeilingTokens(
        activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? ""),
        getContextBudgetK(),
      ),
    },
    steps: wireSteps,
    onImagesStripped: (modelId) =>
      console.warn(`[vision] stripping images for ${modelId} — a local build without an mmproj projector, or a provider that refused images`),
  });
  snapshotContext(deps, wire);
  log.lastWire = wire;

  // Per-turn latches, as createRoundRunner holds them: each fires at most once for the whole turn.
  let obligations = noObligations();
  let didToolCall = false;
  let finalizeNudged = false;
  let delegationNudged = false;

  // The round on screen, and what has streamed into it so far.
  let view = createRoundView(deps);
  let streamed = { content: "", reasoning: "" };
  // The calls the latest reply made — to answer with placeholders if the turn is cut short before they ran.
  let pendingCalls: RuntimeToolCall[] = [];

  /** Deliver nudges through the turn buffer — which stores them — and hand the runtime the same bytes. */
  const deliver = (texts: string[]): string | undefined => {
    const blocks = texts.filter((text) => buf.nudgeIntoLastTool(text)).map(wrapReminder);
    return blocks.length ? blocks.join("\n\n") : undefined;
  };

  /** Every tool call, on the path createRoundRunner's runToolCall takes. Returns what the model will read. */
  const runTool = async (name: string, rawArgs: unknown): Promise<{ ok: boolean; content: string }> => {
    const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
    const startedAt = Date.now();
    const handler = rendererTools[name];
    let callOk = true;
    const base = handler
      ? await handler(ctx, args)
      : await execToolCall(ctx, name, args, name, "main", null, (v) => {
          callOk = v;
        });
    // Finished delegations and background jobs ride back on the result, as they do on the other path.
    const content = (name === "join_subagents" ? base : base + drainDelegations(ctx)) + drainJobEvents(ctx);
    if (RENDERER_HANDLED_TOOLS.has(name)) {
      logToolCall({
        actor: "main",
        name,
        args,
        ok: true,
        result: content,
        resultTokens: isUsageLogEnabledSync() ? countTokens(content) : undefined,
        ms: Date.now() - startedAt,
        convId,
        turnId,
      });
    }
    // Capped HERE, before the runtime sees it, so what the model is sent and what is stored are the same bytes.
    return { ok: callOk, content: UNCAPPED_TOOLS.has(name) ? content : capToolOutput(content) };
  };

  /** Between rounds, and once after a final answer. The two halves of createRoundRunner's wrap-up. */
  const round = async (info: RuntimeRoundInfo): Promise<RuntimeRoundAnswer> => {
    if (!info.final) {
      const texts: string[] = [];
      // The review / project-memory reminders, known the moment the tools return — delivered before the result
      // they ride is first sent, so the model can still act on them.
      if (info.last?.calls.length) {
        const { due, next } = dueReminders(obligations);
        obligations = next;
        for (const reminder of due) texts.push(reminder === "review" ? FORCE_REVIEW_NUDGE : RECORD_MEMORY_NUDGE);
      }
      // The loop detector's warnings: the specific signal, because a model told "you are looping" varies its
      // arguments rather than changing course.
      for (const s of info.last?.signals ?? []) {
        const text = doomNudge(s);
        if (text) texts.push(text);
      }
      return { nudge: deliver(texts) };
    }
    // The model is ending the turn while delegations it spawned are still running. They are cancelled the moment
    // the turn ends, so this is the last chance to use them. Once per turn, so declining to join is respected.
    const held = schedulerRef.current;
    const outstanding = held && held.turnId === turnId ? held.sched.outstanding() : [];
    if (outstanding.length > 0 && !delegationNudged) {
      delegationNudged = true;
      return { resume: true, nudge: deliver([PENDING_DELEGATION_NUDGE]) };
    }
    // It did work — ran a tool, or reasoned — and then said nothing, so the user saw nothing. Once per turn.
    if ((didToolCall || info.last?.hasReasoning) && !finalizeNudged && info.last?.contentEmpty) {
      finalizeNudged = true;
      return { resume: true, nudge: deliver([FINALIZE_NUDGE]) };
    }
    return {};
  };

  const result = await runTurnInRuntime(
    {
      // Streamed, as chat's own rounds are. llama-server restores this conversation's KV cache by its id.
      provider: runtimeProvider(deps, convId, true),
      messages: wire,
      tools,
      // Declared so a turn that outgrows the window mid-turn is compacted there rather than refused.
      contextWindow: activeModel?.contextWindow ?? resolveContextWindow(modelName),
      meta: { convId, turnId, source: "chat", actor: "main", provider: activeModel?.providerId },
      parallelTools: [...PARALLEL_SAFE_TOOLS],
      // The replay policy applyReasoningPolicy applies to this turn's own rounds: local models, or everyone with
      // "send thinking as context" on.
      replayReasoning: isLocalModel || sendReasoningContext(),
      hostToolsOnly: true,
      thinking: { enabled: thinking.enabled, effort: thinking.effort },
    },
    {
      runTool,
      round,
      onRetry: (e) =>
        ctx.status(
          t(e.kind === "rate-limit" ? "chat.retryingRateLimited" : "chat.retryingNetwork", {
            attempt: String(e.attempt + 1),
            attempts: String(e.attempts),
            seconds: String(Math.max(1, Math.round(e.delay_ms / 1000))),
          }),
        ),
      onDelta: (d) => {
        streamed = d.reset
          ? { content: d.content, reasoning: d.reasoning }
          : { content: streamed.content + d.content, reasoning: streamed.reasoning + d.reasoning };
        if (active()) view.render(streamed.reasoning, phaseSummaryText(streamed.content));
      },
      onRound: (e) => {
        if (e.phase === "start") {
          ctx.status(t("chat.thinking"));
          checkpoint?.roundStarted();
          view = createRoundView(deps);
          streamed = { content: "", reasoning: "" };
          return;
        }
        if (e.phase === "end") {
          if (pendingCalls.length) checkpoint?.callsFinished();
          return;
        }
        // phase === "response": the reply, before any of its tools run.
        const content = e.content ?? "";
        const reasoningText = (e.reasoning ?? "").trim();
        const calls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
        const turn = turnUsage();
        const prompt = Number(e.prompt_tokens ?? 0);
        const completion = Number(e.completion_tokens ?? 0);
        turn.prompt += prompt;
        turn.completion += completion;
        turn.total += prompt + completion;
        turn.cached += Number(e.cached_tokens ?? 0);
        if (e.estimated) turn.estimated = true;
        if (active()) setCtxTokens(prompt);
        // Official models are billed per request; the balance moves with every step. Throttled in the store.
        if (activeModel?.providerId === OFFICIAL_PROVIDER_ID) void useAuthStore.getState().refreshWallet();

        view.render(reasoningText, calls.length ? thinkingProcessText(content) : content, calls.length > 0);
        buf.push(
          calls.length
            ? { role: "assistant", content: content || null, tool_calls: calls, ...(reasoningText ? { reasoning_content: reasoningText } : {}) }
            : { role: "assistant", content: content || null, ...(reasoningText ? { reasoning_content: reasoningText } : {}) },
        );
        if (content || calls.length || reasoningText) {
          store.appendMessage(convId, {
            role: "assistant",
            content,
            // The runtime's replayed copy: already repaired where the model's arguments were unreadable.
            ...(calls.length ? { tool_calls: calls } : {}),
            ...(reasoningText ? { reasoning: reasoningText } : {}),
            thinkMs: Date.now() - view.startedAt,
            ts: Date.now(),
          });
          if (active() && !calls.length && content.trim()) {
            const idx = (store.getConversation(convId)?.messages.length ?? 0) - 1;
            if (idx >= 0) tagLastAssistantStoredIndex(idx);
          }
        }
        pendingCalls = calls;
        if (calls.length) {
          didToolCall = true;
          checkpoint?.callsStarted(calls.map((c) => ({ callId: c.id, name: c.function.name })));
        } else {
          log.lastContent = content;
        }
      },
      onTool: (e) => {
        if (e.phase !== "end") return; // the call's row is drawn by the tool path itself, in runTool
        const name = e.name;
        const args = (e.args && typeof e.args === "object" ? e.args : {}) as Record<string, unknown>;
        const content = String(e.content ?? "");
        obligations = recordTool(obligations, { name, args }, toolRules);
        if (name === "run_command" && args.notify) {
          awaitingJobsRef.current.set(convId, (awaitingJobsRef.current.get(convId) ?? 0) + 1);
        }
        if (DELEGATION_TOOLS.has(name) && isGoalActive(goalFor(convId))) {
          setGoalFor(convId, recordEvidence(goalFor(convId), { source: name, summary: content }));
        }
        storeToolResult(deps, { id: e.id, name, content });
      },
    },
    signal,
  );
  if (result === null) return null;

  rememberLearned(deps, result.learned);

  // A turn cut short between a reply and its results: every call gets an answer, or the provider refuses the
  // conversation's next request. Stored too, so a reopened conversation reads the same.
  const answered = buf.messages.flatMap((m) => (m.role === "tool" && m.tool_call_id ? [{ toolCallId: m.tool_call_id }] : []));
  for (const tc of unansweredCalls(pendingCalls, answered)) {
    const placeholder = signal.aborted ? t("chat.canceled") : t("chat.skipped");
    storeToolResult(deps, { id: tc.id, name: tc.function.name, content: placeholder });
  }

  // The goal evaluator judges what the final answer was given; the runtime's transcript is verbatim.
  const lastAnswer = (result.messages as ApiMsg[]).map((m) => m.role).lastIndexOf("assistant");
  if (lastAnswer > 0) log.lastWire = (result.messages as ApiMsg[]).slice(0, lastAnswer);

  const reason = result.stop_reason;
  if (reason === "completed" || reason === "cancelled" || reason === "doom-loop" || reason === "context-limit") {
    return { stop: { stop: true, reason, detail: result.detail } };
  }
  // A provider failure, or a stop the chat's own loop has no name for: surfaced the way send() surfaces a failed
  // request, with the rounds that did complete already stored.
  throw new Error(reason === "error" ? failureText(result.detail ?? "error", endpoint, t) : `${reason}${result.detail ? `: ${result.detail}` : ""}`);
}
