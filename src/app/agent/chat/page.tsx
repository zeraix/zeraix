"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { syncToolLLMConfig } from "@/lib/ai/toolkit";
import { primeUsageLog } from "@/lib/ai/usageLog";
import { isLocalEndpoint } from "@/lib/ai/localModel";
import { DEFAULT_SECURE_ENV } from "@/lib/ai/sandbox";
import { useT } from "@/lib/i18n";
import { SkillSelectPanel } from "./components/SkillSelectPanel";
import BrowserPanel from "./components/BrowserPanel";
import { migrateLegacyAgentStorage } from "@/lib/ai/agentStorage";
import { hydrateAppConfig } from "@/lib/ai/appConfig";
import { DEFAULT_THINKING, thinkingParams } from "@/lib/ai/thinking";
import { useAgentChatStore } from "@/store/agentChatStore";
import { enabledSkills } from "@/lib/ai/skills/store";
import { GoalBar } from "./components/GoalBar";
import { ensureModelListSeeded, resolveContextWindow } from "@/lib/ai/models";
import { CHAT_COLUMN } from "./constants";
import type { ApiMsg } from "./types";
import { cancelJobsFor } from "@/lib/ai/generation/jobs";
import { setBrowserBusy } from "@/lib/automation";
import { TodoPanel } from "./components/TodoPanel";
import { ChatTranscript } from "./components/ChatTranscript";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { Composer } from "./components/Composer";
import { ProjectSkillsPrompt } from "./components/ProjectSkillsPrompt";
import { AnimatePresence, motion } from "framer-motion";
import { ConsentPanel } from "./components/ConsentPanel";
import { QueuedMessages } from "./components/QueuedMessages";
import { useConsentQueue } from "./hooks/useConsentQueue";
import { useChoiceQueue } from "./hooks/useChoiceQueue";
import { ChatHeader } from "./components/ChatHeader";
import { SubAgentInspector, SubAgentInspectorButton } from "./components/SubAgentInspector";
import { useSubAgentExecutionStore } from "@/store/subagentExecutionStore";
import { ChatDialogs } from "./components/ChatDialogs";
import { ContextUsageRing } from "./components/ContextUsageRing";
import { useTranscriptWindow } from "./hooks/useTranscriptWindow";
import { useSandboxEnv } from "./hooks/useSandboxEnv";
import { usePerConvState } from "./hooks/usePerConvState";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { useModelSelection } from "./hooks/useModelSelection";
import { restoreDisplay, restoreWireBuffer } from "./transcript/conversationRestore";
// ── State-owning hooks split out of this component (each owns one slice; see the files) ──────────────────────
import { useChatDisplay } from "./hooks/useChatDisplay";
import { useComposerInput } from "./hooks/useComposerInput";
import { useWorkdirSetup } from "./hooks/useWorkdirSetup";
import { useChatSkills } from "./hooks/useChatSkills";
import { useRecoveryNotice } from "./hooks/useRecoveryNotice";
import { useSessionUsage } from "./hooks/useSessionUsage";
import { useContextDiagnostics } from "./hooks/useContextDiagnostics";
import { useChatRequests } from "./hooks/useChatRequests";
import { useChatCompaction } from "./hooks/useChatCompaction";
import { useConversationSwitch } from "./hooks/useConversationSwitch";
import { useJobEvents } from "./hooks/useJobEvents";
import { useGoalCommand } from "./hooks/useGoalCommand";
import { useChatSend } from "./hooks/useChatSend";
import { useMessageActions } from "./hooks/useMessageActions";

