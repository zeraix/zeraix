/**
 * Delegation — the sub-agent tools, and the per-turn machinery underneath them.
 *
 * Four tools live here, and they are one mechanism seen from four angles: `run_subagent` (one delegation,
 * awaited in place), `spawn_subagents` / `join_subagents` (many, concurrent, collected later), and
 * `spawn_sub_agent` (the brokered anonymous path, where the model names the tools a subtask needs and a
 * broker decides what it actually gets). With them come the two drains — the safety net that carries a
 * conclusion the model forgot to collect, and a background job's result, onto whatever tool result comes next.
 *
 * This is a turn-scoped module, which is the reason it can be one at all. A delegation's scheduler, its
 * repeat-guard bucket and its display bubbles all live and die with the turn that spawned them, so the
 * factory is called once per turn from `send()` rather than during render — and reading a ref from a turn,
 * unlike reading one while rendering, is exactly what refs are for.
 *
 * Two things deliberately did NOT move out of the component: `brokerRef`, which spans the whole mounted
 * chat so that grants and the audit trail outlive any one turn, and `orchestrationDeclsRef`. Both are
 * `useRef`, so their declarations must stay where hooks are legal; they arrive here as parameters.
 */
import { InMemoryAuditLog } from "@/lib/ai/orchestration/audit-log";
import { isKnownTool, type ToolDeclaration } from "@/lib/ai/orchestration/capabilities";
import type { CapabilityBroker } from "@/lib/ai/orchestration/capability-broker";
import { createConfiguredBroker, MAX_TURNS_PER_SUBAGENT } from "@/lib/ai/orchestration/config";
import { toChatMessages, toChatTools, toModelTurn } from "@/lib/ai/orchestration/openai-adapter";
import {
  createSpawnSubAgentHandler,
  // Aliased: `formatSpawnResult` is already taken by the fixed-role spawn_subagents path in subagents.ts,
  // and the two format different things.
  formatSpawnResult as formatBrokeredSpawn,
} from "@/lib/ai/orchestration/orchestrator-tool";
import type { ModelClient } from "@/lib/ai/orchestration/sub-agent-runner";
import { listTools, type ToolSchema } from "@/lib/ai/toolkit";
import {
  SUBAGENTS,
  delegationSubject, findRepeatDelegation, isSameDelegation, repeatDelegationResult,
  formatAutoDelivery, formatJoinResult, formatSpawnResult,
  MAX_PARALLEL_SUBAGENTS, MAX_SUBAGENTS_PER_TURN, JOIN_DEFAULT_TIMEOUT_MS, JOIN_MAX_TIMEOUT_MS,
  type DelegationMeta, type PriorDelegation,
} from "@/lib/ai/subagents";
import { SubAgentScheduler, type SchedulerLike } from "@/lib/ai/subagentScheduler";
import { createRuntimeScheduler } from "./runtimeScheduler";
import { logSubagentRun } from "@/lib/ai/usageLog";
import { formatJobDelivery } from "@/lib/ai/services";
import type { SandboxStatus } from "@/lib/ai/sandbox";
import type { TFunc } from "@/lib/i18n";
import { useAgentChatStore } from "@/store/agentChatStore";
import { createRunDelegation } from "./delegation";
import { applyReasoningPolicy } from "./wireHelpers";
import type { ApiMsg, ChatResponse, DisplayMsg, RequestLog, RunCtx, SubAgentStep } from "./types";
import type { ThinkingConfig } from "@/lib/ai/thinking";
import type { ModelCapabilities } from "@/lib/agent/modelAdapter";

/** The conversation's own request path, shared with the main loop so a delegation bills and logs identically. */
type RequestChat = (
  messages: ApiMsg[],
  tools?: unknown[],
  signal?: AbortSignal,
  onDelta?: (d: { content: string; reasoning: string }) => void,
  log?: RequestLog,
) => Promise<ChatResponse>;

