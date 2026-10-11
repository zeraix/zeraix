"use client";

import { useRef } from "react";
import { toast } from "sonner";
import type { InMemoryAuditLog } from "@/lib/ai/orchestration/audit-log";
import type { ToolDeclaration } from "@/lib/ai/orchestration/capabilities";
import type { CapabilityBroker } from "@/lib/ai/orchestration/capability-broker";
import type { DelegationMeta, PriorDelegation } from "@/lib/ai/subagents";
import type { SchedulerLike } from "@/lib/ai/subagentScheduler";
import { isLocalEndpoint } from "@/lib/ai/localModel";
import { useLocaleStore, type TFunc } from "@/lib/i18n";
import { useAgentChatStore } from "@/store/agentChatStore";
import { MAX_INPUT_CHARS } from "../constants";
import { parseGoalCommand } from "../goal/goalCommand";
import { parseSlashCommand } from "../utils/slashCommands";
import { landUserMessage } from "../turn/turnSetup";
import { runChatTurn, type TurnRefs } from "../turn/chatTurn";
import type { ApiMsg, Attachment } from "../types";
import type { ChatDisplay } from "./useChatDisplay";
import type { ChatCompaction } from "./useChatCompaction";
import type { ChatRequests } from "./useChatRequests";
import type { ChatSkills } from "./useChatSkills";
import type { ChoiceQueue } from "./useChoiceQueue";
import type { ComposerInput } from "./useComposerInput";
import type { useConsentQueue } from "./useConsentQueue";
import type { DiagSnapshot } from "./useContextDiagnostics";
import type { GoalCommandApi } from "./useGoalCommand";
import type { JobEvents } from "./useJobEvents";
import type { ModelSelection } from "./useModelSelection";
import type { PerConvState } from "./usePerConvState";
import type { RecoveryNoticeState } from "./useRecoveryNotice";
import type { SandboxEnv } from "./useSandboxEnv";
import type { SessionUsage } from "./useSessionUsage";
import type { WorkdirSetup } from "./useWorkdirSetup";

export type SendOpts = { text?: string; attachments?: Attachment[]; _fromQueue?: boolean };

/**
 * Everything a send reaches, as the page holds it.
 *
 * Wide on purpose: a turn is where every piece of the chat meets — the model, the transcript, the per-conversation
 * state, the consent and choice queues, the usage meters, compaction, background jobs. Each hook's result is
 * passed whole rather than restated field by field, so the list says WHICH state a turn depends on and the hooks
 * themselves say what that state is.
 */
export interface ChatSendDeps {
  t: TFunc;
  /** For the "open conversation" action of a reply notification. */
  router: { push: (href: string) => void };

  // ── Conversation identity, the wire buffer, and the per-turn flags the page shares with its reset paths ──
  convIdRef: React.RefObject<string | null>;
  setConvId: (id: string | null) => void;
  convoRef: React.RefObject<ApiMsg[]>;
  /** One AbortController per conversation currently generating. */
  runsRef: React.RefObject<Map<string, AbortController>>;
  /** The previous round was stopped by the user: the next send carries RESUME_NUDGE. */
  interruptedRef: React.RefObject<boolean>;
  /** A rated regeneration's one-time feedback hint, consumed by the next send. */
  feedbackNudgeRef: React.RefObject<string | null>;

  // ── Turn chrome ─────────────────────────────────────────────────────────────────────────────────────────────
  loading: boolean;
  setLoading: (v: boolean) => void;
  setStatus: (s: string) => void;
  setError: (text: string | null) => void;
  pinToBottom: () => void;
  /** "Clear chat" — what `/clear` runs, so the command and the header button cannot drift. */
  clearActiveConversationContent: () => void;

  // ── State owned by the page's hooks ─────────────────────────────────────────────────────────────────────────
  composer: ComposerInput;
  model: ModelSelection;
  sandbox: SandboxEnv;
  toolkit: WorkdirSetup;
  skills: ChatSkills;
  view: ChatDisplay;
  perConv: PerConvState;
  consent: Pick<ReturnType<typeof useConsentQueue>, "requestConsent" | "allowedToolsRef">;
  askUser: ChoiceQueue["askUser"];
  usage: SessionUsage;
  compaction: ChatCompaction;
  jobs: JobEvents;
  recovery: RecoveryNoticeState;
  diagRef: React.RefObject<DiagSnapshot>;
  goalCommand: GoalCommandApi;
  requests: ChatRequests;
}

