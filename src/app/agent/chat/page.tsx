"use client";

import { InMemoryAuditLog } from "@/lib/ai/orchestration/audit-log";
import type { ToolDeclaration } from "@/lib/ai/orchestration/capabilities";
import type { CapabilityBroker } from "@/lib/ai/orchestration/capability-broker";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getWorkingDir,
  getPathForFile,
  defaultWorkingDir,
  isToolkitAvailable,
  listTools,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import { isLlmProxyAvailable } from "@/lib/ai/llm";
import {
  onServiceEvent,
  formatJobMessage,
  type ServiceEvent,
} from "@/lib/ai/services";
import {
  primeUsageLog,
} from "@/lib/ai/usageLog";
import {
  simulateBudgets,
  defaultBudgetCandidates,
  formatSimulation,
} from "./contextDiag";
import { isLocalEndpoint, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import { DEFAULT_SECURE_ENV } from "@/lib/ai/sandbox";
import { useLocaleStore, useT } from "@/lib/i18n";
import { toast } from "sonner";
// Only the two types remain here: the delegation tools themselves moved to chatDelegation.ts.
import type { DelegationMeta, PriorDelegation } from "@/lib/ai/subagents";
import type { SchedulerLike } from "@/lib/ai/subagentScheduler";
import { SkillSelectPanel } from "./SkillSelectPanel";
import BrowserPanel from "./BrowserPanel";
import { getStorage } from "@zzcpt/zztool";
import {
  AGENT_GOAL_EVALUATOR_MODEL_KEY,
  AGENT_WORKDIR_KEY,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
} from "@/constants/Agent";
import { migrateLegacyAgentStorage, putStorage } from "@/lib/ai/agentStorage";
import { hydrateAppConfig } from "@/lib/ai/appConfig";
import { notifyAgentError } from "@/lib/ai/agentNotify";
import { useAgentChatStore } from "@/store/agentChatStore";
import { enabledSkills, loadInstalled } from "@/lib/ai/skills/store";
import { loadPluginSkills } from "@/lib/plugins/skills";
import { pluginBridge } from "@/lib/plugins/bridge";
import { buildSystemPrompt, buildToolSet as buildToolSet_ } from "@/lib/ai/promptPrefix";
import { loadEnabledProjectSkills } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import {
  buildWireContext,
  sanitizeToolCallPairs,
  deserializeCompaction,
  type CompactionState,
} from "./contextCompress";
import {
  renderTaskMemory,
} from "./taskMemory";
import {
  emptyGoal,
  isGoalEmpty,
  isGoalActive,
  renderGoalState,
  startGoal,
  clearGoal,
  type GoalState,
} from "./goalState";
import { parseGoalCommand, GOAL_CLEAR_ALIASES, type GoalCommand } from "./goalCommand";
import { parseSlashCommand } from "./slashCommands";
import { createGoalEvaluator, TRANSCRIPT_BUDGET_FRACTION } from "./goalEvaluator";
import { GoalBar } from "./GoalBar";
import { countMessagesTokens, countTokens } from "@/lib/ai/tokenizer";
// ── Extracted modules (data / types / constants / tool declarations / display components) ──────────────────────
import {
  resolveModelById,
  ensureModelListSeeded,
  setSelectedModelId,
  resolveContextWindow,
  OFFICIAL_PROVIDER_ID,
} from "@/lib/ai/models";
import { useAuthStore } from "@/store/authStore";
import {
  FEEDBACK_DOWN_NUDGE,
  FEEDBACK_UP_NUDGE,
  LOOP_BREAK_NUDGE,
  repeatedCallNudge,
  repeatedFailureNudge,
  equivalentCallNudge,
  repeatedResourceNudge,
  CHAT_COLUMN,
  DELEGATION_TOOLS,
  MAX_INPUT_CHARS,
  supportsFieldSizing,
  MUTATING_FILE_TOOLS,
  RESUME_NUDGE,
  RISKY_PATH_PATTERN,
} from "./constants";
import {
  addBlock,
  diffReminder,
  foldReminders,
  materializeReminders,
  renderReminder,
  wrapReminder,
} from "./reminders";
// The doom-loop detector (docs/agent-runtime-loop.md §12). Superseded app/agent/chat/loopGuard.ts at M3:
// §20 rule 7 forbids two competing Stop Policies, and a detector that withdraws the model's tools was one.
import { runAgentLoop } from "@/lib/agent/agentLoop";
import { createRendererTools, type RendererTool } from "./chatTools";
import { createDelegationTools } from "./chatDelegation";
import { createCompaction } from "./chatCompaction";
import type { RuntimeBoundary } from "@/lib/agent/runtimeBoundary";
import { prepareWire, type WireSteps } from "@/lib/agent/contextManager";
import type { ToolRuntimeRules } from "@/lib/agent/toolRuntime";
// Execution State, the reasoning policy and the doom-loop detector are all owned by runAgentLoop now;
// only the capability derivation stays here, because both the loop and the delegation factory need it.
import { describeCapabilities } from "@/lib/agent/modelAdapter";
import type {
  ApiMsg,
  Attachment,
  ReminderState,
  RunCtx,
  DisplayMsg,
} from "./types";
import { capabilityAvailable } from "@/lib/ai/generation";
import { mediaDir } from "@/lib/ai/mediaLibrary";
import {
  onGenerationJobEvent,
  cancelJobsFor,
  type GenerationJobEvent,
} from "@/lib/ai/generation/jobs";
import { isMemoryFilesAvailable } from "@/lib/ai/memoryFiles";
import { setBrowserBusy } from "@/lib/automation";
import { TodoPanel } from "./TodoPanel";
import { ChatTranscript } from "./ChatTranscript";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { Composer } from "./Composer";
import { ProjectSkillsPrompt } from "./ProjectSkillsPrompt";
import { AnimatePresence, motion } from "framer-motion";
import { ConsentPanel } from "./ConsentPanel";
import { useConsentQueue } from "./useConsentQueue";
import { useChoiceQueue } from "./useChoiceQueue";
import { createToolExec } from "./toolExec";
import {
  hoistSystemToFront,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  stripWireMetadata,
  applyReasoningPolicy,
  toInstalledProjectSkill,
} from "./wireHelpers";
import {
  buildReminderState,
} from "./sendPrep";
import { createChatRequest } from "./chatRequest";
import { createSummarizeHistory } from "./summarize";
import { ChatHeader } from "./ChatHeader";
import { SubAgentInspector, SubAgentInspectorButton } from "./SubAgentInspector";
import { useSubAgentExecutionStore } from "@/store/subagentExecutionStore";
import { ChatDialogs } from "./ChatDialogs";
import { ContextUsageRing } from "./ContextUsageRing";
import { useTranscriptWindow } from "./useTranscriptWindow";
import { useSandboxEnv } from "./useSandboxEnv";
import { usePerConvState } from "./usePerConvState";
import { useModelSelection } from "./useModelSelection";
import { createJobHandlers } from "./jobEvents";
import { checkTurnGoal, finishTurn } from "./turnFinish";
import { landUserMessage } from "./turnSetup";
import { createTurnBuffer } from "./turnBuffer";
import { createRoundRunner, type RoundLog } from "./turnRound";
import { restoreDisplay, restoreWireBuffer } from "./conversationRestore";

/** Resolve once the browser has painted, so a state change made just before is actually on screen. */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    // rAF runs *before* the paint, hence the nested timeout. The outer timeout is a ceiling, not a delay (the first
    // resolve wins): rAF is paused while the window is minimised or occluded, and a conversation switch must not
    // hang waiting for a frame that only arrives when the user comes back.
    setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

/**
 * The wire-transformation steps, bound once (see contextManager.ts).
 *
 * Module scope rather than per-render: these are eight module functions that never change, and rebuilding
 * the object every round would allocate for nothing.
 */
const WIRE_STEPS: WireSteps = {
  buildWireContext: (messages, compaction) => buildWireContext(messages, compaction as CompactionState | null),
  sanitizeToolCallPairs,
  materializeReminders,
  stripWireMetadata,
  applyReasoningPolicy,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  hoistSystemToFront,
};

/** The tool rules the turn's obligations are judged against (see toolRuntime.ts). Fixed, so bound once. */
const TOOL_RULES: ToolRuntimeRules = {
  mutatingTools: MUTATING_FILE_TOOLS,
  riskyPath: RISKY_PATH_PATTERN,
  delegationTools: DELEGATION_TOOLS,
};

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
    isLocalModel,
    thinking,
    changeThinking,
    thinkingUnsupportedRef,
    reasoningContextUnsupportedRef,
    sendReasoningContext,
    localLlmReady,
    localStartDialog,
    setLocalStartDialog,
  } = useModelSelection({ convIdRef, t });
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null); // For the input box's auto-fit height
  // Attachments pending send: images go multimodal, text files are inlined into the prompt, the rest attach only the file name.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [display, setDisplay] = useState<DisplayMsg[]>([]);
  // A synchronous mirror of the display array: lets streaming rendering synchronously read "the display baseline before this round started" as increments arrive,
  // without waiting for a setState re-render. Every entry point that writes display updates it synchronously (pushDisplay / loadConversation / streaming rendering).
  const displayRef = useRef<DisplayMsg[]>([]);
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
  const [status, setStatus] = useState(""); // While generating, show the user "what it is doing"
  const [error, setError] = useState<string | null>(null);
  const [toolsReady, setToolsReady] = useState(false);
  // Mirror, for callers that outlive the render they were created in. __seedPrefix is registered in a mount-only effect, so it
  // closes over the FIRST render's toolsReady (false) permanently — reading the state there silently drops the whole local-tool
  // block from the captured prefix, which would produce a seed that never matches a real request.
  const toolsReadyRef = useRef(false);
  const [proxyReady, setProxyReady] = useState(false);
  // Working directory: AI tool calls (read/write files / run commands) are confined to this directory.
  const [workdir, setWorkdir] = useState("");
  const [workdirInput, setWorkdirInput] = useState("");
  // Whether the user has "explicitly chosen" the working directory (tools always have a WORKDIR by default, so this needs a separate flag).
  // An explicit choice is expected; without one it falls back to the default working directory (under userData/agent).
  const [workdirChosen, setWorkdirChosen] = useState(false);
  // The default workspace is minted once per session: defaultWorkingDir returns a NEW directory each call, so re-applying
  // it per message would spread one conversation's files over a different folder every turn.
  const defaultAppliedRef = useRef(false);
  // Sandbox runtime status + this session's secure-environment switch (see useSandboxEnv).
  const {
    sandboxStatusRef,
    sandboxStatus,
    sandboxDialogTick,
    openSandboxDialog,
    vmUpdatable,
    secureEnv,
    secureEnvRef,
    applySecureEnv,
  } = useSandboxEnv({ convIdRef, activeConvId, activeProjectId });
  // Skills: the installed list (including enabled state) + the panel toggle. installedRef lets the async send loop read the latest value.
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const installedSkillsRef = useRef<InstalledSkill[]>([]);
  // Enabled "project skills" (from .claude/.cursor/.zeraix, see ProjectSkillsPrompt / config.json) —
  // mapped to the InstalledSkill shape and merged into the runtime skill set, so they too can be progressively disclosed by load_skill.
  const projectSkillsRef = useRef<InstalledSkill[]>([]);
  const reloadProjectSkills = async () => {
    projectSkillsRef.current = (await loadEnabledProjectSkills()).map(toInstalledProjectSkill);
  };
  // Skills provided by installed plugins (the marketplace, /agent/plugins). Same treatment as project
  // skills: mapped to InstalledSkill and merged into the runtime set, so load_skill discloses them
  // progressively like any other. Enablement and revocation are decided by the plugin store, so
  // there is no separate toggle here.
  const pluginSkillsRef = useRef<InstalledSkill[]>([]);
  const setInstalledSkillsBoth = (list: InstalledSkill[]) => {
    installedSkillsRef.current = list;
    setInstalledSkills(list);
  };
  const [skillsOpen, setSkillsOpen] = useState(false);
  /** The Sub-agent Execution Inspector. Its entry point hides itself when nothing has been delegated. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The settings area (working directory / run parameters) is collapsed by default; it expands on demand in dev mode when a working directory is missing.
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  // Conversation switch in progress: the message area shows a skeleton instead of the outgoing transcript.
  const [switching, setSwitching] = useState(false);
  // Serialises switches. Clicking through the sidebar starts overlapping loads (the archive read and the
  // working-directory hand-off both await), and whichever finished last used to win regardless of which the user
  // actually asked for. Each load carries a token; once a newer one starts, the older one stops before it commits.
  const switchTokenRef = useRef(0);
  /**
   * Abandon an in-flight conversation switch. Used by the reset paths ("new conversation" / "clear chat"): bumping the
   * token stops the load before it commits, which both keeps it from overwriting the freshly emptied view and — since a
   * stale load deliberately leaves the skeleton alone — is why the flag has to be cleared here rather than by that load.
   */
  const cancelPendingSwitch = () => {
    switchTokenRef.current++;
    setSwitching(false);
  };
  // The API conversation retained across rounds (including system / tool messages), not involved in rendering. Fully faithful, it is the single source of truth for both the "display view" and
  // the "compressed wire view"; compaction only happens in the pre-send derivation step (buildWireContext) and never rewrites it.
  const convoRef = useRef<ApiMsg[]>([]);
  // Context compaction state: the compaction plan frozen at the start of each round (including the history summary text); null means not compacted, wire view == full conversation.
  const compactionRef = useRef<CompactionState | null>(null);
  // The user's manual "compact now" flag: once set, the generated compaction is kept even if usage falls back below the threshold (not auto-cleared).
  const manualCompactRef = useRef(false);
  // Whether the current conversation's wire context is compacted (only drives the "compacted" badge, does not display counts).
  const [compacted, setCompacted] = useState(false);
  const [compacting, setCompacting] = useState(false); // Manual compaction in progress, disable the button
  // Session-level compaction cache (only for this run session, not persisted): the summary is a runtime artifact; used to restore compaction when switching away and back to the same conversation,
  // avoiding "compaction lost after switching, progress bar bouncing back to the uncompressed size". key = conversation id.
  const compactionCacheRef = useRef<
    Map<string, { state: CompactionState | null; manual: boolean; compacted: boolean; ctxTokens: number }>
  >(new Map());
  // messages[0] composed before the conversation record existed (first send). Attached to the record at the persist site below.
  const pendingSystemPromptRef = useRef<string>("");
  // Sensitive-operation confirmation queue (extracted to useConsentQueue): the front-of-queue `pending`
  // for the panel, keyboard nav, request/answer/drop, and the per-conversation "don't ask again" allow-set.
  const {
    pending,
    consentSel,
    setConsentSel,
    consentPanelRef,
    allowedToolsRef,
    requestConsent,
    answerConsent,
    dropConsentsFor,
    onConsentKey,
  } = useConsentQueue();
  // The ask_user choice cards (see useChoiceQueue). `onPush` is a lazy wrapper because pushDisplay is a
  // plain const declared further down; only the call happens later, by which time it is initialised.
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
  // Context diagnostics (measurement phase): the last wire + tool schemas + window actually sent, so the
  // offline budget-replay harness (window.__ctxSim, dev only) can run against a real heavy task on demand.
  const diagRef = useRef<{ messages: ApiMsg[]; tools: unknown[]; contextWindow: number }>({
    messages: [],
    tools: [],
    contextWindow: 0,
  });
  // Token usage: turnUsageRef accumulates all requests of "this round" (including tool rounds and subagents); sessionUsage is the whole-session accumulation.
  // estimated indicates that part of this round / session was estimated with tiktoken (the provider did not return usage).
  const turnUsageRef = useRef({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false });
  // Wall-clock start of this round, stamped where turnUsageRef is reset so the reported duration spans exactly the
  // same window as the token accounting: from send until the loop settles, including every tool round and subagent.
  const turnStartRef = useRef(0);
  // Current context usage (the input tokens of the most recent request = the compressed wire size), drives the usage progress bar above the input box.
  // Mirror the latest value in a ref, to ease snapshotting the current usage when switching conversations (the state in a closure may be stale).
  const [contextTokens, setContextTokens] = useState(0);
  const contextTokensRef = useRef(0);
  const setCtxTokens = (n: number) => {
    contextTokensRef.current = n;
    setContextTokens(n);
  };
  const [sessionUsage, setSessionUsage] = useState({
    prompt: 0,
    completion: 0,
    total: 0,
    cached: 0, // Accumulated input tokens served from the prefix cache
    estimated: false,
  });
  // Run parameters removed: tool rounds / subagent rounds no longer have an upper limit, and the old deadlock protection keyed on
  // "the same call again" / "another timeout" is gone with them. The related settings and persistence were removed accordingly.
  // What replaced it is not a limit but a progress test (loopGuard.ts): a turn is only stopped once it demonstrably stops learning
  // anything, so long work is unaffected and only a loop is cut short. Manual "stop" remains, and is still the user's own control.

  // Per-conversation queue / checklist / Task Memory / Goal State (see usePerConvState).
  const {
    queued,
    syncQueued,
    enqueueMessage,
    removeQueued,
    clearQueue,
    shiftQueued,
    queueLength,
    todos,
    todosFor,
    setTodosFor,
    toggleTodo,
    taskMemoryFor,
    setTaskMemoryFor,
    displayedGoal,
    goalExpanded,
    setGoalExpanded,
    goalFor,
    setGoalFor,
    scheduleGoalClear,
    showPendingGoal,
    adoptConversation,
    resetConversation,
  } = usePerConvState({ convIdRef });

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



  // Keep the diagnostics' context window current even before the first send of a freshly-loaded
  // conversation, so the harness reports the right window (e.g. 1M) rather than a fallback.
  useEffect(() => {
    diagRef.current.contextWindow =
      activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
  }, [activeModel]);

  /**
   * Compose messages[0], and build the tool array.
   *
   * Both are pulled out of send() so seed generation can obtain the EXACT prefix the app sends without driving the UI and without
   * reimplementing the composition. A seed is keyed on the bytes of [messages[0] + tools]; if the generator built those bytes by
   * its own route, a divergence would show up as a seed that silently never matches. One code path, two callers.
   *
   * Both come from src/lib/ai/promptPrefix.ts, so send() and the seed generator compose them by exactly one code path. The native
   * schemas are fetched over IPC here; the generator reads them straight off disk. Declared this far up only because the
   * __seedPrefix harness below closes over them, and a `const` arrow is not hoisted.
   */
  const composeSystemPrompt = (): string =>
    buildSystemPrompt({ toolsReady: toolsReadyRef.current, memory: isMemoryFilesAvailable() });

  const buildToolSet = async () =>
    buildToolSet_(toolsReadyRef.current ? await listTools("openai") : [], { memory: isMemoryFilesAvailable() });

  // Expose the offline budget-replay harness on the window so a real heavy task can be simulated from
  // the console: `__ctxSim()` (default budget spread) or `__ctxSim(40, 60, 80)` (custom K-token budgets).
  // It RETURNS a structured result — so the numbers are visible even when the console's level filter
  // hides console.log/Info output — and also logs a formatted table. Read-only measurement; deliberately
  // available in every build during this measurement phase (not gated on NODE_ENV), so it works on the
  // packaged app the user actually runs a heavy task in.
  useEffect(() => {

    const w = window as unknown as {
      __ctxSim?: (...budgetsK: number[]) => unknown;
      __seedPrefix?: () => Promise<unknown>;
    };
    // Kept for inspecting a live install ("what is this app actually sending?"). Seed generation no longer needs it: the prefix
    // is static text in promptPrefix.ts, so scripts/capture-prefix.mjs computes it without an app at all.
    w.__seedPrefix = async () => ({ system: composeSystemPrompt(), tools: await buildToolSet() });
    const K = (n: number) => `${(n / 1000).toFixed(1)}K`;
    w.__ctxSim = (...budgetsK: number[]) => {
      try {
        const messages = convoRef.current; // the full verbatim buffer — the simulator does its own compaction
        const { tools, contextWindow } = diagRef.current;
        const userTurns = messages.filter((m) => m.role === "user").length;
        if (userTurns === 0) {
          const note = "[ctxSim] No conversation captured yet — open or send a heavy task first, then re-run __ctxSim().";
          console.log(note);
          return { note };
        }
        const cw = contextWindow || 128000;
        const schemaTokens = tools.length ? countTokens(JSON.stringify(tools)) : 0;
        const candidates = budgetsK.length
        ? [
              { label: "current (window-relative)" },
              ...budgetsK.map((kk) => ({
                label: `${kk}K budget`,
                triggerTokens: Math.min(cw * 0.75, kk * 1000),
                targetTokens: Math.min(cw * 0.5, Math.round(kk * 1000 * 0.65)),
              })),
            ]
            : defaultBudgetCandidates(cw);
        const result = simulateBudgets({ messages, contextWindow: cw, schemaTokens, candidates });
        console.log(formatSimulation(result));
        const b = result.finalBreakdown;
        // A compact, expandable object so the key numbers are legible even with console.log hidden.
        return {
          turns: result.turns,
          window: K(cw),
          buckets: {
            system: K(b.system),
            toolSchemas: schemaTokens ? K(schemaTokens) : "not captured — send once this session",
            history: K(b.history),
            toolOutputs: K(b.toolOutputs),
            subagent: K(b.subagentOutputs),
            messagesTotal: K(b.total),
          },
          dedupReclaim: K(result.dedupReclaimTokens),
          redundantReReads: b.rereads,
          budgets: result.reports.map((r) => ({
            budget: r.label,
            maxWire: K(r.maxWireTokens),
            avgWire: K(r.avgWireTokens),
            summariserCalls: r.summariserCalls,
            coldWrites: r.coldWrites,
            summariserInput: K(r.summariserInputTokens),
          })),
          full: result,
        };
      } catch (err) {
        // Return the failure (filter-proof) as well as logging it — the console level filter was
        // swallowing the throw, which is why __ctxSim() looked like it produced "nothing".
        const e = err as Error;
        console.error("[ctxSim] crashed:", e);
        return { error: e?.message ?? String(err), stack: e?.stack };
      }
    };
    return () => {
      delete w.__ctxSim;
      delete w.__seedPrefix;
    };
  // Mount-only on purpose: this registers window globals and takes them down again on unmount. Listing the two
  // composers as dependencies would tear the harness down and rebuild it on every render, and both read the
  // values they need through refs precisely so the mount-time closure stays correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After mount, restore the last selection / key + probe whether local tools are available (Electron only).
  useEffect(() => {
    void (async () => {
      hydrateAppConfig(); // First seed local storage from app.config (an INI next to the executable); the file wins
      migrateLegacyAgentStorage(); // Merge the old flat keys into the agent object before the first read
      ensureModelListSeeded(); // On first run, migrate the model list out of the legacy single-select config
      initActiveModel(); // The currently selected model → the endpoint / model / key used for sending
      const ready = isToolkitAvailable();
      setToolsReady(ready);
      toolsReadyRef.current = ready;
      setProxyReady(isLlmProxyAvailable());
      // Usage log: read the switch once so the per-tool-call log helpers can answer synchronously.
      // Off by default, in which case every logging call below is a no-op.
      void primeUsageLog();
      setInstalledSkillsBoth(loadInstalled()); // Restore installed skills (including enabled state)
      // Working directory: prefer the directory explicitly chosen and persisted on the home page (the previous stage); otherwise take the main process's current directory.
      const savedWorkdir = getStorage(AGENT_WORKDIR_KEY);
      if (typeof savedWorkdir === "string" && savedWorkdir) {
        setWorkdir(savedWorkdir);
        setWorkdirInput(savedWorkdir);
        setWorkdirChosen(true); // Already explicitly chosen in the previous stage, satisfying the dev-mode requirement
        if (ready) await setWorkingDir(savedWorkdir).catch(() => {});
      } else if (ready) {
        try {
          const dir = await getWorkingDir();
          setWorkdir(dir);
          setWorkdirInput(dir);
        } catch {
          /* Keep empty if reading fails */
        }
      }
      await useAgentChatStore.getState().init(); // Load projects / conversation records
      setSetupDone(true); // Initialization complete → trigger ?c= load / pending auto-send
    })();
    // initActiveModel is stable (useCallback with no deps), so listing it keeps this mount-only.
  }, [initActiveModel]);


  // Input-box auto-fit height: grows with content, up to 30vh, then scrolls internally.
  // FALLBACK ONLY. Where the engine has `field-sizing: content` the box sizes itself in CSS
  // (.composer-autosize, globals.css) and this effect returns immediately -- setting a height and then
  // reading scrollHeight forces a synchronous layout of the entire transcript, on every keystroke, which
  // is the single most expensive thing typing used to do.
  // The deps include onChatRoute: this component is permanently mounted by AgentShell, so before the first entry the composer is hidden (scrollHeight=0),
  // and pinning the height to 0px then would keep it collapsed. So when hidden (scrollHeight=0), skip measuring and keep the rows=1 default single-line height,
  // then re-measure and correct after the route becomes active and visible.
  useEffect(() => {
    if (supportsFieldSizing()) return;
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight === 0) return; // Hidden / not yet laid out: do not measure, to avoid collapsing to 0
    const max = Math.round(window.innerHeight * 0.3);
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input, onChatRoute]);


  // Apply the working directory: set the tools' working directory to the path the user entered; afterwards all tool calls are confined to this directory.
  // const applyWorkdir = async () => {
  //   const dir = workdirInput.trim();
  //   if (!dir || !toolsReady) return;
  //   setWorkdirMsg(null);
  //   try {
  //     const resolved = await setWorkingDir(dir);
  //     setWorkdir(resolved);
  //     setWorkdirInput(resolved);
  //     setWorkdirChosen(true); // Explicitly specified by the user, satisfying the dev-mode requirement
  //     putStorage(AGENT_WORKDIR_KEY, resolved); // Persist, reused across pages / reopens
  //     setWorkdirMsg(t("chat.workdirSet", { dir: resolved }));
  //   } catch (e) {
  //     setWorkdirMsg(t("chat.workdirApplyFail", { err: e instanceof Error ? e.message : String(e) }));
  //   }
  // };

  // // Pop up the native directory picker to let the user choose the working directory themselves; it takes effect once selected.
  // const browseWorkdir = async () => {
  //   if (!toolsReady) return;
  //   setWorkdirMsg(null);
  //   try {
  //     const dir = await chooseWorkingDir();
  //     if (!dir) return; // User canceled
  //     setWorkdir(dir);
  //     setWorkdirInput(dir);
  //     setWorkdirChosen(true); // Explicitly chosen by the user, satisfying the dev-mode requirement
  //     putStorage(AGENT_WORKDIR_KEY, dir); // Persist, reused across pages / reopens
  //     setWorkdirMsg(t("chat.workdirSet", { dir }));
  //   } catch (e) {
  //     setWorkdirMsg(t("chat.workdirBrowseFail", { err: e instanceof Error ? e.message : String(e) }));
  //   }
  // };

  // Within the threshold from the bottom counts as "at the bottom" (leaving margin, to tolerate the bottom frosted-glass usage bar and line-height error).
  // The URL-seeding effect (?c= / ?q= / pending) lives at the very bottom of this component, because it calls
  // loadConversation and send — both declared far below here, and a `const` arrow is not hoisted.

  // Permanent-mount reset: this component does not unmount on route change, so once seededRef is set true it would stay true forever — leaving the chat route (e.g. "new conversation"
  // first jumps back to the home page /agent) resets the latch, so the next entry into the chat page carrying pending/?q= can consume again. Otherwise a message sent from the home page the second
  // time onwards would be skipped directly by the effect above: the page navigates but the message is not sent, and no new conversation appears in the sidebar.
  useEffect(() => {
    if (!onChatRoute) seededRef.current = false;
  }, [onChatRoute]);


  useEffect(() => {
    // Creating a new conversation cleared the chosen directory → reset this page's working-directory selection state.
    const onWorkdirClear = () => {
      setWorkdirChosen(false);
      setWorkdir("");
      setWorkdirInput("");
      defaultAppliedRef.current = false; // a new conversation gets its own default workspace
    };
    // Clicking a project set the working directory → sync it to this page's working-directory input and apply it to the tool sandbox.
    const onWorkdirSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setWorkdirInput(dir);
      setWorkdirChosen(true);
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
    window.addEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    return () => {
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    };
  }, []);

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
    resetTranscriptView(); // New conversation: nothing to reveal, back to the tail-only window, following from the bottom
    cancelPendingSwitch(); // ...and drop any conversation still being switched in, so it cannot land on top of this
    resetConversation(convIdRef.current); // Queue panel, task list, Task Memory brief and goal
    setAttachments([]); // Clear unsent attachments
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
    setSessionUsage({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }); // Reset the session token stats
    setCtxTokens(0); // New conversation: context usage back to zero
    convoRef.current = [];
    // Reset context compaction: a new conversation has no history to compact.
    compactionRef.current = null;
    manualCompactRef.current = false;
    setCompacted(false);
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
    pendingJobsRef.current.delete(id);
    awaitingJobsRef.current.delete(id);
    // Execution history belongs to the transcript being deleted: keeping it would leave the Inspector
    // describing work whose conversation no longer exists.
    useSubAgentExecutionStore.getState().clearConversationExecutions(id);
    useAgentChatStore.getState().truncateMessages(id, 0); // empty the messages, keep the conversation entry
    displayRef.current = [];
    setDisplay([]);
    resetTranscriptView();
    cancelPendingSwitch();
    // The goal goes with the messages it was pursued through: the evaluator judges from the transcript, and a
    // goal left active over an emptied conversation would be judged against nothing.
    resetConversation(id);
    setAttachments([]);
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
    setSessionUsage({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false });
    setCtxTokens(0);
    convoRef.current = [];
    compactionRef.current = null;
    manualCompactRef.current = false;
    setCompacted(false);
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

  // Load a historical conversation: rebuild the display and the API conversation (messages[0] is replayed from the frozen
  // conv.systemPrompt; only records from before that field existed fall back to composing on the next send).
  // Lazy loading: first ensure the conversation file of the project this conversation belongs to is loaded (projectId comes from the sidebar navigation's ?p=).
  /**
   * Open a conversation, with a skeleton in the message area for as long as the swap takes. The paint yield is what
   * makes the skeleton visible at all: without it the "show skeleton" state and the finished transcript land in the
   * same frame, so the placeholder would never reach the screen even though the swap itself is slow.
   */
  const loadConversation = async (id: string, projectId?: string) => {
    const token = ++switchTokenRef.current;
    const stale = () => switchTokenRef.current !== token;
    setSwitching(true);
    try {
      await afterPaint();
      if (stale()) return;
      await swapInConversation(id, projectId, stale);
    } finally {
      // Only the newest switch may take the skeleton down — otherwise an overtaken load would clear it while the
      // conversation the user actually clicked is still loading.
      if (!stale()) setSwitching(false);
    }
  };

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
    // Restore this conversation's checklist / Task Memory brief / goal, and put them on screen.
    adoptConversation(id, conv);
    store.setActiveConversation(id);
    applyEffectiveModel(); // Loading a conversation → adopt its conversation-level bound model (global if none)
    // Restore this conversation's working directory: set the tools' working directory back to the directory used when the conversation was created (fall back to its owning project's directory if missing).
    // Otherwise opening a historical conversation directly from the sidebar would not trigger WORKDIR_SET_EVENT, and the tools would stay at the process default directory
    // (zeraix-workspace), causing the AI to work in the wrong directory / report the wrong directory.
    const restoredDir = conv.workdir || store.projects.find((p) => p.id === conv.projectId)?.workdir || "";
    if (restoredDir) {
      setWorkdir(restoredDir);
      setWorkdirInput(restoredDir);
      setWorkdirChosen(true);
      putStorage(AGENT_WORKDIR_KEY, restoredDir); // Persist, reused across pages / reopens
      if (isToolkitAvailable()) await setWorkingDir(restoredDir).catch(() => {});
      if (stale()) return; // A newer switch is already rebuilding the view — do not overwrite it with this one
    }
    // Rebuild the conversation sent to the model: faithfully restore the tool-call trace (the assistant's tool_calls + tool result messages),
    // so that when continuing the chat the model still "remembers" what it called and what results it got.
    //
    // messages[0] is replayed from the record rather than recomposed: it is a function of mode, sandbox status and the memory
    // bridge, so recomputing it here rewrote the front of the prefix whenever any of those had moved since the conversation
    // started. Only a record written before this field existed falls through to the compose step on the next send.
    // Rebuild the wire buffer and the transcript from the record (see conversationRestore.ts).
    //
    // messages[0] is replayed from the record rather than recomposed: it is a function of mode, sandbox status
    // and the memory bridge, so recomputing it here rewrote the front of the prefix whenever any of those had
    // moved since the conversation started. Only a record written before this field existed falls through to
    // the compose step on the next send.
    convoRef.current = restoreWireBuffer(conv);
    const disp = restoreDisplay(conv);
    displayRef.current = disp;
    setDisplay(disp);
    // A question this conversation asked while the user was looking elsewhere is still waiting on an answer.
    // Re-shown here, after the rebuild, because the rebuild is what would otherwise drop it.
    restorePendingChoices(id);
    // Opening a conversation mounts only its last few turns; the rest is revealed on scroll-up.
    // Reset per conversation, so a long history expanded earlier does not make the next one open fully mounted.
    resetTranscriptView(); // Switching conversations: display pinned to the bottom, resume auto-follow
    // Restore the compaction state, to avoid "compaction lost, progress bar bouncing back to the uncompressed size" after switching back / reopening. Prefer the session-level cache
    // (the latest within this run), then the disk snapshot (across restarts). If neither exists, start from uncompressed (rebuilt on demand on the first send).
    const cached = compactionCacheRef.current.get(id);
    const fromDisk = conv.compaction
      ? {
          state: deserializeCompaction(conv.compaction),
          manual: conv.compaction.manual,
          compacted: conv.compaction.compacted,
          ctxTokens: conv.compaction.ctxTokens,
        }
      : null;
    const restored = cached ?? fromDisk;
    if (restored) {
      compactionRef.current = restored.state;
      manualCompactRef.current = restored.manual;
      setCompacted(restored.compacted);
      setCtxTokens(restored.ctxTokens);
    } else {
      compactionRef.current = null;
      manualCompactRef.current = false;
      setCompacted(false);
      // No cache: estimate usage from the current conversation size, so the progress bar has a value immediately (refreshed with the provider's exact value on the next send).
      setCtxTokens(countMessagesTokens(convoRef.current));
    }
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

  const pushDisplay = (m: DisplayMsg) => {
    // Key: update the mirror synchronously. A setState updater function only runs at React flush, so if the mirror is only updated in there, within this synchronous stack
    // the mirror is still the old value — the next send loop capturing the baseline with `liveBase = displayRef.current` would miss the tool bubble just pushed,
    // and then renderTurn rebuilding from the stale baseline would "wipe" it (manifesting as: the bubble flashes then disappears). So update the mirror once synchronously here first.
    displayRef.current = [...displayRef.current, m];
    // Still write React state with a functional update (taking the latest state as authoritative), preserving concurrent updates like choice cards; re-align the mirror to the latest state at flush.
    setDisplay((d) => {
      const next = [...d, m];
      displayRef.current = next;
      return next;
    });
  };
  /** Replace one already-pushed display entry, matched by object identity, keeping its position.
   *  Used to grow a bubble in place while it is still running (a sub-agent appending its steps), which
   *  push/pop cannot express. Mirrors pushDisplay's synchronous-mirror-then-setState discipline for the
   *  same reason: the send loop reads displayRef synchronously to rebuild from a baseline. */
  const replaceDisplay = (target: DisplayMsg, next: DisplayMsg) => {
    const swap = (d: DisplayMsg[]) => d.map((x) => (x === target ? next : x));
    displayRef.current = swap(displayRef.current);
    setDisplay((d) => {
      const n = swap(d);
      displayRef.current = n;
      return n;
    });
  };
  /**
   * Finish an in-flight bubble: replace it if it is still there, append it if it is not.
   *
   * `replaceDisplay` matches by object identity and is a silent no-op when the target has gone — correct for a
   * delegation growing its steps, where a lost update costs one stale row. It is the wrong shape for completing
   * a tool call: the display list is rebuilt from a baseline on every streamed delta, so a bubble pushed before
   * a call can legitimately be absent by the time the call returns, and a no-op there would strand the row as
   * permanently "running" AND drop the result with it.
   *
   * Appending is the right fallback because the result is the thing that matters; its position is not.
   */
  const completeDisplay = (target: DisplayMsg, next: DisplayMsg) => {
    if (displayRef.current.includes(target)) {
      replaceDisplay(target, next);
      return;
    }
    pushDisplay(next);
  };
  // Fallback: after any other setDisplay path (choice-card updates, etc.) renders, sync the mirror, to avoid the mirror lagging behind the state.
  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  // Attach the archive index to the "last assistant display entry" (called after this conversation's just-generated final reply is persisted), so it can be rated and persisted.
  const tagLastAssistantStoredIndex = (idx: number) => {
    setDisplay((d) => {
      const copy = [...d];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].kind === "assistant") {
          copy[i] = { ...copy[i], storedIndex: idx } as DisplayMsg;
          break;
        }
      }
      displayRef.current = copy;
      return copy;
    });
  };

  // Rate an AI reply (thumbs up / down / clear): persist it to the corresponding StoredMessage.rating (not in the hash, does not change content),
  // synchronously update the rating in the in-memory wire buffer (kept for audit; stripWireMetadata removes it before sending), and highlight it in the display.
  // useCallback keeps the reference stable (independent of send / state), to avoid a full re-render of the memoized MessageItem.
  const rateMessage = useCallback(
    (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => {
      const convId = convIdRef.current;
      if (convId && storedIndex != null) {
        useAgentChatStore.getState().setMessageRating(convId, storedIndex, rating);
        // Sync the in-memory wire buffer: archived messages are all non-system, so "the storedIndex-th non-system message in convoRef" corresponds
        // to that StoredMessage — locating by this correctly skips the leading system prompt, which is more robust than index + offset.
        // (Nudges no longer occupy messages of their own — they ride inside existing turns' content — so the only remaining skew
        // is an empty assistant turn, which exists live but is never persisted.)
        // Rebuilt rather than mutated in place: the buffer is read by an in-flight round (which captured it as
        // `roundConvo` before its first await) and by the compaction planner, and editing a message object under
        // them changes what those already-captured arrays contain. Only the rated turn is replaced.
        let seen = -1;
        convoRef.current = convoRef.current.map((cm) => {
          if (cm.role === "system") return cm;
          seen++;
          if (seen !== storedIndex || cm.role !== "assistant") return cm;
          const copy = { ...cm };
          if (rating) copy.rating = rating;
          else delete copy.rating;
          return copy;
        });
      }
      const next = displayRef.current.map((m, i) =>
        i === displayIndex && m.kind === "assistant" ? { ...m, rating: rating ?? undefined } : m,
      );
      displayRef.current = next;
      setDisplay(next);
    },
    [],
  );

  // The model-request layer (transport, streaming reassembly, usage accounting, and the retry fallbacks for
  // models that reject thinking parameters, replayed thinking, or images). See chatRequest.ts.
  //
  // Built on every render so the returned function always sees the current model / key / thinking settings —
  // the same thing the inline closure it replaced did. The factory itself touches none of the accessors it is
  // handed; they are called per request, from the tool loop. The rule cannot follow that, hence the exemption.
  // eslint-disable-next-line react-hooks/refs
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

  // History → summary, for the compaction plan below. See summarize.ts.
  const summarizeHistory = createSummarizeHistory(requestChat);

  // ── Context compaction ────────────────────────────────────────────────────────────────
  // Folding old turns into a summary, and the wire view that results. See chatCompaction.ts — the whole
  // cluster moved there, including the disk snapshot, because every part of it is about the same decision.
  //
  // Built on every render for the same reason createChatRequest above is, and exempt for the same reason:
  // the factory itself reads none of what it is handed. `compactNow` is wired to a button, so this cannot be
  // deferred into the turn the way the delegation and renderer tables are.
  const { snapshotCompaction, persistCompaction, maybeCompact, compactNow } =
    // eslint-disable-next-line react-hooks/refs
    createCompaction({
      t,
      activeModel,
      compacting,
      loading,
      compacted,
      setCompacted,
      setCompacting,
      setCtxTokens,
      convIdRef,
      convoRef,
      compactionRef,
      compactionCacheRef,
      manualCompactRef,
      contextTokensRef,
      summarizeHistory,
      taskMemoryFor,
      setTaskMemoryFor,
    });


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
  // eslint-disable-next-line react-hooks/refs -- same exemption as createChatRequest above: nothing here reads a ref
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

  /**
   * Plan and freeze compaction at the start of each round (or manually). force=true is the manual "compact now", which ignores the threshold and compacts as much as possible.
   * Reuse memory: if a summary with the same coversCount already exists (history is append-only, so the earlier prefix is unchanged), reuse it directly, to avoid re-summarizing every round.
   */
  /**
   * Commit a computed compaction plan to the conversation it belongs to.
   *
   * The summariser call inside maybeCompact can take seconds, and the user can switch conversations while it runs. By then
   * compactionRef / convoRef belong to a DIFFERENT conversation, so writing them would give that conversation this one's plan and
   * persist it under its id. When the round is no longer the active view, the plan goes to the per-conversation cache (which
   * loadConversation restores from) and to disk under the round's own id instead, and the live refs and UI state are left alone.
   */

  // Runtime skills = the installed skills the user enabled + conditionally-equipped built-in skills: when commands actually run in the sandbox,
  // the "document / media processing toolbox" is automatically attached (so the model directly uses the tools preinstalled in the image, rather than suggesting a pip/apt install).
  // Built-in skills are not persisted to storage and do not appear in the skills panel; they are rebuilt on every send based on the sandbox status, taking effect immediately on ready/downgrade.
  const runtimeSkills = () => {
    // The installed skills the user enabled + the enabled project skills (.claude/.cursor/.zeraix) + skills from installed plugins + conditionally-equipped built-in skills.
    const list = [...enabledSkills(installedSkillsRef.current), ...projectSkillsRef.current, ...pluginSkillsRef.current];
    // The built-in toolbox is NOT added here. messages[0] lists it unconditionally, so including it would list it twice — and
    // worse, the list would change whenever the VM came up or fell back, which is exactly the churn the skills change event
    // exists to avoid. Whether it is usable right now is carried by the environment event instead.
    const withBuiltin = list;
    // Stable order (sorted by id): the catalog now travels as the skills change event, and diffReminder compares arrays
    // order-sensitively — an insertion-order flip would re-emit the whole menu even though nothing changed.
    return [...withBuiltin].sort((a, b) => a.id.localeCompare(b.id));
  };

  // Load / refresh the enabled project skills (reloaded when switching the working directory); an empty set when not Electron or there is no directory.
  useEffect(() => {
    if (!toolsReady) {
      projectSkillsRef.current = [];
      return;
    }
    let active = true;
    void loadEnabledProjectSkills().then((loaded) => {
      if (active) projectSkillsRef.current = loaded.map(toInstalledProjectSkill);
    });
    return () => {
      active = false;
    };
  }, [workdir, toolsReady]);

  // Load / refresh skills from installed plugins, and follow the plugin store's own changes. The
  // subscription matters as much as the initial load: a plugin withdrawn by the registry is disabled
  // in the main process, and without this the conversation would keep offering its skill until the
  // next reload — which is precisely the window revocation exists to close.
  useEffect(() => {
    let active = true;
    const refresh = () => void loadPluginSkills().then((list) => {
      if (active) pluginSkillsRef.current = list;
    });
    refresh();
    const off = pluginBridge()?.onChanged(refresh);
    return () => {
      active = false;
      off?.();
    };
  }, []);


  // The implementation of "edit user message / regenerate": updated to the latest closure on every render (capturing the latest send / states),
  // so the stably-referenced regenerate / editUser below call the latest version when clicked (avoiding useCallback capturing a stale send).
  const resendRef = useRef<(displayIndex: number, newText: string, feedbackNudge?: string | null) => void>(() => {});

  /**
   * A `notify` background job finishing wakes the conversation back up. Same late-bound-ref shape as resendRef
   * and for the same reason: the subscription is mounted once, but it has to reach the CURRENT `send`.
   *
   * The event may land at any moment, including while a round is generating or while the user is reading a
   * different conversation — so it is routed exactly like a user message rather than sent straight out:
   * idle here → send now; busy → the FIFO queue drains it when this round ends; another conversation → the
   * queue holds it until that one is opened again. Nothing new has to be taught about concurrency.
   */
  /**
   * Job results that arrived mid-turn, per conversation, waiting for a tool result to ride back on.
   *
   * A ref rather than state: the tool loop reads it from closures that must see the current value the moment a
   * job reports, and nothing about it is rendered.
   */
  const pendingJobsRef = useRef(new Map<string, string[]>());

  /**
   * Background jobs this conversation has been promised a result from, but has not received yet.
   *
   * Incremented when the model starts a `notify` job, decremented when one reports back. It exists for the goal
   * loop: a turn that ends while a build is still running has nothing new to show, so evaluating it can only
   * produce "not met", and auto-continuing would burn rounds racing a job that was always going to take
   * minutes. Deferring instead costs nothing — the job's completion opens a turn of its own when it lands, and
   * THAT turn is evaluated.
   */
  const awaitingJobsRef = useRef(new Map<string, number>());
  const jobFinishedRef = useRef<(evt: ServiceEvent) => void>(() => {});
  /** Same late-bound shape, for jobs this renderer runs itself (image / video generation). */
  const generationJobFinishedRef = useRef<(evt: GenerationJobEvent) => void>(() => {});
  useEffect(() => onServiceEvent((evt) => jobFinishedRef.current(evt)), []);
  useEffect(() => onGenerationJobEvent((evt) => generationJobFinishedRef.current(evt)), []);

  // Resend from "the displayIndex-th display message (must be a user message)": truncate this point and everything after it
  // (the display / wire / persistence are aligned by "user message ordinal" — user messages correspond one-to-one across all three), then resend with newText.
  // Shared by "edit user message" (newText = the edited text) and "regenerate" (newText = the original user text).
  const editUser = useCallback((displayIndex: number, newText: string) => {
    resendRef.current(displayIndex, newText);
  }, []);
  // Regenerate an AI reply: trace back to the nearest user message before it and resend from that point with the original text (discarding that round and everything after).
  // rating: the user's rating of the reply being regenerated (up / down) — used to inject a one-time English feedback hint, letting the rating influence this regeneration in real time.
  const regenerate = useCallback((assistantIndex: number, rating?: "up" | "down" | null) => {
    const disp = displayRef.current;
    let userIdx = -1;
    for (let i = Math.min(assistantIndex, disp.length - 1); i >= 0; i--) {
      if (disp[i]?.kind === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const um = disp[userIdx];
    // Armed INSIDE resendRef, after its early returns — not here. resendRef bails when the target text is empty, which happens
    // for an image-only turn, and arming the ref first left it set: the nudge then landed on the user's next, unrelated message.
    // Harmless while nudges were wire-only; permanent now that they are written into the turn and persisted.
    const nudge = rating === "down" ? FEEDBACK_DOWN_NUDGE : rating === "up" ? FEEDBACK_UP_NUDGE : null;
    resendRef.current(userIdx, um.kind === "user" ? um.content : "", nudge);
  }, []);

  // Images go multimodal, which every provider bounds; ≤10MB is the common floor. Nothing else has a size
  // limit any more: a non-image is saved to the library and referenced by path, never read into the prompt.
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const pushAttachment = (a: Attachment) => setAttachments((list) => [...list, a]);

  // Select a file of any type: images defer the upload decision to send time based on the model (local → base64,
  // not uploaded; cloud → uploaded to OSS at send time); everything else is saved to the media library on send
  // and referenced by its path, whatever its type.
  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const id = ++attachIdRef.current;
      const meta = { id, name: file.name, size: file.size };
      const hostPath = getPathForFile(file); // Only present for Electron drag-in/selection; empty string for web / synthetic files
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_BYTES) {
          setError(t("chat.imageTooLarge", { name: file.name }));
          continue;
        }
        // Do not upload when attaching: decide only before sending based on the model selected at that time (avoids an upload/privacy mismatch caused by switching models after attaching).
        // Keep the file reference: local models read the original bytes and convert to base64 when sending (cannot rely on the previewUrl, which will be revoked, and cannot fetch
        // the OSS link — the CDN transcodes it to WebP, which llama cannot decode); cloud models use file to upload to OSS and get the publicUrl when sending. See send().
        // hostPath is captured for images as well: on send they are copied into the working directory
        // like binary attachments, so file tools / sandbox commands can open the actual file. A model
        // that can *see* an image still cannot *edit* it without a path on disk.
        const previewUrl = URL.createObjectURL(file);
        pushAttachment({ ...meta, kind: "image", file, previewUrl, hostPath });
      } else {
        // Every non-image attachment is a FILE: copied to the working directory on send and handed to the
        // model as a path. Nothing is inlined any more — see addFilesTo in lib/ai/attachments.ts for why a
        // path beats a transcript of the file's contents.
        pushAttachment({ ...meta, kind: "binary", hostPath, file });
      }
    }
  };
  const removeAttachment = (id: number) =>
    setAttachments((list) => {
      const target = list.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl); // Release the local preview
      return list.filter((a) => a.id !== id);
    });

  // Queue resume: after a conversation's round of generation ends, if it still has queued messages and is still the current conversation, take the front of the queue and auto-send it (processing in order).
  // A conversation switched away from does not auto-resume (its queue is retained and triggered by loadConversation when switched back to and loaded).
  const processQueue = (convId: string | null) => {
    if (!convId || convId !== convIdRef.current) return;
    if (useAgentChatStore.getState().generating[convId]) return; // This conversation is still generating; wait for it to finish before resuming
    const next = shiftQueued(convId);
    if (next) void send({ text: next.text, attachments: next.attachments, _fromQueue: true });
  };


  /**
   * Working-directory policy, applied on every send (only when Electron tools are available). Choosing a folder is
   * OPTIONAL: a session without one runs in the app-managed default workspace under userData/agent, which is what a new
   * session in a fresh workspace gets. Nothing here refuses a send for want of a folder.
   *
   * Order matters. An explicit choice is looked for FIRST, including one this page may not have heard about, and only a
   * genuine absence falls through to the default. Reversed, a folder picked on the home page would be silently ignored in
   * favour of a scratch directory whenever the event announcing it did not arrive — the session would run somewhere the
   * user did not choose, which is worse than either policy on its own.
   *
   * Returns the directory this round should use, or null when the send must be abandoned — in which case the
   * reason is already on screen.
   */
  const resolveEffectiveWorkdir = async (): Promise<string | null> => {
    if (!toolsReady) return workdir;
    if (workdirChosen) return workdir;
    // If the input box already has a path (e.g. a default prefill) → adopt and apply it directly, without first clicking "apply" manually.
    // Fall back to reading the persisted AGENT_WORKDIR_KEY: after the home page WorkdirSelector chooses a directory it is already persisted, but the permanently-mounted chat page may
    // still have workdirChosen false and workdirInput empty because it did not receive WORKDIR_SET_EVENT — in that case recover it from storage, so an explicit choice is not lost.
    const savedDir = getStorage(AGENT_WORKDIR_KEY);
    const dir = workdirInput.trim() || (typeof savedDir === "string" ? savedDir.trim() : "");
    if (dir) {
      try {
        const resolved = await setWorkingDir(dir);
        setWorkdir(resolved);
        setWorkdirInput(resolved);
        setWorkdirChosen(true);
        putStorage(AGENT_WORKDIR_KEY, resolved); // Persist, reused across pages / reopens
        return resolved;
      } catch (e) {
        setError(t("chat.workdirSetFail", { err: e instanceof Error ? e.message : String(e) }));
        setSettingsOpen(true);
        return null;
      }
    }
    // No folder anywhere: the default workspace. Applied ONCE per session — defaultWorkingDir mints a fresh directory per
    // call, so re-resolving it on every message would scatter one conversation's files across a new folder each turn.
    if (!defaultAppliedRef.current) {
      try {
        const d = await defaultWorkingDir();
        defaultAppliedRef.current = true;
        setWorkdir(d);
        setWorkdirInput(d);
        return d;
      } catch (e) {
        setError(t("chat.workdirDefaultFail", { err: e instanceof Error ? e.message : String(e) }));
        return null;
      }
    }
    return workdir;
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
  /**
   * A goal set before its conversation record exists.
   *
   * `/goal <condition>` on an empty chat runs before the first send has created the conversation, so there is no
   * id to key the goal by yet. Stashed here and flushed the moment the record is created, exactly as the
   * composed system prompt already is (pendingSystemPromptRef).
   */
  const pendingGoalRef = useRef<GoalState | null>(null);

  /**
   * The conversation whose goal loop just hit its round limit.
   *
   * The exhaustion path clears the goal so the final honest-report round cannot itself be evaluated and
   * re-trigger the limit — but clearing it also makes the "is this conversation still under a goal" gate in
   * `finally` false, which would swallow that very round. This carries the one-shot permission across.
   */
  const goalExhaustedRef = useRef<string | null>(null);

  /** Elapsed wall-clock of a goal run, for the achievement toast. Mirrors GoalBar's own formatting. */

  /**
   * Execute a parsed `/goal` command.
   *
   * Returns the text the send should continue with, or null when the command is complete in itself. Setting a
   * goal returns the condition, because the doc's contract is that `/goal <condition>` starts working on it
   * immediately — the user should not have to type the same sentence again as a separate message.
   *
   * Feedback is a toast plus the goal bar rather than a chat message: the bar already shows the condition, the
   * elapsed time, the round count, the spend and the last verdict continuously, so a bare `/goal` has nothing
   * to print that is not already on screen — it just opens the bar.
   */
  const handleGoalCommand = (cmd: Exclude<GoalCommand, { kind: "none" }>): string | null => {
    const convId = convIdRef.current;
    const current = convId ? goalFor(convId) : (pendingGoalRef.current ?? emptyGoal());
    /** Write to the conversation when there is one, otherwise stash for the record that is about to exist. */
    const write = (g: GoalState) => {
      if (convId) setGoalFor(convId, g);
      else {
        pendingGoalRef.current = isGoalEmpty(g) ? null : g;
        showPendingGoal(isGoalEmpty(g) ? null : g);
      }
    };

    if (cmd.kind === "error") {
      toast.error(t("goal.unknownSub", { sub: cmd.detail, aliases: GOAL_CLEAR_ALIASES.join(" / ") }));
      return null;
    }

    if (cmd.kind === "status") {
      if (isGoalActive(current) || current.status === "achieved") setGoalExpanded(true);
      else toast.info(t("goal.noneSet"));
      return null;
    }

    if (cmd.kind === "clear") {
      if (!isGoalActive(current)) {
        toast.info(t("goal.noneSet"));
        return null;
      }
      // Clearing takes effect immediately, mid-turn included: the end-of-turn check re-reads the goal and finds
      // it inactive, so a loop running right now stops after the round it is in rather than at the next one.
      write(clearGoal(current));
      toast.success(t("goal.cleared", { condition: current.condition }));
      return null;
    }

    // cmd.kind === "set" — replacing whatever was there, with no confirmation but with the displaced condition
    // named, so a goal the user had forgotten about cannot vanish silently.
    const replaced = isGoalActive(current) ? current.condition : "";
    write(startGoal(cmd.condition, { now: Date.now(), source: "user" }));
    setGoalExpanded(false);
    toast.success(replaced ? t("goal.replaced", { condition: replaced }) : t("goal.set"));
    // Advisory only, and after the success: the goal IS set. A condition is not paid for once like an ordinary
    // message — it is re-rendered into the wire every turn and handed to the evaluator every round — and that
    // is the one thing about its length a user cannot see for themselves.
    if (cmd.long) {
      toast.info(t("goal.longCondition", { len: String(cmd.condition.length) }));
    }
    // The condition itself becomes this round's instruction.
    return cmd.condition;
  };

  const send = async (opts?: { text?: string; attachments?: Attachment[]; _fromQueue?: boolean }) => {
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
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }; // Reset this round's usage
    // send() is an async event handler, never render code: it is reached from the composer, the queue and the
    // job-finished subscription, and every clock read below happens after at least one await.
    turnStartRef.current = Date.now(); // Start this round's clock (paired with the usage reset above)

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
    const { convId: genConvId, userWireIdx, userStoredIdx } = landed;
    let roundConvo = landed.roundConvo;
    const store = useAgentChatStore.getState();

    store.setConversationGenerating(genConvId, true);
    runsRef.current.set(genConvId, ctrl); // Register this conversation's run, for cancel (active conversation) / background concurrency
    // "Whether in the active view": apply view side effects only while active; a background conversation persists silently.
    const active = () => convIdRef.current === genConvId;
    // One id per generation, shared by everything this turn spends (see RunCtx.turnId).
    const turnId = `${genConvId}-${Date.now().toString(36)}`;
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
      wireBuffer: () => convoRef.current,
      compaction: () => compactionRef.current,
      // Lets a tool's bubble go up before the call and be completed in place. `completeDisplay` rather than
      // `replaceDisplay`: a bubble can be gone by the time its call returns, and the result must survive that.
      replaceDisplay: completeDisplay,
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
      push: (m) => { if (active()) pushDisplay(m); },
      // Routed through the boundary rather than calling setStatus directly: this is the §13 contract in use,
      // and it is what lets the same handlers run under a test boundary in M5.
      status: (s) => boundary.onEvent({ type: "status", text: s }),
    };

    /**
     * The instruction the goal loop wants to run next, decided by the end-of-turn check.
     *
     * Declared out here because it is written inside the try and read in `finally`: the next round must start
     * only after this one's cleanup has run (spinner cleared, usage recorded, generating flag released), or the
     * send it triggers would be enqueued behind a turn that is technically still in flight.
     */
    let goalContinuation: string | null = null;

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

    const {
      runSubAgent,
      spawnSubagents,
      joinSubagents,
      spawnSubAgent,
      drainDelegations,
      drainJobEvents,
      shutdownScheduler,
    } = createDelegationTools({
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
    });

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
          // Read per turn rather than cached: the library follows the data-storage location, which the user
          // can change from Settings mid-session, and a cached path would keep announcing the old folder —
          // the one failure this announcement exists to prevent. One IPC call against a model request is free.
          assetsDir: await mediaDir().catch(() => ""),
          activeModel,
          skills: enabled,
          imageGenerationAvailable: capabilityAvailable("image_generation"),
          videoGenerationAvailable: capabilityAvailable("video_generation"),
          task: renderTaskMemory(taskMemoryFor(genConvId)),
          // The goal rides the same road as the mission brief, and for the same reason: it is re-rendered from
          // structured state every turn, so the model sees the current condition, criteria and plan even after
          // compaction has discarded every message that produced them.
          goal: renderGoalState(goalFor(genConvId)),
        });
        const delta = diffReminder(current, foldReminders(roundConvo));
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

      const loopOutcome = await runAgentLoop({
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
        runRound: createRoundRunner({
          convId: genConvId,
          turnId,
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
          setDisplay,
          setCtxTokens,
          diagRef,
          lastArtifactRef,
              schedulerRef,
          awaitingJobsRef,
          tagLastAssistantStoredIndex,
          goalFor,
          setGoalFor,
          setRenderDelta: (fn) => { renderDelta = fn; },
        }),
      });

      /**
       * The wrap-up round after a detected doom loop.
       *
       * The Runtime stops on escalation; withdrawing the tools and making the model account for itself is the
       * host's response, and it belongs here rather than inside the loop because it is a request this host
       * builds. Same outcome the user saw before — one final, tool-free reply explaining where it got stuck —
       * reached through one decision instead of two.
       */
      if (loopOutcome.stop.reason === "doom-loop" && !ctrl.signal.aborted) {
        nudgeIntoLastTool(LOOP_BREAK_NUDGE);
        // Said out loud, because from outside a loop and long work look identical — a spinner and a rising
        // token count — and the user is the one paying for the difference.
        if (active()) toast.warning(t("chat.loopBroken"));
        console.warn(`[loop-guard] ${loopOutcome.stop.detail ?? "no new information"}; withdrawing tools for a final reply`);
        // Built through prepareWire like every other request. Hand-composing a few of its steps here would be
        // a second wire builder, and it would skip the two that matter least often and hurt most when missed:
        // the reasoning replay policy, and image handling for a provider that rejects them.
        const wrapWire = prepareWire(buf.messages, compaction, {
          model: {
            isLocal: isLocalModel,
            acceptsImages: !!activeModel?.multimodal,
            sendReasoningContext: sendReasoningContext(),
            modelId: activeModel?.model,
          },
          steps: WIRE_STEPS,
        });
        const wrapUp = await requestChat(wrapWire, undefined, ctrl.signal, undefined, {
          actor: "main",
          convId: genConvId,
          turnId,
        });
        const wrapMsg = wrapUp.choices?.[0]?.message;
        // A model that emits tool calls when none were declared: rare, and seen on local builds whose chat
        // template writes call syntax out of habit. Nothing can execute them — there is no declaration to
        // validate them against — and the round is over, so they are dropped rather than persisted. Writing
        // them would leave an assistant.tool_calls that nothing answers, which the provider rejects on the
        // conversation's NEXT request.
        if (wrapMsg?.tool_calls?.length) {
          console.warn(`[loop-guard] dropped ${wrapMsg.tool_calls.length} tool call(s) emitted with no tools declared`);
          delete wrapMsg.tool_calls;
        }
        roundLog.lastWire = wrapWire;
        roundLog.lastContent = wrapMsg?.content ?? "";
        if (roundLog.lastContent && active()) pushDisplay({ kind: "assistant", content: roundLog.lastContent });
        if (roundLog.lastContent) {
          store.appendMessage(genConvId, {
            role: "assistant",
            content: roundLog.lastContent,
            ts: Date.now(),
          });
        }
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
      // Show this round's token usage (including tool rounds / subagents), and add it to the session total.
      const u = turnUsageRef.current;
      // Wall-clock time for the whole round. Measured here in `finally`, so it covers the normal path, an error, and a
      // user cancel alike — i.e. it always reflects how long the user actually waited.
      const elapsedMs = turnStartRef.current > 0 ? Date.now() - turnStartRef.current : 0;
      if (u.prompt > 0 || u.completion > 0 || u.total > 0) {
        const total = u.total || u.prompt + u.completion;
        if (active())
          pushDisplay({
            kind: "usage",
            prompt: u.prompt,
            completion: u.completion,
            total,
            cached: u.cached,
            estimated: u.estimated,
            elapsedMs,
          });
        setSessionUsage((s) => ({
          prompt: s.prompt + u.prompt,
          completion: s.completion + u.completion,
          total: s.total + total,
          cached: s.cached + u.cached,
          estimated: s.estimated || u.estimated,
        }));
      }
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
  };

  // Refreshed after every render alongside resendRef, for the same closure reason. See the declaration above.
  // Assigned in an effect rather than during render: a ref written while rendering is read by whatever
  // rendered first, and React may discard a render entirely. Both of these are only ever called from an
  // event or a subscription — i.e. after the commit — so binding them post-commit changes nothing about
  // which closure the caller gets.
  useEffect(() => {
    // Both job handlers, rebuilt against this render's `send` (see jobEvents.ts).
    const jobs = createJobHandlers({
      convIdRef,
      sandboxStatusRef,
      pendingJobsRef,
      awaitingJobsRef,
      send: (opts) => void send(opts),
      pushDisplay,
      enqueueMessage,
    });
    jobFinishedRef.current = jobs.onServiceJob;
    generationJobFinishedRef.current = jobs.onGenerationJob;

    // On every render, refresh the "resend from a user message" implementation, capturing the latest send / state (see the note at the resendRef declaration).
    resendRef.current = (displayIndex, newText, feedbackNudge) => {
      if (loading) return; // Editing / regenerating is not allowed while generating
      if (!newText.trim()) return;
      const disp = displayRef.current;
      const target = disp[displayIndex];
      if (!target || target.kind !== "user") return;
      // Past every early return, so the resend is definitely happening: a nudge armed here cannot leak onto a later message.
      if (feedbackNudge !== undefined) feedbackNudgeRef.current = feedbackNudge;
      // Preserve the images the user originally attached to this message: editing the text or regenerating
      // must not silently drop them. Reconstruct minimal image attachments from the stored image URLs
      // (OSS link for a cloud model, data URI for a local one — both are directly usable as image_url at
      // send time, so no file/hostPath is needed). We deliberately pass ONLY these below, never the
      // input-box's currently staged attachments, so an edit can't merge in unrelated files.
      const keptImages: Attachment[] = (target.images ?? []).map((url, i) => ({
        id: ++attachIdRef.current,
        name: `image-${i + 1}`,
        size: 0,
        kind: "image" as const,
        url,
      }));
      // Which user message this is (1-based): user messages correspond one-to-one across "display / wire / persistence", serving as the alignment anchor.
      let k = 0;
      for (let i = 0; i <= displayIndex; i++) if (disp[i]?.kind === "user") k++;
      if (k === 0) return;
      const convId = convIdRef.current;
      // 1) Truncate the display: remove this user message and everything after it.
      const nextDisplay = disp.slice(0, displayIndex);
      displayRef.current = nextDisplay;
      setDisplay(nextDisplay);
      // 2) Truncate the wire conversation (convoRef): keep up to just before the k-th user message (system is at index 0 and is kept by the slice).
      {
        let seen = 0;
        let cut = convoRef.current.length;
        for (let i = 0; i < convoRef.current.length; i++) {
          if (convoRef.current[i].role === "user") {
            seen++;
            if (seen === k) { cut = i; break; }
          }
        }
        convoRef.current = convoRef.current.slice(0, cut);
      }
      // 3) Truncate the persisted messages: likewise keep up to just before the k-th user StoredMessage.
      if (convId) {
        const msgs = useAgentChatStore.getState().getConversation(convId)?.messages ?? [];
        let seen = 0;
        let cut = msgs.length;
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].role === "user") {
            seen++;
            if (seen === k) { cut = i; break; }
          }
        }
        useAgentChatStore.getState().truncateMessages(convId, cut);
      }
      // History changed: reset context compaction (the old summary may reference deleted rounds), and send will rebuild it on demand.
      compactionRef.current = null;
      manualCompactRef.current = false;
      setCompacted(false);
      persistCompaction(convId);
      // Resend from this point with the new text, re-attaching the original message's images (see keptImages)
      // and nothing else — the input-box's staged attachments are intentionally excluded.
      void send({ text: newText, attachments: keptImages });
    };
  }); // no dependency array: both bindings must be refreshed on EVERY render, which is the whole point

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q) setInput(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupDone, params, onChatRoute]);

  return (
    <div className="relative flex h-full">
    <div className="relative flex h-full minonSecureEnvChange-w-0 flex-1 flex-col overflow-hidden bg-surface text-ink">
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
        onOpenSkills={() => setSkillsOpen(true)}
        enabledSkillCount={enabledSkills(installedSkills).length}
        settingsOpen={settingsOpen}
      />

      {/* Messages */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <CustomScrollbar
        viewportRef={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1"
        viewportClassName="flex flex-col bg-surface"
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
        onClose={() => setSkillsOpen(false)}
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
          onClear={() => {
            const g = goalFor(convIdRef.current);
            if (!isGoalActive(g)) return;
            setGoalFor(convIdRef.current, clearGoal(g));
            toast.success(t("goal.cleared", { condition: g.condition }));
          }}
        />
      )}

      {/* Task list: fixed above the input box, showing progress.
          Lowest priority — it yields and hides when the sensitive-operation confirmation panel is present, to avoid competing for space with it. */}
      {todos.length > 0 && !(pending && pending.convId === viewConvId) && (
        <TodoPanel todos={todos} onToggle={toggleTodo} onClear={() => setTodosFor(convIdRef.current, [])} />
      )}

      {/* Queued messages: messages the user sends again while generating are listed here and auto-sent in order after this round ends. Can be removed one by one. */}
      {queued.length > 0 && (
        <div className="px-4 pt-2">
          <div className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface-muted/40 px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-subtle">
              <span className="font-medium text-ink-muted">{t("chat.queued")}</span>
              <span className="rounded-full bg-surface-hover px-1.5 py-px tabular-nums">{queued.length}</span>
              <span>{t("chat.queuedHint")}</span>
            </div>
            <div className="flex flex-col gap-1">
              {queued.map((m, idx) => (
                <div key={m.id} className="flex items-center gap-2 text-xs text-ink">
                  <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-ink-subtle">{idx + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {m.text || (m.hasAttachments ? t("chat.attachmentLabel") : "")}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeQueued(m.id)}
                    title={t("chat.remove")}
                    className="shrink-0 rounded px-1 text-ink-subtle transition hover:text-destructive"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
