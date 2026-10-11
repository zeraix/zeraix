/**
 * One turn of the chat, from the landed user message to the end of its cleanup. Lifted out of the chat page's
 * `send()`: useChatSend.ts takes the message as far as the conversation record, and hands over here.
 *
 * The turn registers itself (generating flag, AbortController, crash checkpoint), wires its tools and boundary
 * (turnWiring.ts), announces what changed since the last turn, runs the loop — in the Rust runtime when it can,
 * in this window otherwise — checks the goal, and then, by whatever route it ends, cleans up after itself and
 * decides what runs next: the queue, a stranded job result, or the goal loop's next round.
 */
import { toast } from "sonner";
import type { InMemoryAuditLog } from "@/lib/ai/orchestration/audit-log";
import type { ToolDeclaration } from "@/lib/ai/orchestration/capabilities";
import type { CapabilityBroker } from "@/lib/ai/orchestration/capability-broker";
import type { PriorDelegation } from "@/lib/ai/subagents";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { formatJobMessage } from "@/lib/ai/services";
import { approvalReminderLine } from "@/lib/ai/approvalMode";
import { notifyAgentError } from "@/lib/ai/agentNotify";
import { OFFICIAL_PROVIDER_ID } from "@/lib/ai/models";
import { capabilityAvailable } from "@/lib/ai/generation";
import { mediaDir } from "@/lib/ai/mediaLibrary";
import { setBrowserBusy } from "@/lib/automation";
import { useAgentChatStore } from "@/store/agentChatStore";
import { useAuthStore } from "@/store/authStore";
// The doom-loop detector (docs/agent-runtime-loop.md §12). Superseded app/agent/chat/loopGuard.ts at M3:
// §20 rule 7 forbids two competing Stop Policies, and a detector that withdraws the model's tools was one.
import { runAgentLoop } from "@/lib/agent/agentLoop";
import type { StopDecision } from "@/lib/agent/stopPolicy";
import {
  repeatedCallNudge,
  repeatedFailureNudge,
  equivalentCallNudge,
  repeatedResourceNudge,
  RESUME_NUDGE,
} from "../constants";
import { addBlock, diffReminder, foldReminders, renderReminder, wrapReminder } from "../context/reminders";
import { renderTaskMemory } from "../context/taskMemory";
import { isGoalActive, renderGoalState } from "../goal/goalState";
import { buildReminderState } from "./sendPrep";
import { createRendererTools, type RendererTool } from "../tools/chatTools";
import type { HeldScheduler } from "../delegation/chatDelegation";
import { createTurnCheckpoint } from "./turnState";
import { checkTurnGoal, finishTurn } from "./turnFinish";
import type { LandedMessage } from "./turnSetup";
import { createTurnBuffer } from "./turnBuffer";
import { createRoundRunner, runLoopBreakRound, type RoundLog, type RoundRunnerDeps } from "./turnRound";
import { runChatTurnInRuntime } from "./runtimeRound";
import { TOOL_RULES, WIRE_STEPS, wireTurn } from "./turnWiring";
import type { ApiMsg, ReminderState } from "../types";
import type { ChatSendDeps, SendOpts } from "../hooks/useChatSend";

/** The refs useChatSend owns on the turn's behalf: they outlive any one call, and only turns use them. */
export interface TurnRefs {
  /** The artifact a generation tool just produced, handed to the persist step. */
  lastArtifactRef: React.RefObject<{ src: string; kind: "image" | "video"; servedBy?: string } | null>;
  /** Delegations completed in the current turn, for the repeat guard in runSubAgent. */
  delegationsRef: React.RefObject<{ turnId: string; done: PriorDelegation[] }>;
  /** The turn's concurrent-delegation scheduler (spawn_subagents / join_subagents). */
  schedulerRef: React.RefObject<HeldScheduler | null>;
  brokerRef: React.RefObject<{ broker: CapabilityBroker; audit: InMemoryAuditLog } | null>;
  orchestrationDeclsRef: React.RefObject<Map<string, ToolDeclaration> | null>;
  /** The conversation whose goal loop just hit its round limit (one-shot, see checkTurnGoal). */
  goalExhaustedRef: React.RefObject<string | null>;
}