export interface ChatSend {
  send: (opts?: SendOpts) => Promise<void>;
  /** Take the front of a conversation's queue and send it, if that conversation is on screen and idle. */
  processQueue: (convId: string | null) => void;
}

/**
 * The user's message, from the composer to the start of the turn: commands, the preflight, the working-directory
 * policy, and landing the message. The turn itself is chatTurn.ts.
 *
 * Owns the refs that live exactly as long as a turn needs them but outlive any single call — the delegation
 * scheduler, the broker, the artifact side-channel — and hands them to the turn alongside `deps`.
 */
export function useChatSend(deps: ChatSendDeps): ChatSend {
  const { t, convIdRef, setConvId, convoRef, loading, setLoading, setError, pinToBottom } = deps;
  const { clearActiveConversationContent } = deps;
  const { input, setInput, attachments, setAttachments } = deps.composer;
  const {
    activeModel,
    endpoint,
    modelName,
    apiKey,
    isLocalModel,
    selectedModelId,
    localLlmReady,
    setLocalStartDialog,
  } = deps.model;
  const { secureEnvRef, sandboxStatusRef } = deps.sandbox;
  const { toolsReady, workdirChosen, resolveEffectiveWorkdir, composeSystemPrompt } = deps.toolkit;
  const { runtimeSkills } = deps.skills;
  const { displayRef, pushDisplay } = deps.view;
  const { enqueueMessage, shiftQueued, setGoalFor } = deps.perConv;
  const { beginTurnUsage } = deps.usage;
  const { handleGoalCommand, pendingGoalRef } = deps.goalCommand;

  // Side-channel for image_generation: the tool returns only a text note (the artifact must not enter the wire), but
  // the persist step needs the image URL to store it for display rebuild. generateImageAction sets this right before
  // returning; the persist step consumes it. Safe because image_generation runs serially (its own tool group).
  /**
   * The artifact a generation tool just produced, handed to the persist step below.
   *
   * Carries its KIND, not just a URL. Image and video are stored and rendered differently — a video src in
   * an <img> shows nothing at all — so a single untyped "artifact" field would produce a bubble that is
   * silently empty after a reload, which reads as lost work rather than as a wrong tag.
   */
  const lastArtifactRef = useRef<{ src: string; kind: "image" | "video"; servedBy?: string } | null>(null);
  /**
   * Where a delegation tool call parks its sub-agent's inner tool trace, so the persist step can store it
   * beside the conclusion and a reopened conversation shows the same operations the user watched.
   *
   * Keyed by the parsed-args object, which is unique per tool call — a single "last one wins" ref was
   * enough while run_subagent was the only delegation and ran strictly serially, but spawn_subagents
   * starts delegations that outlive their own tool call and settle alongside each other, so the trace has
   * to be addressed rather than assumed. `storedIndex` is filled in by the persist step once the message
   * exists on disk; until then steps accumulate and are flushed on the first patch.
   */
  /** Delegations completed in the current turn, for the repeat guard in runSubAgent (keyed by turn, never cleared — see there). */
  const delegationsRef = useRef<{ turnId: string; done: PriorDelegation[] }>({ turnId: "", done: [] });
  /**
   * The turn's concurrent-delegation scheduler (spawn_subagents / join_subagents).
   *
   * Keyed by turnId for the same reason as delegationsRef: there is no single point where a turn is known
   * to have ended, so rebuilding on a new id is the only reset that cannot leak one turn's jobs into the
   * next. The outgoing scheduler is cancelled on the way out — a delegation whose turn is over has nowhere
   * to deliver a conclusion, so letting it keep running would just burn tokens into a dead display.
   */
  const schedulerRef = useRef<{
    turnId: string;
    /** Either implementation — the renderer's own, or the Rust runtime's. See chatDelegation's schedulerFor. */
    sched: SchedulerLike<DelegationMeta>;
    /**
     * Stops the delegation loops themselves, which cancelling the scheduler alone cannot do: the scheduler
     * settles a job's *outcome* (so a waiting join unblocks), while the loop producing it keeps requesting
     * until something tells it to stop. The turn's own signal covers a user interrupt; this covers the
     * other exit, a turn that simply ended, where nothing is aborted and a running sub-agent would
     * otherwise carry on billing requests into a conversation that has moved on.
     */
    stop: AbortController;
  } | null>(null);
  /**
   * The two refs the delegation tools need but cannot own.
   *
   * `createDelegationTools` is called per turn, so it cannot call `useRef` — and neither of these is
   * turn-scoped anyway. The broker spans the whole mounted chat on purpose: grants, concurrency and the
   * audit trail are a property of the session, and rebuilding it every turn would re-ask for everything the
   * user already allowed. The declaration cache is just as long-lived, for cost rather than semantics.
   */
  const brokerRef = useRef<{ broker: CapabilityBroker; audit: InMemoryAuditLog } | null>(null);
  const orchestrationDeclsRef = useRef<Map<string, ToolDeclaration> | null>(null);
  // messages[0] composed before the conversation record existed (first send). Attached to the record at the persist site below.
  const pendingSystemPromptRef = useRef<string>("");
  /**
   * The conversation whose goal loop just hit its round limit.
   *
   * The exhaustion path clears the goal so the final honest-report round cannot itself be evaluated and
   * re-trigger the limit — but clearing it also makes the "is this conversation still under a goal" gate in
   * `finally` false, which would swallow that very round. This carries the one-shot permission across.
   */
  const goalExhaustedRef = useRef<string | null>(null);
  const turnRefs: TurnRefs = {
    lastArtifactRef,
    delegationsRef,
    schedulerRef,
    brokerRef,
    orchestrationDeclsRef,
    goalExhaustedRef,
  };

  // Queue resume: after a conversation's round of generation ends, if it still has queued messages and is still the current conversation, take the front of the queue and auto-send it (processing in order).
  // A conversation switched away from does not auto-resume (its queue is retained and triggered by loadConversation when switched back to and loaded).
  const processQueue = (convId: string | null) => {
    if (!convId || convId !== convIdRef.current) return;
    if (useAgentChatStore.getState().generating[convId]) return; // This conversation is still generating; wait for it to finish before resuming
    const next = shiftQueued(convId);
    if (next) void send({ text: next.text, attachments: next.attachments, _fromQueue: true });
  };

  /**
   * Reject the send outright, or divert it, before anything is mutated: a round already generating (the message
   * is queued instead), an image still uploading, no usable model, or a local model that is not running.
   *
   * Returns false when `send` must stop — every branch has already told the user why, or taken the message.
   */
  const passesSendPreflight = (text: string, atts: Attachment[], fromQueue: boolean): boolean => {
    // Hard ceiling on message length. Checked here as well as by the composer's maxLength, because the queue
    // and the home page's pending auto-send pass their text straight to send() without ever going through the
    // textarea, so the attribute cannot see them.
    if (text.length > MAX_INPUT_CHARS) {
      const num = new Intl.NumberFormat(useLocaleStore.getState().locale);
      setError(t("chat.inputTooLong", { n: num.format(text.length), max: num.format(MAX_INPUT_CHARS) }));
      return false;
    }
    // Generation in progress: enqueue the new message (auto-sent in order after this round ends) rather than dropping it. _fromQueue is the queue resume itself, so let it through.
    if (loading && !fromQueue) {
      const convId = convIdRef.current;
      if (convId) {
        enqueueMessage(convId, text, atts);
        setInput("");
        setAttachments([]); // The attachment objects have been handed over to the queue (their previewUrl is released at send time), so do not revoke here
      }
      return false;
    }
    // Do not send while an image is still uploading to OSS, to avoid a missing publicUrl. Local models are the exception: they use inline base64 (the bytes are on this machine) and need not wait for an upload.
    if (!isLocalModel && atts.some((a) => a.kind === "image" && a.uploading)) {
      setError(t("chat.imageUploading"));
      return false;
    }
    // Local models (127.0.0.1 llama-server) need no API key (the proxy layer substitutes "local" as a placeholder, see chatOnce).
    if (!activeModel || !endpoint || !modelName || (!apiKey.trim() && !isLocalEndpoint(endpoint))) {
      setError(t("chat.noModel"));
      return false;
    }
    // A local model is selected but llama-server is not running (e.g. after an app restart): do not auto-start, pop a dialog guiding the user to start it manually in the model library.
    if (isLocalModel && localLlmReady === false) {
      setLocalStartDialog(true);
      return false;
    }
    return true;
  };

  // opts is used for programmatic sends (e.g. the home page's pending auto-send / queue resume); when omitted, the input box / attachment state is used.
  const send = async (opts?: SendOpts) => {
    let text = (opts?.text ?? input).trim();
    const atts = opts?.attachments ?? attachments; // Snapshot: cleared later
    // Commands are handled before the preflight, deliberately. They never reach a model, so a missing API key
    // must not reject one — and `/goal clear` and `/clear` in particular have to work WHILE a turn is
    // generating, which the preflight would otherwise turn into a queued message that only lands after the
    // thing it was meant to stop.
    //
    // An unrecognised `/word` is NOT intercepted: it falls through and is sent as an ordinary message, because
    // people type paths and dates and a strict reading would refuse messages they meant to send.
    const slash = parseSlashCommand(text);
    if (slash?.name === "clear") {
      const count = displayRef.current.length;
      setInput("");
      // Same operation the header's "clear chat" performs, so the two cannot drift: the conversation keeps its
      // sidebar entry and its title, and only the history inside it goes.
      clearActiveConversationContent();
      // Said out loud because the deletion is real and there is no undo. The header button at least sits under
      // a menu the user opened on purpose; a typed command deserves an acknowledgement of what it just did.
      if (count > 0) toast.success(t("chat.clearedCount", { count: String(count) }));
      else toast.info(t("chat.clearedEmpty"));
      return;
    }
    if (slash?.name === "goal") {
      const cmd = parseGoalCommand(text);
      if (cmd.kind !== "none") {
        const proceed = handleGoalCommand(cmd);
        setInput("");
        if (!proceed) return;
        text = proceed;
      }
    }
    if (slash?.name === "shell") {
      return
    }
    if (!text && atts.length === 0) return;
    if (!passesSendPreflight(text, atts, !!opts?._fromQueue)) return;

    const effectiveWorkdir = await resolveEffectiveWorkdir();
    if (effectiveWorkdir === null) return; // Rejected by the working-directory policy; the reason is already on screen

    setError(null);
    setInput("");
    pinToBottom(); // After sending, return to the bottom to follow this round's output
    atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)); // Release the local previews
    setAttachments([]);
    setLoading(true);
    // This round's AbortController; when sending, the conversation must be the current active one, and it is registered into runsRef at the genConvId point (once the conversation id is determined).
    const ctrl = new AbortController();
    // Reset this round's usage and start its clock (see useSessionUsage). send() is an async event handler, never
    // render code: it is reached from the composer, the queue and the job-finished subscription.
    beginTurnUsage();

    // Inject system (local capabilities + working-directory constraint + enabled-skill hints): only when the current conversation has no system message yet,
    // so that continuing to send after loading a historical conversation also backfills system.
    const enabled = runtimeSkills();
    if (convoRef.current[0]?.role !== "system") {
      const composedSystem = composeSystemPrompt();
      convoRef.current = [{ role: "system", content: composedSystem }, ...convoRef.current];
      // Freeze it on the conversation record. Everything above is a function of mode, sandbox status and which memory bridge is
      // present — all of which can differ by the time the conversation is reopened. The rebuilt buffer carries no system message,
      // so without this the compose step ran again on every reload and silently rewrote the very front of the prefix.
      if (convIdRef.current) {
        useAgentChatStore.getState().setConversationSystemPrompt(convIdRef.current, composedSystem);
      } else {
        // No conversation record yet (this is the first send). Stash it so the persist site below can attach it once the record
        // exists — the record is created a few lines down, from the same values.
        pendingSystemPromptRef.current = composedSystem;
      }
    }
    // Nothing variable is written into messages[0] any more: the date, the active model, the working directory, the skill menu and
    // the mission brief are all announced downstream as change events (see reminders.ts). messages[0] is therefore a function of
    // the mode alone, which is what lets two installs share a prefix — and a resident KV seed.
    // Land the user's message: into the wire buffer, onto the screen, and onto disk (see turnSetup.ts).
    const landed = await landUserMessage({
      text,
      attachments: atts,
      effectiveWorkdir,
      toolsReady,
      isLocalModel,
      selectedModelId,
      workdirChosen,
      secureEnv: secureEnvRef.current,
      sandboxStatus: sandboxStatusRef.current,
      t,
      convoRef,
      convIdRef,
      pendingGoalRef,
      pendingSystemPromptRef,
      setConvId,
      setGoalFor,
      pushDisplay,
    });
    if (!landed.ok) {
      setError(landed.error);
      setLoading(false);
      return;
    }
    // The message is on screen and on disk; everything from here on is the turn itself (see chatTurn.ts). Handed
    // this render's `send` and `processQueue`, so a queued message and the goal loop's next round go down the
    // same road this one did.
    await runChatTurn({ ...deps, ...turnRefs, send, processQueue }, { text, effectiveWorkdir, enabled, landed, ctrl });
  };

  return { send, processQueue };
}
