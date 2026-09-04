import { countMessagesTokens, countTokens } from "@/lib/ai/tokenizer";
import { logContextDiag, logToolCall, isUsageLogEnabledSync } from "@/lib/ai/usageLog";
import { resolveContextWindow, type ResolvedModel } from "@/lib/ai/models";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import { sanitizeToolCallArguments } from "@/lib/ai/toolArgs";
import { useAgentChatStore } from "@/store/agentChatStore";
import { prepareWire, type WireSteps } from "@/lib/agent/contextManager";
import {
  noObligations,
  recordTool,
  dueReminders,
  unansweredCalls,
  type ToolRuntimeRules,
  type TurnObligations,
} from "@/lib/agent/toolRuntime";
import type { ToolResult } from "@/lib/agent/turn";
import type { RoundRequest, RoundResult } from "@/lib/agent/agentLoop";
import type { ConsentRequester } from "./ConsentPanel";
import type { createChatRequest } from "./chatRequest";
import type { RuntimeBoundary } from "@/lib/agent/runtimeBoundary";
import { describeContext } from "./contextDiag";
import { capToolOutput } from "./compress";
import { resultCeilingTokens } from "./contextCompress";
import { phaseSummaryText, thinkingProcessText } from "./wireHelpers";
import { groupParallelCalls, resolveToolCalls, type ResolvedCall } from "./sendPrep";
import { isGoalActive, recordEvidence, type GoalState } from "./goalState";
import type { RendererTool } from "./chatTools";
import type { TurnBuffer } from "./turnBuffer";
import type { ApiMsg, DisplayMsg, RunCtx, ToolCall } from "./types";
import {
  DELEGATION_TOOLS,
  FINALIZE_NUDGE,
  FORCE_REVIEW_NUDGE,
  PENDING_DELEGATION_NUDGE,
  RECORD_MEMORY_NUDGE,
  RENDERER_HANDLED_TOOLS,
  PARALLEL_SAFE_TOOLS,
  UNCAPPED_TOOLS,
} from "./constants";

/**
 * What the turn's last round left behind for the post-loop work.
 *
 * The goal evaluator judges the transcript that was actually sent plus the answer it produced, and the reply
 * notification quotes that answer — both run after the loop, so the round that produced them has to record
 * them somewhere the loop's caller can still read.
 */
export interface RoundLog {
  lastWire: ApiMsg[];
  lastContent: string;
}

export interface RoundRunnerDeps {
  // ── Identity and lifetime ────────────────────────────────────────────────────────────────────────────────
  convId: string;
  turnId: string;
  signal: AbortSignal;
  /** Whether this conversation is the one on screen: a background turn persists but must not write the view. */
  active: () => boolean;
  t: (key: string, vars?: Record<string, string>) => string;

  // ── This turn's state ────────────────────────────────────────────────────────────────────────────────────
  buf: TurnBuffer;
  /** The compaction plan frozen at the start of the turn; the wire is derived through it every round. */
  compaction: unknown;
  log: RoundLog;

  // ── Model and request ────────────────────────────────────────────────────────────────────────────────────
  activeModel: ResolvedModel | null;
  modelName: string;
  isLocalModel: boolean;
  sendReasoningContext: () => boolean;
  wireSteps: WireSteps;
  /** The tool declarations for this turn. Withdrawn by the loop guard by being handed an empty list. */
  tools: unknown[];
  requestChat: ReturnType<typeof createChatRequest>["requestChat"];
  boundary: RuntimeBoundary;
  ctx: RunCtx;

  // ── Tools ────────────────────────────────────────────────────────────────────────────────────────────────
  /** The renderer's own tools, dispatched by name; everything else falls through to execToolCall. */
  rendererTools: Record<string, RendererTool>;
  execToolCall: (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    actor?: string,
    requester?: ConsentRequester | null,
    onResult?: (ok: boolean) => void,
  ) => Promise<string>;
  toolRules: ToolRuntimeRules;
  /** A delegation that finished while a tool was running rides back on that tool's result. */
  drainDelegations: (ctx: RunCtx) => string;
  drainJobEvents: (ctx: RunCtx) => string;

