/**
 * The per-turn objects a turn's loop is handed: tool execution, the Runtime/UI boundary, the run context, the
 * model's capabilities, and the sub-agent tools. Lifted out of the chat page's `send()` with chatTurn.ts.
 *
 * Built once per turn, at event time — every factory here closes over refs, and a turn is when a ref may be
 * read. Also home to the two fixed tables every turn shares, bound once at module scope.
 */
import type { WireSteps } from "@/lib/agent/contextManager";
import type { RuntimeBoundary } from "@/lib/agent/runtimeBoundary";
import type { ToolRuntimeRules } from "@/lib/agent/toolRuntime";
// Execution State, the reasoning policy and the doom-loop detector are all owned by runAgentLoop now;
// only the capability derivation stays here, because both the loop and the delegation factory need it.
import { describeCapabilities } from "@/lib/agent/modelAdapter";
import { useAgentChatStore } from "@/store/agentChatStore";
import { buildWireContext, sanitizeToolCallPairs, type CompactionState } from "../context/contextCompress";
import { DELEGATION_TOOLS, MUTATING_FILE_TOOLS, RISKY_PATH_PATTERN } from "../constants";
import { materializeReminders } from "../context/reminders";
import {
  hoistSystemToFront,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  stripWireMetadata,
  applyReasoningPolicy,
} from "../context/wireHelpers";
import { createToolExec } from "../tools/toolExec";
import { createDelegationTools } from "../delegation/chatDelegation";
import type { RuntimeModel } from "./runtimeRound";
import type { RunCtx } from "../types";
import type { TurnHost } from "./chatTurn";

/**
 * The wire-transformation steps, bound once (see contextManager.ts).
 *
 * Module scope rather than per-render: these are eight module functions that never change, and rebuilding
 * the object every round would allocate for nothing.
 */
export const WIRE_STEPS: WireSteps = {
  buildWireContext: (messages, compaction, ceiling) =>
    buildWireContext(messages, compaction as CompactionState | null, ceiling),
  sanitizeToolCallPairs,
  materializeReminders,
  stripWireMetadata,
  applyReasoningPolicy,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  hoistSystemToFront,
};

/** The tool rules the turn's obligations are judged against (see toolRuntime.ts). Fixed, so bound once. */
export const TOOL_RULES: ToolRuntimeRules = {
  mutatingTools: MUTATING_FILE_TOOLS,
  riskyPath: RISKY_PATH_PATTERN,
  delegationTools: DELEGATION_TOOLS,
};

/** The turn this wiring is for, as runChatTurn has established it. */
export interface TurnIdentity {
  genConvId: string;
  turnId: string;
  ctrl: AbortController;
  /** What the user typed this turn — the Inspector's label for the delegations it starts. */
  text: string;
  /** Whether this conversation is the one on screen. */
  active: () => boolean;
  /** May this round write to the transcript on screen? Stricter than `active()` (see runChatTurn). */
  ownsView: () => boolean;
  store: ReturnType<typeof useAgentChatStore.getState>;
}