/** The unified tool path (consent, sandbox, usage log). The brokered agent needs its two optional tails. */
type ExecToolCall = (
  ctx: RunCtx,
  name: string,
  args: Record<string, unknown>,
  displayName: string,
  actor?: string,
  requester?: { agentId: string; task: string } | null,
  onResult?: (ok: boolean) => void,
) => Promise<string>;

/** The tools and the two lifecycle handles the turn loop needs back. */
export interface DelegationTools {
  runSubAgent: (ctx: RunCtx, rawArgs: Record<string, unknown>) => Promise<string>;
  spawnSubagents: (ctx: RunCtx, rawArgs: Record<string, unknown>) => Promise<string>;
  joinSubagents: (ctx: RunCtx, rawArgs: Record<string, unknown>) => Promise<string>;
  spawnSubAgent: (ctx: RunCtx, rawArgs: Record<string, unknown>) => Promise<string>;
  /** Conclusions that landed while the model was elsewhere, for the next tool result to carry. */
  drainDelegations: (ctx: RunCtx) => string;
  /** Background `notify` job results, same ride. */
  drainJobEvents: (ctx: RunCtx) => string;
  /** Settle every outstanding job AND stop the loops producing them. Called from the turn's `finally`. */
  shutdownScheduler: (held: HeldScheduler) => void;
}

/** The turn's scheduler, held by the component so the turn's `finally` can still reach it. */
export interface HeldScheduler {
  turnId: string;
  /** Either implementation — the renderer's own, or the Rust runtime's. See `schedulerFor`. */
  sched: SchedulerLike<DelegationMeta>;
  stop: AbortController;
}

export interface DelegationDeps {
  t: TFunc;
  toolsReady: boolean;
  workdir: string;
  endpoint: string;
  isLocalModel: boolean;
  sendReasoningContext: () => boolean;
  /** The user's thinking setting. A sub-agent's reasoning policy clamps against it, exactly as the main one does. */
  thinking: ThinkingConfig;
  /** What the model can do (§5) — the gate on varying reasoning effort per round. */
  capabilities: ModelCapabilities;
  sandboxStatusRef: { current: SandboxStatus | null };
  requestChat: RequestChat;
  execToolCall: ExecToolCall;
  replaceDisplay: (target: DisplayMsg, next: DisplayMsg) => void;
  /** Where a delegation tool call parks its sub-agent trace, keyed by the args object identity. */
  /**
   * A WeakMap, not a Map, and keyed on the tool call's own args object: the sink dies with the call that
   * created it, so a long conversation does not accumulate one entry per delegation forever.
   */
  subagentSinksRef: {
    current: WeakMap<object, { convId: string; steps: SubAgentStep[]; storedIndex: number | null }>;
  };
  schedulerRef: { current: HeldScheduler | null };
  delegationsRef: { current: { turnId: string; done: PriorDelegation[] } };
  brokerRef: { current: { broker: CapabilityBroker; audit: InMemoryAuditLog } | null };
  orchestrationDeclsRef: { current: Map<string, ToolDeclaration> | null };
  pendingJobsRef: { current: Map<string, string[]> };
}