  // ── Host state the round reads or writes ─────────────────────────────────────────────────────────────────
  displayRef: React.RefObject<DisplayMsg[]>;
  setDisplay: (next: DisplayMsg[]) => void;
  setCtxTokens: (n: number) => void;
  diagRef: React.RefObject<{ messages: ApiMsg[]; tools: unknown[]; contextWindow: number }>;
  lastArtifactRef: React.RefObject<{ src: string; kind: "image" | "video"; servedBy?: string } | null>;
  schedulerRef: React.RefObject<{ turnId: string; sched: { outstanding: () => unknown[] } } | null>;
  awaitingJobsRef: React.RefObject<Map<string, number>>;
  tagLastAssistantStoredIndex: (idx: number) => void;
  goalFor: (convId: string | null) => GoalState;
  setGoalFor: (convId: string | null, g: GoalState) => void;
  /** Rebind where a streaming delta goes; the renderer closes over this round's display baseline. */
  setRenderDelta: (fn: (content: string, reasoning: string) => void) => void;
}

/**
 * One round of the turn: build the wire, make the request, execute whatever tools came back, and report the
 * result to the agent loop.
 *
 * The factory holds the per-TURN latches — the obligations ledger and the three wrap-up guards — because each
 * of them fires at most once for the whole turn, not once per round. A nudge the model reads and declines must
 * not be re-injected, or the turn cannot end.
 *
 * Everything about when to stop belongs to runAgentLoop, not here (docs/agent-runtime-loop.md §20 rule 7):
 * this function only ever reports what a round produced.
 */
