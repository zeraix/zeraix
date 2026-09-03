/**
 * One delegation, run to its conclusion.
 *
 * Three call paths share this loop: run_subagent (one delegation, blocking) and spawn_subagents /
 * join_subagents (many, concurrent, collected later). Only the LOOP is shared — each path owns its own
 * display bubble, because what the user should see differs: a lone delegation settles its own bubble on its
 * conclusion, whereas a fan-out keeps one bubble for the whole batch.
 *
 * A factory rather than a hook: it holds no state of its own, only the page values it is handed. The page
 * calls it on every render, so the returned function always sees current config.
 */
import { useAgentChatStore } from "@/store/agentChatStore";
import { isLocalEndpoint } from "@/lib/ai/localModel";
import { parseToolArguments, sanitizeToolCallArguments } from "@/lib/ai/toolArgs";
import { isSandboxEngine, sandboxEnvHint, type SandboxStatus } from "@/lib/ai/sandbox";
import {
  delegationSubject,
  SUBAGENT_TOOL_DISCIPLINE,
  type PriorDelegation,
  type SubAgentDef,
} from "@/lib/ai/subagents";
import { STOPPED_BY_USER_RESULT } from "@/lib/ai/subagentScheduler";
import { listTools } from "@/lib/ai/toolkit";
import { logSubagentRun } from "@/lib/ai/usageLog";
import type { TFunc } from "@/lib/i18n";
import { linkSignals } from "@/lib/agent/abortSignals";
import type { ExecutionHandle } from "@/lib/agent/executionRegistry";
import { capToolOutput } from "./compress";
import { PARALLEL_SAFE_TOOLS, UNCAPPED_TOOLS, WORKDIR_SCOPE_RULE, workdirPrompt } from "./constants";
import { groupParallelCalls } from "./sendPrep";
import type { ApiMsg, ChatResponse, RequestLog, RunCtx } from "./types";
import { applyReasoningPolicy } from "./wireHelpers";
import { runAgentLoop, type AgentLoopResult } from "@/lib/agent/agentLoop";
import { initExecutionState } from "@/lib/agent/executionState";
import type { RuntimeBoundary } from "@/lib/agent/runtimeBoundary";
import type { ToolResult } from "@/lib/agent/turn";
import type { ModelCapabilities } from "@/lib/agent/modelAdapter";
import type { ThinkingConfig } from "@/lib/ai/thinking";

/** What one delegation is asked to do, plus where its progress goes. */
export type DelegationOpts = {
  agentId: string;
  task: string;
  def: SubAgentDef;
  /** Distinguishes concurrent delegations in the trace and the usage log ("s2 explore"). */
  label: string;
  status: (s: string) => void;
  /**
   * The execution record this delegation reports its life against (TODO §5).
   *
   * Created by the caller, because that is where the delegation is DECIDED: a spawned one has to exist as
   * "queued" while it waits for a slot, which is before this function is ever called. Optional so the loop
   * stays usable — in tests, and by any future caller — without an observer attached.
   */
  execution?: ExecutionHandle;
};