export function wireTurn(host: TurnHost, turn: TurnIdentity) {
  const { t, setStatus, schedulerRef, delegationsRef, brokerRef, orchestrationDeclsRef, convoRef } = host;
  const { requestChat } = host.requests;
  const {
    activeModel,
    endpoint,
    apiKey,
    modelName,
    isLocalModel,
    thinking,
    approvalModeRef,
    thinkingUnsupportedRef,
    reasoningContextUnsupportedRef,
    sendReasoningContext,
  } = host.model;
  const { pushDisplay, replaceDisplay, completeDisplay } = host.view;
  const { requestConsent, allowedToolsRef } = host.consent;
  const hostAskUser = host.askUser;
  const { turnUsageRef } = host.usage;
  const { toolsReady, workdir } = host.toolkit;
  const { sandboxStatusRef } = host.sandbox;
  const { compactionRef } = host.compaction;
  const { pendingJobsRef } = host.jobs;
  const { genConvId, turnId, ctrl, text, active, ownsView, store } = turn;

  /**
   * The Runtime/UI boundary for this turn (docs/agent-runtime-loop.md §13, milestone M2).
   *
   * Built here, from the refs and state this component already owns, and handed to whatever needs it —
   * which today is still the loop below, in this same file. That is what M2 is for: the contract exists and
   * the call sites go through it, while the loop itself stays put until M5 can move it onto already-proven
   * primitives.
   *
   * `signal` is passed, never created: §13 is explicit that page.tsx keeps owning the per-conversation
   * AbortController map and the Runtime only accepts a signal. Every `active()` guard stays on this side of
   * the boundary too — a background conversation must still persist and still run, it just must not write
   * the view of whatever conversation the user is actually looking at.
   */
  /**
   * Where a streaming delta goes.
   *
   * Rebound at the top of every round, because the renderer for a round closes over that round's display
   * baseline — the boundary is built once, before the loop, and cannot capture a closure that does not
   * exist yet. A no-op until the first round assigns it, so a delta arriving out of band is dropped rather
   * than throwing.
   */
  let renderDelta: (content: string, reasoning: string) => void = () => {};

  /**
   * Consent, execution, the display bubble and the usage log for every tool call (see toolExec.ts).
   *
   * Built per turn rather than at component scope, for the same reason as the renderer-tool table below:
   * the factory closes over refs, and constructing it during render means handing those refs to a function
   * at a point React does not guarantee is safe to read them (react-hooks/refs says exactly that). A turn
   * is an event, which is when a ref may be read — and nothing outside a turn calls either of these.
   *
   * `hostConsent` is also what the §13 boundary hands the Runtime, so consent has one implementation
   * whether it is asked for from the tool loop or from a Runtime that no longer lives in this component.
   */
  const { execToolCall, hostConsent } = createToolExec({
    t,
    requestConsent,
    allowedTools: () => allowedToolsRef.current,
    approvalMode: () => approvalModeRef.current,
    wireBuffer: () => convoRef.current,
    compaction: () => compactionRef.current,
    // Lets a tool's bubble go up before the call and be completed in place. `completeDisplay` rather than
    // `replaceDisplay`: a bubble can be gone by the time its call returns, and the result must survive that.
    // Gated like every other write of this turn: a bubble is also gone when the user has switched to another
    // conversation, and the append fallback would then put this turn's finished call into THAT transcript.
    // The result is not lost — it is persisted under this conversation and rebuilt when it is opened again.
    replaceDisplay: (target, next) => {
      if (ownsView()) completeDisplay(target, next);
    },
  });

  const boundary: RuntimeBoundary = {
    signal: ctrl.signal,
    onEvent: (event) => {
      switch (event.type) {
        case "status":
          if (active()) setStatus(event.text);
          break;
        case "delta":
          if (active()) renderDelta(event.content, event.reasoning);
          break;
        // turn-start / turn-end / tool-start / tool-end / stopped are emitted from M3 onward, once there is
        // an Execution State and a Stop Policy to emit them. Ignored rather than unhandled: an event the
        // host does not care about must never be a crash, since the Runtime does not know who is listening.
        default:
          break;
      }
    },
    requestConsent: (req) => hostConsent(genConvId, req),
    // Routed at M2b: the same host function `chatTools` now calls, so there is one implementation of
    // "ask and wait" rather than one per caller.
    askUser: (questions) => hostAskUser(genConvId, questions),
    storage: {
      appendMessage: (sessionId, msg) => {
        store.appendMessage(sessionId, msg as Parameters<typeof store.appendMessage>[1]);
        return (store.getConversation(sessionId)?.messages.length ?? 0) - 1;
      },
      setMessageReminder: (sessionId, index, reminderText) =>
        useAgentChatStore.getState().setMessageReminder(sessionId, index, reminderText),
      setGenerating: (sessionId, generating) => store.setConversationGenerating(sessionId, generating),
    },
  };

  const ctx: RunCtx = {
    convId: genConvId,
    turnId,
    signal: ctrl.signal,
    push: (m) => { if (ownsView()) pushDisplay(m); },
    // Routed through the boundary rather than calling setStatus directly: this is the §13 contract in use,
    // and it is what lets the same handlers run under a test boundary in M5.
    status: (s) => boundary.onEvent({ type: "status", text: s }),
  };

  /**
   * The sub-agent tools for this turn (see chatDelegation.ts).
   *
   * Built here rather than at component scope for the same reason as the renderer table below: the factory
   * is handed refs, and a turn is an event. Built OUTSIDE the try, unlike that table, because `finally`
   * calls shutdownScheduler and cannot see a const declared inside the block it is unwinding.
   */
  /**
   * What this model can actually do (docs/agent-runtime-loop.md §5).
   *
   * Derived once per turn, before anything that needs it: the reasoning policy below and the sub-agent
   * loops both gate on it. Seeded with the live rejection set, so a model that has already refused the
   * thinking parameter is reported as unable to reason and nothing keeps trying to vary it.
   */
  const modelCaps = describeCapabilities({
    model: modelName,
    local: isLocalModel,
    multimodal: !!activeModel?.multimodal,
    contextWindow: activeModel?.contextWindow,
    thinkingRejected: thinkingUnsupportedRef.current.has(modelName),
  });

  // The model as a run in the Rust runtime reaches it — the pieces requestChat closes over. One object for the
  // turn and its delegations, so both reach the provider the same way (see runtimeRound.ts).
  const runtimeModel: RuntimeModel = {
    endpoint,
    apiKey,
    modelName,
    isLocalModel,
    activeModel,
    thinking,
    capabilities: modelCaps,
    thinkingUnsupported: () => thinkingUnsupportedRef.current,
    reasoningContextUnsupported: () => reasoningContextUnsupportedRef.current,
    turnUsage: () => turnUsageRef.current,
  };

  const delegation = createDelegationTools({
    t,
    // What the user actually typed this turn — the Inspector groups delegations under it, because "which
    // turn started this agent" is a question about a message, not about a correlation id.
    turnLabel: text,
    toolsReady,
    workdir,
    endpoint,
    isLocalModel,
    sendReasoningContext,
    sandboxStatusRef,
    requestChat,
    execToolCall,
    replaceDisplay,
    thinking,
    capabilities: modelCaps,
    schedulerRef,
    delegationsRef,
    brokerRef,
    orchestrationDeclsRef,
    pendingJobsRef,
    runtimeModel,
  });

  return {
    execToolCall,
    boundary,
    ctx,
    modelCaps,
    runtimeModel,
    delegation,
    /** Rebind where a streaming delta goes (see renderDelta above). */
    setRenderDelta: (fn: (content: string, reasoning: string) => void) => { renderDelta = fn; },
  };
}
