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
import { detectServices } from "@/store/servicesStore";
import { isSandboxEngine, sandboxEnvHint, type SandboxStatus } from "@/lib/ai/sandbox";
import {
  delegationSubject,
  SUBAGENT_TOOL_DISCIPLINE,
  type PriorDelegation,
  type SubAgentDef,
} from "@/lib/ai/subagents";
import { listTools } from "@/lib/ai/toolkit";
import { logSubagentRun } from "@/lib/ai/usageLog";
import type { TFunc } from "@/lib/i18n";
import { capToolOutput } from "./compress";
import { PARALLEL_SAFE_TOOLS, UNCAPPED_TOOLS, WORKDIR_SCOPE_RULE, workdirPrompt } from "./constants";
import { groupParallelCalls } from "./sendPrep";
import type { ApiMsg, ChatResponse, RunCtx, SubAgentStep } from "./types";
import { applyReasoningPolicy } from "./wireHelpers";

/** What one delegation is asked to do, plus where its progress goes. */
export type DelegationOpts = {
  agentId: string;
  task: string;
  def: SubAgentDef;
  /** Distinguishes concurrent delegations in the trace and the usage log ("s2 explore"). */
  label: string;
  onStep: (s: SubAgentStep) => void;
  status: (s: string) => void;
};

export function createRunDelegation(deps: {
  t: TFunc;
  /** Electron only: without local tools a sub-agent runs with no tool set at all. */
  toolsReady: boolean;
  workdir: string;
  /** Called at delegation time, not here — the VM can come up or fall back mid-conversation. */
  sandboxStatus: () => SandboxStatus | null;
  isLocalModel: boolean;
  sendReasoningContext: () => boolean;
  requestChat: (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    onDelta?: (d: { content: string; reasoning: string }) => void,
    log?: { actor: string; convId?: string; turnId?: string },
  ) => Promise<ChatResponse>;
  execToolCall: (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    actor?: string,
  ) => Promise<string>;
  /** This turn's completed delegations — the repeat-delegation guard reads it, likewise at delegation time. */
  delegations: () => { turnId: string; done: PriorDelegation[] };
}) {
  const {
    t,
    toolsReady,
    workdir,
    sandboxStatus,
    isLocalModel,
    sendReasoningContext,
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
    const { agentId, task, def, label } = opts;
    opts.status(t("chat.subagentProcessing", { agent: agentId }));

    // Usage-log bookkeeping for this delegation. The sub-agent's own rounds are counted here rather
    // than read back off turnUsageRef: that ref accumulates every conversation generating at the same
    // time, so a background turn running in parallel would be billed to whichever delegation was open.
    const startedAt = Date.now();
    // `label`, not `agentId`: three concurrent `explore` delegations would otherwise share one actor and
    // the usage log could no longer say which of them spent what.
    const actor = `sub:${label}`;
    const subLog = { actor, convId: ctx.convId, turnId: ctx.turnId };
    const subUsage = { prompt: 0, completion: 0, total: 0 };
    let rounds = 0;
    let stepCount = 0;

    // The sub-agent's internal tool calls are reported through onStep rather than pushed as sibling
    // bubbles. Siblings were the obvious approach and are wrong: a delegation persists as a single tool
    // message, so N sibling bubbles seen live would collapse to one on reload. Nesting keeps live and
    // reloaded identical (StoredMessage.steps) — and the user still sees every operation.
    const collectCtx: RunCtx = {
      ...ctx,
      push: (m) => {
        if (m.kind !== "tool") return; // the subagent has no path to choice cards / usage rows
        stepCount++;
        opts.onStep({ name: m.name, args: m.args, ok: m.ok, result: m.result });
      },
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

    // No upper limit on subagent rounds: loop until the subagent produces final text, or the user interrupts (using this run's own signal).
    while (true) {
      if (ctx.signal.aborted) return finish("(canceled)", "cancelled");
      opts.status(t("chat.subagentThinking", { agent: agentId }));
      // The subagent bypasses the main wire pipeline, so the policy is applied here too — without it the thinking text carried
      // on `convo` below would reach every provider, including the ones that reject the field.
      const data = await requestChat(
        applyReasoningPolicy(convo, isLocalModel, sendReasoningContext()),
        subTools,
        ctx.signal,
        undefined,
        subLog,
      );
      rounds++;
      const u = data.usage;
      if (u) {
        subUsage.prompt += u.prompt_tokens ?? 0;
        subUsage.completion += u.completion_tokens ?? 0;
        subUsage.total += u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
      }
      if (ctx.signal.aborted) return finish("(canceled)", "cancelled");
      const msg = data.choices?.[0]?.message;
      if (!msg) return finish("(no response from subagent)", "no response");
      // Rebuilt field-by-field rather than spread: the response type allows `null` for the reasoning fields, while the wire
      // buffer wants "absent or a string". A subagent runs its own tool loop against the same model, so it has the same
      // prefix break to avoid — carry the thinking text, and let applyReasoningPolicy above decide who actually receives it.
      const subReasoning = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
      convo = [
        ...convo,
        {
          role: "assistant",
          content: msg.content,
          ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
          ...(subReasoning ? { reasoning_content: subReasoning } : {}),
        },
      ];

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const runOne = async (tc: (typeof msg.tool_calls)[number]) => {
          let a: Record<string, unknown> = {};
          try {
            a = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* Invalid JSON arguments, call with an empty object */
          }
          const content = await execToolCall(collectCtx, tc.function.name, a, `${label}→${tc.function.name}`, actor);
          return { tc, content };
        };

        // Same batching rule as the main loop: consecutive read-only calls run concurrently, everything else serial.
        // No dispatcher unwrapping here — a subagent's calls are executed by raw name (see execToolCall below).
        const groups = groupParallelCalls(
          msg.tool_calls,
          (tc) => tc.function.name,
          PARALLEL_SAFE_TOOLS,
        );

        for (const group of groups) {
          if (ctx.signal.aborted) return finish("(canceled)", "cancelled");
          const settled =
            group.length > 1 ? await Promise.all(group.map(runOne)) : [await runOne(group[0])];
          for (const { tc, content } of settled) {
            if (typeof content === "string") detectServices(content);
            // Compress overly long tool output, to avoid bloating the subagent context (the subagent conversation is not persisted and only lives for this delegation).
            // read_file is exempt for the same reason as the main loop: eliding the middle of a source file makes the subagent's conclusion unreliable.
            const capped = UNCAPPED_TOOLS.has(tc.function.name) ? content : capToolOutput(content);
            convo = [...convo, { role: "tool", tool_call_id: tc.id, content: capped }];
          }
        }
        continue;
      }
      return finish(msg.content || "(no output from subagent)");
    }
  };
}