export function createDelegationTools(deps: DelegationDeps): DelegationTools {
  const {
    t,
    toolsReady,
    workdir,
    endpoint,
    isLocalModel,
    sendReasoningContext,
    thinking,
    capabilities,
    sandboxStatusRef,
    requestChat,
    execToolCall,
    replaceDisplay,
    subagentSinksRef,
    schedulerRef,
    delegationsRef,
    brokerRef,
    orchestrationDeclsRef,
    pendingJobsRef,
  } = deps;

  // ── Delegation plumbing ─────────────────────────────────────────────────────────────────────────
  //
  // Three call paths share one delegation loop: run_subagent (one delegation, blocking), and
  // spawn_subagents / join_subagents (many, concurrent, collected later). Only the loop is shared —
  // each path owns its own display bubble, because what the user should see differs: a lone delegation
  // settles its own bubble on its conclusion, whereas a fan-out keeps one bubble for the whole batch.

  /** Get (or create) the place a delegation tool call parks its sub-agent trace for persistence. */
  const delegationSink = (argsKey: object, convId: string) => {
    const existing = subagentSinksRef.current.get(argsKey);
    if (existing) return existing;
    const fresh = { convId, steps: [] as SubAgentStep[], storedIndex: null as number | null };
    subagentSinksRef.current.set(argsKey, fresh);
    return fresh;
  };

  /**
   * Record one sub-agent tool call against a sink, patching the stored message when it already exists.
   *
   * A blocking delegation finishes before its tool result is written, so its steps ride along with
   * appendMessage. A spawned one does not: it settles after that message is on disk, so its trace has to
   * be patched in — otherwise the operations the user watched happen would vanish on reload.
   */
  const recordStep = (
    sink: { convId: string; steps: SubAgentStep[]; storedIndex: number | null },
    step: SubAgentStep,
  ) => {
    sink.steps.push(step);
    if (sink.storedIndex != null) {
      useAgentChatStore.getState().setMessageSteps(sink.convId, sink.storedIndex, [...sink.steps]);
    }
  };

  /** Settle every outstanding job AND stop the loops still producing them. Both, always — see `stop` above. */
  const shutdownScheduler = (held: NonNullable<typeof schedulerRef.current>) => {
    held.sched.cancelAll();
    held.stop.abort();
  };

  /** The scheduler for the current turn, rebuilt (and the previous one shut down) when the turn changes. */
  const schedulerFor = (ctx: RunCtx): SchedulerLike<DelegationMeta> => {
    const held = schedulerRef.current;
    if (held && held.turnId === ctx.turnId) return held.sched;
    if (held) shutdownScheduler(held);
    const stop = new AbortController();
    const publishCounts = (s: SchedulerLike<DelegationMeta>) => {
      const c = s.counts();
      if (c.running + c.queued > 0) {
        ctx.status(t("chat.subagentsWorking", { running: c.running, queued: c.queued }));
      }
    };

    // Stage 4b: the Rust runtime schedules when it is available and switched on, and this window still
    // runs every delegation. Off by default -- see subagentBridge.mjs for why this one stage is opt-in
    // rather than flag-on-by-default like the others.
    const fromRuntime = createRuntimeScheduler<DelegationMeta>(ctx.turnId, () => {
      if (schedulerRef.current?.turnId === ctx.turnId) publishCounts(schedulerRef.current.sched);
    });
    if (fromRuntime) {
      const heldRuntime = { turnId: ctx.turnId, sched: fromRuntime as SchedulerLike<DelegationMeta>, stop };
      if (ctx.signal.aborted) shutdownScheduler(heldRuntime);
      else ctx.signal.addEventListener("abort", () => shutdownScheduler(heldRuntime), { once: true });
      schedulerRef.current = heldRuntime;
      return heldRuntime.sched;
    }

    // Annotated because `onChange` refers to `sched`, and an inferred type cannot close that loop.
    const sched: SubAgentScheduler<DelegationMeta> = new SubAgentScheduler<DelegationMeta>({
      limit: MAX_PARALLEL_SUBAGENTS,
      maxJobs: MAX_SUBAGENTS_PER_TURN,
      // The in-flight half of the repeat-delegation guard. The completed half (delegationsRef) can only
      // see delegations that already returned, so before this a model that spawned the same question
      // twice in one batch paid for both — the case fan-out makes easy and serial delegation never could.
      isDuplicate: (a, b) => isSameDelegation(a, b),
      onChange: () => publishCounts(sched),
    });
    const held2 = { turnId: ctx.turnId, sched, stop };
    // Cancelling the turn has to reach the scheduler directly, not via the run loop's `finally`: when the
    // user hits stop the loop is typically parked inside join_subagents, so waiting for the loop to unwind
    // would deadlock the cancel behind the very wait it is meant to interrupt.
    if (ctx.signal.aborted) shutdownScheduler(held2);
    else ctx.signal.addEventListener("abort", () => shutdownScheduler(held2), { once: true });
    schedulerRef.current = held2;
    return sched;
  };

  // One sub-agent, run to its conclusion in its own small loop. See delegation.ts — it needs no page state
  // beyond what is threaded in here, so it lives outside the component.
  // Same shape as createChatRequest, and it no longer needs the react-hooks/refs exemption that stood here:
  // this whole factory is called from a turn rather than from render, which is when reading a ref is legitimate.
  const runDelegation = createRunDelegation({
    t,
    toolsReady,
    workdir,
    endpoint,
    // Read when the delegation runs, not when this factory is built — see the note on the parameters.
    sandboxStatus: () => sandboxStatusRef.current,
    isLocalModel,
    sendReasoningContext,
    thinking,
    capabilities,
    requestChat,
    execToolCall,
    delegations: () => delegationsRef.current,
  });

  /**
   * Reset the completed-delegation record when the turn changes.
   *
   * Keyed by turnId rather than cleared at some end-of-turn point, because there is no single place a turn
   * is known to have ended (it can abort, be cancelled, or run in the background while another
   * conversation is active) — keying is the only reset that cannot leak one turn's delegations into the next.
   */
  const ensureTurnBucket = (ctx: RunCtx) => {
    const bucket = delegationsRef.current;
    if (bucket.turnId !== ctx.turnId) {
      bucket.turnId = ctx.turnId;
      bucket.done = [];
    }
    return bucket;
  };

  /** The repeat-guard reply, shown and logged like a real delegation so the saving is visible in the timeline. */
  const answerFromPriorDelegation = (ctx: RunCtx, agentId: string, task: string, prior: PriorDelegation) => {
    const answer = repeatDelegationResult(prior);
    logSubagentRun({
      agent: agentId, task, rounds: 0, steps: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      ms: 0, ok: true, error: "repeat: answered from an earlier delegation this turn",
      convId: ctx.convId, turnId: ctx.turnId,
    });
    return answer;
  };

  // run_subagent: one delegation, awaited in place. The simple path, unchanged in behaviour.
  const runSubAgent = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const agentId = String(rawArgs.agent ?? "");
    const task = String(rawArgs.task ?? "").trim();
    const def = SUBAGENTS.find((a) => a.id === agentId);
    if (!def) return `Unknown subagent: ${agentId}`;
    if (!task) return "task must not be empty.";

    const bucket = ensureTurnBucket(ctx);
    const repeat = findRepeatDelegation(agentId, task, bucket.done);
    if (repeat) {
      const answer = answerFromPriorDelegation(ctx, agentId, task, repeat);
      ctx.push({ kind: "tool", name: `run_subagent → ${agentId}`, args: { agent: agentId, task }, ok: true, result: answer });
      return answer;
    }

    // A "delegate" bubble, so the user can see what task the main model handed to which sub-agent. Its
    // `steps` grow in place as the sub-agent works, so the delegation is not an opaque wait.
    const sink = delegationSink(rawArgs, ctx.convId);
    // Typed as the tool variant, not the DisplayMsg union: `...bubble` below must keep the tool shape.
    let bubble: Extract<DisplayMsg, { kind: "tool" }> = {
      kind: "tool",
      name: `run_subagent → ${agentId}`,
      args: { agent: agentId, task },
      ok: true,
      result: task,
      steps: sink.steps,
    };
    ctx.push(bubble);
    // New object identity so memoized message components re-render; the array is copied for the same reason.
    const refresh = (result?: string) => {
      const next = { ...bubble, steps: [...sink.steps], ...(result != null ? { result } : {}) };
      replaceDisplay(bubble, next);
      bubble = next;
    };

    const { conclusion } = await runDelegation(ctx, {
      agentId,
      task,
      def,
      label: agentId,
      onStep: (s) => {
        recordStep(sink, s);
        refresh();
      },
      status: ctx.status,
    });
    // Settle the bubble on the conclusion. Live and reloaded views must agree, and the reload path rebuilds
    // `result` from the persisted tool content — which is the conclusion, not the task. Without this the
    // bubble showed the task while running and the conclusion after reopening.
    refresh(conclusion);
    return conclusion;
  };

  /**
   * spawn_subagents: start delegations concurrently and hand back their ids at once.
   *
   * Returns as soon as the jobs are registered — it never awaits them. That is the whole point: the model
   * gets its handles in the same round it asked, so it can keep working and then block exactly once in
   * join_subagents, instead of asking "are they done yet" every round.
   */
  const spawnSubagents = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const entries = Array.isArray(rawArgs.tasks) ? rawArgs.tasks : [];
    if (entries.length === 0) return "tasks must be a non-empty array of { agent, task } objects.";

    const bucket = ensureTurnBucket(ctx);
    const sched = schedulerFor(ctx);
    const sink = delegationSink(rawArgs, ctx.convId);
    // The delegations run on the scheduler's stop signal rather than the turn's. It fires on BOTH exits —
    // the user interrupting (ctx.signal is wired to shut the scheduler down) and the turn simply ending
    // with work in flight — whereas ctx.signal covers only the first, which is the exit a spawned
    // delegation is least likely to take.
    const jobCtx: RunCtx = { ...ctx, signal: schedulerRef.current!.stop.signal };

    // ONE bubble for the whole batch, whose trace collects every delegation's tool calls (each already
    // prefixed with its job id by runDelegation's label). Per-delegation bubbles would look right live and
    // then collapse on reload, because the batch persists as this single tool message.
    let bubble: Extract<DisplayMsg, { kind: "tool" }> = {
      kind: "tool",
      name: "spawn_subagents",
      args: rawArgs,
      ok: true,
      result: "",
      steps: sink.steps,
    };
    ctx.push(bubble);
    const refresh = (result?: string) => {
      const next = { ...bubble, steps: [...sink.steps], ...(result != null ? { result } : {}) };
      replaceDisplay(bubble, next);
      bubble = next;
    };

    const spawned: Array<{ id: string; agent: string; coalesced: boolean; refused?: string }> = [];
    const answered: string[] = [];
    for (const raw of entries) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const agentId = String(entry.agent ?? "");
      const task = String(entry.task ?? "").trim();
      const def = SUBAGENTS.find((a) => a.id === agentId);
      if (!def) {
        spawned.push({ id: "", agent: agentId || "(missing)", coalesced: false, refused: `unknown sub-agent "${agentId}"` });
        continue;
      }
      if (!task) {
        spawned.push({ id: "", agent: agentId, coalesced: false, refused: "task must not be empty" });
        continue;
      }
      // Completed-delegation guard: answer from the earlier conclusion instead of spawning a second copy.
      // Its in-flight counterpart lives in the scheduler's isDuplicate — together they cover both the
      // "asked again later" and the "asked twice in one batch" cases.
      const repeat = findRepeatDelegation(agentId, task, bucket.done);
      if (repeat) {
        answered.push(answerFromPriorDelegation(ctx, agentId, task, repeat));
        continue;
      }
      const meta: DelegationMeta = { agent: agentId, task, subject: delegationSubject(task) };
      const res = await sched.spawn(meta, async (job) => {
        const { conclusion } = await runDelegation(jobCtx, {
          agentId,
          task,
          def,
          label: `${job.id} ${agentId}`,
          onStep: (s) => {
            recordStep(sink, s);
            refresh();
          },
          // Per-delegation progress text is dropped on this path: concurrent delegations would fight over
          // the single status line. The scheduler's onChange publishes the aggregate instead.
          status: () => {},
        });
        return conclusion;
      });
      spawned.push({ id: res.id, agent: agentId, coalesced: res.coalesced, refused: res.refused });
    }

    const summary =
      formatSpawnResult(spawned) + (answered.length > 0 ? `\n\n${answered.join("\n\n")}` : "");
    refresh(summary);
    return summary;
  };

  /**
   * join_subagents: block until the named delegations finish, then return their conclusions.
   *
   * This is the call that replaces polling. It awaits the jobs' own promises, so the tool call is
   * suspended for exactly as long as the work takes and wakes the moment it is done — one model
   * round-trip for the whole wait, however long that is.
   */
  const joinSubagents = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const held = schedulerRef.current;
    const sched = held && held.turnId === ctx.turnId ? held.sched : null;
    if (!sched) return "No delegations have been spawned in this turn — call spawn_subagents first.";

    const ids = Array.isArray(rawArgs.ids)
      ? rawArgs.ids.map((v) => String(v)).filter((v) => v.length > 0)
      : null;
    const mode = rawArgs.mode === "any" ? "any" : "all";
    // Non-blocking collect: the model still has work in hand and wants what has already finished. The main
    // agent has exactly one thread of control, so a blocking join costs it every other action until the
    // delegations land — this is the escape hatch that lets it keep that time when it can still use it.
    const block = rawArgs.block !== false;
    const secs = typeof rawArgs.timeout_seconds === "number" ? rawArgs.timeout_seconds : null;
    const timeoutMs =
      secs != null && secs > 0 ? Math.min(secs * 1000, JOIN_MAX_TIMEOUT_MS) : JOIN_DEFAULT_TIMEOUT_MS;

    const before = sched.counts();
    if (block) ctx.status(t("chat.subagentsJoin", { done: before.settled, total: before.total }));
    let bubble: Extract<DisplayMsg, { kind: "tool" }> = {
      kind: "tool",
      name: "join_subagents",
      args: rawArgs,
      ok: true,
      result: t("chat.subagentsJoin", { done: before.settled, total: before.total }),
    };
    ctx.push(bubble);

    const r = await sched.join(ids && ids.length > 0 ? ids : null, { mode, timeoutMs, block });
    const text = formatJoinResult(
      r.ready.map((x) => ({
        meta: x.job.meta,
        id: x.outcome.id,
        state: x.outcome.state,
        result: x.outcome.result,
      })),
      r.pending,
      r.unknown,
      r.timedOut,
      block,
    );
    const next = { ...bubble, result: text };
    replaceDisplay(bubble, next);
    bubble = next;
    return text;
  };

  /**
   * Conclusions that landed while the model was doing something else, appended to whatever tool result
   * comes next.
   *
   * The safety net under spawn/join: a delegation the model forgets to collect is work already paid for,
   * and without this it would be silently discarded when the turn ends. Empty string when there is
   * nothing to deliver, so the common case adds no bytes to the wire.
   */
  // ── Brokered anonymous sub-agents (spawn_sub_agent) ─────────────────────────────────────────────
  //
  // The fixed roles above (run_subagent / spawn_subagents) keep their static tool lists and do not touch
  // any of this. What follows is the other path: the model names the tools a subtask needs, a broker in
  // src/lib/ai/orchestration decides what it actually gets, and the sub-agent is re-checked before every
  // single tool call. See capability-broker.ts for why that decision is pure code and never the model's.
  //
  // Tool execution routes back through execToolCall rather than calling the toolkit directly, so a brokered
  // sub-agent's actions land in the same timeline, the same usage log, and the same consent panel as
  // everything else. Two consent systems for one app would be a way to have neither.

  const getBroker = () => {
    if (!brokerRef.current) {
      const audit = new InMemoryAuditLog();
      brokerRef.current = {
        audit,
        broker: createConfiguredBroker({
          audit,
          // High-risk tools are approved per call by the consent panel below, which is a strictly finer
          // gate than one yes at grant time — so the grant-time path must not ALSO prompt, or the user
          // answers twice for the same action. Denying here and confirming there would refuse the grant
          // outright; approving here and confirming there is the behaviour we want.
          approver: { id: "renderer:per-call-consent", approve: async () => true },
        }),
      };
    }
    return brokerRef.current;
  };

  const getOrchestrationDecls = async () => {
    if (!orchestrationDeclsRef.current) {
      const map = new Map<string, ToolDeclaration>();
      if (toolsReady) {
        for (const t of (await listTools("raw")) as ToolSchema[]) {
          // Unclassified names — MCP tools above all — can never be granted, so they are not offered.
          if (!isKnownTool(t.name)) continue;
          map.set(t.name, { name: t.name, description: t.description, input_schema: t.parameters as never });
        }
      }
      orchestrationDeclsRef.current = map;
    }
    return orchestrationDeclsRef.current;
  };

  const spawnSubAgent = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    if (!toolsReady) return "spawn_sub_agent needs local tools, which are unavailable in this environment.";
    const task = String(rawArgs.task ?? "");
    const decls = await getOrchestrationDecls();
    const { broker } = getBroker();
    const sink = delegationSink(rawArgs, ctx.convId);

    const client: ModelClient = {
      async send(req) {
        // Reuses the conversation's own request path — same provider, key, proxy and usage logging as
        // every other call. Only the message and tool translation is ours.
        const data = await requestChat(
          applyReasoningPolicy(
            toChatMessages(req.system, req.messages) as unknown as ApiMsg[],
            isLocalModel,
            sendReasoningContext(),
          ),
          req.tools.length ? toChatTools(req.tools) : undefined,
          ctx.signal,
        );
        return toModelTurn(data);
      },
    };

    const result = await createSpawnSubAgentHandler({
      broker,
      client,
      requesterId: `conv:${ctx.convId}`,
      maxTurns: MAX_TURNS_PER_SUBAGENT,
      tools: {
        declarationFor: (name) => decls.get(name),
        execute: async (name, input, context) => {
          let ok = true;
          const content = await execToolCall(
            ctx,
            name,
            input,
            `${context.agentId}→${name}`,
            `sub:${context.agentId}`,
            { agentId: context.agentId, task },
            (v) => {
              ok = v;
            },
          );
          recordStep(sink, { name, args: input, ok, result: content });
          return { content, isError: !ok };
        },
      },
    })(rawArgs);

    ctx.push({
      kind: "tool",
      name: `spawn_sub_agent → ${result.agentId ?? "(not created)"}`,
      args: rawArgs,
      ok: result.status === "completed",
      result: formatBrokeredSpawn(result),
    });
    return formatBrokeredSpawn(result);
  };

  /**
   * Background jobs that reported back during this turn, formatted to ride the next tool result.
   *
   * The counterpart to drainDelegations below, and it exists for the same reason: work that finishes while the
   * model is mid-turn has no other way in. Keyed by conversation, so a job belonging to a background
   * conversation is not handed to whichever turn happens to be running.
   */
  const drainJobEvents = (ctx: RunCtx): string => {
    const held = pendingJobsRef.current.get(ctx.convId);
    if (!held || held.length === 0) return "";
    pendingJobsRef.current.delete(ctx.convId);
    return formatJobDelivery(held);
  };

  const drainDelegations = (ctx: RunCtx): string => {
    const held = schedulerRef.current;
    if (!held || held.turnId !== ctx.turnId) return "";
    const ready = held.sched.drain();
    if (ready.length === 0) return "";
    return formatAutoDelivery(
      ready.map((x) => ({
        meta: x.job.meta,
        id: x.outcome.id,
        state: x.outcome.state,
        result: x.outcome.result,
      })),
    );
  };

  return {
    runSubAgent,
    spawnSubagents,
    joinSubagents,
    spawnSubAgent,
    drainDelegations,
    drainJobEvents,
    shutdownScheduler,
  };
}