export function createRunDelegation(deps: {
  t: TFunc;
  /** Electron only: without local tools a sub-agent runs with no tool set at all. */
  toolsReady: boolean;
  workdir: string;
  /** The model endpoint, for the local-only sub-conversation id below (the same test the wire header uses). */
  endpoint: string;
  /** Called at delegation time, not here — the VM can come up or fall back mid-conversation. */
  sandboxStatus: () => SandboxStatus | null;
  isLocalModel: boolean;
  sendReasoningContext: () => boolean;
  /** The user's thinking setting. A sub-agent's reasoning is clamped against it exactly as the main agent's is. */
  thinking: ThinkingConfig;
  /** What the model can do (§5): the gate on varying reasoning effort per round. */
  capabilities: ModelCapabilities;
  requestChat: (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    onDelta?: (d: { content: string; reasoning: string }) => void,
    log?: RequestLog,
    /** Per-request reasoning, from this round's phase. Omitted → the session setting. */
    reasoning?: ThinkingConfig,
  ) => Promise<ChatResponse>;
  execToolCall: (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    actor?: string,
    /** Set when a brokered sub-agent is the caller; null here — a fixed-role delegation is not brokered. */
    requester?: { agentId: string; task: string } | null,
    /** Whether the call succeeded. Folded into Execution State, so a failure makes the next round `recovering`. */
    onResult?: (ok: boolean) => void,
  ) => Promise<string>;
  /** This turn's completed delegations — the repeat-delegation guard reads it, likewise at delegation time. */
  delegations: () => { turnId: string; done: PriorDelegation[] };
}) {
  const {
    t,
    toolsReady,
    workdir,
    endpoint,
    sandboxStatus,
    isLocalModel,
    sendReasoningContext,
    thinking,
    capabilities,
    requestChat,
    execToolCall,
    delegations,
  } = deps;

  // Runs the sub-agent to its conclusion: an independent small loop with its own system prompt and
  // restricted tool set. Owns the model loop, the usage bookkeeping and the repeat-guard record; the
  // caller owns the display.
  return async (
    ctx: RunCtx,
    opts: DelegationOpts,
  ): Promise<{ conclusion: string; error?: string }> => {
    const { agentId, task, def, label, execution } = opts;
    // Stopped before it ever got a slot — the Inspector's Stop on a queued delegation, on a scheduler that
    // still serves the body afterwards. Nothing was spent and nothing runs: it never starts. Not `finish`,
    // because a delegation that never ran has no usage line to write.
    if (execution?.signal.aborted) {
      execution.cancel();
      return { conclusion: STOPPED_BY_USER_RESULT, error: "cancelled" };
    }
    opts.status(t("chat.subagentProcessing", { agent: agentId }));
    // queued → running. The body is running by definition once this function has been entered: on the fan-out
    // path the scheduler only calls it after handing out a concurrency slot.
    execution?.start();

    // What this delegation runs on: the turn's signal (the scheduler's, on the fan-out path) joined with the
    // execution's own, which is the Inspector's per-sub-agent Stop. One signal, because the loop, the model
    // request and every tool call each take one; released when the loop ends, because the turn's signal
    // outlives this delegation and would otherwise keep a listener per delegation for the whole turn.
    const stop = execution ? linkSignals(ctx.signal, execution.signal) : null;
    const signal = stop?.signal ?? ctx.signal;

    // Usage-log bookkeeping for this delegation. The sub-agent's own rounds are counted here rather
    // than read back off turnUsageRef: that ref accumulates every conversation generating at the same
    // time, so a background turn running in parallel would be billed to whichever delegation was open.
    const startedAt = Date.now();
    // `label`, not `agentId`: three concurrent `explore` delegations would otherwise share one actor and
    // the usage log could no longer say which of them spent what.
    const actor = `sub:${label}`;

    // This sub-agent's own conversation id on the local server.
    //
    // One per delegation, because that is exactly how long a sub-agent lives here: this loop builds its
    // messages from scratch every time ([system, task]) and keeps only the conclusion, so nothing is ever
    // resumed. If resuming a sub-agent is added later, the id moves to that sub-agent's record and this line
    // becomes the place it is minted, not the place it is derived — which is why the id belongs to the agent,
    // not the call.
    //
    // Random, not a counter: a counter would have to survive reload to stay unique, and a reload that re-minted
    // `#sub1` for a different agent would hand it a stranger's KV. `label` cannot serve either — it is `explore`
    // for every blocking delegation, and its "s2 explore" form restarts at s1 each turn.
    //
    // randomUUID, not Math.random().toString(16): that yields a VARIABLE-width suffix — 0.5 gives "8", one character,
    // which collides with any other one-character suffix at 1-in-16.
    //
    // Shaped `<parent>#<agent>-<rand>` purely so the server's slot logs are readable. NOTHING parses it: the server
    // has no notion of a sub-conversation, and the app erases these ids from its own record (Conversation.subConvIds).
    //
    // Only for a local endpoint. The id exists to name KV on our own server, and a cloud provider neither receives it
    // (the header is local-only) nor writes anything it could name — so minting one there would add a line to the
    // user's stored conversation for nothing. Read per delegation, not per conversation: switching models mid-thread
    // then decides each delegation on its own, which is right, because whether KV gets written is decided the same way.
    const subConvId = isLocalEndpoint(endpoint)
      ? `${ctx.convId}#${agentId}-${crypto.randomUUID().slice(0, 8)}`
      : undefined;
    // Recorded BEFORE the request, so a crash mid-delegation cannot leave KV on disk that nothing can name.
    if (subConvId) useAgentChatStore.getState().addSubConvId(ctx.convId, subConvId);
    const subLog: RequestLog = { actor, convId: ctx.convId, subConvId, turnId: ctx.turnId };
    const subUsage = { prompt: 0, completion: 0, total: 0 };
    let rounds = 0;
    let stepCount = 0;

    // A sub-agent's internal work does not appear in the conversation.
    //
    // It used to, nested inside the delegation's own bubble. That was the best available answer while there
    // was nowhere else to put it, and it is no longer: the Sub-agent Inspector shows the whole run — every
    // tool call, its arguments, its result, its timing — as a page of its own. Keeping both would say the
    // same thing twice, in the place least able to afford the room, and the transcript's job is the
    // conversation the user is having rather than the machinery underneath it.
    //
    // The sink stays as the guard. `execToolCall` skips the display for a call carrying an `executionId`, so
    // nothing should arrive here — but `push` is on the context, any future caller can reach it, and a
    // delegation whose context did not swallow its pushes would put them straight into the conversation.
    const collectCtx: RunCtx = {
      ...ctx,
      // Every tool this sub-agent runs is dispatched through execToolCall with this context, which is the
      // whole of the tool-attribution mechanism (TODO §9) — no tool is modified, and a nested delegation
      // would inherit it as its parent.
      executionId: execution?.id,
      // The joined signal, so Stop reaches a tool mid-call and not only the next round.
      signal,
      push: () => {},
    };

    // Subagent tool set: reuse the same tool set, filtered by def.tools (a sub-agent gets neither
    // run_subagent nor spawn_subagents, so delegation cannot nest).
    let subTools: unknown[] | undefined;
    if (toolsReady) {
      const all = (await listTools("openai")) as Array<{ function?: { name?: string } }>;
      subTools = def.tools ? all.filter((t) => def.tools!.includes(t.function?.name ?? "")) : all;
    }

    // The subagent and the main agent share the same execution engine, and system likewise injects the command-execution environment description.
    // SUBAGENT_TOOL_DISCIPLINE is what the main agent gets from base.system.md; a sub-agent runs on its own
    // prompt alone, so without this it never learns that batched read-only calls run concurrently here.
    // Only the scope half of the workdir rules: a sub-agent never receives user uploads, so WORKDIR_UPLOAD_RULES would be dead
    // weight here. It does not see the main conversation's messages[0], so the rule has to be composed explicitly.
    // Name the working directory the way the sub-agent must address it. In the sandbox that is /workspace — for commands
    // because it is the cwd there, and for file tools because they accept it as an alias of the working directory. That
    // also makes this system prompt BYTE-IDENTICAL across conversations and installs, where the host path made every
    // sub-agent call a fresh prefix (the path differs per conversation), so nothing before the task could be reused.
    // Native (dev mode, or the VM down): there is no /workspace, so the host path is the only name that works.
    const subWorkdir = isSandboxEngine(sandboxStatus()?.active) ? "/workspace" : workdir;
    const sys = [
      workdir ? `${def.systemPrompt}\n${workdirPrompt(subWorkdir)}\n${WORKDIR_SCOPE_RULE}` : def.systemPrompt,
      SUBAGENT_TOOL_DISCIPLINE,
      sandboxEnvHint(sandboxStatus()),
    ].join("\n");
    let convo: ApiMsg[] = [
      { role: "system", content: sys },
      { role: "user", content: task },
    ];

    const finish = (conclusion: string, error?: string) => {
      // One line per delegation, beside the per-round model entries and the per-call tool entries it
      // produced: the summary answers "what did handing this off cost", the others show how it got there.
      logSubagentRun({
        agent: agentId,
        task,
        rounds,
        steps: stepCount,
        promptTokens: subUsage.prompt,
        completionTokens: subUsage.completion,
        totalTokens: subUsage.total,
        ms: Date.now() - startedAt,
        ok: !error,
        error,
        convId: ctx.convId,
        turnId: ctx.turnId,
      });
      // Recorded only on success: a delegation that was cancelled or errored has no answer to reuse, and
      // re-running it is exactly the right thing for the model to do.
      if (!error) {
        delegations().done.push({
          agent: agentId,
          task,
          subject: delegationSubject(task),
          conclusion,
        });
      }
      return { conclusion, error };
    };

    // ── The shared Agent Loop ────────────────────────────────────────────────────────────────────────────
    //
    // docs/agent-runtime-loop.md §15: a sub-agent runs "its own instance of the same Agent Loop the Main
    // Agent uses", not a second implementation of one. This used to be a bare `while (true)` with no upper
    // limit, no doom-loop detection and no stop policy — so a sub-agent that started repeating itself did so
    // completely unobserved, which is worse than the main agent's case because nobody is watching its output.
    //
    // What it gains by converging: execution state, phase-based reasoning (a recovery round inside a
    // delegation keeps full effort, a routine one is economised), doom-loop detection, and the same
    // structured stop reasons. What it keeps: everything about how a delegation runs — its own conversation,
    // its own tool set, its trace reported to the Inspector, its usage accounting.
    let lastContent = "";

    // A sub-agent's boundary. It has no path to choice cards (collectCtx drops every push) and its
    // conversation is never persisted, so those two members are unreachable rather than merely unused —
    // stated here as behaviour instead of left as silent no-ops.
    const boundary: RuntimeBoundary = {
      signal,
      onEvent: (event) => {
        if (event.type === "status") opts.status(event.text);
        // A round opening is the one moment the delegation is demonstrably thinking rather than running a
        // tool; the tool phases come from the dispatcher itself.
        if (event.type === "turn-start") execution?.action("thinking");
      },
      // Consent is asked for INSIDE execToolCall, on the same queue the main agent uses and with the
      // sub-agent named as requester. The loop never reaches for it.
      requestConsent: async () => "no",
      askUser: async () => {
        throw new Error("a sub-agent cannot ask the user: it has no path to a choice card");
      },
      storage: {
        appendMessage: () => -1,
        setMessageReminder: () => {},
        setGenerating: () => {},
      },
    };

    const result = await runAgentLoop({
      boundary,
      sessionId: ctx.convId,
      turnId: ctx.turnId,
      modelId: agentId,
      agentId,
      thinking,
      capabilities,
      // Sub-agents have no goal of their own: the goal belongs to the conversation, and the main agent's
      // evaluator judges it from the transcript the delegation's conclusion lands in.
      evaluateGoal: undefined,
      now: () => Date.now(),
      runRound: async ({ reasoning }) => {
        opts.status(t("chat.subagentThinking", { agent: agentId }));
        // The subagent bypasses the main wire pipeline, so the policy is applied here too — without it the
        // thinking text carried on `convo` would reach every provider, including those that reject the field.
        const data = await requestChat(
          applyReasoningPolicy(convo, isLocalModel, sendReasoningContext()),
          subTools,
          signal,
          undefined,
          subLog,
          // The phase-based effort the loop resolved for THIS round. Passing it is the entire point of the
          // convergence: without it the loop would compute a reasoning decision that nothing applied, and a
          // sub-agent's recovery round would be issued at whatever the session default happened to be.
          reasoning.config,
        );
        rounds++;
        const u = data.usage;
        if (u) {
          subUsage.prompt += u.prompt_tokens ?? 0;
          subUsage.completion += u.completion_tokens ?? 0;
          subUsage.total += u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
        }
        const msg = data.choices?.[0]?.message;
        if (!msg) {
          return { content: "", reasoning: "", toolResults: [], toolCallCount: 0, providerError: "no response" };
        }
        // Rebuilt field-by-field rather than spread: the response type allows `null` for the reasoning
        // fields, while the wire buffer wants "absent or a string". A subagent runs its own tool loop against
        // the same model, so it has the same prefix break to avoid — carry the thinking text, and let
        // applyReasoningPolicy above decide who actually receives it.
        const subReasoning = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
        convo = [
          ...convo,
          {
            role: "assistant",
            content: msg.content,
            // Same repair as the main loop (see turnRound): a delegation replays its own assistant turns, so
            // a tool call with unreadable arguments would 400 every remaining round of the sub-agent.
            ...(msg.tool_calls?.length ? { tool_calls: [...sanitizeToolCallArguments(msg.tool_calls)] } : {}),
            ...(subReasoning ? { reasoning_content: subReasoning } : {}),
          },
        ];
        lastContent = msg.content || "";
        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
          return { content: lastContent, reasoning: subReasoning, toolResults: [], toolCallCount: 0 };
        }

        const runOne = async (tc: (typeof calls)[number]) => {
          // Same reading as the main loop: a payload that is merely fenced or doubly encoded is recovered, and one that is
          // truncated is reported as such rather than run with `{}` — which had the tool answer "missing required parameter"
          // to a sub-agent that had sent it, and cost a round of its (capped) budget to a message it could not act on.
          const parsed = parseToolArguments(tc.function.arguments);
          if (!parsed.ok) {
            // Reported to the Inspector as the failed call it is. It never reaches execToolCall — the
            // arguments could not be read — so this is the one call the dispatcher cannot report, and every
            // other call the sub-agent makes is visible there. A silent gap reads as a step that never
            // happened, which is exactly the wrong impression when the step is why the round was wasted.
            const callId = execution?.toolCall(tc.function.name, {});
            if (callId) execution?.toolResult(callId, tc.function.name, false, parsed.error, 0);
            return { tc, args: {} as Record<string, unknown>, content: parsed.error, ok: false };
          }
          const a = parsed.args;
          let ok = true;
          const content = await execToolCall(
            collectCtx,
            tc.function.name,
            a,
            `${label}→${tc.function.name}`,
            actor,
            null,
            (v) => {
              ok = v;
            },
          );
          return { tc, args: a, content, ok };
        };

        // Same batching rule as the main loop: consecutive read-only calls run concurrently, everything else
        // serial. No dispatcher unwrapping — a subagent's calls are executed by raw name.
        const groups = groupParallelCalls(calls, (tc) => tc.function.name, PARALLEL_SAFE_TOOLS);
        // Counted here, where the calls are issued. It used to be counted in `collectCtx.push`, which worked
        // only for as long as execToolCall pushed a bubble per call — it no longer does for a sub-agent, and
        // a step count that silently went to zero is exactly the kind of usage-log number nobody notices is
        // wrong. `steps` is what logSubagentRun records this delegation as having cost.
        stepCount += calls.length;
        const toolResults: ToolResult[] = [];
        for (const group of groups) {
          if (signal.aborted) break;
          const settled =
            group.length > 1 ? await Promise.all(group.map(runOne)) : [await runOne(group[0])];
          for (const { tc, args, content, ok } of settled) {
            // Compress overly long tool output, to avoid bloating the subagent context (its conversation is
            // not persisted and lives only for this delegation). read_file is exempt for the same reason as
            // the main loop: eliding the middle of a source file makes the conclusion unreliable.
            const capped = UNCAPPED_TOOLS.has(tc.function.name) ? content : capToolOutput(content);
            convo = [...convo, { role: "tool", tool_call_id: tc.id, content: capped }];
            toolResults.push({
              toolCallId: tc.id,
              name: tc.function.name,
              args,
              content: capped,
              ok,
              ms: 0,
            });
          }
        }
        return {
          content: lastContent,
          reasoning: subReasoning,
          toolResults,
          toolCallCount: calls.length,
        };
      },
    })
      .catch((e: unknown): AgentLoopResult => {
        // The loop can also end by THROWING — a provider rejection, a tool that raised.
        //
        // Under an aborted signal that throw IS the stop working: a stop pulled the signal under a request or
        // a tool in flight, and `fetch` rejects with the abort reason ("signal is aborted without reason")
        // rather than returning. Read as a failure, the Inspector showed that DOMException text as the
        // sub-agent's conclusion and painted the row red — for a delegation that did exactly what was asked
        // of it. So it is folded into the loop's own `cancelled` outcome, and the switch below handles it
        // exactly as a stop the loop noticed itself.
        if (signal.aborted) {
          return { stop: { stop: true, reason: "cancelled" }, state: initExecutionState(), turns: [] };
        }
        // Anything else is a real failure. The scheduler turns the throw into the job's `failed` outcome, so
        // without this the execution record would be the one place the delegation appeared to be still
        // running. Re-raised untouched: this observes, it does not handle.
        execution?.fail(e instanceof Error ? e.message : String(e), "error");
        throw e;
      })
      .finally(() => stop?.release());

    // Map the structured stop reason onto the delegation's own two-field outcome. Only `completed` is an
    // answer; everything else is a delegation that did not finish, and saying so is what stops a truncated
    // run from being recorded as a reusable conclusion (see finish()).
    switch (result.stop.reason) {
      case "completed": {
        const conclusion = lastContent || "(no output from subagent)";
        execution?.complete(conclusion);
        return finish(conclusion);
      }
      case "cancelled":
        // Cancellation is its own outcome, not a failure: the delegation did not go wrong, it was stopped.
        // The Inspector distinguishes them, and an interrupted turn showing three red rows would read as
        // three broken sub-agents (TODO §22, §25).
        execution?.cancel();
        // WHICH stop it was decides what the parent is told. The turn's: nobody reads the answer, the whole
        // turn is unwinding. This delegation's own (the Inspector's Stop): the main agent carries on, and
        // has to learn the work is incomplete and that the user chose that — or it delegates the task again.
        return finish(execution?.signal.aborted ? STOPPED_BY_USER_RESULT : "(canceled)", "cancelled");
      case "doom-loop": {
        const conclusion = lastContent || `(the ${agentId} sub-agent stopped making progress and was halted)`;
        execution?.fail(result.stop.detail || "the sub-agent stopped making progress", "doom-loop");
        return finish(conclusion, `doom-loop: ${result.stop.detail ?? ""}`.trim());
      }
      default: {
        const conclusion = lastContent || `(the ${agentId} sub-agent stopped: ${result.stop.reason})`;
        const reason = result.stop.reason ?? "error";
        execution?.fail(result.stop.detail || reason, reason);
        return finish(
          conclusion,
          result.stop.detail ? `${result.stop.reason}: ${result.stop.detail}` : result.stop.reason,
        );
      }
    }
  };
}