export function createRoundRunner(deps: RoundRunnerDeps) {
  const {
    convId: genConvId, turnId, signal, active, t,
    buf, compaction, log,
    activeModel, modelName, isLocalModel, sendReasoningContext, wireSteps, tools, requestChat, boundary, ctx,
    rendererTools, execToolCall, toolRules, drainDelegations, drainJobEvents,
    displayRef, setDisplay, setCtxTokens, diagRef, lastArtifactRef, schedulerRef,
    awaitingJobsRef, tagLastAssistantStoredIndex, goalFor, setGoalFor, setRenderDelta,
  } = deps;
  const ctrl = { signal };
  const store = useAgentChatStore.getState();
  const nudgeIntoLastTool = buf.nudgeIntoLastTool;

  // What this turn owes: a review for a risky change, a note to project memory for a source edit. Both
  // fire at most once per turn — a reminder the model reads and declines must not be re-injected, or the
  // turn cannot end. See toolRuntime.ts, which is where the rules and the latches now live (M5b).
  let obligations: TurnObligations = noObligations();
  // Wrap-up guard: whether a tool was executed this turn (including subagents). If a tool was executed yet the model ends with empty content (no user-facing
  // final answer, common when the main model "assumes it's done" and stays silent after a subagent returns a result, or writes the conclusion into reasoning),
  // inject one FINALIZE_NUDGE to nudge it to answer formally. finalizeNudged ensures at most once per turn, to avoid an infinite loop.
  let didToolCall = false;
  let finalizeNudged = false;
  // Wrap-up guard: whether the model has already been told once that it is ending the turn with
  // delegations still running. See PENDING_DELEGATION_NUDGE.
  let delegationNudged = false;

  return async ({ reasoning: roundReasoning }: RoundRequest): Promise<RoundResult> => {
    ctx.status(t("chat.thinking"));
    // Wire view: the "sent to the model" version of this round's local buffer derived through the compaction plan (a background conversation does not depend on the active view).
    // Also backfill tool-call pairing as a fallback: prevents assistant.tool_calls with missing results from getting a 400 from the provider when "reopening an interrupted / backend-crashed conversation".
    // The buffer → wire transformation (docs/agent-runtime-loop.md §10, M5a). Six steps that used to sit
    // inline here; their ORDER is the specification and is documented in contextManager.ts. The steps
    // themselves are unchanged and are passed in, so the mature modules that implement them
    // (contextCompress / reminders / wireHelpers) stay the single implementation.
    //
    // The runtime context (time zone, date, current model) used to be concatenated into messages[0] on
    // every request, which re-prefilled the whole conversation at every midnight and every model switch.
    // It is announced once, when it changes, as a change event above. Likewise the interrupt-resume and
    // rating hints, and Task Memory — all written into the turn itself before the loop starts, so they
    // persist and the turn renders identically on every later request.
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
        // Otherwise invisible: the request goes out with the pictures replaced by "N image(s) omitted",
        // the model answers that it cannot see images, and nothing on screen says the app removed them.
        // If this fires for a model that DOES support vision, the verdict behind it is in the model list
        // (visionUnsupported) and settings offers a reset.
        console.warn(
          `[vision] stripping images for ${modelId} — it is a local build without ` +
            "an mmproj projector, or a provider rejected image input for it within the last day",
        ),
    });
    // Context diagnostics (Phase 1, measurement only): snapshot exactly what is about to be sent —
    // buckets + the tool-schema tax the app's own estimate never counts + the redundant-re-read proxy.
    // Also stash the wire/tools/window so the offline replay harness can simulate budgets on this task.
    {
      const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
      diagRef.current = { messages: wire, tools, contextWindow: cw };
      if (isUsageLogEnabledSync()) {
        const b = describeContext(wire, tools);
        logContextDiag({
          actor: "main",
          convId: genConvId,
          turnId,
          model: modelName,
          ctxWindow: cw,
          ctxSystem: b.system,
          ctxToolSchemas: b.toolSchemas,
          ctxHistory: b.history,
          ctxToolOutputs: b.toolOutputs,
          ctxSubagent: b.subagentOutputs,
          ctxTotal: b.total,
          ctxWire: b.wireTotal,
          rereads: b.rereads,
          msgCount: b.msgCount,
        });
      }
    }
    // Phased streaming: the final reply's content / reasoning renders chunk by chunk, and each "tool-call round" body is
    // shown as that phase's summary (phaseSummaryText strips the chain-of-thought remnants), presenting the process of
    // "phase summary → execute → next phase summary …". Daily mode used to discard tool-round bodies instead; with the
    // modes merged, the phased presentation is the only one.
    const wantIncremental = true;
    const showPhaseSummary = true;
    // This round's display baseline = the display array before this round started (only meaningful in the active view; a background conversation does not touch the active view).
    const liveBase = active() ? displayRef.current : [];
    // Shared by finalization / increments: rebuild this round's display as [baseline, deep-thinking?, body?] (only effective in the active view).
    // asPhase: the body is "the phase summary of a tool-call round" — collected into the card as a "thinking process" timeline entry,
    // rather than a standalone final reply; a final reply with no tool calls goes to assistant (a standalone bubble + action bar).
    // When this round's request went out. The thinking-process header reports how long the model took, and this is
    // the only honest place to measure it from: the gap between two stored messages also covers tool execution,
    // and for a background conversation, however long the user left it sitting.
    const roundStart = Date.now();
    const renderTurn = (reasoning: string, content: string, asPhase = false) => {
      if (!active()) return;
      const ms = Date.now() - roundStart;
      const items: DisplayMsg[] = [];
      if (reasoning) items.push({ kind: "reasoning", content: reasoning, ms });
      if (content) items.push(asPhase ? { kind: "phase", content, ms } : { kind: "assistant", content });
      const next = [...liveBase, ...items];
      displayRef.current = next;
      setDisplay(next);
    };
    // Streaming always renders incrementally as a normal reply bubble (so the final reply forms smoothly); if this round ultimately carries tool calls,
    // the finalization below with asPhase=true folds that body into the "thinking process" timeline (exactly in sync with the tools starting to execute).
    // Each delta re-measures, so the header counts up while the round runs instead of appearing only at the end.
    setRenderDelta((content, reasoning) =>
      renderTurn(reasoning, showPhaseSummary ? phaseSummaryText(content) : content));
    // Routed through the boundary (§13): the request path emits a delta, the host decides what a delta
    // looks like. Still `undefined` when incremental rendering is off, because that is what tells
    // requestChat to use the non-streaming transport — a no-op callback would silently switch it to
    // streaming and change how every provider error surfaces.
    const onDelta =
      wantIncremental && active()
        ? (d: { content: string; reasoning: string }) =>
            boundary.onEvent({ type: "delta", content: d.content, reasoning: d.reasoning })
        : undefined;
    // Tools are withdrawn from the round after the loop guard fires onward, which is the whole mechanism: an
    // instruction to stop calling tools is a request the model can decline by calling a tool, whereas an
    // empty tool set is not. requestChat omits the field entirely when the list is empty (see
    // sendChatOnce), so the provider is told nothing is callable rather than being handed an empty array.
    log.lastWire = wire;
    const data = await requestChat(
      wire,
      tools,
      ctrl.signal,
      onDelta,
      { actor: "main", convId: genConvId, turnId },
      roundReasoning.config,
    );
    // Cancelled mid-round. Reported as an empty round rather than by returning from send():
    // the loop re-checks the signal and stops with reason `cancelled`, so there is one place
    // that decides a run has ended (after the request).
    if (ctrl.signal.aborted) return { content: "", reasoning: "", toolResults: [], toolCallCount: 0 };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(t("chat.emptyResponse"));
    // Context usage: this request's input tokens (refresh the progress bar only while active; a background conversation does not touch the current view).
    if (active()) setCtxTokens(data.usage?.prompt_tokens ?? countMessagesTokens(wire));
    // Deep thinking (a reasoning model's reasoning_content): kept on the buffer; whether it is fed back is applyReasoningPolicy's call.
    const reasoningText = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
    // Finalize this round's display: the deep-thinking block + body. A final reply with no tool calls always shows the
    // body; the body of a tool-call round becomes this round's thinking-process text, kept whole — the streaming
    // bubble above trimmed the chain of thought off to stay readable mid-turn, and this is where it comes back.
    const finalContent = msg.tool_calls?.length
      ? showPhaseSummary
        ? thinkingProcessText(msg.content ?? "")
        : ""
      : msg.content ?? "";
    // The phase summary of a tool-call round enters the "thinking process" timeline (asPhase); a final reply with no tool calls becomes a standalone bubble.
    renderTurn(reasoningText, finalContent, !!msg.tool_calls?.length);
    // reasoning_content rides the buffer so it is available to replay, but applyReasoningPolicy decides whether it reaches
    // the wire: by default local models only, and only for turns after the last user query, which is exactly what their
    // chat template renders back; with "send thinking as context" on, every model gets every turn's thinking.
    // Repaired before it reaches the wire or storage, never before execution: `resolveToolCalls` below still
    // sees exactly what the model emitted, so the error it reports and the partial it recovers are unchanged.
    // What changes is only the copy that gets REPLAYED — a tool call whose `arguments` are not valid JSON is
    // rejected by the provider on every later request, which kills the conversation rather than the round.
    // Same array back when nothing needed fixing, so a healthy turn keeps its byte-identical prefix.
    const wireToolCalls = msg.tool_calls?.length ? sanitizeToolCallArguments(msg.tool_calls) : undefined;
    buf.push(
      wireToolCalls?.length
        ? { role: "assistant", content: msg.content ?? null, tool_calls: [...wireToolCalls], ...(reasoningText ? { reasoning_content: reasoningText } : {}) }
        : { role: "assistant", content: msg.content ?? null, ...(reasoningText ? { reasoning_content: reasoningText } : {}) },
    );

    // Persist the assistant message (including the tool calls it issued) to this conversation (genConvId), so that after reopening / switching back the model still knows what it did.
    // A plain-text final reply is also persisted here (the wrap-up below does not archive it again).
    if (msg.content || msg.tool_calls?.length || reasoningText) {
      store.appendMessage(genConvId, {
        role: "assistant",
        content: msg.content ?? "",
        // The repaired copy, for the same reason: a conversation reopened from disk rebuilds its wire history
        // from these, so persisting the malformed original would resurrect the 400 on every future session.
        ...(wireToolCalls?.length ? { tool_calls: [...wireToolCalls] } : {}),
        ...(reasoningText ? { reasoning: reasoningText } : {}),
        // Persisted so a reopened conversation still reports how long each round took, rather than showing the
        // duration only until the view is rebuilt from disk.
        thinkMs: Date.now() - roundStart,
        ts: Date.now(),
      });
      // After persisting the final reply (no tool calls, has body): attach its archive index to the just-rendered display entry,
      // so it can be rated and persisted within this conversation (otherwise the storedIndex would only be obtained on the next loadConversation rebuild).
      if (active() && !msg.tool_calls?.length && (msg.content ?? "").trim()) {
        const idx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;
        if (idx >= 0) tagLastAssistantStoredIndex(idx);
      }
    }

    // Has tool calls → execute them, feed the results back, and continue to the next round.
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      didToolCall = true; // A tool was executed this round: provides the basis for the "empty-content wrap-up" guard
      const calls = msg.tool_calls;
      // Resolved ONCE, up front: everything downstream keys on the RESOLVED name, never on what the model
      // emitted (see resolveToolCalls).
      const resolved = resolveToolCalls(calls);
      const callOf = (tc: ToolCall): ResolvedCall =>
        resolved.get(tc) ?? { name: tc.function.name, args: {} };

      // ask_user: pop a choice card and wait for the user to click.
      // update_todos: update the task list above the input box.
      // load_skill: feed back the full instructions of an enabled skill as the tool result (progressive disclosure).
      // run_subagent: delegate to a subagent and feed back its final conclusion as the tool result.
      // Other tools: executed through the unified path (including sensitive-operation confirmation).
      const runToolCall = async (tc: ToolCall) => {
        const { name, args, argError } = callOf(tc);
        const startedAt = Date.now();
        // Arguments that could not be read: report that, and run nothing. Executing with `{}` instead made the tool answer
        // with its own "missing required parameter", which reads as a schema disagreement over arguments the model can see
        // itself having sent — and sends it off correcting a shape that was already right. See parseToolArguments.
        if (argError) {
          ctx.push({ kind: "tool", name, args: {}, ok: false, result: argError });
          // Logged here because neither logging site downstream is reached: execToolCall never runs, and the
          // renderer-tool log below is past the return. A round that burned a full prompt and produced no call is
          // exactly what someone reading the usage log is looking for.
          logToolCall({
            actor: "main",
            name,
            args: {},
            ok: false,
            result: argError,
            resultTokens: isUsageLogEnabledSync() ? countTokens(argError) : undefined,
            ms: Date.now() - startedAt,
            convId: genConvId,
            turnId,
          });
          return { tc, name, args, content: argError, ok: false };
        }
        // Renderer-handled tools dispatch by name to their local handler (see rendererTools); everything
        // else falls through to execToolCall (the unified sandbox/consent path).
        const handler = rendererTools[name];
        // Whether the call succeeded, for the loop guard's repeated-failure signal. execToolCall folds a
        // failure into the text it returns, so the distinction is only available through this callback;
        // renderer-handled tools (a choice card, the todo list, the browser panel) have no failure mode
        // that reaches here, hence the true default rather than a guess parsed out of their text.
        let callOk = true;
        const base = handler
          ? await handler(ctx, args)
          : await execToolCall(ctx, name, args, name, "main", null, (v) => {
              callOk = v;
            });
        // Auto-delivery: a delegation that finished while this tool was running rides back on its
        // result. Appended here, at the one point every tool result passes through, so the model
        // cannot lose a conclusion by never calling join_subagents — and so it has no reason to poll
        // for one. Deliberately skipped on join_subagents itself, which already reported everything
        // it was owed and would otherwise print the same conclusions twice in one result.
        // Background job results ride back the same way, and unconditionally — join_subagents is exempt
        // from the delegation drain because it has already reported those, but it has said nothing about
        // a build that finished while it was blocking.
        const content =
          (name === "join_subagents" ? base : base + drainDelegations(ctx)) + drainJobEvents(ctx);
        // Usage log: the branches above are the tools the renderer handles itself (a choice card,
        // the todo list, a skill's instructions, memory, the browser panel). They never reach
        // execToolCall, which is where every other tool is logged, so without this they would be
        // the one class of action missing from the timeline. run_subagent is absent from the set
        // because runSubAgent logs the delegation itself, with its rounds and tokens.
        if (RENDERER_HANDLED_TOOLS.has(name)) {
          logToolCall({
            actor: "main",
            name,
            args,
            ok: true,
            result: content,
            resultTokens: isUsageLogEnabledSync() ? countTokens(content) : undefined,
            ms: Date.now() - startedAt,
            convId: genConvId,
            turnId,
          });
        }
        return { tc, name, args, content, ok: callOk };
      };

      // Batched on the RESOLVED name, so a dispatched read is recognised as read-only (see groupParallelCalls).
      const groups = groupParallelCalls(calls, (tc) => callOf(tc).name, PARALLEL_SAFE_TOOLS);

      // The loop guard's reading of every call in THIS round, judged together once the round is complete:
      // a round is only stalled when nothing in it was productive, so a single real result anywhere in a
      // parallel batch clears the streak.
      // What the loop is handed back: it folds these into Execution State and into the doom-loop
      // detector itself, so nothing here observes them a second time.
      const roundResults: ToolResult[] = [];
      for (const group of groups) {
        if (ctrl.signal.aborted) break;
        // Results are consumed in the original order regardless of which call settled first, so the tool
        // messages stay aligned with assistant.tool_calls.
        const settled =
          group.length > 1
            ? await Promise.all(group.map(runToolCall))
            : [await runToolCall(group[0])];

        for (const { tc, name, args, content, ok } of settled) {
          // Delegating to a reviewer counts as reviewed; recording anything satisfies the memory guard;
          // a mutating call on a risky path re-arms the review. One reducer, so the six places that used
          // to mutate these flags are now one call. See toolRuntime.recordTool.
          obligations = recordTool(obligations, { name, args }, toolRules);
          // A `notify` job promises a result later. Counted so the goal check can defer rather than judge
          // a turn whose whole point was to start something and wait for it.
          if (name === "run_command" && args.notify) {
            awaitingJobsRef.current.set(genConvId, (awaitingJobsRef.current.get(genConvId) ?? 0) + 1);
          }
          // Sub-agent write-back. A delegation runs in its own isolated context and its conversation is
          // never persisted, so the only durable trace is this one tool result — which compaction is free
          // to summarise away. Copying the conclusion into Goal State keeps it as established fact, and it
          // is handed to the evaluator separately from the transcript for exactly that reason.
          if (DELEGATION_TOOLS.has(name) && isGoalActive(goalFor(genConvId))) {
            setGoalFor(genConvId, recordEvidence(goalFor(genConvId), { source: name, summary: content }));
          }

          // Compress overly long tool output before feeding back / persisting (the full text is already in each tool's display bubble, so the UI is unaffected).
          // read_file is exempt: it returns the line range that was asked for, so there is nothing to elide.
          const cappedContent = UNCAPPED_TOOLS.has(name)
            ? content
            : capToolOutput(content);
          buf.pushTool({ role: "tool", tool_call_id: tc.id, content: cappedContent });
          // A generated image's artifact URL is stored display-only (not in content, so it never re-enters the wire),
          // so the image bubble can be rebuilt after switching conversations. Consume the side-channel ref.
          const artifact =
            name === "image_generation" || name === "video_generation"
              ? lastArtifactRef.current
              : null;
          lastArtifactRef.current = null;
          // Persist the tool result to this conversation (store the compressed version, to avoid bloating storage / the integrity hash).
          store.appendMessage(genConvId, {
            role: "tool",
            content: cappedContent,
            tool_call_id: tc.id,
            // The RESOLVED name, not what the model emitted: this field is display-only (loadConversation rebuilds tool
            // bubbles from it), so persisting "call_tool" would make every reopened conversation show a row of identical
            // dispatcher bubbles instead of the tools that actually ran. The wire copy in assistant.tool_calls is untouched.
            name,
            ts: Date.now(),
            ...(artifact
              ? {
                  [artifact.kind === "video" ? "video" : "image"]: artifact.src,
                  servedBy: artifact.servedBy,
                }
              : {}),
          });
          buf.markToolStored((store.getConversation(genConvId)?.messages.length ?? 0) - 1);

          // ── Progress guard ──────────────────────────────────────────────────────────────────────────
          // Judged on `cappedContent` rather than `content`: what the guard has to answer is "does the
          // model already have this", and what the model has is the capped text. Placed after the append
          // so a reminder rides the result it is about — nudgeIntoLastTool writes into the message that
          // was just recorded, which the model has not been shown yet, so it costs no re-prefill.
          roundResults.push({ toolCallId: tc.id, name, args, content: cappedContent, ok, ms: 0 });
        }
      }
      // Wrap-up alignment: for any tool_call with no result yet (this round was cut short early because the user canceled), append a placeholder result,
      // ensuring assistant.tool_calls and tool results correspond one-to-one — otherwise, when continuing the chat / reopening, it would be rejected by the provider because "tool_calls were not answered".
      // The placeholder is also persisted, staying consistent with the conversation fed back to the model.
      const answeredIds = buf.messages.flatMap((mm) =>
        mm.role === "tool" && mm.tool_call_id ? [{ toolCallId: mm.tool_call_id }] : [],
      );
      for (const tc of unansweredCalls(msg.tool_calls, answeredIds)) {
        const placeholder = ctrl.signal.aborted ? t("chat.canceled") : t("chat.skipped");
        buf.pushTool({ role: "tool", tool_call_id: tc.id, content: placeholder });
        store.appendMessage(genConvId, {
          role: "tool",
          content: placeholder,
          tool_call_id: tc.id,
          name: callOf(tc).name,
          ts: Date.now(),
        });
        buf.markToolStored((store.getConversation(genConvId)?.messages.length ?? 0) - 1);
      }
      // Cancelled mid-round. Reported as an empty round rather than by returning from send():
      // the loop re-checks the signal and stops with reason `cancelled`, so there is one place
      // that decides a run has ended (after the tools).
      if (ctrl.signal.aborted) return { content: "", reasoning: "", toolResults: [], toolCallCount: 0 };
      // ── File-change guards, evaluated HERE rather than at wrap-up ───────────────────────────────────────────────
      // Both flags are known the moment the tools return, so the nudge is written into the last tool result before that
      // result is ever sent. Two things follow. The model reads it while it can still act — it can delegate the reviewer in
      // its very next turn instead of being told off for a conclusion it already reached. And mutating a message that has
      // not been sent yet costs nothing: the previous request did not contain this tool result at all, so there is no
      // divergence and no re-prefill. Nudging at wrap-up instead would rewrite a result the model had already answered.
      //
      // Each fires at most once per round. Neither blocks the wrap-up: the old wrap-up-time version let the model through
      // after one nudge anyway ("if the model still insists, let it through, to avoid a deadlock"), so this is the same
      // single nudge, delivered early enough to be preventive. They stay able to fire again on a later turn — the review
      // guard is a safety check, so a risky change at turn 40 must be caught even though turn 5 was.
      {
        const { due, next } = dueReminders(obligations);
        obligations = next;
        // Both can be due at once and both are delivered: they are about different things, and dropping
        // one because the other fired would silently skip a safety check.
        for (const reminder of due) {
          nudgeIntoLastTool(reminder === "review" ? FORCE_REVIEW_NUDGE : RECORD_MEMORY_NUDGE);
        }
      }
      // Doom-loop detection is the LOOP's now, not this function's — one detector, one policy (§20 rule
      // 7). It observes these same results, warns through onDoomSignal above, and escalates to a
      // `doom-loop` stop. The wrap-up round that used to happen here, with the tools withdrawn, happens
      // after the loop returns instead: same outcome for the user, one place that decides it.
      return {
        content: msg.content ?? "",
        reasoning: reasoningText,
        toolResults: roundResults,
        toolCallCount: msg.tool_calls.length,
      };
    }

    // Outstanding-delegation guard: the model is about to end the turn (no tool calls this round) while
    // delegations it spawned are still running. They are cancelled the instant the turn ends, so this is
    // the last moment the work can still be used. Placed before the finalize guard because it is the more
    // specific diagnosis of an empty ending — a model that spawned and then stalled has something to wait
    // for, not something to summarise. Fires once per turn, so declining to join is respected.
    {
      const held = schedulerRef.current;
      const outstanding = held && held.turnId === turnId ? held.sched.outstanding() : [];
      if (outstanding.length > 0 && !delegationNudged) {
        delegationNudged = true;
        nudgeIntoLastTool(PENDING_DELEGATION_NUDGE);
        return { content: "", reasoning: reasoningText, toolResults: [], toolCallCount: 0, forceContinue: true };
      }
    }

    // Wrap-up guard: the model demonstrably did work this round — ran a tool, or produced reasoning — yet ended with
    // empty content, so the user saw nothing. Inject one FINALIZE_NUDGE to make it answer from what it already has,
    // then continue the loop. Only once, to avoid a deadlock.
    //
    // `reasoningText` is in the condition because a tool call is not the only way to end up here. A reasoning model
    // writing ABOUT its own control tokens emits one for real: Qwen's tokenizer has </think> as a special token, so
    // a turn explaining thinking tags terminates itself at the backtick before the tag name. Observed twice in one
    // conversation — once truncating the answer at 845 tokens, once ending the whole response at 0 — and the user
    // had to type "continue" by hand, which is exactly what this nudge does.
    //
    // Requiring evidence of work (a tool ran, or tokens were reasoned) rather than firing on any empty reply keeps
    // an aborted or genuinely empty stream from being nudged into a second request.
    if ((didToolCall || reasoningText.trim()) && !finalizeNudged && !(msg.content ?? "").trim()) {
      finalizeNudged = true;
      nudgeIntoLastTool(FINALIZE_NUDGE);
      return { content: "", reasoning: reasoningText, toolResults: [], toolCallCount: 0, forceContinue: true };
    }

    // The model answered with no tool calls. Whether that ENDS the turn is the stop policy's decision,
    // not this function's — a goal in force can turn a "final" answer into another round. Everything that
    // used to follow here (the goal check, the checklist archive, the reply notification) now runs after
    // the loop returns, because all of it is about a turn that has finished rather than a round that has.
    log.lastContent = msg.content ?? "";
    return { content: log.lastContent, reasoning: reasoningText, toolResults: [], toolCallCount: 0 };
  };
}