/** What a turn reaches: the send's dependencies, the turn refs, and the send that started it. */
export interface TurnHost extends ChatSendDeps, TurnRefs {
  /** The `send` of the render that started this turn — the goal loop's next round goes down the same road. */
  send: (opts?: SendOpts) => Promise<void>;
  processQueue: (convId: string | null) => void;
}

/** What useChatSend settled before handing over. */
export interface TurnStart {
  /** What the user typed (or the goal loop's instruction). */
  text: string;
  /** The directory this turn runs in, already resolved by the working-directory policy. */
  effectiveWorkdir: string;
  /** The runtime skill set, as of the send. */
  enabled: InstalledSkill[];
  landed: LandedMessage;
  /** This turn's AbortController, created at the send and registered here. */
  ctrl: AbortController;
}

export async function runChatTurn(host: TurnHost, start: TurnStart): Promise<void> {
  const { t, router, convIdRef, convoRef, runsRef, interruptedRef, feedbackNudgeRef } = host;
  const { setLoading, setStatus, setError, diagRef, schedulerRef, lastArtifactRef, goalExhaustedRef, send, processQueue } = host;
  const { requestChat, evaluateGoal } = host.requests;
  const { activeModel, modelName, isLocalModel, thinking, approvalModeRef, sendReasoningContext } = host.model;
  const { viewTokenRef, adoptDisplay, pushDisplay, displayRef, setDisplay, tagLastAssistantStoredIndex } = host.view;
  const {
    queuedTexts,
    todosFor,
    setTodosFor,
    taskMemoryFor,
    setTaskMemoryFor,
    goalFor,
    setGoalFor,
    scheduleGoalClear,
    enqueueMessage,
    queueLength,
  } = host.perConv;
  const hostAskUser = host.askUser;
  const { turnUsageRef, setCtxTokens, recordTurnUsage } = host.usage;
  const { toolsReady, buildToolSet } = host.toolkit;
  const { sandboxStatusRef } = host.sandbox;
  const { maybeCompact } = host.compaction;
  const { awaitingJobsRef, pendingJobsRef } = host.jobs;
  const { runtimeSkills } = host.skills;
  const { pendingRecoveryRef } = host.recovery;
  const { text, effectiveWorkdir, enabled, landed, ctrl } = start;

  const { convId: genConvId, userWireIdx, userStoredIdx } = landed;
  // A brand-new conversation just got its id, and the empty transcript the reset left behind is now ITS
  // transcript. Adopted here rather than in setConvId, because setConvId is ALSO how a switch begins — and
  // there the display still belongs to the outgoing conversation until swapInConversation rebuilds it.
  if (viewTokenRef.current.owner === null) adoptDisplay(genConvId);
  let roundConvo = landed.roundConvo;
  const store = useAgentChatStore.getState();

  store.setConversationGenerating(genConvId, true);
  runsRef.current.set(genConvId, ctrl); // Register this conversation's run, for cancel (active conversation) / background concurrency
  // "Whether in the active view": apply view side effects only while active; a background conversation persists silently.
  const active = () => convIdRef.current === genConvId;
  /**
   * May this round write to the transcript on screen?
   *
   * Stricter than `active()`, and it has to be. `active()` reads convIdRef, which moves the moment the user
   * clicks another conversation, while the transcript itself is rebuilt one await later inside
   * swapInConversation — so there is a window where `active()` is true over a transcript that still belongs
   * to the conversation being left. Appending there puts this conversation's rows in that one.
   *
   * Used only for writes to the display ARRAY. The status line, the error banner and the token ring are
   * chrome, not transcript, and stay on `active()`.
   */
  const ownsView = () => viewTokenRef.current.owner === genConvId;
  // One id per generation, shared by everything this turn spends (see RunCtx.turnId).
  const turnId = `${genConvId}-${Date.now().toString(36)}`;
  /**
   * This turn's crash checkpoint (docs/agent-runtime-crash-recovery.md C2, turnState.ts).
   *
   * The loop's own state — the round it is on and the tool calls that are out — lives in refs that die with the
   * renderer. Writing it to the conversation record at every round boundary is what lets the next session say
   * what was interrupted instead of showing a repaired transcript with no trace of the interruption. Cleared in
   * `finally` below on every route out of the turn, so a record that survives means a crash and nothing else.
   */
  const checkpoint = createTurnCheckpoint({
    turnId,
    save: (state) => useAgentChatStore.getState().setConversationTurnState(genConvId, state),
    queued: () => queuedTexts(genConvId),
    // Only this turn's own scheduler counts: schedulerRef may already hold the NEXT turn's by the time a late
    // write lands, and reporting that one would attribute another turn's delegations to this crash.
    delegations: () =>
      schedulerRef.current?.turnId === turnId ? schedulerRef.current.sched.outstanding().length : 0,
  });

  // Tool execution, the Runtime/UI boundary, the run context, the model's capabilities and the sub-agent tools
  // for this turn (see turnWiring.ts).
  const { execToolCall, boundary, ctx, modelCaps, runtimeModel, delegation, setRenderDelta } = wireTurn(host, {
    genConvId,
    turnId,
    ctrl,
    text,
    active,
    ownsView,
    store,
  });

  /**
   * The instruction the goal loop wants to run next, decided by the end-of-turn check.
   *
   * Declared out here because it is written inside the try and read in `finally`: the next round must start
   * only after this one's cleanup has run (spinner cleared, usage recorded, generating flag released), or the
   * send it triggers would be enqueued behind a turn that is technically still in flight.
   */
  let goalContinuation: string | null = null;

  const {
    runSubAgent,
    spawnSubagents,
    joinSubagents,
    spawnSubAgent,
    drainDelegations,
    drainJobEvents,
    shutdownScheduler,
  } = delegation;

  try {
    // Tool set = ask_user + update_todos + load_skill + (local tools + run_subagent, Electron only).
    //
    // Every declaration here must be byte-identical across installs and independent of which keys are configured: on templates
    // that render tools BEFORE the system prompt, any difference in any declaration re-prefills the whole prompt. So nothing in
    // this array is conditional on user state — where a capability genuinely varies, the tool is still declared and its
    // unavailability is announced as a change event. Only `mode` is allowed to vary it, because messages[0] is mode-determined
    // anyway. See docs/cache-stable-prompt-context.md.
    const tools = await buildToolSet();
    /**
     * The renderer's own tools: dispatched by name to a handler that closes over component state, instead of
     * going through execToolCall (the unified sandbox/consent path). A table rather than a ternary chain so
     * adding a tool is one line and the control flow in the loop stays flat.
     *
     * Built per turn rather than at component scope. The table closes over refs, and constructing it
     * during render means handing those refs to a function at a point React does not guarantee is safe
     * to read them (react-hooks/refs says exactly that). A turn is an event, which is when a ref may be
     * read — and the table has never been needed anywhere but inside the loop below.
     */
    const rendererTools: Record<string, RendererTool> = {
      // The self-contained half (choice cards, todos, skills, memory, browser, image generation) is built by
      // createRendererTools from the slice of state listed in RendererToolDeps. `set_goal` / `update_plan` are
      // absent from it on purpose — see that factory's doc for why absence here, and not merely undeclaring
      // them, is what makes the goal untouchable by the model.
      ...createRendererTools({
        t,
        convIdRef,
        runtimeSkills,
        sandboxStatusRef,
        toolsReady,
        activeModel,
        lastArtifactRef,
        askUser: hostAskUser,
        onJobStarted: (convId) =>
          awaitingJobsRef.current.set(convId, (awaitingJobsRef.current.get(convId) ?? 0) + 1),
        setTodosFor,
        taskMemoryFor,
        setTaskMemoryFor,
        goalFor,
        setGoalFor,
      }),
      // The delegation family stays in the component: these own the per-turn sub-agent scheduler, so their
      // lifetime is the turn's, not this render's.
      run_subagent: runSubAgent,
      spawn_subagents: spawnSubagents,
      join_subagents: joinSubagents,
      spawn_sub_agent: spawnSubAgent,
    };
    // Progress guard: the tool loop below is unbounded on purpose, so a turn that has stopped learning
    // anything would otherwise run until the user notices and presses stop. The guard watches for the
    // absence of new information rather than for round count (see loopGuard.ts), warns the model twice,
    // and then withdraws tool access — which is what `toolsWithdrawn` does: from that point every request
    // goes out with no tools declared, so the model can only answer in text and the loop exits.
    //
    // Withdrawn for the REST of the turn rather than for one round. In the ordinary case the difference is
    // invisible: the forced round produces a reply with no tool calls and the turn is over anyway. It
    // matters for the case this whole mechanism exists for — a model that has stopped responding to what it
    // is told. Restoring the tools after one round would hand a still-looping turn its tools back, and the
    // guard has already latched, so there would be nothing left to stop it the second time.
    /**
     * Execution State for this turn (docs/agent-runtime-loop.md §4.2), and the capabilities the reasoning
     * policy is gated on (§5). Live from M5d.
     *
     * This is what makes §6 real rather than advisory: until now every request in a turn carried the same
     * reasoning configuration, so a routine "read the next file" round cost exactly what a recovery round
     * did. The phase is derived from recorded facts — did the last tool fail, was context just compacted —
     * and the policy turns it into an effort that only ever goes DOWN from the user's setting.
     */

    // Interrupt resume: consume the previous round's "was interrupted" flag (cleared once read). If the previous round was stopped,
    // the user turn carries a hint nudging the model to reuse the analysis / tool results already retained above and continue,
    // without repeating completed work. It is written once, into that turn, by the change-events block below.
    const resumeFromInterrupt = interruptedRef.current;
    interruptedRef.current = false;
    // Rating feedback hint: consume the one-time nudge set by the previous "regenerate after thumbs up / down" (cleared once read); written into the user turn by the change-events block below.
    const feedbackNudge = feedbackNudgeRef.current;
    feedbackNudgeRef.current = null;
    // Start of this round: plan and freeze context compaction (only acts above the threshold, and may trigger one summarizer-model call).
    // Once frozen, any messages added during this round's tool loop are sent as-is, keeping the wire prefix stable throughout the round and hitting the prefix cache.
    const roundCompaction = await maybeCompact({
      signal: ctrl.signal,
      log: { actor: "compact", convId: genConvId, turnId },
      messages: roundConvo,
      convId: genConvId,
    });
    if (ctrl.signal.aborted) return;
    // ── Change events ────────────────────────────────────────────────────────────────────────────────────────────────
    // Announce whatever moved since the last emission, into the user turn added above — never as a message of its own, because
    // message counts are the alignment anchor for edit / regenerate, ratings and the compaction tail (see reminders.ts).
    //
    // Emitted HERE, after maybeCompact, because compaction is Task Memory's second writer: a brief the summariser extracted a
    // few lines ago has to reach the model on this turn, not the next one. The turn is already on disk by now, so the disk copy
    // is updated in place rather than written at append time.
    //
    // "Last emission" is FOLDED from the buffer, never cached: edit and regenerate delete turns, and a cached value would keep
    // claiming an emission that no longer exists, silently dropping that constraint for the rest of the conversation.
    {
      const current = buildReminderState({
        workdir: effectiveWorkdir || "",
        sandbox: sandboxStatusRef.current,
        // Read from the ref, not the state closed over by this turn: the user can switch modes while a
        // turn is running, and the tool loop below already honours the change per call.
        approval: approvalReminderLine(approvalModeRef.current),
        // Read per turn rather than cached: the library follows the data-storage location, which the user
        // can change from Settings mid-session, and a cached path would keep announcing the old folder —
        // the one failure this announcement exists to prevent. One IPC call against a model request is free.
        assetsDir: await mediaDir().catch(() => ""),
        activeModel,
        skills: enabled,
        imageGenerationAvailable: capabilityAvailable("image_generation"),
        videoGenerationAvailable: capabilityAvailable("video_generation"),
        task: renderTaskMemory(taskMemoryFor(genConvId)),
        // A crash notice claimed when this conversation was opened, if any. Consumed here so it rides the same
        // change event as everything else and is said exactly once — a second send never repeats it.
        recovery: pendingRecoveryRef.current.get(genConvId),
        // The goal rides the same road as the mission brief, and for the same reason: it is re-rendered from
        // structured state every turn, so the model sees the current condition, criteria and plan even after
        // compaction has discarded every message that produced them.
        goal: renderGoalState(goalFor(genConvId)),
      });
      const delta = diffReminder(current, foldReminders(roundConvo));
      // Consumed: said on this turn, so it must not be said again on the next one. The persisted checkpoint that
      // produced it is not cleared here — this turn's own `roundStarted` overwrites it a moment later, and if this
      // send fails before that, the record is still there to be reported again, which is the correct outcome.
      pendingRecoveryRef.current.delete(genConvId);
      // The two one-shot nudges that fire on a turn's first request ride the same carrier. They are persisted like everything
      // else: a nudge that appears in the wire on one turn and is gone on the next breaks the prefix at that turn, which costs
      // more than the handful of tokens it saves. They carry no payload — a nudge is not standing state.
      const blocks = [
        ...(delta ? [renderReminder(delta)] : []),
        ...(resumeFromInterrupt ? [wrapReminder(RESUME_NUDGE)] : []),
        ...(feedbackNudge ? [wrapReminder(feedbackNudge)] : []),
      ];
      const target = roundConvo[userWireIdx];
      if (blocks.length && target?.role === "user") {
        // The block lives in its own field; `content` stays exactly what the user typed. The two are combined only when the
        // wire is built (materializeReminders), so the bubble, the summariser and every content transform see clean text.
        const reminderText = addBlock(target.reminderText, blocks.join("\n\n"));
        const merged: ReminderState = { ...(target.reminder ?? {}), ...delta };
        // Rebuilt from `target` (already narrowed to the user arm) rather than spread over the union, which would widen `content`.
        const updated: ApiMsg = { ...target, reminderText, reminder: merged };
        roundConvo = roundConvo.map((m, i) => (i === userWireIdx ? updated : m));
        if (active()) convoRef.current = roundConvo;
        if (genConvId && userStoredIdx >= 0) {
          useAgentChatStore.getState().setMessageReminder(genConvId, userStoredIdx, reminderText, merged);
        }
      }
    }
    // This round's conversation buffer and compaction plan: captured as local values; afterwards the loop only mutates these two locals and never again directly reads/writes convoRef /
    // compactionRef (those belong to the "active view" and are rebuilt by loadConversation when switching conversations). Mirror them back to the view while active.
    const compaction = roundCompaction;
    // This turn's conversation buffer (see turnBuffer.ts). The loop only ever mutates this, and never again
    // directly reads/writes convoRef / compactionRef — those belong to the "active view" and are rebuilt by
    // loadConversation on a conversation switch.
    const buf = createTurnBuffer({
      initial: roundConvo,
      convId: genConvId,
      syncView: (messages) => { if (active()) convoRef.current = messages; },
    });
    const nudgeIntoLastTool = buf.nudgeIntoLastTool;
    // No upper limit on tool-call rounds: loop until the model gives a final reply with no tool calls, or the user interrupts.
    // The one thing that can end it otherwise is the progress guard (loopGuard.ts) — and it ends it through the same door, by
    // withdrawing the tools so the only reply available is a final one. There is still no round cap.
    /**
     * The turn's last round, kept for the post-loop work.
     *
     * The goal evaluator judges the transcript that was actually sent plus the answer it produced, and the
     * reply notification quotes that answer — both run after the loop, so the round that produced them has
     * to leave them behind.
     */
    const roundLog: RoundLog = { lastWire: [], lastContent: "" };

    const roundDeps: RoundRunnerDeps = {
      convId: genConvId,
      turnId,
      checkpoint,
      signal: ctrl.signal,
      active,
      t,
      buf,
      compaction,
      log: roundLog,
      activeModel,
      modelName,
      isLocalModel,
      sendReasoningContext,
      wireSteps: WIRE_STEPS,
      tools,
      requestChat,
      boundary,
      ctx,
      rendererTools,
      execToolCall,
      toolRules: TOOL_RULES,
      drainDelegations,
      drainJobEvents,
      displayRef,
      viewTokenRef,
      setDisplay,
      setCtxTokens,
      diagRef,
      lastArtifactRef,
      schedulerRef,
      awaitingJobsRef,
      tagLastAssistantStoredIndex,
      goalFor,
      setGoalFor,
      setRenderDelta,
    };
    // The Rust runtime takes the whole turn (unless ZERAIX_RUST_CHAT_LOOP=off). Null means it cannot — before
    // anything ran — and the turn runs on this window's own loop.
    const loopOutcome: { stop: StopDecision } =
      (await runChatTurnInRuntime({ ...roundDeps, ...runtimeModel, turnUsage: () => turnUsageRef.current })) ??
      (await runAgentLoop({
        boundary,
        sessionId: genConvId,
        turnId,
        modelId: modelName,
        thinking,
        capabilities: modelCaps,
        // The goal is NOT wired in here on purpose. `evaluateGoal` would make an unmet goal run another round
        // inside this turn; today an unmet goal ends the turn and queues a fresh one carrying the evaluator's
        // reason, which re-runs compaction and rebuilds the wire. Those are materially different, and the
        // second is the behaviour this app has. The check therefore stays below, after the loop.
        evaluateGoal: undefined,
        // The proportional half of §12: name the specific signal, because a model told the vaguer thing
        // ("you are looping") varies its arguments rather than changing course.
        onDoomSignal: (signal, result, verdict) => {
          if (signal === "identical") nudgeIntoLastTool(repeatedCallNudge(result.name, verdict.repeat));
          else if (signal === "equivalent") nudgeIntoLastTool(equivalentCallNudge(result.name, verdict.repeat));
          else if (signal === "failing") nudgeIntoLastTool(repeatedFailureNudge(result.name, verdict.failStreak));
          else if (signal === "resource") nudgeIntoLastTool(repeatedResourceNudge(result.name, verdict.resourceHits));
        },
        now: () => Date.now(),
        runRound: createRoundRunner(roundDeps),
      }));

    // The wrap-up round after a detected doom loop: see runLoopBreakRound.
    if (loopOutcome.stop.reason === "doom-loop" && !ctrl.signal.aborted) {
      await runLoopBreakRound(roundDeps, {
        detail: loopOutcome.stop.detail,
        // Said out loud, because from outside a loop and long work look identical — a spinner and a rising
        // token count — and the user is the one paying for the difference.
        warn: () => { if (active()) toast.warning(t("chat.loopBroken")); },
        show: (content) => { if (ownsView()) pushDisplay({ kind: "assistant", content }); },
      });
    }

    /**
     * Everything below is about a turn that has FINISHED, not a round that has.
     *
     * Skipped entirely when the user cancelled. Before the loop moved out, the two mid-round abort checks
     * returned from send() outright, so a cancelled turn reached none of this; now the loop returns
     * normally with reason `cancelled` and the guard has to be explicit. Without it, pressing stop would
     * announce a completed reply and archive the checklist of a turn that never finished.
     */
    if (!ctrl.signal.aborted) {
      // ── Goal check ───────────────────────────────────────────────────────────────────────────────────────
      // The turn is over and the model has answered. If a goal is in force, this is where an INDEPENDENT
      // evaluator reads what just happened and decides whether the condition is met — the model does not get
      // a vote, and there is no tool through which it could ask for one.
      //
      // Placed here, inside the try, rather than in `finally`: the wire view and the abort signal are both in
      // scope, the user sees the check as part of the turn rather than as a pause after it, and cancelling
      // stops it like anything else. The decision it produces is handed to `finally`, which fires the next
      // round after the normal end-of-turn cleanup has run.
      goalContinuation = await checkTurnGoal({
        convId: genConvId,
        turnId,
        signal: ctrl.signal,
        t,
        active,
        status: ctx.status,
        goalFor,
        setGoalFor,
        scheduleGoalClear,
        awaitingJobs: awaitingJobsRef.current.get(genConvId) ?? 0,
        turnUsage: turnUsageRef.current,
        lastWire: roundLog.lastWire,
        lastContent: roundLog.lastContent,
        evaluateGoal,
        allowExhaustedRound: (id) => { goalExhaustedRef.current = id; },
      });

      // The body was already finalized and displayed by renderTurn above, and archiving was done when the
      // message was produced, so neither is repeated here. A background conversation does not write the
      // current view; when switched back to, its display is rebuilt from the store by loadConversation.
      await finishTurn({
        convId: genConvId,
        t,
        active,
        goalContinuation,
        lastContent: roundLog.lastContent,
        todosFor,
        setTodosFor,
        pushDisplay,
        openConversation: (id) => router.push(`/agent/chat?c=${encodeURIComponent(id)}`),
      });
    }
  } catch (e) {
    // A user-initiated cancel does not count as an error.
    if (!ctrl.signal.aborted) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (active()) setError(errMsg); // Only the active conversation shows the error on screen; a background conversation still sends a system notification
      // Trigger condition 2a: API / network error → system notification (only pops when in the background/minimized), owned by this conversation.
      notifyAgentError("api", errMsg, genConvId);
    }
  } finally {
    // The turn is over by SOME route — a reply, an error, or the user's Stop. All three are ends the app
    // survived, so the checkpoint has done its job and must go: only a record that outlives the process
    // means an interruption (docs/agent-runtime-crash-recovery.md C2).
    checkpoint.clear();
    if (runsRef.current.get(genConvId) === ctrl) runsRef.current.delete(genConvId);
    // Stop any delegation still running for this turn. Nothing can consume a conclusion once the turn is
    // over — the wire is closed and the display is done — so letting one finish would only spend tokens
    // writing into a conversation that has moved on. The model was warned by PENDING_DELEGATION_NUDGE
    // before it got here.
    if (schedulerRef.current?.turnId === turnId) {
      shutdownScheduler(schedulerRef.current);
      schedulerRef.current = null;
    }
    // Interrupted by the user (rather than a normal end / error): mark "interrupted", so the next send prompts the model to reuse the retained analysis and resume.
    if (ctrl.signal.aborted) interruptedRef.current = true;
    store.setConversationGenerating(genConvId, false); // End generation: remove the spinner from that conversation's sidebar row
    // The view state is reset only while "this conversation is still the current active view"; a background conversation ending does not touch the currently viewed conversation's loading state / halo.
    if (active()) {
      setLoading(false);
      setStatus("");
      setBrowserBusy(false); // End of this round: turn off the browser glowing halo
    }
    // This round's token usage (including tool rounds / subagents): shown while active, and added to the session total.
    recordTurnUsage((row) => { if (active()) pushDisplay(row); });
    // The per-step refresh above is throttled, so the last step of a fast turn can be missed. Force one
    // final read to guarantee the number on screen matches what the platform actually charged.
    if (activeModel?.providerId === OFFICIAL_PROVIDER_ID) {
      void useAuthStore.getState().refreshWallet({ force: true });
    }
    // Stranded job results: the turn ended before any tool result could carry them (the model was writing
    // its final answer when the build finished, or it made no further tool call). They become their own turn
    // instead, which is what the idle path would have done had the job landed a moment later. Drained BEFORE
    // processQueue so that turn starts immediately rather than waiting for the next thing to happen.
    const stranded = pendingJobsRef.current.get(genConvId) ?? [];
    if (stranded.length > 0) {
      pendingJobsRef.current.delete(genConvId);
      // A cancelled turn drops them: cancel() clears this conversation's queue for the same reason, and
      // waking the conversation back up is the opposite of what "stop" asked for.
      if (!ctrl.signal.aborted) {
        for (const notice of stranded) enqueueMessage(genConvId, formatJobMessage(notice), []);
      }
    }
    // Queue resume: after a normal end (not a user interruption), if this conversation still has queued messages and is still the current conversation, auto-send the next one.
    // Interruption (the user clicked "stop") does not resume — cancel() clears this conversation's queue at the same time.
    if (!ctrl.signal.aborted) processQueue(genConvId);
    // ── Goal loop ────────────────────────────────────────────────────────────────────────────────────────
    // The evaluator said the condition is not met, so run another round with its reason as the instruction —
    // no user input, which is the entire point of the mechanism.
    //
    // Three things gate it, all of them cases where continuing would be wrong rather than merely unhelpful:
    //  - a user interrupt (the loop is exactly what "stop" means to stop);
    //  - the goal having been cleared since the check (`/goal clear` mid-turn, which must take effect now);
    //  - a queued user message, which processQueue above has just started — a real instruction outranks an
    //    automatic one, and the goal will be re-checked at the end of that turn anyway.
    const queueBusy = queueLength(genConvId) > 0;
    const stillGoverned = isGoalActive(goalFor(genConvId)) || goalExhaustedRef.current === genConvId;
    goalExhaustedRef.current = null;
    if (goalContinuation && !ctrl.signal.aborted && !queueBusy && stillGoverned) {
      // Down the same road a queued message takes, so an automatic round is built exactly like any other turn
      // — same compaction, same reminders, same consent gating. _fromQueue only marks it as not being typed.
      void send({ text: goalContinuation, attachments: [], _fromQueue: true });
    }
  }
}
