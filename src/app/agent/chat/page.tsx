"use client";

import { InMemoryAuditLog } from "@/lib/ai/orchestration/audit-log";
import type { ToolDeclaration } from "@/lib/ai/orchestration/capabilities";
import type { CapabilityBroker } from "@/lib/ai/orchestration/capability-broker";
import type { ConsentRequester } from "./ConsentPanel";
import type { ChoiceAnswer, ChoiceQuestion } from "./types";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  callTool,
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
  isJobCompletion,
  describeJobEvent,
  formatJobMessage,
  type ServiceEvent,
} from "@/lib/ai/services";
import {
  isUsageLogEnabledSync,
  logContextDiag,
  logToolCall,
  primeUsageLog,
} from "@/lib/ai/usageLog";
import {
  describeContext,
  simulateBudgets,
  defaultBudgetCandidates,
  formatSimulation,
} from "./contextDiag";
import { isLocalEndpoint, localLlm, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import { setSecureEnv as syncSecureEnv, onSandboxStatus, getSandboxStatus, getSandboxVmInfo, isSandboxEngine, DEFAULT_SECURE_ENV, type SandboxStatus } from "@/lib/ai/sandbox";
import { useLocaleStore, useT } from "@/lib/i18n";
import { toast } from "sonner";
// Only the two types remain here: the delegation tools themselves moved to chatDelegation.ts.
import type { DelegationMeta, PriorDelegation } from "@/lib/ai/subagents";
import { SubAgentScheduler } from "@/lib/ai/subagentScheduler";
import { SkillSelectPanel } from "./SkillSelectPanel";
import BrowserPanel from "./BrowserPanel";
import { getStorage } from "@zzcpt/zztool";
import {
  AGENT_GOAL_EVALUATOR_MODEL_KEY,
  AGENT_MAX_GOAL_ROUNDS_KEY,
  AGENT_WORKDIR_KEY,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
} from "@/constants/Agent";
import { migrateLegacyAgentStorage, putStorage } from "@/lib/ai/agentStorage";
import { hydrateAppConfig } from "@/lib/ai/appConfig";
import { notifyReplyComplete, notifyAgentError, notifyQuestion } from "@/lib/ai/agentNotify";
import { isWindowAlwaysOnTop } from "@/lib/electron/windowControls";
import { useAgentChatStore } from "@/store/agentChatStore";
import { enabledSkills, loadInstalled } from "@/lib/ai/skills/store";
import { loadPluginSkills } from "@/lib/plugins/skills";
import { pluginBridge } from "@/lib/plugins/bridge";
import { buildSystemPrompt, buildToolSet as buildToolSet_ } from "@/lib/ai/promptPrefix";
import { ROUTED_TOOLS, resolveToolCall, routedFailureHint, unknownToolResult } from "@/lib/ai/toolRouter";
import { loadEnabledProjectSkills } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { makeUnifiedDiff } from "./diffUtil";
import { capToolOutput } from "./compress";
import {
  buildWireContext,
  sanitizeToolCallPairs,
  deserializeCompaction,
  pathProvenance,
  type CompactionState,
} from "./contextCompress";
import {
  loadThinking,
  saveThinking,
  THINKING_CHANGE_EVENT,
  type ThinkingConfig,
} from "@/lib/ai/thinking";
import {
  emptyTaskMemory,
  isTaskMemoryEmpty,
  normalizeTaskMemory,
  renderTaskMemory,
  type TaskMemory,
} from "./taskMemory";
import {
  emptyGoal,
  isGoalEmpty,
  isGoalActive,
  restoreGoal,
  toStoredGoal,
  renderGoalState,
  startGoal,
  clearGoal,
  achieveGoal,
  GOAL_ACHIEVED_LINGER_MS,
  recordEvaluation,
  addTurnSpend,
  recordEvidence,
  applyTodoStatuses,
  decideNextRound,
  MAX_GOAL_AUTO_ROUNDS,
  type GoalState,
} from "./goalState";
import { parseGoalCommand, GOAL_CLEAR_ALIASES, type GoalCommand } from "./goalCommand";
import { parseSlashCommand } from "./slashCommands";
import { createGoalEvaluator, TRANSCRIPT_BUDGET_FRACTION } from "./goalEvaluator";
import { GoalBar } from "./GoalBar";
import { normalizeTodos } from "@/lib/ai/conversation";
import { countMessagesTokens, countTokens } from "@/lib/ai/tokenizer";
// ── Extracted modules (data / types / constants / tool declarations / display components) ──────────────────────
import {
  resolveActiveModel,
  resolveModelById,
  ensureModelListSeeded,
  loadModelList,
  getSelectedModel,
  setSelectedModelId,
  resolveContextWindow,
  OFFICIAL_PROVIDER_ID,
  MODEL_LIST_CHANGE_EVENT,
  type ResolvedModel,
  type AgentModel,
} from "@/lib/ai/models";
import { useAuthStore } from "@/store/authStore";
import {
  FEEDBACK_DOWN_NUDGE,
  FEEDBACK_UP_NUDGE,
  FINALIZE_NUDGE,
  RECORD_MEMORY_NUDGE,
  FORCE_REVIEW_NUDGE,
  PENDING_DELEGATION_NUDGE,
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
  PARALLEL_SAFE_TOOLS,
  RENDERER_HANDLED_TOOLS,
  RESUME_NUDGE,
  RISKY_PATH_PATTERN,
  toolNeedsConsent,
  UNCAPPED_TOOLS,
  toolStatusText,
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
import type { ToolResult } from "@/lib/agent/turn";
import { createRendererTools, type RendererTool } from "./chatTools";
import { createDelegationTools } from "./chatDelegation";
import { createCompaction } from "./chatCompaction";
import type { ConsentDecision, ConsentRequest, RuntimeBoundary } from "@/lib/agent/runtimeBoundary";
import { prepareWire, type WireSteps } from "@/lib/agent/contextManager";
import { noObligations, recordTool, dueReminders, unansweredCalls, type ToolRuntimeRules } from "@/lib/agent/toolRuntime";
// Execution State, the reasoning policy and the doom-loop detector are all owned by runAgentLoop now;
// only the capability derivation stays here, because both the loop and the delegation factory need it.
import { describeCapabilities } from "@/lib/agent/modelAdapter";
import type {
  ApiMsg,
  Attachment,
  ContentPart,
  ReminderState,
  RunCtx,
  DisplayMsg,
  SubAgentStep,
  Todo,
  ToolCall,
} from "./types";
import { capabilityAvailable } from "@/lib/ai/generation";
import { mediaDir, mediaSrcFor, registerMedia } from "@/lib/ai/mediaLibrary";
import {
  onGenerationJobEvent,
  describeJobResult,
  cancelJobsFor,
  type GenerationJobEvent,
} from "@/lib/ai/generation/jobs";
import { isMemoryFilesAvailable } from "@/lib/ai/memoryFiles";
import { setBrowserBusy } from "@/lib/automation";
import { detectServices } from "@/store/servicesStore";
import { TodoPanel } from "./TodoPanel";
import { ChatTranscript } from "./ChatTranscript";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { Composer } from "./Composer";
import { ProjectSkillsPrompt } from "./ProjectSkillsPrompt";
import { AnimatePresence, motion } from "framer-motion";
import { ConsentPanel } from "./ConsentPanel";
import { useConsentQueue } from "./useConsentQueue";
import {
  hoistSystemToFront,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  phaseSummaryText,
  thinkingProcessText,
  stripWireMetadata,
  applyReasoningPolicy,
  toInstalledProjectSkill,
} from "./wireHelpers";
import {
  buildImageParts,
  buildReminderState,
  composeWireText,
  groupParallelCalls,
  resolveToolCalls,
  saveAttachments,
} from "./sendPrep";
import { createChatRequest } from "./chatRequest";
import { createSummarizeHistory } from "./summarize";
import { ChatHeader } from "./ChatHeader";
import { ChatDialogs } from "./ChatDialogs";
import { ContextUsageRing } from "./ContextUsageRing";

/**
 * Transcript windowing. A long conversation used to mount every message at once — hundreds of markdown /
 * code-highlight subtrees in one commit, which stalls opening the conversation and makes every subsequent
 * re-render (each streaming token flushes `display`) walk the whole list. Only the tail is mounted; earlier
 * turns are added in batches as the user scrolls up. `display` itself still holds the full transcript — it is
 * the display source of truth and message indices must stay absolute — this only bounds what reaches the DOM.
 */
const INITIAL_VISIBLE_TURNS = 5; // Turns mounted when a conversation is opened
const LOAD_MORE_TURNS = 5; // Turns added per "load earlier" step

/**
 * Index in `display` where the last `turns` user messages begin (a "turn" = a user message plus everything the
 * assistant produced in response). Returns 0 when the transcript holds fewer than `turns` of them, i.e. the
 * whole thing is already visible. Because the result always lands on a user message (or 0), the window never
 * splits a run of tool/reasoning entries that ProcessGroup collapses into one card.
 */
function startOfLastTurns(display: DisplayMsg[], turns: number): number {
  let seen = 0;
  for (let i = display.length - 1; i >= 0; i--) {
    if (display[i].kind === "user" && ++seen >= turns) return i;
  }
  return 0;
}

/** Index where the `turns` user messages immediately preceding `before` begin (0 once the start is reached). */
function startOfTurnsBefore(display: DisplayMsg[], before: number, turns: number): number {
  let seen = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (display[i].kind === "user" && ++seen >= turns) return i;
  }
  return 0;
}

/**
 * Layout effect that is safe to prerender. This project builds with `output: "export"`, so client components are
 * rendered on the server at build time, where useLayoutEffect does nothing and React says so on the console.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
  // The currently selected model (chosen in settings / home page, read-only here for sending). endpoint / model / apiKey are derived from it.
  const [activeModel, setActiveModel] = useState<ResolvedModel | null>(null);
  // The list of selectable models + the currently selected id (used by the model picker inside the input box).
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(null);
  // Thinking mode (master switch + gear), set from the composer toolbar and persisted globally like the
  // selected model. Read synchronously on the client for the same reason the locale store does: the
  // toolbar would otherwise flash the default before the stored choice lands.
  const [thinking, setThinking] = useState<ThinkingConfig>(loadThinking);
  const changeThinking = (next: ThinkingConfig) => {
    setThinking(next);
    saveThinking(next);
  };
  // This component is mounted once for the app's lifetime, so a setting changed anywhere else (the home
  // page's own composer writes the same storage) would otherwise never reach the value used for sending.
  useEffect(() => {
    const sync = () => setThinking(loadThinking());
    window.addEventListener(THINKING_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THINKING_CHANGE_EVENT, sync);
  }, []);
  // Models that rejected the thinking switch outright (see the 400 fallback in requestChat): once a model
  // is in here the field is left off its requests for the rest of the session.
  const thinkingUnsupportedRef = useRef<Set<string>>(new Set());
  // Same idea for the other direction: models that rejected a REPLAYED thinking block (`reasoning_content` on an
  // assistant message of the request). While the model is in here, the "send thinking as context" setting is
  // suspended for it — the wire is built without the replay instead of paying a failed request per turn.
  const reasoningContextUnsupportedRef = useRef<Set<string>>(new Set());
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
  const subagentSinksRef = useRef(
    new WeakMap<
      object,
      { convId: string; steps: SubAgentStep[]; storedIndex: number | null }
    >(),
  );
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
    sched: SubAgentScheduler<DelegationMeta>;
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
  /**
   * Secure environment: does THIS session run commands inside the sandbox VM, or directly on the host?
   *
   * Per session, not per project — see Conversation.secureEnv. A new session inherits the project's most recent one, an
   * existing session adopts whatever it recorded, and either way this state is the single source of truth that the header
   * toggle renders, the main process is synced to, and createConversation stamps onto a brand-new record.
   *
   * The ref exists for the same reason every other one on this page does: the send loop is async and outlives the render
   * that started it, so it must read the value that is live now rather than the one captured when the turn began.
   */
  const [secureEnv, setSecureEnvState] = useState<boolean>(DEFAULT_SECURE_ENV);
  const secureEnvRef = useRef<boolean>(DEFAULT_SECURE_ENV);
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
  // The settings area (working directory / run parameters) is collapsed by default; it expands on demand in dev mode when a working directory is missing.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The header's root element. Nothing reads it yet — it exists so measurements against the top bar (its height,
  // its bottom edge) have a handle that does not depend on a querySelector or a magic pixel constant.
  const headerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll follow: pinned to the bottom by default. If the user manually scrolls up while generating → pause auto-scroll and surface a "back to bottom" button; scrolling back to the bottom resumes it.
  // atBottomRef is for the synchronous read of "whether to follow when new content arrives" (avoiding reliance on async state); atBottom drives the button's visibility.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // For the scroll bar's thumb position
  const [scrollTopNum, setScrollTopNum] = useState(0); 
  // Transcript window: how far back into `display` the DOM currently reaches. An absolute index rather than a
  // "how many turns" count, so that appending to the tail (streaming, a new send) does not push already-revealed
  // history back out of view — indices of earlier entries are stable, every write to `display` is tail-only.
  // MAX_SAFE_INTEGER = "not expanded", meaning just the initial tail. Reset on conversation switch / clear.
  const [historyAnchor, setHistoryAnchor] = useState(Number.MAX_SAFE_INTEGER);
  const resetHistoryWindow = () => setHistoryAnchor(Number.MAX_SAFE_INTEGER);
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
  // Distance from the bottom to preserve across a "load earlier" expansion, handed to the layout effect below.
  const scrollAnchorRef = useRef<number | null>(null);
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
  // User choice (ask_user): resolve wakes the waiting Promise when an option is clicked.
  // ask_user's pending-answer choice cards: keyed by card id (each question is independent, multiple conversations / concurrent questions never overwrite each other).
  // Each entry records the issuing conversation, to ease unblocking by conversation on cancel / clear.
  const choiceResolversRef = useRef<
    Map<number, { convId: string | null; questions: ChoiceQuestion[]; resolve: (v: string) => void }>
  >(
    new Map(),
  );
  const choiceIdRef = useRef(0);
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

  // Message queue: while generating, a new send by the user is no longer dropped but enqueued per conversation (FIFO), and auto-sent in order after this round of generation ends.
  // The queue lives in the component (AgentShell keeps it permanently mounted), so switching pages inside /agent does not affect the queue or resume. Keyed by conversation id.
  type QueuedMsg = { id: number; text: string; attachments: Attachment[] };
  const queueRef = useRef<Map<string, QueuedMsg[]>>(new Map());
  const queueIdRef = useRef(0);
  const [queued, setQueued] = useState<{ id: number; text: string; hasAttachments: boolean }[]>([]);
  // Map a conversation's queue to the display state of the "currently viewed conversation" (only the current conversation renders the queue panel).
  const syncQueued = (convId: string | null) => {
    if (convId !== convIdRef.current) return;
    const q = (convId && queueRef.current.get(convId)) || [];
    setQueued(q.map((m) => ({ id: m.id, text: m.text, hasAttachments: m.attachments.length > 0 })));
  };
  const enqueueMessage = (convId: string, text: string, attachments: Attachment[]) => {
    const q = queueRef.current.get(convId) ?? [];
    q.push({ id: ++queueIdRef.current, text, attachments });
    queueRef.current.set(convId, q);
    syncQueued(convId);
  };
  const removeQueued = (id: number) => {
    const convId = convIdRef.current;
    const q = convId ? queueRef.current.get(convId) : undefined;
    if (!convId || !q) return;
    q.forEach((m) => m.id === id && m.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)));
    queueRef.current.set(convId, q.filter((m) => m.id !== id));
    syncQueued(convId);
  };

  // Task list (update_todos): fixed above the input box. Owned per conversation, not globally — the panel belongs to
  // the conversation that created it, so switching away must take it off screen and switching back must bring it back.
  // A single shared list also let two conversations generating at once overwrite each other's todos.
  const [todos, setTodos] = useState<Todo[]>([]);
  const todosByConvRef = useRef(new Map<string, Todo[]>());
  const todosFor = (convId: string | null): Todo[] =>
    (convId ? todosByConvRef.current.get(convId) : undefined) ?? [];
  /** Write a conversation's list, and mirror it on screen only when that conversation is the one being viewed. */
  const setTodosFor = (convId: string | null, next: Todo[]) => {
    if (convId) {
      if (next.length > 0) todosByConvRef.current.set(convId, next);
      else todosByConvRef.current.delete(convId);
      // Persisted since M6 (docs/agent-runtime-loop.md §16, §18 Test 7). The list used to live only in this
      // ref and be archived as a display bubble at end of turn, so reopening a conversation mid-task showed
      // the transcript of a checklist and no checklist — the model's plan survived in Goal State while the
      // user's view of it did not. A runtime artifact, flushed to disk like compaction and goal.
      useAgentChatStore.getState().setConversationTodos(convId, next.length > 0 ? next : null);
    }
    if (convId === convIdRef.current) setTodos(next);
  };

  // Task Memory: the model's INTERNAL mission brief (prose only, with provenance). Deliberately separate
  // from the visible todos above — it is context the model reads (pinned into the wire, preserved across
  // compaction), never shown to the user. Per-conversation and persisted so the mission survives reopen.
  const taskMemoryByConvRef = useRef(new Map<string, TaskMemory>());
  const taskMemoryFor = (convId: string | null): TaskMemory =>
    (convId ? taskMemoryByConvRef.current.get(convId) : undefined) ?? emptyTaskMemory();
  /** Write a conversation's Task Memory (persists; clears the entry + disk snapshot when empty). */
  const setTaskMemoryFor = (convId: string | null, tm: TaskMemory) => {
    if (convId) {
      if (isTaskMemoryEmpty(tm)) taskMemoryByConvRef.current.delete(convId);
      else taskMemoryByConvRef.current.set(convId, tm);
      useAgentChatStore
        .getState()
        .setConversationTaskMemory(convId, isTaskMemoryEmpty(tm) ? null : tm);
    }
  };

  // Goal State: the condition this task must reach, plus the bookkeeping of the loop driving it there.
  // Held per conversation and persisted exactly like Task Memory above, for the same reason and one more: the
  // loop keeps running until an independent evaluator says the condition is met, so a goal that did not survive
  // a reload would silently turn a half-finished task into a finished one. See goalState.ts.
  //
  // The authority is the ref: the send loop reads and writes it from closures that must see the current value
  // synchronously, which is the same reason todos and Task Memory are refs. `displayedGoal` is the render-visible
  // mirror of whichever conversation is on screen — exactly the todos/setTodos arrangement above, and for the
  // same reason (a panel gated on a ref is invisible to React, so it only updated when something else happened
  // to re-render).
  const goalByConvRef = useRef(new Map<string, GoalState>());
  const [displayedGoal, setDisplayedGoal] = useState<GoalState | null>(null);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const goalFor = (convId: string | null): GoalState =>
    (convId ? goalByConvRef.current.get(convId) : undefined) ?? emptyGoal();
  /**
   * Write a conversation's Goal State.
   *
   * Persists only what toStoredGoal admits — an ACTIVE goal. An achieved or cleared one stays in the ref for the
   * rest of the session (so the bar can show the run that just finished) and is deliberately absent from disk,
   * which is what stops a reopened conversation from resurrecting a goal whose run is over.
   */
  const setGoalFor = (convId: string | null, g: GoalState) => {
    if (!convId) return;
    if (isGoalEmpty(g)) goalByConvRef.current.delete(convId);
    else goalByConvRef.current.set(convId, g);
    useAgentChatStore.getState().setConversationGoal(convId, toStoredGoal(g));
    // Mirror on screen only when this conversation is the one being viewed: a background conversation's goal
    // persists silently and is picked up by the swap below when the user comes back to it.
    if (convId === convIdRef.current) setDisplayedGoal(isGoalEmpty(g) ? null : g);
  };

  /** Pending "clear the achieved goal" timers, keyed by conversation. */
  const goalClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * Clear an achieved goal after a short window (see GOAL_ACHIEVED_LINGER_MS).
   *
   * The window exists so the finished run — rounds, elapsed, spend — is readable before it goes. What the
   * window must not do is clear something else: within ten seconds the user can drop the goal, start a new one
   * with /goal, or the conversation can be switched away. So the timer re-reads the state when it fires and
   * only clears if it is still looking at the very run it was scheduled for, matched on condition AND start
   * time — a new goal with the same wording is a different run and must survive.
   */
  const scheduleGoalClear = (convId: string, achieved: GoalState) => {
    const timers = goalClearTimersRef.current;
    const existing = timers.get(convId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(convId);
      const current = goalFor(convId);
      const sameRun =
        current.status === "achieved" &&
        current.condition === achieved.condition &&
        current.run.startedAt === achieved.run.startedAt;
      if (sameRun) setGoalFor(convId, clearGoal(current));
    }, GOAL_ACHIEVED_LINGER_MS);
    timers.set(convId, timer);
  };

  // Timers outlive the turn that scheduled them, so unmounting mid-window would otherwise fire into a dead
  // component.
  useEffect(() => {
    const timers = goalClearTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // The set_goal and update_plan handlers lived here. They are gone with the tools: the goal is the user's,
  // and a handler kept "just in case" would still be reachable by name through call_tool, which is exactly the
  // hole removing the tools was meant to close.

  // set_task_state and update_todos moved to chatTools.ts with the rest of the renderer tools.
  // toggleTodo stays: it is the USER ticking a box, not a tool call.

  // Manual toggle: switch this item between "completed / not completed". Only ever acts on the viewed conversation's list.
  const toggleTodo = (index: number) => {
    const next = todosFor(convIdRef.current).map((t, i) =>
      i === index ? { ...t, status: t.status === "completed" ? "pending" : "completed" } : t,
    );
    setTodosFor(convIdRef.current, next as Todo[]);
    // The user ticking an item is a statement about the plan too — same fold as the model's own update_todos.
    const goal = applyTodoStatuses(goalFor(convIdRef.current), next as Todo[]);
    if (goal !== goalFor(convIdRef.current)) setGoalFor(convIdRef.current, goal);
  };

  // Discard all pending-answer ask_user prompts of a conversation (unblocking them with the given text as the result). Used to release by conversation on cancel / clear.
  // Declared ahead of its callers (cancel / clearAll below) rather than beside the other choice-card code: a
  // `const` arrow is not hoisted, so defining it after them would leave it in the temporal dead zone for anything
  // that ran during the same tick.
  const dropChoicesFor = (convId: string | null, message: string) => {
    const dropped: number[] = [];
    for (const [id, e] of choiceResolversRef.current) {
      if (e.convId === convId) {
        choiceResolversRef.current.delete(id);
        dropped.push(id);
        e.resolve(message);
      }
    }
    // Close the cards too, not just their promises. The card owns a submit button now, and one whose
    // resolver has been thrown away would sit there looking answerable and silently do nothing when
    // clicked — worse than the old card, which at least showed no affordance once it was moot.
    if (dropped.length > 0) {
      setDisplay((d) =>
        d.map((m) => (m.kind === "choice" && dropped.includes(m.id) ? { ...m, submitted: true } : m)),
      );
    }
    useAgentChatStore.getState().setPendingQuestionIds(
      new Set([...choiceResolversRef.current.values()].flatMap((e) => (e.convId ? [e.convId] : []))),
    );
  };

  // Stop the current generation: abort the in-flight request for the "current active conversation", release any waiting confirmation / choice, and the loop then exits on its own.
  // Background-conversation generation is unaffected (each has its own independent AbortController).
  const cancel = () => {
    const cid = convIdRef.current;
    if (cid) {
      runsRef.current.get(cid)?.abort();
      // Stop = abort the current generation, and clear this conversation's queued messages (releasing their attachment previews); no more auto-resume.
      const q = queueRef.current.get(cid);
      if (q?.length) {
        q.forEach((m) => m.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)));
        queueRef.current.delete(cid);
        syncQueued(cid);
      }
    }
    dropConsentsFor(cid); // Release this conversation's waits in the confirmation queue (ending them with "reject") and advance the queue
    dropChoicesFor(cid, "The user canceled."); // Release all of this conversation's pending-answer ask_user prompts
  };


  // The connection config needed for sending, all derived from the "currently selected model" (maintained in settings / home page).
  const endpoint = activeModel?.endpoint ?? "";
  const modelName = activeModel?.model ?? "";
  const apiKey = activeModel?.apiKey ?? "";

  // The actual running status of the local model (llama.cpp): after an app restart, llama-server is not started automatically (no auto-start),
  // so a selected local model may be "in the list but not running". Subscribe to the main-process status to drive the top dot and the send guidance (go to settings to start it).
  const isLocalModel = !!activeModel && (activeModel.providerId === LOCAL_PROVIDER_ID || isLocalEndpoint(endpoint));
  // "Replay past thinking blocks on this request": the user setting, minus the models that proved they reject the field.
  // Read as a function rather than captured once, because both refs and the setting can change mid conversation.
  const sendReasoningContext = () => thinking.sendContext && !reasoningContextUnsupportedRef.current.has(modelName);
  const [localLlmReady, setLocalLlmReady] = useState<boolean | null>(null);
  // The "local model not started" dialog (pops when a send is blocked, guiding the user to Settings → Local model to start it).
  const [localStartDialog, setLocalStartDialog] = useState(false);
  useEffect(() => {
    // Clearing the tri-state the moment the model stops being local IS the correct render-visible answer, and
    // the async probe below can only overwrite it later. Nothing derives from it during this render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isLocalModel) { setLocalLlmReady(null); return; }
    const bridge = localLlm();
    if (!bridge) { setLocalLlmReady(false); return; } // Non-Electron: the local model is necessarily unavailable
    let alive = true;
    bridge.status().then((st) => { if (alive) setLocalLlmReady(!!st.ready); }).catch(() => { if (alive) setLocalLlmReady(false); });
    const off = bridge.onStatus((st) => { if (alive) setLocalLlmReady(!!st.ready); });
    return () => { alive = false; off?.(); };
  }, [isLocalModel, activeModel?.id]);

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
      setActiveModel(resolveActiveModel()); // The currently selected model → the endpoint / model / key used for sending
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
  }, []);

  // Compute the "effective model for the current conversation": the conversation-level binding takes priority,
  // falling back to the globally selected model when the binding is missing / points to a deleted model. Synced to the input-box picker and the resolved model used for sending.
  const applyEffectiveModel = useCallback(() => {
    const store = useAgentChatStore.getState();
    const conv = convIdRef.current ? store.getConversation(convIdRef.current) : null;
    const list = loadModelList();
    const globalId = getSelectedModel()?.id ?? null;
    const bound = conv?.modelId && list.some((m) => m.id === conv.modelId) ? conv.modelId : null;
    const eid = bound ?? globalId;
    setSelectedModelIdState(eid);
    setActiveModel(eid ? resolveModelById(eid) : null);
  }, []);

  // When returning to this page after switching models in settings / home page, refresh the selectable list and the effective model.
  useEffect(() => {
    const refresh = () => {
      ensureModelListSeeded();
      setModels(loadModelList());
      applyEffectiveModel();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(MODEL_LIST_CHANGE_EVENT, refresh); // Refresh immediately on same-page list changes such as a local model becoming ready / stopping
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener(MODEL_LIST_CHANGE_EVENT, refresh); };
  }, [applyEffectiveModel]);

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

  // Switch models within the input box: bind to the current conversation (if the conversation is not yet created, bind when it
  // is created on the first send); does not change the global one. This used to be conditional — dev mode bound per session,
  // daily mode wrote the global selection — and with the two modes merged, per-session binding is what survives, because that
  // is the behaviour the model picker sits next to a specific conversation to provide.
  const selectModel = (id: string) => {
    setSelectedModelIdState(id);
    setActiveModel(resolveModelById(id));
    if (convIdRef.current) useAgentChatStore.getState().setConversationModel(convIdRef.current, id);
  };
  const selectedLabel = models.find((m) => m.id === selectedModelId)?.label ?? null;
  // Group by category: official / local models / third-party / custom.
  const modelGroups = [
    { key: "official", labelKey: t("chat.groupOfficial"), items: models.filter((m) => !m.custom && m.providerId === OFFICIAL_PROVIDER_ID) },
    { key: "local", labelKey: t("chat.groupLocal"), items: models.filter((m) => m.providerId === LOCAL_PROVIDER_ID) },
    { key: "thirdParty", labelKey: t("chat.groupThirdParty"), items: models.filter((m) => !m.custom && m.providerId !== OFFICIAL_PROVIDER_ID && m.providerId !== LOCAL_PROVIDER_ID) },
    { key: "custom", labelKey: t("chat.groupCustom"), items: models.filter((m) => m.custom) },
  ].filter((g) => g.items.length > 0);

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
  const SCROLL_BOTTOM_THRESHOLD = 48;
  const isAtBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  };
  // Scroll listener: update "whether pinned to the bottom". Manual scroll-up while generating → pause auto-scroll, show the button; scroll back to the bottom → resume.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // currentTarget, not target: the typed one is the scroller itself, while `target` is whatever descendant
    // the event passed through and is only an EventTarget — it has no scrollTop to read.
    // const el = e.currentTarget;
    // if (el) {
    //   if (scrollTopNum < el.scrollTop) {
    //     headerRef.current?.classList.add("hidden");
    //   } else {
    //     headerRef.current?.classList.remove("hidden");
    //   }
    //   setScrollTopNum(el.scrollTop);
    // }
    const near = isAtBottom();
    atBottomRef.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  };
  // Back to bottom: smoothly scroll to the bottom and resume auto-follow (used by the "back to bottom" button and when sending / loading a conversation).
  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
  };
  // Auto-scroll to the bottom: only follow new content / generation state while the user is currently pinned to the bottom; after a manual scroll-up, stop bothering them until they scroll back to the bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [display, loading]);

  // Where the mounted window starts. min(anchor, tail) does double duty: it keeps expanded history expanded, and it
  // re-clamps after a truncation (edit / regenerate drops the tail, which can leave the anchor past the end) so the
  // last turns are always mounted no matter what happened to `display`.
  const visibleStart = useMemo(
    () => Math.min(historyAnchor, startOfLastTurns(display, INITIAL_VISIBLE_TURNS)),
    [display, historyAnchor],
  );
  const hasEarlier = visibleStart > 0;
  // Reveal the previous batch of turns. The container grows above the viewport, so record the distance from the
  // bottom first and restore it once the new nodes are laid out — otherwise the browser keeps scrollTop and the
  // view jumps backwards by the height of everything just inserted.
  const loadEarlier = useCallback(() => {
    if (visibleStart <= 0) return;
    const el = scrollRef.current;
    scrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setHistoryAnchor(startOfTurnsBefore(displayRef.current, visibleStart, LOAD_MORE_TURNS));
  }, [visibleStart]);
  // Restore the scroll position against the taller content, before the browser paints the expanded list.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const keep = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (el && keep != null) el.scrollTop = el.scrollHeight - keep;
  }, [visibleStart]);
  // Scrolling up to the sentinel pulls in the next batch. Guarded on the container actually being scrollable:
  // a transcript shorter than the viewport has its sentinel permanently in view, and auto-expanding there would
  // walk the whole history on open — exactly what the window exists to prevent. The button covers that case.
  const earlierSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = earlierSentinelRef.current;
    if (!node || !hasEarlier) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const el = scrollRef.current;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        loadEarlier();
      },
      { root: scrollRef.current, rootMargin: "200px 0px 0px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasEarlier, loadEarlier]);

  // The URL-seeding effect (?c= / ?q= / pending) lives at the very bottom of this component, because it calls
  // loadConversation and send — both declared far below here, and a `const` arrow is not hoisted.

  // Permanent-mount reset: this component does not unmount on route change, so once seededRef is set true it would stay true forever — leaving the chat route (e.g. "new conversation"
  // first jumps back to the home page /agent) resets the latch, so the next entry into the chat page carrying pending/?q= can consume again. Otherwise a message sent from the home page the second
  // time onwards would be skipped directly by the effect above: the page navigates but the message is not sent, and no new conversation appears in the sidebar.
  useEffect(() => {
    if (!onChatRoute) seededRef.current = false;
  }, [onChatRoute]);

  // Sandbox: the current status (the ref feeds the system prompt describing the command-execution environment; the state drives the title-row status badge).
  const sandboxStatusRef = useRef<SandboxStatus | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
  const [sandboxDialogTick, setSandboxDialogTick] = useState(0); // Incrementing it opens the sandbox startup dialog (clicking the top badge)
  const [vmUpdatable, setVmUpdatable] = useState(false); // The runtime environment has an updatable version (versions.json target ≠ downloaded) → badge hint

  /**
   * Apply this session's secure-environment switch: remember it, mirror it to the main process, and read the status back.
   *
   * The read-back is what makes the change visible immediately — `active` flips to qemu/native as the main process re-routes,
   * and that value is what the header indicator shows and what buildReminderState turns into the command-environment change
   * event on the next turn. Without it the UI would keep showing the previous engine until some unrelated status push arrived.
   *
   * `persist` is false only for the initial adoption of a session's own setting: writing it straight back would dirty every
   * conversation merely by opening it. A real toggle, and a new session's inherited value, both persist.
   *
   * Idempotent by design. The inheritance effect below re-runs whenever the active project or a lazily loaded project's
   * conversations change, and most of those re-runs land on the value already in force; doing the work anyway would mean a
   * setState (and a render) per sidebar click for a switch that did not move. `syncedRef` — rather than just comparing to
   * `secureEnvRef` — is what still guarantees the FIRST call reaches the main process, even when the session's answer
   * happens to equal the initial state and the comparison alone would skip it.
   */
  const syncedRef = useRef(false);
  const applySecureEnv = (next: boolean, { persist = true }: { persist?: boolean } = {}) => {
    const persisting = persist && !!convIdRef.current;
    if (syncedRef.current && next === secureEnvRef.current && !persisting) return;
    syncedRef.current = true;
    secureEnvRef.current = next;
    setSecureEnvState(next);
    if (persisting) {
      useAgentChatStore.getState().setConversationSecureEnv(convIdRef.current!, next);
    }
    void syncSecureEnv(next)
      .then(() => getSandboxStatus())
      .then((st) => {
        if (st) {
          sandboxStatusRef.current = st;
          setSandboxStatus(st);
        }
      });
  };

  // Sandbox: subscribe to the main process's background initialization status (download runtime environment → start), writing to ref/state.
  // Presentation is handled by the startup progress dialog SandboxStartupDialog; the status also feeds environment-hint injection and the title badge.
  useEffect(() => {
    const apply = (st: SandboxStatus) => {
      sandboxStatusRef.current = st;
      setSandboxStatus(st);
    };
    getSandboxStatus().then((st) => st && apply(st)); // When the page mounts later than the main-process initialization, backfill the current status
    return onSandboxStatus(apply);
  }, []);

  // Whether the runtime environment has an updatable version (versions.json target version ≠ downloaded): re-checked as the sandbox phase changes, driving the badge's "updatable" hint.
  useEffect(() => {
    getSandboxVmInfo().then((i) => setVmUpdatable(!!i?.updatable));
  }, [sandboxStatus?.phase]);

  /**
   * Smart default for a session that does not exist yet: inherit the secure-environment switch from the project's most
   * recent session.
   *
   * Only ever runs with no active conversation — an existing session's own setting wins, and swapInConversation applies it.
   * Keyed on the active project as well, because "New chat" leaves the conversation null while the user goes on clicking
   * through projects in the sidebar, and each click changes which project's answer applies. Projects load lazily, so
   * secureEnvDefaultFor answers undefined until this one's conversations arrive and the app default stands in the meantime;
   * `loadedProjectIds` is in the dependency list so the answer is revised the moment it can be. That set, rather than
   * `conversations` itself, because the latter is a fresh array on every appended message — subscribing to it would
   * re-render this page on every streamed turn to re-decide something that cannot have changed.
   *
   * persist:false throughout — there is no record to write to yet. The value is stamped onto the record at createConversation.
   */
  const loadedProjectIds = useAgentChatStore((s) => s.loadedProjectIds);
  useEffect(() => {
    if (activeConvId) return;
    const store = useAgentChatStore.getState();
    applySecureEnv(store.secureEnvDefaultFor(activeProjectId) ?? DEFAULT_SECURE_ENV, { persist: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, activeProjectId, loadedProjectIds]);

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
    resetHistoryWindow(); // New conversation: nothing to reveal, back to the tail-only window
    cancelPendingSwitch(); // ...and drop any conversation still being switched in, so it cannot land on top of this
    atBottomRef.current = true; // New conversation: follow from the bottom
    setAtBottom(true);
    setQueued([]); // New conversation: clear the queue panel (the new conversation has no queue yet)
    setAttachments([]); // Clear unsent attachments
    setTodosFor(convIdRef.current, []); // Clear this conversation's task list
    setTaskMemoryFor(convIdRef.current, emptyTaskMemory()); // ...and its Task Memory brief
    setGoalFor(convIdRef.current, emptyGoal()); // ...and its goal, so no loop survives into a new conversation
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
    useAgentChatStore.getState().truncateMessages(id, 0); // empty the messages, keep the conversation entry
    displayRef.current = [];
    setDisplay([]);
    resetHistoryWindow();
    cancelPendingSwitch();
    atBottomRef.current = true;
    setAtBottom(true);
    setQueued([]);
    setAttachments([]);
    setTodosFor(id, []);
    setTaskMemoryFor(id, emptyTaskMemory()); // clear this conversation's Task Memory brief too
    // The goal goes with the messages it was pursued through: the evaluator judges from the transcript, and a
    // goal left active over an emptied conversation would be judged against nothing.
    setGoalFor(id, emptyGoal());
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
    // Restore the checklist from disk, unless a live in-session copy is already held — same rule as Task
    // Memory below: the ref is the authority while the app has been running, disk is the authority after a
    // reopen. A record written before M6 has no field, and normalizeTodos reads that as an empty list.
    if (!todosByConvRef.current.has(id)) {
      const restored = normalizeTodos(conv.todos);
      if (restored.length > 0) todosByConvRef.current.set(id, restored as Todo[]);
    }
    // Restore this conversation's internal Task Memory brief from disk into the ref, so the mission survives
    // app reopen. Seed only if the ref doesn't already hold a live in-session copy.
    if (conv.taskMemory && !taskMemoryByConvRef.current.has(id)) {
      const tm = normalizeTaskMemory(conv.taskMemory);
      if (!isTaskMemoryEmpty(tm)) taskMemoryByConvRef.current.set(id, tm);
    }
    // Restore an ACTIVE goal from disk. restoreGoal zeroes the run counters on the way through: they describe an
    // activation that is no longer happening, and "18 rounds, 240K tokens" shown against a loop that is not
    // running reads as progress. The goal comes back active but idle — the next send re-arms the loop, so
    // reopening the app never silently resumes spending on something nobody re-authorised. An achieved or
    // cleared goal was never persisted, so there is nothing here that could resurrect one.
    if (conv.goal && !goalByConvRef.current.has(id)) {
      const g = restoreGoal(conv.goal);
      if (isGoalActive(g)) goalByConvRef.current.set(id, g);
    }
    // Swap the todo panel to this conversation's own list (empty unless it has one in flight). Without this the
    // previous conversation's todos stayed on screen, looking as though they belonged to the conversation just opened.
    setTodos(todosFor(id));
    setDisplayedGoal(goalFor(id).condition ? goalFor(id) : null); // ...and the goal bar, for the same reason
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
    const restoredSystem: ApiMsg[] = conv.systemPrompt ? [{ role: "system", content: conv.systemPrompt }] : [];
    convoRef.current = conv.messages.map((m): ApiMsg => {
      // A tool result may carry a mid-loop nudge. It rides its own field, so `content` replays unchanged and the reminder is
      // re-merged at wire-build time — the turn renders exactly as it was sent (see reminders.ts).
      if (m.role === "tool")
        return {
          role: "tool",
          tool_call_id: m.tool_call_id ?? "",
          content: m.content,
          ...(m.reminderText ? { reminderText: m.reminderText } : {}),
        };
      if (m.role === "assistant")
        return {
          role: "assistant",
          content: m.content,
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
          // The rating (thumbs up / down) is restored from the archive into the in-memory wire buffer; stripWireMetadata removes the field before sending.
          ...(m.rating ? { rating: m.rating } : {}),
          // Thinking text is restored too, or reopening mid tool-loop would replay a prompt missing the <think> blocks the model
          // itself produced — the same prefix break this field exists to avoid. applyReasoningPolicy still gates who receives it.
          ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
        };
      // Rebuild the multimodal user turn. The archive splits a user message into `content` (the text the
      // bubble renders) and `images` (the URLs), so replaying `content` alone silently dropped every image
      // the user had sent: the transcript still showed the thumbnail — rebuilt from `images` just below —
      // while the model saw a text-only history and could no longer answer questions about the picture.
      // Reassemble the OpenAI-compatible shape it was sent as: one text part (when there is text) followed
      // by one image_url part per image.
      //   { role:"user", content:[ {type:"text",text}, {type:"image_url",image_url:{url}}, … ] }
      // `wireText` is preferred over `content` when present: it is the version that carried inlined
      // text-file contents and saved attachment paths (see the persist site), which `content` omits so the
      // user's own bubble stays clean.
      // `reminderText` and `reminder` ride along: the first is text the model has already been shown, so losing it would change
      // this turn's bytes on the next send; the second is what the compaction fold reads to reconstruct standing state, so losing
      // it would make the next send re-emit everything (see docs/cache-stable-prompt-context.md).
      const userText = m.wireText ?? m.content;
      const extras = {
        ...(m.reminderText ? { reminderText: m.reminderText } : {}),
        ...(m.reminder ? { reminder: m.reminder } : {}),
      };
      if (m.images?.length) {
        return {
          role: "user",
          content: [
            ...(userText ? [{ type: "text" as const, text: userText }] : []),
            ...m.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
          ...extras,
        };
      }
      return { role: "user", content: userText, ...extras };
    });
    convoRef.current = [...restoredSystem, ...convoRef.current];
    // Rebuild the display: tool result messages are restored as tool bubbles (arguments taken from the corresponding assistant tool_call); an assistant message that only issues
    // tool calls and has no body is skipped in the display layer (its trace is reflected by the tool bubbles).
    const callArgs = new Map<string, { name: string; args: unknown }>();
    for (const m of conv.messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          let a: unknown = {};
          try {
            a = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* Invalid JSON arguments, display as an empty object */
          }
          // Resolved, for the same reason the tool result persists a resolved name: a call_tool entry would otherwise rebuild
          // the bubble with the dispatcher's own {name, arguments} envelope in place of the arguments the tool actually ran on.
          const { name: rn, args: ra } = resolveToolCall(tc.function.name, (a ?? {}) as Record<string, unknown>);
          callArgs.set(tc.id, { name: rn, args: ra });
        }
      }
    }
    const disp: DisplayMsg[] = [];
    conv.messages.forEach((m, mi) => {
      if (m.role === "user") {
        disp.push({ kind: "user", content: m.content, images: m.images, files: m.files });
      } else if (m.role === "tool") {
        const info = m.tool_call_id ? callArgs.get(m.tool_call_id) : undefined;
        disp.push({
          kind: "tool",
          name: m.name ?? info?.name ?? "tool",
          args: info?.args ?? {},
          ok: true,
          result: m.content,
          // Restore a generated image so it survives a conversation switch (persisted display-only, see StoredMessage.image).
          ...(m.image ? { image: m.image, servedBy: m.servedBy } : {}),
          // Same for a sub-agent's inner steps, so the reopened view matches what was shown live.
          ...(m.steps?.length ? { steps: m.steps } : {}),
        });
      } else if (m.role === "assistant") {
        // The deep-thinking block is restored before this round's content / tool trace (consistent with the real-time order).
        if (m.reasoning) disp.push({ kind: "reasoning", content: m.reasoning, ms: m.thinkMs });
        // Final reply with no tool calls: the body is shown as-is. The body of a round that issued tool calls becomes that
        // round's thinking-process text — whole, chain of thought included (thinkingProcessText), matching the real-time
        // display. Daily-mode conversations used to skip it here, because their live view skipped it too; with the modes
        // merged the live view is always phased, so the rebuild is unconditional and old records now render the same way
        // a new one would.
        // storedIndex=mi + rating feed the action-bar rating: clicking persists it to that StoredMessage and highlights the chosen rating.
        if (m.content) {
          if (!m.tool_calls?.length) {
            disp.push({ kind: "assistant", content: m.content, rating: m.rating, storedIndex: mi });
          } else {
            // The body of a tool-call round: rebuilt as a "thinking process" entry (phase), consistent with the real-time
            // display — part of the stream, not a standalone block, and with no action bar (rating belongs to the final reply).
            const summary = thinkingProcessText(m.content);
            if (summary) disp.push({ kind: "phase", content: summary, ms: m.thinkMs });
          }
        }
      }
    });
    displayRef.current = disp;
    setDisplay(disp);
    // A question this conversation asked while the user was looking elsewhere is still waiting on an answer.
    // Re-shown here, after the rebuild, because the rebuild is what would otherwise drop it.
    restorePendingChoices(id);
    // Opening a conversation mounts only its last INITIAL_VISIBLE_TURNS turns; the rest is revealed on scroll-up.
    // Reset per conversation, so a long history expanded earlier does not make the next one open fully mounted.
    resetHistoryWindow();
    atBottomRef.current = true; // Switching conversations: display pinned to the bottom, resume auto-follow
    setAtBottom(true);
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
  /**
   * Explain a FAILED call to a tool the model never saw a schema for.
   *
   * A routed tool is called from a one-line catalog signature (see toolRouter.ts), so a rejected call is the one moment its full
   * parameter list is worth its tokens — the alternative is the model guessing again, and a guess costs a whole round trip at
   * 50-80K prompt tokens. Only on failure, and only for routed tools: a declared tool's schema is already in every request.
   *
   * Reached only on the error path, so the extra listTools() round trip is free in the case that matters. Covers the toolkit's
   * tools only: the routed renderer tools (browser / openBrowser / image_generation) never come through here, and their handlers
   * already answer with a description of what they wanted.
   */
  const explainToolFailure = async (name: string, content: string): Promise<string> => {
    if (!ROUTED_TOOLS.has(name) && !content.startsWith("Unknown tool")) return content;
    try {
      const all = (await listTools("openai")) as Array<{ function?: { name?: string; parameters?: unknown } }>;
      const hit = all.find((t) => t.function?.name === name);
      if (!hit) return `${content}\n\n${unknownToolResult(name, all.flatMap((t) => (t.function?.name ? [t.function.name] : [])))}`;
      return ROUTED_TOOLS.has(name) ? content + routedFailureHint(name, hit.function?.parameters) : content;
    } catch {
      return content; // The hint is an optimisation; never let looking it up turn a tool error into a broken turn.
    }
  };

  // The pre-confirmation change preview: read the old content, compute the new content by the tool's semantics, and generate a diff with line numbers (returns null on failure).
  const buildPreviewDiff = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "edit_file" && name !== "write_file") return null;
    const p = String(args.path ?? "");
    if (!p) return null;
    try {
      const r = await callTool("read_file", { path: p });
      const before = r.ok ? r.content : "";
      let after = before;
      if (name === "write_file") {
        after = String(args.content ?? "");
      } else {
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr || !before.includes(oldStr)) return null;
        if (args.replace_all) {
          after = before.split(oldStr).join(newStr);
        } else {
          const idx = before.indexOf(oldStr); // Replace the first literal occurrence, to avoid $ being treated as regex
          after = before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
        }
      }
      return makeUnifiedDiff(before, after);
    } catch {
      return null;
    }
  };

  // Execute a single tool call (including sensitive-operation confirmation), push a display bubble, and return the result text fed back to the model.
  // displayName is only for display (subagent calls carry an "agentId→" prefix).
  /**
   * Ask the user to approve a tool call — the host half of the §13 boundary's `requestConsent` (M2b).
   *
   * A thin adapter onto `useConsentQueue`, and thin on purpose: the queueing, the per-conversation ordering
   * and the "don't ask again" set are all behaviour worth keeping exactly as it is. What this adds is the
   * contract's argument shape, so that the caller does not have to know the queue's six-parameter signature.
   */
  const hostConsent = (convId: string | null, req: ConsentRequest): Promise<ConsentDecision> =>
    requestConsent(
      convId,
      req.name,
      req.args,
      req.previewDiff ?? null,
      req.warning ?? null,
      (req.requester ?? null) as ConsentRequester | null,
    );

  const execToolCall = async (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    // Usage-log attribution: "main" for the primary agent, "sub:<id>" when a sub-agent is acting.
    // Every tool call funnels through here, so this is the one place a delegation's actions are recorded.
    actor = "main",
    // Set when a brokered anonymous sub-agent is the caller. Two effects, both deliberate: the consent
    // panel names the agent and its task, and the "don't ask again" shortcut is bypassed (see below).
    requester: ConsentRequester | null = null,
    // Lets a caller learn whether the call succeeded. execToolCall folds failures into the returned text
    // for the model's benefit, which loses the distinction everywhere else — the orchestration audit log
    // needs it back.
    onResult?: (ok: boolean) => void,
  ): Promise<string> => {
    ctx.status(toolStatusText(name, args));
    // Same as send(): execToolCall only ever runs from inside the tool loop, long after the commit.
    // eslint-disable-next-line react-hooks/purity
    const startedAt = Date.now();
    const log = (ok: boolean, result: string, blocked?: boolean) =>
      logToolCall({
        actor,
        name,
        args,
        ok,
        blocked,
        result,
        // What this step costs the conversation: a tool call spends no tokens itself, but its result
        // is carried into every later request, which is the number worth seeing per step. Estimated
        // with the same tokenizer the context bar falls back to, and only when logging is on -- a
        // tool result can be thousands of characters and tokenizing it otherwise is pure waste.
        resultTokens: isUsageLogEnabledSync() ? countTokens(result) : undefined,
        ms: Date.now() - startedAt,
        convId: ctx.convId,
        turnId: ctx.turnId,
      });
    // Consent policy lives in toolNeedsConsent (constants.ts) so the rules can grow in one place. Currently every sensitive
    // tool is confirmed. The "always" allowance still short-circuits repeat prompts.
    // A sub-agent's call always asks, even for a tool the user allowed with "don't ask again": that answer
    // was given about work the user had themselves requested and was watching. An autonomous delegation
    // deciding to write a file is a different question, and inheriting the earlier yes would silently make
    // sub-agents more powerful than the agent the user is actually looking at.
    if (toolNeedsConsent(name) && (requester !== null || !allowedToolsRef.current.has(name))) {
      const previewDiff = await buildPreviewDiff(name, args);
      // §A1: warn when this mutation targets a file the model only "knows" from compressed history — its
      // latest read/write was folded into the summary and never re-verified at the tail. Pure lookup, no cost.
      const targetPath =
        typeof args.path === "string" ? args.path : typeof args.destination === "string" ? args.destination : "";
      const warning =
        targetPath && pathProvenance(convoRef.current, compactionRef.current, targetPath) === "digest-only"
          ? t("chat.provenanceWarning")
          : null;
      // Routed through the §13 contract shape rather than the raw six-argument call (M2b). `hostConsent` is
      // the same function the boundary hands the Runtime, so consent has one implementation whether it is
      // asked for from here or from a Runtime that no longer lives in this component.
      const decision = await hostConsent(ctx.convId, { name, args, previewDiff, warning, requester });
      if (decision === "always") allowedToolsRef.current.add(name);
      if (decision === "no") {
        const denied = "The user rejected this operation.";
        ctx.push({ kind: "tool", name: displayName, args, ok: false, result: denied });
        // A refused call is logged too: "what did the agent try to do" is exactly the question the log
        // exists to answer, and a silent gap there reads as if it never asked.
        log(false, denied, true);
        onResult?.(false);
        return denied;
      }
    }
    // This run's signal goes with the call, so Stop reaches the work itself. Without it the loop only
    // noticed the abort at its next checkpoint — which for run_command is after the command exits or hits
    // its timeout, so stopping a one-minute build appeared to do nothing at all for a minute.
    const result = await callTool(name, args, ctx.signal);
    ctx.push({ kind: "tool", name: displayName, args, ok: result.ok, result: result.content });
    log(result.ok, result.content);
    onResult?.(result.ok);
    // The schema hint is model-facing only: the bubble above and the log entry keep the tool's own error, because a parameter
    // dump is what the model needs to retry and noise to everyone reading the timeline.
    return result.ok ? result.content : await explainToolFailure(name, result.content);
  };

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

  /**
   * Ask the user a question and wait — the host half of the §13 boundary's `askUser` (M2b).
   *
   * This is where the loop used to reach into component state and park a promise in a ref. It still parks a
   * promise in a ref; what changed is WHO does it. The tool now calls a function it was handed, so the tool
   * itself no longer needs to be inside a React component — which is the property M5 depends on.
   *
   * Resolves with the text to feed back to the model, already formatted by `submitChoice`: how an answer
   * reads depends on whether it was multi-select or flagged for discussion, and that is the host's knowledge.
   */
  /**
   * Push the set of conversations with an unanswered question into the store, so the sidebar can badge them.
   *
   * The counterpart to the consent queue's own badge sync, and it exists for the same reason: a question
   * asked by a conversation the user is not looking at has to be discoverable from outside it. Called
   * wherever the pending set changes — asked, answered, dropped.
   */
  const syncQuestionBadges = () => {
    const ids = new Set<string>();
    for (const e of choiceResolversRef.current.values()) if (e.convId) ids.add(e.convId);
    useAgentChatStore.getState().setPendingQuestionIds(ids);
  };

  const hostAskUser = (convId: string, questions: ChoiceQuestion[]): Promise<string> => {
    const id = ++choiceIdRef.current;
    // Trigger condition 4: question notification — the AI needs user input to continue (only pops when the
    // app is unfocused). This is also what makes a question asked by a BACKGROUND conversation discoverable,
    // now that its card no longer appears in whichever conversation happens to be on screen.
    notifyQuestion(convId, questions[0].question);
    // Keyed by card id, so concurrent questions do not overwrite each other and are answered independently.
    // Registered before the card is shown, so a submit can never arrive ahead of its resolver.
    return new Promise<string>((resolve) => {
      choiceResolversRef.current.set(id, { convId, questions, resolve });
      // Shown only in the conversation that asked.
      //
      // This used to be pushed unconditionally, with the reasoning that an interactive prompt must stay
      // answerable or a background conversation would wait forever. The cost was worse than the problem: a
      // question from conversation B appeared inside conversation A, where it reads as part of A's
      // transcript and answers a question the user cannot see the context for. The waiting case is solved
      // properly instead — `restorePendingChoices` re-shows the card when the user opens B, because a choice
      // card is display-only and would otherwise be lost the moment the display is rebuilt.
      if (convId === convIdRef.current) {
        pushDisplay({ kind: "choice", id, questions, answers: questions.map(() => null), submitted: false });
      }
      syncQuestionBadges();
    });
  };

  /**
   * Re-show the unanswered questions of the conversation being opened.
   *
   * Choice cards live only in the display, which a conversation switch rebuilds from the store — so without
   * this a card asked while the user was elsewhere would vanish, and the tool call parked on its promise
   * would never be answerable. Ordered by card id, which is the order they were asked in.
   */
  const restorePendingChoices = (convId: string) => {
    const pending = [...choiceResolversRef.current.entries()]
      .filter(([, e]) => e.convId === convId)
      .sort(([a], [b]) => a - b);
    for (const [id, entry] of pending) {
      pushDisplay({
        kind: "choice",
        id,
        questions: entry.questions,
        answers: entry.questions.map(() => null),
        submitted: false,
      });
    }
  };

  /**
   * The user submits a card: mark it answered, and wake the waiting tool call with every answer at once.
   *
   * useCallback keeps the reference stable, to avoid invalidating the memoized MessageItem on every render.
   */
  const submitChoice = useCallback((id: number, answers: ChoiceAnswer[]) => {
    const entry = choiceResolversRef.current.get(id);
    if (!entry) return; // Already handled / no such card, ignore
    choiceResolversRef.current.delete(id);
    // Inlined rather than calling syncQuestionBadges: this callback has an empty dependency list, so it
    // would capture the first render's copy. The two statements below read only a ref and the store, so
    // there is nothing render-scoped to go stale.
    useAgentChatStore.getState().setPendingQuestionIds(
      new Set([...choiceResolversRef.current.values()].flatMap((e) => (e.convId ? [e.convId] : []))),
    );
    let questions: ChoiceQuestion[] = [];
    setDisplay((d) =>
      d.map((m) => {
        if (m.kind !== "choice" || m.id !== id) return m;
        questions = m.questions;
        return { ...m, answers, submitted: true };
      }),
    );
    // One line per question, so a multi-question card comes back as one legible block rather than something
    // the model has to re-associate with what it asked. Single-question cards keep the original wording, to
    // avoid changing what every existing prompt has been tuned against.
    // A multi-select answer is spelled out as a quoted list rather than the joined string, so that picking
    // two options cannot be read back as one option that happened to contain a comma.
    const answerText = (a: ChoiceAnswer) => (a.values ? a.values.map((v) => `"${v}"`).join(", ") : a.value);
    const lines = answers.map((a, i) => {
      const q = questions[i]?.question ?? "";
      return a.discuss
        ? `- ${q} → the user wants to discuss this rather than settle it`
        : `- ${q} → ${answerText(a)}`;
    });
    const anyDiscuss = answers.some((a) => a.discuss);
    const discussNote = anyDiscuss
      ? "\nFor the question(s) marked for discussion, do not draw a conclusion directly; ask the user about it or offer deeper analysis first, and continue only after discussing it with them."
      : "";
    entry.resolve(
      answers.length === 1 && !anyDiscuss
        ? answers[0].values
          ? `The user selected: ${answerText(answers[0])}`
          : `The user chose: ${answers[0].value}`
        : `The user answered:\n${lines.join("\n")}${discussNote}`,
    );
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
    const q = queueRef.current.get(convId);
    if (!q || q.length === 0) return;
    const next = q.shift();
    syncQueued(convId);
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
  const formatGoalElapsed = (startedAt: number): string => {
    if (!startedAt) return "—";
    // eslint-disable-next-line react-hooks/purity -- called from the send loop, never from render
    const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(total / 3600);
    return h > 0
      ? `${h}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
      : `${Math.floor(total / 60)}:${pad(total % 60)}`;
  };

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
        setDisplayedGoal(isGoalEmpty(g) ? null : g);
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
    // eslint-disable-next-line react-hooks/purity -- an event handler; see the note on the first Date.now() in send()
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
    atBottomRef.current = true; // After sending, return to the bottom to follow this round's output
    setAtBottom(true);
    atts.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)); // Release the local previews
    setAttachments([]);
    setLoading(true);
    // This round's AbortController; when sending, the conversation must be the current active one, and it is registered into runsRef at the genConvId point (once the conversation id is determined).
    const ctrl = new AbortController();
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }; // Reset this round's usage
    // send() is an async event handler, never render code: it is reached from the composer, the queue and the
    // job-finished subscription, and every clock read below happens after at least one await. The lint rule
    // cannot see that (a plain function declared in a component body is assumed to run during render), so the
    // timestamps are disabled one by one rather than by silencing the rule for the file.
    // eslint-disable-next-line react-hooks/purity
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
    // Binary/oversized attachments: under Electron, persist them to the working directory first (workdir is already mounted into the sandbox),
    // so the model can process them directly with file tools / sandbox commands; the browser environment keeps to file names only.
    const savedPaths = toolsReady ? await saveAttachments(atts) : new Map<number, string>();
    // Assemble this round's content: images go multimodal via image_url, everything else is composed into the
    // body (inlined text, or a note pointing at the path it was saved to). With images, use a content array;
    // otherwise a plain string (compatible with non-vision models).
    const images = await buildImageParts(atts, isLocalModel);
    if (!images.ok) {
      setError(t("chat.uploadFail", { name: images.name, err: images.err }));
      setLoading(false);
      return;
    }
    const imageParts = images.parts;
    const composed = composeWireText(text, atts, savedPaths, sandboxStatusRef.current);
    const userContent: string | ContentPart[] =
      imageParts.length > 0
        ? [...(composed ? [{ type: "text" as const, text: composed }] : []), ...imageParts]
        : composed;
    convoRef.current = [...convoRef.current, { role: "user", content: userContent }];
    // Index of the turn just added, in the buffer and (below) on disk. A change event is written into THIS turn after compaction
    // has run, so both positions have to be known exactly — locating it later by scanning could hit an older turn.
    const userWireIdx = convoRef.current.length - 1;
    // The round's own buffer, captured HERE, before any await. Everything below runs after `await listTools` and
    // `await maybeCompact` (which can spend seconds in the summariser), and the user can switch conversations in that window —
    // after which convoRef belongs to a different conversation entirely. Re-reading it later would splice this round's turns into
    // someone else's history. syncView() is the only thing that mirrors back, and it already checks active().
    let roundConvo = convoRef.current;
    // Conversational memory: the user may have just stated a durable project rule ("we use npm
    // here, not pnpm"). Nothing in the repository records that, and the model does not reliably
    // volunteer remember_project, so the main process gates and extracts it. Fire-and-forget: a
    // cheap keyword gate rejects almost everything before any token is spent, and nothing here can
    // delay or fail the send.
    if (composed.trim()) void callTool("note_conversation", { text: composed });
    const userFiles = atts
      .filter((a) => a.kind !== "image")
      .map((a) => ({ name: a.name, size: a.size, embedded: a.kind === "text" }));
    // The display bubble and the send share the same source: cloud = OSS URL; local = data URI (the preview blob is revoked at send time, and it must remain visible across restarts).
    const userImages = imageParts.map((p) => p.image_url.url);
    pushDisplay({ kind: "user", content: text, images: userImages, files: userFiles });

    // Persistence: the conversation record is created as soon as the user starts chatting, then appended to one by one.
    const store = useAgentChatStore.getState();
    // The conversation id this round of generation belongs to (captured as a stable local value, unaffected by switching conversations): drives the spinner on that conversation's sidebar row,
    // and lays the groundwork for later "background concurrent generation" — always record / clear by genConvId, rather than relying on the current active conversation.
    let convId = convIdRef.current;
    if (!convId) {
      // Projects are grouped by folder: an explicitly chosen folder → that folder's project, otherwise the default project.
      convId = store.createConversation({
        workdir: effectiveWorkdir || undefined,
        projectWorkdir: workdirChosen ? effectiveWorkdir : undefined,
        // Stamp the environment this session is starting in — the value the page already resolved (inherited from the
        // project's last session, or the app default). Recorded even when the user never touched the toggle, because it is
        // what the NEXT session in this project inherits.
        secureEnv: secureEnvRef.current,
      });
      setConvId(convId);
      // Firmly bind the new conversation to the currently selected model (conversation-level binding).
      if (selectedModelId) {
        store.setConversationModel(convId, selectedModelId);
      }
      // Freeze messages[0] on the brand-new record (it was composed above, before this record existed).
      // A goal set with /goal before this record existed (see pendingGoalRef) is attached here, so the loop it
      // starts belongs to the conversation from its very first turn.
      if (pendingGoalRef.current) {
        setGoalFor(convId, pendingGoalRef.current);
        pendingGoalRef.current = null;
      }
      if (pendingSystemPromptRef.current) {
        store.setConversationSystemPrompt(convId, pendingSystemPromptRef.current);
        pendingSystemPromptRef.current = "";
      }
    }
    // Bound to a const so the closures below (active(), the RunCtx, the log calls) capture a settled string
    // rather than the still-reassignable `convId` above.
    const genConvId = convId;
    // Index what the user just handed over, at the point it lands on disk. Placed here rather than beside the
    // save because the conversation id is what makes an entry findable later, and it is only settled now.
    // Only what was actually saved: a save can fail, and an entry pointing at nothing would be a library row
    // the user can click and get an error from.
    for (const a of atts) {
      const savedPath = savedPaths.get(a.id);
      if (!savedPath) continue;
      void registerMedia({
        // The renderable source. A local path is not one — an <img src="C:\…"> shows nothing — so an asset
        // in the library is addressed through the app's own scheme, and only an actual URL is used as-is.
        src: a.url || mediaSrcFor(savedPath, true),
        // The browser's own verdict, when there is one. `image/*` was a placeholder that could not be
        // categorised, so an uploaded PNG landed under "other" and a document under nothing at all.
        mime: a.file?.type || (a.kind === "image" ? "image/png" : "application/octet-stream"),
        path: savedPath,
        bytes: a.size,
        origin: "upload",
        convId: genConvId,
        // The name on DISK, which is not the name it arrived with: storing a file replaces spaces and
        // reserved punctuation with underscores. Recording the original here made the index disagree with
        // its own `path`, so the library showed a title no file on disk answered to.
        filename: savedPath.split(/[\\/]/).pop() || a.name,
      });
    }
    store.appendMessage(genConvId, {
      role: "user",
      content: text,
      // `text` is what the bubble shows; `composed` is what the model was actually sent (it also carries
      // inlined text-file contents and saved attachment paths). Store the difference so replaying this
      // conversation reproduces the message the model saw, not just the one the user typed.
      ...(composed !== text ? { wireText: composed } : {}),
      images: userImages.length ? userImages : undefined,
      files: userFiles.length ? userFiles : undefined,
      // eslint-disable-next-line react-hooks/purity -- see the note on the first Date.now() in send()
      ts: Date.now(),
    });
    const userStoredIdx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;

    store.setConversationGenerating(genConvId, true);
    runsRef.current.set(genConvId, ctrl); // Register this conversation's run, for cancel (active conversation) / background concurrency
    // "Whether in the active view": apply view side effects only while active; a background conversation persists silently.
    const active = () => convIdRef.current === genConvId;
    // One id per generation, shared by everything this turn spends (see RunCtx.turnId).
    // eslint-disable-next-line react-hooks/purity -- see the note on the first Date.now() in send()
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
      subagentSinksRef,
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
      // What this turn owes: a review for a risky change, a note to project memory for a source edit. Both
      // fire at most once per turn — a reminder the model reads and declines must not be re-injected, or the
      // turn cannot end. See toolRuntime.ts, which is where the rules and the latches now live (M5b).
      let obligations = noObligations();
      // Wrap-up guard: whether a tool was executed this round (including subagents). If a tool was executed yet the model ends with empty content (no user-facing
      // final answer, common when the main model "assumes it's done" and stays silent after a subagent returns a result, or writes the conclusion into reasoning),
      // inject one FINALIZE_NUDGE to nudge it to answer formally. finalizeNudged ensures at most once per round, to avoid an infinite loop.
      let didToolCall = false;
      let finalizeNudged = false;
      // Wrap-up guard: whether the model has already been told once that it is ending the turn with
      // delegations still running. See PENDING_DELEGATION_NUDGE.
      let delegationNudged = false;
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

      // Carrier for the mid-loop nudges: the last tool result, in the buffer and on disk. Those nudges fire AFTER the assistant
      // turn has been appended and persisted, so there is no new turn to ride and no reliable way to find the carrier by scanning
      // (the compaction plan may already have rewritten the wire view). Tracked at each append instead. See reminders.ts.
      let lastToolIdx = -1;
      let lastToolStoredIdx = -1;
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
      let convo = roundConvo;
      const compaction = roundCompaction;
      const syncView = () => { if (active()) convoRef.current = convo; };
      /**
       * Write a one-shot nudge into the last tool result, and persist it there.
       *
       * The two file-change guards call this at tool-completion time, so the result is mutated BEFORE it is first sent and the
       * model reads the nudge in time to act on it. FINALIZE_NUDGE is the exception: it can only be detected after the model has
       * replied with an empty body, so it does rewrite an already-sent result — free in practice, because sanitizeToolCallPairs
       * drops that empty assistant turn, leaving this tool result as the tail. Appended rather than prepended for the same reason:
       * divergence at the end of a result that can run to thousands of characters costs far less than at its front.
       *
       * Returns false when there is no tool turn to carry it (nothing was called this round), so the caller can fall through.
       */
      const nudgeIntoLastTool = (text: string): boolean => {
        const target = lastToolIdx >= 0 ? convo[lastToolIdx] : undefined;
        if (target?.role !== "tool") return false;
        // The per-round flag at each call site already prevents a repeat within the round; this stops a double-write if the same
        // carrier is reached twice, without making the nudge once-per-conversation.
        if (target.reminderText?.includes(text)) return true;
        // Its own field, never the tool result's content: stubbing a stale read replaces that content wholesale, and a nudge the
        // model has already been shown must not disappear with it.
        const reminderText = addBlock(target.reminderText, wrapReminder(text));
        convo = convo.map((m, i) => (i === lastToolIdx ? { ...target, reminderText } : m));
        syncView();
        if (genConvId && lastToolStoredIdx >= 0) {
          useAgentChatStore.getState().setMessageReminder(genConvId, lastToolStoredIdx, reminderText);
        }
        return true;
      };
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
      let lastWire: ApiMsg[] = [];
      let lastContent = "";

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
        runRound: async ({ reasoning: roundReasoning }) => {
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
          const wire = prepareWire(convo, compaction, {
            model: {
              isLocal: isLocalModel,
              acceptsImages: !!activeModel?.multimodal,
              sendReasoningContext: sendReasoningContext(),
              modelId: activeModel?.model,
            },
            steps: WIRE_STEPS,
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
          renderDelta = (content, reasoning) =>
            renderTurn(reasoning, showPhaseSummary ? phaseSummaryText(content) : content);
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
          lastWire = wire;
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
          convo = [
            ...convo,
            msg.tool_calls?.length
              ? { role: "assistant", content: msg.content, tool_calls: msg.tool_calls, ...(reasoningText ? { reasoning_content: reasoningText } : {}) }
              : { role: "assistant", content: msg.content, ...(reasoningText ? { reasoning_content: reasoningText } : {}) },
          ];
          syncView();

          // Persist the assistant message (including the tool calls it issued) to this conversation (genConvId), so that after reopening / switching back the model still knows what it did.
          // A plain-text final reply is also persisted here (the wrap-up below does not archive it again).
          if (msg.content || msg.tool_calls?.length || reasoningText) {
            store.appendMessage(genConvId, {
              role: "assistant",
              content: msg.content ?? "",
              ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
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
            const callOf = (tc: ToolCall) => resolved.get(tc) ?? { name: tc.function.name, args: {} };

            // ask_user: pop a choice card and wait for the user to click.
            // update_todos: update the task list above the input box.
            // load_skill: feed back the full instructions of an enabled skill as the tool result (progressive disclosure).
            // run_subagent: delegate to a subagent and feed back its final conclusion as the tool result.
            // Other tools: executed through the unified path (including sensitive-operation confirmation).
            const runToolCall = async (tc: ToolCall) => {
              const { name, args } = callOf(tc);
              const startedAt = Date.now();
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
                obligations = recordTool(obligations, { name, args }, TOOL_RULES);
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
                convo = [...convo, { role: "tool", tool_call_id: tc.id, content: cappedContent }];
                lastToolIdx = convo.length - 1;
                syncView();
                // A generated image's artifact URL is stored display-only (not in content, so it never re-enters the wire),
                // so the image bubble can be rebuilt after switching conversations. Consume the side-channel ref.
                const artifact =
                  name === "image_generation" || name === "video_generation"
                    ? lastArtifactRef.current
                    : null;
                lastArtifactRef.current = null;
                // Likewise for a sub-agent's inner steps: display-only, stored beside the conclusion so reopening
                // the conversation shows the same operations the user watched happen. Addressed by the tool
                // call's own args object, because a spawned delegation settles after this point and has to be
                // able to find its message again (see the storedIndex hand-off below).
                const sink = subagentSinksRef.current.get(args as object) ?? null;
                const subSteps = sink ? sink.steps : null;
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
                  // Copied, not the live array: a spawned delegation keeps appending to it after this write.
                  ...(subSteps?.length ? { steps: [...subSteps] } : {}),
                });
                lastToolStoredIdx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;
                // Tell the sink where its message landed. Until this point a still-running delegation has
                // nowhere to write its trace; from here every step it takes is patched straight onto that
                // message, so the reopened conversation matches what the user watched.
                if (sink) {
                  sink.storedIndex = lastToolStoredIdx;
                  if (sink.steps.length > 0) store.setMessageSteps(genConvId, lastToolStoredIdx, [...sink.steps]);
                }

                // Detect local service addresses in the tool output (e.g. an http://localhost:5173 printed by a dev server),
                // using the full output (the elided middle section may also contain a URL). Once registered, the bottom-left floating indicator displays it and polls its health.
                if (typeof content === "string") detectServices(content);

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
            const answeredIds = convo.flatMap((mm) =>
              mm.role === "tool" && mm.tool_call_id ? [{ toolCallId: mm.tool_call_id }] : [],
            );
            for (const tc of unansweredCalls(msg.tool_calls, answeredIds)) {
              const placeholder = ctrl.signal.aborted ? t("chat.canceled") : t("chat.skipped");
              convo = [...convo, { role: "tool", tool_call_id: tc.id, content: placeholder }];
              lastToolIdx = convo.length - 1;
              syncView();
              store.appendMessage(genConvId, {
                role: "tool",
                content: placeholder,
                tool_call_id: tc.id,
                name: callOf(tc).name,
                ts: Date.now(),
              });
              lastToolStoredIdx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;
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
          lastContent = msg.content ?? "";
          return { content: lastContent, reasoning: reasoningText, toolResults: [], toolCallCount: 0 };
        },
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
        const wrapWire = prepareWire(convo, compaction, {
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
        lastWire = wrapWire;
        lastContent = wrapMsg?.content ?? "";
        if (lastContent && active()) pushDisplay({ kind: "assistant", content: lastContent });
        if (lastContent) {
          store.appendMessage(genConvId, {
            role: "assistant",
            content: lastContent,
            // eslint-disable-next-line react-hooks/purity -- see the note on the first Date.now() in send()
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
        {
          const before = goalFor(genConvId);
          // Deferred while a `notify` job this conversation started has not reported yet. The turn ended
          // because the model was told to end it and wait — there is nothing new for the evaluator to read,
          // so a check now can only say "not met", and continuing would race a build that was always going to
          // take minutes. The job's arrival opens its own turn, and that one is evaluated.
          const awaitingJobs = (awaitingJobsRef.current.get(genConvId) ?? 0) > 0;
          if (isGoalActive(before) && !ctrl.signal.aborted && !awaitingJobs) {
            ctx.status(t("chat.goalChecking"));
            // The turn's own spend is attributed to the goal before the evaluator's is added, so the figure in
            // the bar is what this goal has cost in total, not what the evaluator alone cost.
            const u = turnUsageRef.current;
            const turnTokens = u.total || u.prompt + u.completion;
            // `wire` is what the model was actually sent this round; the reply it produced arrived afterwards,
            // so it is appended here — without it the evaluator would judge a transcript missing its conclusion.
            const judged: ApiMsg[] = [...lastWire, { role: "assistant", content: lastContent }];
            const outcome = await evaluateGoal(
              {
                condition: before.condition,
                criteria: before.criteria.map((c) => c.text),
                // Sub-agent conclusions, which may pre-date compaction and so be absent from the transcript
                // while still being the reason a criterion holds.
                established: before.evidence.map((e) => `${e.source}: ${e.summary}`),
                messages: judged,
              },
              ctrl.signal,
              { actor: "goal", convId: genConvId, turnId },
            );
            const met = outcome.ok && outcome.verdict.met;
            // A failed evaluation is NOT a verdict. It is recorded and flagged in the UI, but it neither
            // completes the goal nor drives another round: with an evaluator that is down, continuing would
            // work blind for every round the cap allows.
            const reason = outcome.ok ? outcome.verdict.reason : outcome.error;
            const scored = addTurnSpend(before, turnTokens);
            const evaluated = recordEvaluation(scored, { reason, tokens: outcome.tokens, failed: !outcome.ok });
            if (met) {
              const done = achieveGoal(evaluated, reason);
              setGoalFor(genConvId, done);
              // The achievement record the doc asks for: condition, duration, rounds and spend. Display-only
              // and deliberately not persisted — an achieved goal is session state, so nothing here can bring a
              // finished run back after a reload.
              if (active()) {
                toast.success(
                  t("goal.achieved", {
                    rounds: String(done.run.turnCount),
                    elapsed: formatGoalElapsed(done.run.startedAt),
                    tokens: String(done.run.tokenSpend),
                  }),
                );
              }
              // Then clear it. `achieved` deactivates the loop, but GoalBar renders anything that is not
              // `cleared`, and nothing ever left `achieved` — so the finished goal sat above the composer for
              // the rest of the session and only `/goal clear` removed it. The bar was meant to show "the run
              // that just finished", which is a transient idea that had no transition behind it.
              //
              // Delayed rather than immediate so that record is actually readable; the impossible/exhausted
              // paths clear at once because they queue an explaining round that must not be re-evaluated,
              // whereas nothing follows a success.
              scheduleGoalClear(genConvId, done);
            } else {
              setGoalFor(genConvId, evaluated);
              const maxRounds = Number(getStorage(AGENT_MAX_GOAL_ROUNDS_KEY)) || MAX_GOAL_AUTO_ROUNDS;
              const decision = decideNextRound(evaluated, {
                met: false,
                reason,
                maxRounds,
                impossible: outcome.ok && outcome.verdict.impossible === true,
                failed: !outcome.ok,
              });
              if (decision.action === "impossible" || decision.action === "exhausted") {
                // Neither is an achievement, and neither may read as one. The goal is cleared FIRST so the
                // final explaining round cannot itself be evaluated and re-trigger the same ending, then the
                // instruction is queued. Re-issuing `/goal` is how the user asks for more.
                setGoalFor(genConvId, clearGoal(evaluated));
                if (active()) {
                  toast.error(
                    decision.action === "impossible"
                      ? t("goal.impossible", { reason })
                      : t("goal.stoppedAtLimit", { rounds: String(evaluated.run.turnCount) }),
                  );
                }
                // One-shot permission for the report round, which the cleared goal would otherwise gate out.
                goalExhaustedRef.current = genConvId;
                goalContinuation = decision.prompt;
              } else if (decision.action === "continue") {
                goalContinuation = decision.prompt;
              } else if (!outcome.ok && active()) {
                // action "stop" with no verdict: say so, or the turn just ends and the goal appears ignored.
                toast.warning(t("goal.checkFailed", { reason }));
              }
            }
          }
        }

        // Normal reply → end (the body was already finalized and displayed by renderTurn above, and archiving was done when the message was produced, so it is not repeated here).
        // A background conversation does not write the current view; when switched back to, its display is rebuilt from the store by loadConversation.
        // End of conversation: archive this conversation's task list into the chat record, and collapse the floating panel
        // above the input box. Keyed by genConvId, so a background conversation retires its own list rather than the
        // viewed conversation's; the archived bubble is only pushed when that conversation is the one on screen.
        // A goal round that is about to continue keeps its checklist: the plan is still in force, and retiring it
        // here would clear the panel on every round of the loop only to have the next one rebuild it.
        const finishedTodos = goalContinuation ? [] : todosFor(genConvId);
        if (finishedTodos.length > 0) {
          if (active()) pushDisplay({ kind: "todos", todos: finishedTodos });
          setTodosFor(genConvId, []);
        }
        // Trigger condition 1: the AI reply is complete. The channel follows where the user's attention is:
        //  - Finished in the background (a different conversation is on screen) → toast + sidebar dot, plus the
        //    system notification, which self-gates to the window being unfocused;
        //  - On screen, window always on top (certainly visible) → in-app hint (toast);
        //  - On screen, not on top (may be obscured by other windows) → system notification (following the existing preference / unfocused gating, clicking jumps to that conversation).
        // Use the captured genConvId rather than the active conversation id, to ensure correct ownership (reserved for background concurrent generation).
        //
        // Skipped entirely mid-goal-loop: the round is finished but the TASK is not, and telling the user their
        // reply is ready — once per round, up to the round limit — would be both wrong and unbearable. The goal
        // announces itself once, when it is met or when the loop gives up.
        if (goalContinuation) {
          // nothing to announce yet; the loop continues below
        } else if (!active()) {
          // The conversation that finished is not the one on screen. Its sidebar spinner simply stopping is not an
          // announcement, and the system notification is gated on the window being unfocused — so with the app in
          // front of the user, reading another chat, nothing at all used to happen. Two signals, because they
          // answer different questions: a toast naming the chat (with a button that jumps to it) says "it is done
          // now", and an unread dot on its sidebar row survives until the chat is opened, so it still says so for
          // a user who was away from the keyboard. notifyReplyComplete still runs and self-gates: it pops only if
          // the window is unfocused, which is exactly the case the toast cannot cover.
          store.markConversationUnread(genConvId);
          const title = store.getConversation(genConvId)?.title?.trim();
          toast.success(title ? t("chat.replyDoneNamed", { title }) : t("chat.replyDone"), {
            action: {
              label: t("chat.replyDoneOpen"),
              onClick: () => router.push(`/agent/chat?c=${encodeURIComponent(genConvId)}`),
            },
          });
          notifyReplyComplete(genConvId, lastContent);
        } else if (await isWindowAlwaysOnTop()) {
          const title = store.getConversation(genConvId)?.title?.trim();
          toast.success(title ? t("chat.replyDoneNamed", { title }) : t("chat.replyDone"));
        } else {
          notifyReplyComplete(genConvId, lastContent);
        }
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
      const queueBusy = (queueRef.current.get(genConvId)?.length ?? 0) > 0;
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
    jobFinishedRef.current = (evt) => {
      if (!isJobCompletion(evt)) return;
      const convId = convIdRef.current;
      if (!convId) return;
      const notice = describeJobEvent(evt);
      // Two routes, and picking the wrong one is what left a finished build stranded in a visible queue while
      // the turn that was waiting for it worked on blind.
      //
      // MID-TURN → the pending buffer, which the tool loop drains onto the very next tool result. The user
      // queue cannot serve here: by construction it is not read until the turn ENDS, so a job that finishes
      // during a turn is exactly the case it can never deliver. The model was told it may keep working after
      // starting a `notify` job, so this is the normal case, not the edge one.
      //
      // IDLE → straight into a new turn, which is what wakes the conversation back up.
      // One fewer job outstanding, whichever route delivers it. Floored at zero: an event for a job started
      // before this counter existed (or in another conversation) must not push it negative and wedge the
      // goal loop into deferring for ever.
      const waiting = awaitingJobsRef.current.get(convId) ?? 0;
      if (waiting > 0) awaitingJobsRef.current.set(convId, waiting - 1);
      if (useAgentChatStore.getState().generating[convId]) {
        const held = pendingJobsRef.current.get(convId) ?? [];
        pendingJobsRef.current.set(convId, [...held, notice]);
      } else {
        void send({ text: formatJobMessage(notice), attachments: [], _fromQueue: true });
      }
    };

    /**
     * A generation job finished (generation/jobs.ts).
     *
     * Deliberately the same two routes `jobFinishedRef` uses for a background command, and for the same
     * reason: mid-turn the result rides the next tool result, because the user-message queue by construction
     * is not read until the turn ENDS — which is precisely the case a job finishing during a turn can never
     * be delivered by. Idle, it opens its own turn, which is what wakes the conversation back up.
     *
     * The difference from a command is that this job produces an ARTIFACT, so the clip is rendered and
     * persisted here before the model is told about it. Rendering it only when the model next speaks would
     * leave the user watching nothing while the thing they asked for sat in a variable.
     */
    generationJobFinishedRef.current = (evt) => {
      const convId = evt.job.convId;
      const waiting = awaitingJobsRef.current.get(convId) ?? 0;
      if (waiting > 0) awaitingJobsRef.current.set(convId, waiting - 1);

      if (evt.status === "succeeded") {
        const isVideo = evt.job.capability === "video_generation";
        const bubble: DisplayMsg = {
          kind: "tool",
          name: evt.job.capability,
          args: { prompt: evt.job.prompt },
          ok: true,
          result: evt.artifact.src,
          ...(isVideo ? { video: evt.artifact.src } : { image: evt.artifact.src }),
          servedBy: evt.artifact.servedBy,
        };
        // Only the conversation on screen draws it; a background one is rebuilt from the store on switch,
        // which is why the persist below is not conditional.
        if (convId === convIdRef.current) pushDisplay(bubble);
        // NOT indexed here. The job runner stores and indexes the artifact before emitting this event, so by
        // the time any listener runs the library file is already current — doing it here raced the library's
        // own re-read and made a finished video vanish from it until the page was reloaded.
        useAgentChatStore.getState().appendMessage(convId, {
          role: "tool",
          content: evt.artifact.src,
          // No tool_call_id: this message answers no call. The turn that started the job has long since
          // closed its own tool_calls, and inventing an id here would pair this with a call that already has
          // a result — which the provider rejects on the conversation's next request.
          name: evt.job.capability,
          ...(isVideo ? { video: evt.artifact.src } : { image: evt.artifact.src }),
          servedBy: evt.artifact.servedBy,
          ts: Date.now(),
        });
      }

      const notice = describeJobResult(evt, isSandboxEngine(sandboxStatusRef.current?.active));
      if (useAgentChatStore.getState().generating[convId]) {
        const held = pendingJobsRef.current.get(convId) ?? [];
        pendingJobsRef.current.set(convId, [...held, notice]);
      } else if (convId === convIdRef.current) {
        void send({ text: formatJobMessage(notice), attachments: [], _fromQueue: true });
      } else {
        // A background conversation that is idle: queued rather than sent, so it wakes when the user opens it
        // instead of starting a turn in a conversation nobody is looking at.
        enqueueMessage(convId, formatJobMessage(notice), []);
      }
    };

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
    <div className="relative flex h-full minonSecureEnvChange-w-0 flex-1 flex-col overflow-hidden bg-surface-muted text-ink">
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
        onSandboxBadgeClick={() => setSandboxDialogTick((n) => n + 1)}
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
      </div>

      {/* Skills panel: download marketplace skills, enable / uninstall. Enabled skills enter the chat configuration (effective from the next message). */}
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