function ChatAgent() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // This component is permanently mounted by AgentShell (it does not unmount when switching between pages inside /agent, so the generation loop and message queue keep running).
  // Therefore it is only "visible / the current page" while on the chat route — route-related side effects are gated on this.
  const onChatRoute = pathname === "/agent/chat";
  const seededRef = useRef(false); // Consume the ?q= / pending / ?c= brought from the home page only once
  const convIdRef = useRef<string | null>(null); // The current conversation record id (created on the first message)
  /**
   * Render-visible mirror of convIdRef, written by setConvId below.
   *
   * The ref is the authority — the send loop and every async handler read it synchronously, and must see the id
   * the moment it changes rather than at the next commit. But the consent panel and the todo panel are gated on
   * "does this belong to the conversation on screen", and reading the ref from JSX made that gate invisible to
   * React: the panel only appeared because some other state happened to re-render at the same time.
   */
  const [viewConvId, setViewConvId] = useState<string | null>(null);
  /** Point both at the same conversation. Every writer goes through here, so the mirror cannot drift. */
  const setConvId = (id: string | null) => {
    convIdRef.current = id;
    setViewConvId(id);
  };
  const [setupDone, setSetupDone] = useState(false); // Mount initialization complete (model / tools / directory ready)
  // Which model this conversation talks to, and everything derived from it (see useModelSelection).
  const model = useModelSelection({ convIdRef, t });
  const {
    activeModel,
    models,
    selectedModelId,
    selectedLabel,
    modelGroups,
    selectModel,
    applyEffectiveModel,
    initActiveModel,
    endpoint,
    modelName,
    apiKey,
    thinking,
    changeThinking,
    approvalMode,
    changeApprovalMode,
    localStartDialog,
    setLocalStartDialog,
  } = model;
  const [loading, setLoading] = useState(false);
  const activeConvId = useAgentChatStore((s) => s.activeConversationId);
  // Active conversation's title, selected reactively so the header dropdown reflects a rename immediately.
  const activeConvTitle = useAgentChatStore((s) => {
    const id = s.activeConversationId;
    return id ? (s.conversations.find((c) => c.id === id)?.title ?? "") : "";
  });
  const renameConversation = useAgentChatStore((s) => s.renameConversation);
  // The project a not-yet-created session would belong to. Subscribed reactively because the secure-environment switch a
  // fresh session shows is inherited from THIS project's last session, and clicking a different project in the sidebar has
  // to move that answer before the user sends anything.
  const activeProjectId = useAgentChatStore((s) => s.activeProjectId);
  // Header "Rename" dialog: null = closed; a string is the draft title being edited.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [status, setStatus] = useState(""); // While generating, show the user "what it is doing"
  /**
   * The error banner, tagged with the conversation it belongs to.
   *
   * It used to be a bare string, and the banner is rendered at the foot of the transcript — so a failure in one
   * conversation stayed on screen while the user read a different one, attributing "Failed to fetch" to a chat that
   * had never made a request. Only two paths cleared it ("new chat" and "clear chat"); switching conversations was
   * not one of them.
   *
   * Tagged rather than cleared on switch, which is the pattern the rest of this view already follows for the todo
   * list, the goal, the queue and the recovery banner: the error belongs to a turn, so switching away hides it and
   * switching back brings it with the conversation it describes. `setError` keeps its one-argument shape, so every
   * call site is unchanged and none of them has to remember to pass an id.
   */
  const [errorState, setErrorState] = useState<{ convId: string | null; text: string } | null>(null);
  const setError = (text: string | null) =>
    setErrorState(text ? { convId: convIdRef.current, text } : null);
  const error = errorState && errorState.convId === viewConvId ? errorState.text : null;
  // What the user is composing: input text, staged attachments, the input box (see useComposerInput).
  const composer = useComposerInput({ onChatRoute, onError: setError, t });
  const { input, setInput, attachments, setAttachments, removeAttachment, addFiles, taRef, fileInputRef } = composer;
  // The transcript on screen, its synchronous mirror, and whose it is (see useChatDisplay).
  const view = useChatDisplay();
  const { display, setDisplay, displayRef, adoptDisplay, pushDisplay } = view;
  // Toolkit readiness, the working directory, and the prompt-prefix composers (see useWorkdirSetup).
  const toolkit = useWorkdirSetup({ onError: setError, t });
  const { toolsReady, proxyReady, workdir, settingsOpen, probeToolkit, restoreWorkdir, adoptWorkdir } = toolkit;
  // Sandbox runtime status + this session's secure-environment switch (see useSandboxEnv).
  const sandbox = useSandboxEnv({ convIdRef, activeConvId, activeProjectId });
  const { sandboxStatusRef, sandboxStatus, sandboxDialogTick, openSandboxDialog, vmUpdatable, secureEnv, applySecureEnv } =
    sandbox;
  // Installed / project / plugin skills and the skills panel (see useChatSkills).
  const skills = useChatSkills({ onChatRoute, workdir, toolsReady });
  const { installedSkills, setInstalledSkillsBoth, reloadInstalledSkills, reloadProjectSkills, skillsOpen } = skills;
  // What the user and the model are told about a turn a crash cut short (see useRecoveryNotice).
  const recovery = useRecoveryNotice({ t });
  const { recoveryNotice, dismissRecovery, noteInterruptedTurn, notePriorSession } = recovery;
  /** The Sub-agent Execution Inspector. Its entry point hides itself when nothing has been delegated. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The header's root element. Nothing reads it yet — it exists so measurements against the top bar (its height,
  // its bottom edge) have a handle that does not depend on a querySelector or a magic pixel constant.
  const headerRef = useRef<HTMLDivElement>(null);
  // Transcript scroll position and how much of `display` is mounted (see useTranscriptWindow).
  const {
    scrollRef,
    earlierSentinelRef,
    atBottom,
    onScroll,
    scrollToBottom,
    pinToBottom,
    resetView: resetTranscriptView,
    visibleStart,
    hasEarlier,
    loadEarlier,
  } = useTranscriptWindow(display, loading, displayRef);
  // The API conversation retained across rounds (including system / tool messages), not involved in rendering. Fully faithful, it is the single source of truth for both the "display view" and
  // the "compressed wire view"; compaction only happens in the pre-send derivation step (buildWireContext) and never rewrites it.
  const convoRef = useRef<ApiMsg[]>([]);
  // Sensitive-operation confirmation queue (extracted to useConsentQueue): the front-of-queue `pending`
  // for the panel, keyboard nav, request/answer/drop, and the per-conversation "don't ask again" allow-set.
  const consent = useConsentQueue();
  const { pending, consentSel, setConsentSel, consentPanelRef, allowedToolsRef, answerConsent, dropConsentsFor, onConsentKey } =
    consent;
  // The ask_user choice cards (see useChoiceQueue).
  const {
    askUser: hostAskUser,
    restorePendingChoices,
    submitChoice,
    dropChoicesFor,
  } = useChoiceQueue({ convIdRef, onPush: (m) => pushDisplay(m), setDisplay });
  // A separate AbortController for each "currently generating" conversation (keyed by conversation id), supporting multi-conversation background concurrency.
  // Cancel = abort the one for the current active conversation; the send loop exits at the next checkpoint.
  const runsRef = useRef<Map<string, AbortController>>(new Map());
  // Interrupt resume: set when the previous round was "stopped" by the user. On the next send (whether the same or a new question), a one-time hint is appended to the model,
  // prompting it to reuse the analysis / tool results already retained above and continue, rather than starting over. Cleared once consumed.
  const interruptedRef = useRef(false);
  // A one-time "rating feedback" hint: set when the user thumbs up / down the previous reply and triggers a regeneration; written
  // into the fresh user turn by the change-events block (same one-time nudge mechanism as RESUME_NUDGE — persisted with the turn,
  // not displayed). Used to let the rating influence the current conversation's next generation in real time.
  const feedbackNudgeRef = useRef<string | null>(null);
  // Token usage for the round and the session, and the current context size (see useSessionUsage).
  const usage = useSessionUsage();
  const { sessionUsage, contextTokens, resetUsage } = usage;
  // Run parameters removed: tool rounds / subagent rounds no longer have an upper limit, and the old deadlock protection keyed on
  // "the same call again" / "another timeout" is gone with them. The related settings and persistence were removed accordingly.
  // What replaced it is not a limit but a progress test (loopGuard.ts): a turn is only stopped once it demonstrably stops learning
  // anything, so long work is unaffected and only a loop is cut short. Manual "stop" remains, and is still the user's own control.

  // Per-conversation queue / checklist / Task Memory / Goal State (see usePerConvState).
  const perConv = usePerConvState({ convIdRef });
  const {
    queued,
    syncQueued,
    enqueueMessage,
    removeQueued,
    clearQueue,
    todos,
    setTodosFor,
    toggleTodo,
    displayedGoal,
    goalExpanded,
    setGoalExpanded,
    adoptConversation,
    resetConversation,
  } = perConv;

  // Stop the current generation: abort the in-flight request for the "current active conversation", release any waiting confirmation / choice, and the loop then exits on its own.
  // Background-conversation generation is unaffected (each has its own independent AbortController).
  const cancel = () => {
    const cid = convIdRef.current;
    if (cid) {
      runsRef.current.get(cid)?.abort();
      // Stop = abort the current generation, and clear this conversation's queued messages (releasing their attachment previews); no more auto-resume.
      clearQueue(cid);
    }
    dropConsentsFor(cid); // Release this conversation's waits in the confirmation queue (ending them with "reject") and advance the queue
    dropChoicesFor(cid, "The user canceled."); // Release all of this conversation's pending-answer ask_user prompts
  };

  // The last request actually sent, and the console harness that replays it (see useContextDiagnostics).
  const { diagRef } = useContextDiagnostics({
    activeModel,
    convoRef,
    composeSystemPrompt: toolkit.composeSystemPrompt,
    buildToolSet: toolkit.buildToolSet,
  });

  // After mount, restore the last selection / key + probe whether local tools are available (Electron only).
  useEffect(() => {
    void (async () => {
      hydrateAppConfig(); // First seed local storage from app.config (an INI next to the executable); the file wins
      migrateLegacyAgentStorage(); // Merge the old flat keys into the agent object before the first read
      ensureModelListSeeded(); // On first run, migrate the model list out of the legacy single-select config
      initActiveModel(); // The currently selected model → the endpoint / model / key used for sending
      const ready = probeToolkit();
      // Usage log: read the switch once so the per-tool-call log helpers can answer synchronously.
      // Off by default, in which case every logging call below is a no-op.
      void primeUsageLog();
      reloadInstalledSkills(); // Restore installed skills (including enabled state)
      // C9: the previous session left its lock behind, so it died before finishing its teardown. Only the flag is
      // read here — the toast is fired by useRecoveryNotice's own effect.
      notePriorSession();
      // Working directory: prefer the directory explicitly chosen and persisted on the home page (the previous stage); otherwise take the main process's current directory.
      await restoreWorkdir(ready);
      await useAgentChatStore.getState().init(); // Load projects / conversation records
      setSetupDone(true); // Initialization complete → trigger ?c= load / pending auto-send
    })();
    // Every callback listed is stable (useCallback with no changing deps), so listing them keeps this mount-only.
  }, [initActiveModel, probeToolkit, reloadInstalledSkills, notePriorSession, restoreWorkdir]);

  // The URL-seeding effect (?c= / ?q= / pending) lives at the very bottom of this component, because it calls
  // loadConversation and send — both declared far below here, and a `const` arrow is not hoisted.

  // Permanent-mount reset: this component does not unmount on route change, so once seededRef is set true it would stay true forever — leaving the chat route (e.g. "new conversation"
  // first jumps back to the home page /agent) resets the latch, so the next entry into the chat page carrying pending/?q= can consume again. Otherwise a message sent from the home page the second
  // time onwards would be skipped directly by the effect above: the page navigates but the message is not sent, and no new conversation appears in the sidebar.
  useEffect(() => {
    if (!onChatRoute) seededRef.current = false;
  }, [onChatRoute]);

  // The model config for main-process tools that make a model call of their own (refine_question). Re-sent whenever
  // the active model changes; without this the main process has no endpoint at all and the tool fails every time.
  // A local llama-server takes any key — "local" is what the chat request itself sends.
  useEffect(() => {
    if (!endpoint || !modelName) return;
    syncToolLLMConfig({
      endpoint,
      model: modelName,
      apiKey: apiKey.trim() || (isLocalEndpoint(endpoint) ? "local" : ""),
      // Thinking OFF for the helper's one-sentence rewrite, in this family's spelling. The helper runs in the main
      // process, which has no copy of the family rules; the switch travels with the config instead.
      body: thinkingParams(
        { ...DEFAULT_THINKING, enabled: false, sendContext: false },
        { local: isLocalEndpoint(endpoint), model: modelName },
      ),
    });
  }, [endpoint, modelName, apiKey]);

  // The request functions this render's model settings produce: chat, summariser, goal evaluator (see useChatRequests).
  const requests = useChatRequests({ model, proxyReady, turnUsageRef: usage.turnUsageRef, t });
  // The conversation-on-screen's compaction state and operations (see useChatCompaction / chatCompaction.ts).
  const compaction = useChatCompaction({
    t,
    activeModel,
    loading,
    convIdRef,
    convoRef,
    setCtxTokens: usage.setCtxTokens,
    contextTokensRef: usage.contextTokensRef,
    summarizeHistory: requests.summarizeHistory,
    taskMemoryFor: perConv.taskMemoryFor,
    setTaskMemoryFor: perConv.setTaskMemoryFor,
  });
  const { compacted, compacting, compactNow, snapshotCompaction, persistCompaction, resetCompaction, restoreCompaction } =
    compaction;
  // Serialised conversation switches and the skeleton shown while one runs (see useConversationSwitch). The swap
  // itself is below; it is reached lazily, because it is declared after this call.
  const { switching, loadConversation, cancelPendingSwitch } = useConversationSwitch({
    swapIn: (id, projectId, stale) => swapInConversation(id, projectId, stale),
  });
  // Background-job bookkeeping and the subscriptions that wake a conversation when one finishes (see useJobEvents).
  // `send` is reached lazily for the same reason: it comes from useChatSend below, which needs these refs.
  const jobs = useJobEvents({
    convIdRef,
    sandboxStatusRef,
    send: (opts) => void send(opts),
    pushDisplay,
    enqueueMessage,
  });
  // `/goal` and the goal bar's clear button (see useGoalCommand).
  const goalCommand = useGoalCommand({
    convIdRef,
    goalFor: perConv.goalFor,
    setGoalFor: perConv.setGoalFor,
    showPendingGoal: perConv.showPendingGoal,
    setGoalExpanded,
    t,
  });

  const clearAll = () => {
    // If there are pending sensitive-operation confirmations / choices, wind them up first to avoid the send loop hanging. Clearing targets the current conversation, releasing its pending-confirmation requests.
    dropConsentsFor(convIdRef.current);
    dropChoicesFor(convIdRef.current, "The user cleared the conversation.");
    // Generation jobs outlive their turn on purpose, so nothing else stops them — but they must not outlive
    // the conversation they would report into. Cancelled silently: waking a conversation the user just
    // cleared is the opposite of what clearing it asked for.
    if (convIdRef.current) cancelJobsFor(convIdRef.current);
    allowedToolsRef.current.clear(); // Clearing the conversation also resets the "don't ask again" allowances
    interruptedRef.current = false; // New conversation: clear any residual "interrupt resume" flag
    displayRef.current = [];
    setDisplay([]);
    adoptDisplay(null); // an empty transcript belongs to no conversation until one is created
    resetTranscriptView(); // New conversation: nothing to reveal, back to the tail-only window, following from the bottom
    cancelPendingSwitch(); // ...and drop any conversation still being switched in, so it cannot land on top of this
    resetConversation(convIdRef.current); // Queue panel, task list, Task Memory brief and goal
    setAttachments([]); // Clear unsent attachments
    resetUsage(); // Round and session token stats, and the context usage, back to zero
    convoRef.current = [];
    // Reset context compaction: a new conversation has no history to compact.
    resetCompaction();
    setConvId(null); // The next send will start a new conversation record
    useAgentChatStore.getState().setActiveConversation(null);
    applyEffectiveModel(); // No conversation → return to the globally selected model
    setError(null);
  };

  // "Clear chat": empty the current conversation's messages but KEEP its sidebar entry (only the content is cleared,
  // the history item stays). Resets the in-memory view like clearAll, but leaves convIdRef on the same (now empty)
  // conversation instead of starting a new one. With no saved conversation yet, there is nothing to keep — just reset.
  const clearActiveConversationContent = () => {
    const id = convIdRef.current;
    if (!id) {
      clearAll();
      return;
    }
    // Stop the turn first if one is running. Clearing does not abort by itself, so the loop would carry on
    // appending into the record that was just emptied — the messages come back one by one, out of a
    // conversation the user believes they deleted. cancel() also drops the queue and releases any pending
    // consent/choice waits, all of which belong to history that no longer exists.
    if (useAgentChatStore.getState().generating[id]) cancel();
    dropConsentsFor(id);
    dropChoicesFor(id, "The user cleared the conversation.");
    allowedToolsRef.current.clear();
    interruptedRef.current = false;
    // Jobs and goal-loop bookkeeping belong to the history being deleted; leaving them would let a build that
    // started before the clear inject its result into an empty conversation.
    jobs.pendingJobsRef.current.delete(id);
    jobs.awaitingJobsRef.current.delete(id);
    // Execution history belongs to the transcript being deleted: keeping it would leave the Inspector
    // describing work whose conversation no longer exists.
    useSubAgentExecutionStore.getState().clearConversationExecutions(id);
    useAgentChatStore.getState().truncateMessages(id, 0); // empty the messages, keep the conversation entry
    displayRef.current = [];
    setDisplay([]);
    adoptDisplay(id); // emptied, but still this conversation's transcript
    resetTranscriptView();
    cancelPendingSwitch();
    // The goal goes with the messages it was pursued through: the evaluator judges from the transcript, and a
    // goal left active over an emptied conversation would be judged against nothing.
    resetConversation(id);
    setAttachments([]);
    resetUsage();
    convoRef.current = [];
    resetCompaction();
    persistCompaction(id); // drop the persisted compaction snapshot for this conversation
    setError(null);
  };

  // Reset of the permanently-mounted conversation view: the sidebar "new conversation" / right-click "new conversation in project" / mode switch and other "start a new thread" entry points
  // all clear the active conversation (store.setActiveConversation(null)). But this component's convIdRef is independent of the store and does not update along with it —
  // without a reset, the next message would continue the old conversation because convIdRef still points to the previous one (manifesting as "right-click new conversation yet keeps using
  // the old one"). So when the active conversation is cleared externally while this component still holds some conversation, reset the view to a clean new-conversation state.
  // clearAll itself also clears the active conversation, but it clears convIdRef first and the guard below decides on that, so it does not re-enter itself;
  // an old conversation's background generation proceeds independently by genConvId, its view side effects are guarded by active(), and the reset does not affect it finishing.
  useEffect(() => {
    if (activeConvId === null && convIdRef.current !== null) {
      clearAll();
      // clearAll does not touch loading/status; clear them as well, to avoid the new empty conversation still showing the "stop / queue" left over from the previous conversation.
      setLoading(false);
      setStatus("");
      setBrowserBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  // The user's message, from the composer to the end of its turn (see useChatSend.ts and chatTurn.ts).
  const { send, processQueue } = useChatSend({
    t,
    router,
    convIdRef,
    setConvId,
    convoRef,
    runsRef,
    interruptedRef,
    feedbackNudgeRef,
    loading,
    setLoading,
    setStatus,
    setError,
    pinToBottom,
    clearActiveConversationContent,
    composer,
    model,
    sandbox,
    toolkit,
    skills,
    view,
    perConv,
    consent,
    askUser: hostAskUser,
    usage,
    compaction,
    jobs,
    recovery,
    diagRef,
    goalCommand,
    requests,
  });

  // Edit / regenerate / rate an already-sent message (see useMessageActions).
  const { editUser, regenerate, rateMessage } = useMessageActions({
    loading,
    convIdRef,
    convoRef,
    displayRef,
    setDisplay,
    attachIdRef: composer.attachIdRef,
    feedbackNudgeRef,
    resetCompaction,
    persistCompaction,
    send,
  });

  // Load a historical conversation: rebuild the display and the API conversation (messages[0] is replayed from the frozen
  // conv.systemPrompt; only records from before that field existed fall back to composing on the next send).
  // Lazy loading: first ensure the conversation file of the project this conversation belongs to is loaded (projectId comes from the sidebar navigation's ?p=).
  // Reached through loadConversation (useConversationSwitch), which shows the skeleton and serialises switches.
  const swapInConversation = async (id: string, projectId?: string, stale: () => boolean = () => false) => {
    const store = useAgentChatStore.getState();
    if (projectId) await store.ensureProjectLoaded(projectId);
    if (stale()) return; // Overtaken by a newer switch: stop before touching any shared state
    const conv = store.getConversation(id);
    if (!conv) return;
    snapshotCompaction(convIdRef.current); // Save the old conversation's compaction state before switching away
    interruptedRef.current = false; // Switching conversations: the interrupt-resume flag does not carry across conversations
    setConvId(id);
    // Adopt the secure-environment switch this conversation ran under, and re-point the main process at it. This is the whole
    // point of binding it to the session: the engine follows whichever conversation is open, so reading an old sandboxed
    // session does not silently start executing its commands on the host (or the reverse).
    //
    // A conversation with no recorded value predates the switch. It falls back to its own project's most recent session, then
    // to the app default — the same ladder a brand-new session climbs — rather than to whatever the previous conversation
    // happened to leave the engine set to. persist:false because merely opening a conversation must not write to it; the
    // value is stamped when the user toggles, or when a new record is created.
    applySecureEnv(
      conv.secureEnv ?? store.secureEnvDefaultFor(conv.projectId) ?? DEFAULT_SECURE_ENV,
      { persist: false },
    );
    // A checkpoint left on the record means the previous turn never reached its end — the process died while it was
    // running (docs/agent-runtime-crash-recovery.md C2). Read here, at the one point a conversation is opened: the
    // banner states the facts to the user, and the sentence for the model waits for the next send rather than being
    // injected into a turn nobody asked for. Nothing is resumed and nothing is re-run — `running` may already have
    // had side effects.
    //
    // Deliberately NOT cleared here. The record is what guarantees the model is told before it acts again, and a user
    // who opens the conversation, quits, and comes back tomorrow to send a message would otherwise get a model that
    // knows nothing about the interrupted work. It is consumed at the send that announces it (and overwritten by that
    // turn's own first checkpoint moments later), so the cost of keeping it is that the banner reappears until the
    // conversation is actually used again — which is true, and dismissible.
    if (conv.turnState && !runsRef.current.has(id)) noteInterruptedTurn(id, conv.turnState);
    // Restore this conversation's checklist / Task Memory brief / goal, and put them on screen.
    adoptConversation(id, conv);
    store.setActiveConversation(id);
    applyEffectiveModel(); // Loading a conversation → adopt its conversation-level bound model (global if none)
    // Restore this conversation's working directory: set the tools' working directory back to the directory used when the conversation was created (fall back to its owning project's directory if missing).
    // Otherwise opening a historical conversation directly from the sidebar would not trigger WORKDIR_SET_EVENT, and the tools would stay at the process default directory
    // (zeraix-workspace), causing the AI to work in the wrong directory / report the wrong directory.
    const restoredDir = conv.workdir || store.projects.find((p) => p.id === conv.projectId)?.workdir || "";
    if (restoredDir) {
      await adoptWorkdir(restoredDir);
      if (stale()) return; // A newer switch is already rebuilding the view — do not overwrite it with this one
    }
    // Rebuild the wire buffer and the transcript from the record (see conversationRestore.ts). Faithfully restores the
    // tool-call trace (the assistant's tool_calls + tool result messages), so that when continuing the chat the model still
    // "remembers" what it called and what results it got.
    //
    // messages[0] is replayed from the record rather than recomposed: it is a function of mode, sandbox status
    // and the memory bridge, so recomputing it here rewrote the front of the prefix whenever any of those had
    // moved since the conversation started. Only a record written before this field existed falls through to
    // the compose step on the next send.
    convoRef.current = restoreWireBuffer(conv);
    const disp = restoreDisplay(conv);
    displayRef.current = disp;
    setDisplay(disp);
    // Only HERE does the transcript become this conversation's. Anything in flight for it has been declining
    // to render since the switch began, and re-takes its baseline from this rebuild on the next delta.
    adoptDisplay(id);
    // A question this conversation asked while the user was looking elsewhere is still waiting on an answer.
    // Re-shown here, after the rebuild, because the rebuild is what would otherwise drop it.
    restorePendingChoices(id);
    // Opening a conversation mounts only its last few turns; the rest is revealed on scroll-up.
    // Reset per conversation, so a long history expanded earlier does not make the next one open fully mounted.
    resetTranscriptView(); // Switching conversations: display pinned to the bottom, resume auto-follow
    // Restore the compaction state (session cache, then disk snapshot, then an estimate — see useChatCompaction).
    restoreCompaction(id, conv);
    // Align the loading state with the "conversation switched to": that conversation is generating in the background → show loading / thinking; otherwise clear it
    // (fixes "still showing AI thinking after a fast switch" — loading/status were originally global and were not reset per conversation after switching).
    const isGenerating = !!useAgentChatStore.getState().generating[id];
    setLoading(isGenerating);
    setStatus(isGenerating ? t("chat.generating") : "");
    setBrowserBusy(false); // The halo belongs to the active conversation; extinguish it on switch, and if the new conversation is operating the browser its run loop will relight it
    // Queue: show this conversation's queued messages; if it is currently idle yet still has a queue (paused when previously switched away), continue the resume after loading.
    syncQueued(id);
    processQueue(id);
  };

  // After initialization is complete:
  //  - ?c= changes → load the corresponding historical conversation (supports switching conversations from the sidebar within the chat page);
  //  - first entry with no ?c= → consume the home page's pending send, or fall back to prefilling from ?q=.
  // Placed last so it sits after loadConversation and send; it does nothing until setupDone flips (which happens
  // in the async mount effect), so running after the other mount effects changes no ordering that matters.
  useEffect(() => {
    if (!setupDone) return;
    // Permanently mounted: only consume ?c= / ?q= / pending on the chat route; on other /agent pages this component is still mounted but should not load a conversation from the URL
    // (otherwise it would clear the view of a generating conversation / mistakenly trigger an auto-send).
    if (!onChatRoute) return;
    const cid = params.get("c");
    if (cid) {
      if (cid !== convIdRef.current) void loadConversation(cid, params.get("p") ?? undefined);
      seededRef.current = true;
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    const pending = useAgentChatStore.getState().consumePendingSend();
    if (pending && (pending.text || pending.attachments.length > 0)) {
      void send({ text: pending.text, attachments: pending.attachments });
      return;
    }
    const q = params.get("q");
    // Prefilling the composer from ?q= is the one thing this effect does to render state. It cannot move to a
    // lazy useState initializer: that would run before setupDone and on every route, prefilling the box for
    // conversations this effect deliberately skips.
    if (q) setInput(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupDone, params, onChatRoute]);

  return (
    <div className="relative flex h-full">
    <div data-skin-slot="chat-column" className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface text-ink">
      <ChatHeader
        ref={headerRef}
        title={activeConvTitle}
        hasConversation={!!activeConvId}
        messageCount={display.length}
        sessionUsage={sessionUsage}
        onRename={() => setRenameDraft(activeConvTitle)}
        onClear={clearActiveConversationContent}
        toolsReady={toolsReady}
        sandboxStatus={sandboxStatus}
        onSandboxBadgeClick={openSandboxDialog}
        secureEnv={secureEnv}
        onSecureEnvChange={applySecureEnv}
        vmUpdatable={vmUpdatable}
        onOpenSkills={skills.openSkills}
        enabledSkillCount={enabledSkills(installedSkills).length}
        settingsOpen={settingsOpen}
      />

      {/* Messages */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <CustomScrollbar
        viewportRef={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1"
        viewportClassName="flex flex-col"
        config={PAGE_SCROLLBAR}
      >
        <div className={cn(CHAT_COLUMN, "flex flex-col gap-4 px-4 py-5")}>
          <ChatTranscript
            switching={switching}
            display={display}
            visibleStart={visibleStart}
            hasEarlier={hasEarlier}
            earlierSentinelRef={earlierSentinelRef}
            loadEarlier={loadEarlier}
            loading={loading}
            status={status}
            error={error}
            toolsReady={toolsReady}
            t={t}
            onSubmitChoice={submitChoice}
            onEditUser={editUser}
            onRegenerate={regenerate}
            onRateMessage={rateMessage}
          />

          <ChatDialogs
            localStartOpen={localStartDialog}
            onLocalStartOpenChange={setLocalStartDialog}
            modelLabel={activeModel?.label}
            sandboxStatus={sandboxStatus}
            secureEnv={secureEnv}
            sandboxDialogTick={sandboxDialogTick}
            renameDraft={renameDraft}
            onRenameDraftChange={setRenameDraft}
            activeConvId={activeConvId}
            onRename={renameConversation}
          />
        </div>

      </CustomScrollbar>
      {/* Back to bottom: surfaces centered below the message area when the user scrolls up while generating; clicking smoothly returns to the bottom and resumes auto-follow. */}
      <button
        type="button"
        onClick={() => scrollToBottom(true)}
        aria-hidden={!(loading && !atBottom)}
        className={cn(
          "absolute bottom-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface/95 px-3.5 py-1.5 text-xs font-medium text-ink shadow-md backdrop-blur transition-all duration-300 hover:bg-surface-muted active:scale-95",
          loading && !atBottom
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <ChevronDown className="size-4" />
        {t("chat.backToBottom")}
      </button>

      {/* Sub-agent Inspector entry: bottom-left of the transcript, beside the delegations it counts. Renders
          nothing until this conversation has actually delegated something. */}
      <SubAgentInspectorButton conversationId={viewConvId} onOpen={() => setInspectorOpen(true)} />
      </div>

      {/* Skills panel: download marketplace skills, enable / uninstall. Enabled skills enter the chat configuration (effective from the next message). */}
      {/* Sub-agent Execution Inspector: every delegation of this conversation, live, from runtime events.
          Scoped to the conversation on screen, so a background conversation's fan-out is not shown here. */}
      <SubAgentInspector
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        conversationId={viewConvId}
      />

      <SkillSelectPanel
        open={skillsOpen}
        onClose={skills.closeSkills}
        installed={installedSkills}
        onChange={setInstalledSkillsBoth}
      />

      {/* Sensitive-operation confirmation panel: pops when the model requests operations like writing files / deleting / running commands, requiring the user's approval.
          Auto-focused on appearance; use ↑/↓ to select, Enter to confirm, Esc to reject.
          Gated to the conversation that issued it: a request made in another chat stays queued and shows as a sidebar badge
          on that chat instead of following the user into the conversation they are currently viewing. */}
      {/* Anchored over the bottom of the column rather than stacked above the composer: while an agent is
          blocked waiting for an answer, the input box and the context-usage bar are covered on purpose. See
          the note in ConsentPanel. AnimatePresence keeps it mounted long enough to animate back out. */}
      <AnimatePresence>
        {pending && pending.convId === viewConvId && (
          <motion.div key="consent" className="absolute inset-x-0 bottom-0 z-30">
            <ConsentPanel
              pending={pending}
              currentConvId={viewConvId}
              consentSel={consentSel}
              onHover={setConsentSel}
              onAnswer={answerConsent}
              onKey={onConsentKey}
              panelRef={consentPanelRef}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Goal status, directly above the checklist — the order the layering actually runs in: goal, then the
          plan's steps. Hidden alongside the todo panel when the confirmation panel needs the space. */}
      {!(pending && pending.convId === viewConvId) && (
        <GoalBar
          goal={displayedGoal}
          running={loading}
          expanded={goalExpanded}
          onExpandedChange={setGoalExpanded}
          onClear={goalCommand.clearGoalFromBar}
        />
      )}

      {/* The previous turn was cut short by a crash (docs/agent-runtime-crash-recovery.md C2). Rendered only for the
          conversation it belongs to, so switching away takes it off screen; dismissible, and gone once dismissed. */}
      {recoveryNotice && recoveryNotice.convId === viewConvId && (
        <RecoveryBanner notice={recoveryNotice} onDismiss={dismissRecovery} />
      )}

      {/* Task list: fixed above the input box, showing progress.
          Lowest priority — it yields and hides when the sensitive-operation confirmation panel is present, to avoid competing for space with it. */}
      {todos.length > 0 && !(pending && pending.convId === viewConvId) && (
        <TodoPanel todos={todos} onToggle={toggleTodo} onClear={() => setTodosFor(convIdRef.current, [])} />
      )}

      {/* Queued messages: messages the user sends again while generating are listed here and auto-sent in order after this round ends. Can be removed one by one. */}
      <QueuedMessages queued={queued} onRemove={removeQueued} t={t} />

      {/* Project skill discovery: detect skills left by other tools in .claude/.codex/.cursor/.github/.windsurf/.zeraix,
          with a bottom-right toast; click "view" to open a dialog and add / view / ignore them one by one. Decisions are written to .zeraix/config.json;
          after adding, the enabled project skills are reloaded so they take effect immediately for subsequent messages. The component only renders a dialog (Portal) and takes no layout space. */}
      {toolsReady && (
        <ProjectSkillsPrompt workdirKey={workdir} onDecided={() => void reloadProjectSkills()} />
      )}

      {/* Composer: attachment preview + input box + toolbar (add file · model selection · send / queue / stop). */}
      <Composer
        input={input}
        onInputChange={setInput}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onAddFiles={addFiles}
        taRef={taRef}
        fileInputRef={fileInputRef}
        loading={loading}
        onSend={() => void send()}
        onCancel={cancel}
        models={models}
        modelGroups={modelGroups}
        selectedLabel={selectedLabel}
        selectedModelId={selectedModelId}
        onSelectModel={selectModel}
        onGoSettings={() => router.push("/agent/settings")}
        thinking={thinking}
        onThinkingChange={changeThinking}
        approvalMode={approvalMode}
        onApprovalModeChange={changeApprovalMode}
        contextIndicator={
          activeModel && (
            <ContextUsageRing
              tokens={contextTokens}
              contextWindow={activeModel.contextWindow ?? resolveContextWindow(activeModel.model)}
              compacted={compacted}
              compacting={compacting}
              generating={loading}
              onCompactNow={compactNow}
            />
          )
        }
      />
    </div>
      <BrowserPanel
        onAddToConversation={({ url, title }) =>
          setInput((v) => `${v ? `${v}\n` : ""}${title ? `${title} ` : ""}${url}`)
        }
      />
    </div>
  );
}

// useSearchParams must be inside a Suspense boundary (required by the Next.js App Router).
// The chat UI is rendered by AgentShell keeping this component permanently mounted (see AgentShell), so it does not unmount when switching pages inside /agent —
// letting the generation loop and message queue keep running. So this route page itself no longer renders content, and the Shell only shows / hides the permanent instance by route.
export function ChatAgentView() {
  return (
    <Suspense fallback={null}>
      <ChatAgent />
    </Suspense>
  );
}

export default function AgentChatPage() {
  return null;
}
