"use client";

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
import { ChevronDown, Pencil, Eraser } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SandboxStartupDialog from "@/components/ai/SandboxStartupDialog";
import {
  callTool,
  chooseWorkingDir,
  defaultWorkingDir,
  getWorkingDir,
  getPathForFile,
  isToolkitAvailable,
  listTools,
  saveAttachment,
  setWorkingDir,
} from "@/lib/ai/toolkit";
import { chatViaProxy, chatStreamViaProxy, isLlmProxyAvailable, isLlmStreamAvailable } from "@/lib/ai/llm";
import {
  buildLogMeta,
  isUsageLogEnabledSync,
  logContextDiag,
  logModelCall,
  logSubagentRun,
  logToolCall,
  primeUsageLog,
} from "@/lib/ai/usageLog";
import {
  describeContext,
  simulateBudgets,
  defaultBudgetCandidates,
  formatSimulation,
  findUnverifiedFacts,
} from "./contextDiag";
import { isLocalEndpoint, localLlm, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import { setSandboxMode, onSandboxStatus, getSandboxStatus, getSandboxVmInfo, sandboxEnvHint, isSandboxEngine, type SandboxStatus } from "@/lib/ai/sandbox";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";
import {
  SUBAGENTS, SUBAGENT_TOOL_DISCIPLINE, subAgentTool,
  delegationSubject, findRepeatDelegation, repeatDelegationResult, type PriorDelegation,
} from "@/lib/ai/subagents";
import { SkillSelectPanel } from "./SkillSelectPanel";
import BrowserPanel from "./BrowserPanel";
import { getStorage } from "@zzcpt/zztool";
import {
  AGENT_MODE_KEY,
  AGENT_STORAGE_ROOT,
  AGENT_WORKDIR_KEY,
  MODE_CHANGE_EVENT,
  WORKDIR_CLEAR_EVENT,
  WORKDIR_SET_EVENT,
  type AgentMode,
} from "@/constants/Agent";
import { migrateLegacyAgentStorage, putStorage } from "@/lib/ai/agentStorage";
import { hydrateAppConfig } from "@/lib/ai/appConfig";
import { notifyReplyComplete, notifyAgentError, notifyQuestion } from "@/lib/ai/agentNotify";
import { isWindowAlwaysOnTop } from "@/lib/electron/windowControls";
import { useAgentChatStore } from "@/store/agentChatStore";
import { enabledSkills, loadInstalled } from "@/lib/ai/skills/store";
import { getSkillInstructions, loadSkillTool, skillSystemHint } from "@/lib/ai/skills/runtime";
import { SANDBOX_TOOLBOX_SKILL } from "@/lib/ai/skills/builtin";
import { buildSystemPrompt, buildToolSet as buildToolSet_ } from "@/lib/ai/promptPrefix";
import { ROUTED_TOOLS, resolveToolCall, routedFailureHint, unknownToolResult } from "@/lib/ai/toolRouter";
/** The built-in skill menu as it appears in messages[0]: fixed text, identical on every install. */
const BUILTIN_SKILL_MENU =
  "[Built-in skills] Always installed and always listed here:\n" +
  `- ${SANDBOX_TOOLBOX_SKILL.id}: ${SANDBOX_TOOLBOX_SKILL.description}`;
import { loadEnabledProjectSkills } from "@/lib/ai/skills/project";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { makeUnifiedDiff } from "./diffUtil";
import { capToolOutput } from "./compress";
import {
  planCompaction,
  buildWireContext,
  sanitizeToolCallPairs,
  compactionSavings,
  serializeCompaction,
  deserializeCompaction,
  resolveHybridBudget,
  pathProvenance,
  MANUAL_COMPACT_MIN_PCT,
  MAX_SUMMARY_REUSE,
  type CompactionState,
} from "./contextCompress";
import { getContextBudgetK } from "@/lib/ai/contextBudget";
import {
  emptyTaskMemory,
  isTaskMemoryEmpty,
  normalizeTaskMemory,
  renderTaskMemory,
  TASK_STATE_EXPLAINER,
  applyTaskState,
  mergeExtracted,
  parseSummaryWithTaskState,
  type TaskMemory,
  type ExtractedTaskState,
} from "./taskMemory";
import type { StoredCompaction } from "@/lib/ai/conversation";
import { countMessagesTokens, countMessageTokens, countTokens } from "@/lib/ai/tokenizer";
// ── Extracted modules (data / types / constants / tool declarations / display components) ──────────────────────
import {
  resolveActiveModel,
  resolveModelById,
  ensureModelListSeeded,
  loadModelList,
  getSelectedModel,
  setSelectedModelId,
  resolveContextWindow,
  markVisionUnsupported,
  PROVIDERS,
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
  MUTATING_FILE_TOOLS,
  PARALLEL_SAFE_TOOLS,
  RENDERER_HANDLED_TOOLS,
  RESUME_NUDGE,
  RISKY_PATH_PATTERN,
  toolNeedsConsent,
  UNCAPPED_TOOLS,
  systemPromptFor,
  selCls,
  toolStatusText,
  workdirPrompt,
  WORKDIR_RULES,
  WORKDIR_SCOPE_RULE,
} from "./constants";
import {
  addBlock,
  diffReminder,
  foldReminders,
  materializeReminders,
  renderReminder,
  wrapReminder,
} from "./reminders";
import type {
  ApiMsg,
  Attachment,
  ChatResponse,
  ContentPart,
  ReminderState,
  DisplayMsg,
  SubAgentStep,
  Todo,
  TodoStatus,
} from "./types";
import {
  askUserTool,
  browserTool,
  deleteMemoryTool,
  openBrowserTool,
  saveMemoryTool,
  imageGenerationTool,
  searchMemoryTool,
  updateTodosTool,
  setTaskStateTool,
} from "./agentTools";
import { generate, capabilityAvailable, imageErrorKey } from "@/lib/ai/generation";
import {
  saveMemoryFile,
  listMemoryFiles,
  deleteMemoryFile,
  isMemoryFilesAvailable,
} from "@/lib/ai/memoryFiles";
import { searchMemories } from "@/lib/ai/memoryRetrieval";
import { browserAction, requestOpenBrowser, setBrowserBusy, type BrowserAction } from "@/lib/automation";
import { formatBytes, uploadFileToOSS, abbreviateNumber } from "./format";
import { MessageItem, ProcessGroup, type ProcessItem } from "./MessageItem";
import { detectServices } from "@/store/servicesStore";
import { TodoPanel } from "./TodoPanel";
import { TranscriptSkeleton } from "./TranscriptSkeleton";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { Composer } from "./Composer";
import { ProjectSkillsPrompt } from "./ProjectSkillsPrompt";
import { ConsentPanel } from "./ConsentPanel";
import { useConsentQueue } from "./useConsentQueue";
import {
  hoistSystemToFront,
  hostOfEndpoint,
  stripAllImagesForText,
  stripRemoteImagesForLocal,
  phaseSummaryText,
  stripWireMetadata,
  applyReasoningPolicy,
  toInstalledProjectSkill,
} from "./wireHelpers";

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
 * The run context for a single send (generation). send() and the tool executions / subagents it invokes share it, to support "background concurrent generation":
 *  - convId: the conversation this generation belongs to (captured stably, unchanged when switching conversations); always used for persistence;
 *  - signal: this run's own independent abort signal (one per conversation, mutually isolated);
 *  - push / status: view side effects that only actually affect the UI while convId is still the current active conversation, otherwise silent
 *    (a background conversation only persists to disk and never pollutes the display or state of the currently viewed conversation; it is rebuilt from the store by loadConversation when switched back to).
 */
type RunCtx = {
  convId: string;
  /**
   * Identifies this one generation in the usage log. Every model call, tool call and delegation the
   * turn produces carries it, which is what lets the log viewer's timeline group a turn's spending
   * instead of showing a flat list of unrelated requests.
   */
  turnId: string;
  signal: AbortSignal;
  push: (m: DisplayMsg) => void;
  status: (s: string) => void;
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
  const [setupDone, setSetupDone] = useState(false); // Mount initialization complete (model / tools / directory ready)
  // The currently selected model (chosen in settings / home page, read-only here for sending). endpoint / model / apiKey are derived from it.
  const [activeModel, setActiveModel] = useState<ResolvedModel | null>(null);
  // The list of selectable models + the currently selected id (used by the model picker inside the input box).
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(null);
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
  // Header "Rename" dialog: null = closed; a string is the draft title being edited.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  // Side-channel for image_generation: the tool returns only a text note (the artifact must not enter the wire), but
  // the persist step needs the image URL to store it for display rebuild. generateImageAction sets this right before
  // returning; the persist step consumes it. Safe because image_generation runs serially (its own tool group).
  const lastImageArtifactRef = useRef<{ image: string; servedBy?: string } | null>(null);
  // Same side-channel shape for run_subagent: the tool returns only the sub-agent's conclusion text, but the
  // persist step needs its inner steps so the reopened conversation shows what it actually did. Points at the
  // live array (mutated in place as steps land), so it is current by the time the persist step reads it.
  // Safe for the same reason as above: run_subagent is not parallel-safe, so it runs in its own serial group.
  const lastSubagentStepsRef = useRef<SubAgentStep[] | null>(null);
  /** Delegations completed in the current turn, for the repeat guard in runSubAgent (keyed by turn, never cleared — see there). */
  const delegationsRef = useRef<{ turnId: string; done: PriorDelegation[] }>({ turnId: "", done: [] });
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
  const [workdirMsg, setWorkdirMsg] = useState<string | null>(null);
  // Whether the user has "explicitly chosen" the working directory (tools always have a WORKDIR by default, so this needs a separate flag).
  // Dev mode requires an explicit choice; in daily mode, if not chosen, it falls back to the default working directory (under userData/agent).
  const [workdirChosen, setWorkdirChosen] = useState(false);
  const defaultAppliedRef = useRef(false); // The daily-mode default directory is applied only once, to avoid picking a new random directory for every message
  const [defaultApplied, setDefaultApplied] = useState(false); // Same as above, for the render layer to display
  // The current mode (daily / dev): comes from the sidebar AgentModeTab, synced via localStorage + a custom event.
  const [mode, setMode] = useState<AgentMode>("daily");
  // Skills: the installed list (including enabled state) + the panel toggle. installedRef lets the async send loop read the latest value.
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const installedSkillsRef = useRef<InstalledSkill[]>([]);
  // Enabled "project skills" (from .claude/.cursor/.zeraix, see ProjectSkillsPrompt / config.json) —
  // mapped to the InstalledSkill shape and merged into the runtime skill set, so they too can be progressively disclosed by load_skill.
  const projectSkillsRef = useRef<InstalledSkill[]>([]);
  const reloadProjectSkills = async () => {
    projectSkillsRef.current = (await loadEnabledProjectSkills()).map(toInstalledProjectSkill);
  };
  const setInstalledSkillsBoth = (list: InstalledSkill[]) => {
    installedSkillsRef.current = list;
    setInstalledSkills(list);
  };
  const [skillsOpen, setSkillsOpen] = useState(false);
  // The settings area (working directory / run parameters) is collapsed by default; it expands on demand in dev mode when a working directory is missing.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll follow: pinned to the bottom by default. If the user manually scrolls up while generating → pause auto-scroll and surface a "back to bottom" button; scrolling back to the bottom resumes it.
  // atBottomRef is for the synchronous read of "whether to follow when new content arrives" (avoiding reliance on async state); atBottom drives the button's visibility.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
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
  const choiceResolversRef = useRef<Map<number, { convId: string | null; resolve: (v: string) => void }>>(
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
  // Run parameters removed: tool rounds / subagent rounds no longer have an upper limit, and the deadlock protection for repeated calls / consecutive timeouts is also disabled;
  // interruption is only via the user's manual "stop". The related settings and persistence were removed accordingly.

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

  // The model calls set_task_state: record its internal mission brief into Task Memory (source "model"),
  // pinned into the wire every turn and preserved across compaction. Not shown to the user. When the brief
  // is unchanged, return a discouraging result so the model stops re-recording it every turn (it over-calls
  // otherwise; the brief is already in context and the compaction extractor backstops it).
  const setTaskState = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    if (typeof rawArgs.notes !== "string") {
      return "No change — pass `notes` (your mission brief) to record it.";
    }
    const next = rawArgs.notes.trim();
    if (next === taskMemoryFor(ctx.convId).notes) {
      return "Task state unchanged — it is already pinned in your context; do not call set_task_state again unless the plan or goal materially changes.";
    }
    setTaskMemoryFor(ctx.convId, applyTaskState(taskMemoryFor(ctx.convId), { notes: next }));
    return "Task state recorded.";
  };

  // The model calls update_todos: overwrite that conversation's list with the full list, returning a short confirmation.
  // A background conversation's list is kept (keyed by its own id) but not shown, so it is intact when the user switches back.
  const updateTodos = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const raw = Array.isArray(rawArgs.todos) ? rawArgs.todos : [];
    const parsed: Todo[] = raw
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const status = o.status;
        return {
          title: String(o.title ?? "").trim(),
          status: (status === "in_progress" || status === "completed"
            ? status
            : "pending") as TodoStatus,
        };
      })
      .filter((t) => t.title);
    setTodosFor(ctx.convId, parsed);
    const done = parsed.filter((t) => t.status === "completed").length;
    return `Updated the todo list (${done}/${parsed.length} completed).`;
  };

  // Manual toggle: switch this item between "completed / not completed". Only ever acts on the viewed conversation's list.
  const toggleTodo = (index: number) => {
    const next = todosFor(convIdRef.current).map((t, i) =>
      i === index ? { ...t, status: t.status === "completed" ? "pending" : "completed" } : t,
    );
    setTodosFor(convIdRef.current, next as Todo[]);
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
  const [localLlmReady, setLocalLlmReady] = useState<boolean | null>(null);
  // The "local model not started" dialog (pops when a send is blocked, guiding the user to Settings → Local model to start it).
  const [localStartDialog, setLocalStartDialog] = useState(false);
  useEffect(() => {
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
    // is a pure function of mode in promptPrefix.ts, so scripts/capture-prefix.mjs computes it without an app at all.
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

  // Compute the "effective model for the current conversation": the conversation-level binding takes priority (dev mode binds per conversation; daily mode leaves it empty by default and uses the global one),
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
  // The deps include onChatRoute: this component is permanently mounted by AgentShell, so before the first entry the composer is hidden (scrollHeight=0),
  // and pinning the height to 0px then would keep it collapsed. So when hidden (scrollHeight=0), skip measuring and keep the rows=1 default single-line height,
  // then re-measure and correct after the route becomes active and visible.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight === 0) return; // Hidden / not yet laid out: do not measure, to avoid collapsing to 0
    const max = Math.round(window.innerHeight * 0.3);
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input, onChatRoute]);

  // Switch models within the input box:
  //  - Dev mode: bind to the current conversation (if the conversation is not yet created, bind when it is created on the first send); does not change the global one.
  //  - Daily mode: by default update the globally selected model (and clear any residual conversation-level binding on this conversation, keeping "daily = global" consistent).
  const selectModel = (id: string) => {
    setSelectedModelIdState(id);
    setActiveModel(resolveModelById(id));
    const store = useAgentChatStore.getState();
    if (mode === "dev") {
      if (convIdRef.current) store.setConversationModel(convIdRef.current, id);
    } else {
      setSelectedModelId(id);
      if (convIdRef.current && store.getConversation(convIdRef.current)?.modelId) {
        store.setConversationModel(convIdRef.current, null);
      }
    }
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
  const onScroll = () => {
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

  // After initialization is complete:
  //  - ?c= changes → load the corresponding historical conversation (supports switching conversations from the sidebar within the chat page);
  //  - first entry with no ?c= → consume the home page's pending send, or fall back to prefilling from ?q=.
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
    if (q) setInput(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupDone, params, onChatRoute]);

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

  // Sandbox: sync the current mode to the main process — the sandbox only serves "daily" mode; dev mode always runs directly on the host.
  // After syncing, read the status back (mode/active change accordingly), keeping the hint text and title-row badge immediately accurate.
  useEffect(() => {
    setSandboxMode(mode)
      .then(() => getSandboxStatus())
      .then((st) => {
        if (st) {
          sandboxStatusRef.current = st;
          setSandboxStatus(st);
        }
      });
  }, [mode]);

  // Sandbox: subscribe to the main process's background initialization status (download runtime environment → start), writing to ref/state.
  // Presentation is handled by the startup progress dialog SandboxStartupDialog (daily mode only); the status also feeds environment-hint injection and the title badge.
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

  // Sync the sidebar's "daily / dev" mode: restore on mount + listen to the custom event (same tab) and storage (cross-tab).
  useEffect(() => {
    const read = () => {
      const v = getStorage(AGENT_MODE_KEY);
      if (v === "daily" || v === "dev") setMode(v);
    };
    read();
    const onCustom = (e: Event) => {
      const v = (e as CustomEvent).detail;
      if (v === "daily" || v === "dev") setMode(v);
    };
    // Under categorized storage, the mode is written in the top-level `agent` object, so the e.key of a cross-tab storage event is that root key.
    const onStorage = (e: StorageEvent) => {
      if (e.key === AGENT_STORAGE_ROOT) read();
    };
    // Switching mode / creating a new conversation cleared the chosen directory → reset this page's working-directory selection state.
    const onWorkdirClear = () => {
      setWorkdirChosen(false);
      setWorkdir("");
      setWorkdirInput("");
      defaultAppliedRef.current = false;
      setDefaultApplied(false);
    };
    // Clicking a project set the working directory → sync it to this page's working-directory input and apply it to the tool sandbox.
    const onWorkdirSet = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      if (typeof dir !== "string" || !dir) return;
      setWorkdir(dir);
      setWorkdirInput(dir);
      setWorkdirChosen(true);
      setWorkdirMsg(t("chat.workdirSet", { dir }));
      if (isToolkitAvailable()) void setWorkingDir(dir).catch(() => {});
    };
    window.addEventListener(MODE_CHANGE_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    window.addEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
    window.addEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    return () => {
      window.removeEventListener(MODE_CHANGE_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(WORKDIR_CLEAR_EVENT, onWorkdirClear);
      window.removeEventListener(WORKDIR_SET_EVENT, onWorkdirSet);
    };
  }, []);

  const clearAll = () => {
    // If there are pending sensitive-operation confirmations / choices, wind them up first to avoid the send loop hanging. Clearing targets the current conversation, releasing its pending-confirmation requests.
    dropConsentsFor(convIdRef.current);
    dropChoicesFor(convIdRef.current, "The user cleared the conversation.");
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
    turnUsageRef.current = { prompt: 0, completion: 0, total: 0, cached: 0, estimated: false };
    setSessionUsage({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false }); // Reset the session token stats
    setCtxTokens(0); // New conversation: context usage back to zero
    convoRef.current = [];
    // Reset context compaction: a new conversation has no history to compact.
    compactionRef.current = null;
    manualCompactRef.current = false;
    setCompacted(false);
    convIdRef.current = null; // The next send will start a new conversation record
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
    dropConsentsFor(id);
    dropChoicesFor(id, "The user cleared the conversation.");
    allowedToolsRef.current.clear();
    interruptedRef.current = false;
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
  /** Snapshot the current conversation's compaction state into the session-level cache, to restore when switching back later (the fast path within this run). */
  const snapshotCompaction = (convId: string | null) => {
    if (!convId) return;
    compactionCacheRef.current.set(convId, {
      state: compactionRef.current,
      manual: manualCompactRef.current,
      compacted,
      ctxTokens: contextTokensRef.current,
    });
  };

  /**
   * Persist the current conversation's compaction snapshot to disk (so compaction can be restored after close and reopen, without re-summarizing).
   * compaction is not part of the integrity hash (see canonical.ts), so it does not trigger re-signing, and the existing signature stays valid.
   * Called after every change to the compaction state (auto-compaction on send / manual "compact now" / clearing on falloff), keeping the disk always current.
   */
  const persistCompaction = (
    convId: string | null,
    // Explicit state for a round whose conversation is no longer the active view: compactionRef belongs to
    // whatever the user switched TO, so a background round must pass its own.
    explicit?: { state: CompactionState | null; manual: boolean; ctxTokens: number },
  ) => {
    if (!convId) return;
    const state = explicit ? explicit.state : compactionRef.current;
    let stored: StoredCompaction | null = null;
    if (state) {
      const s = compactionSavings(state);
      stored = {
        ...serializeCompaction(state),
        manual: explicit ? explicit.manual : manualCompactRef.current,
        compacted: s.summarizedTurns > 0 || s.dedupedReads > 0,
        ctxTokens: explicit ? explicit.ctxTokens : contextTokensRef.current,
      };
    }
    useAgentChatStore.getState().setConversationCompaction(convId, stored);
  };

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
    convIdRef.current = id;
    // Mode is a sidebar-global toggle, but messages[0] and openBrowserTool(mode) are both mode-determined — so opening a stored
    // dev conversation while the sidebar reads "daily" silently rebuilt the prompt and the tool block with the wrong mode. Adopt
    // the conversation's own mode and persist it the way every other writer does (putStorage also mirrors to app.config; a raw
    // setStorage would be reverted by the file-wins hydration on the next launch). Deliberately no MODE_CHANGE_EVENT: the
    // sidebar's handler treats that as a user toggle and navigates back to the home page, away from the conversation just opened.
    if (conv.mode === "daily" || conv.mode === "dev") {
      setMode(conv.mode);
      putStorage(AGENT_MODE_KEY, conv.mode);
    }
    // Restore this conversation's internal Task Memory brief from disk into the ref, so the mission survives
    // app reopen. Seed only if the ref doesn't already hold a live in-session copy.
    if (conv.taskMemory && !taskMemoryByConvRef.current.has(id)) {
      const tm = normalizeTaskMemory(conv.taskMemory);
      if (!isTaskMemoryEmpty(tm)) taskMemoryByConvRef.current.set(id, tm);
    }
    // Swap the todo panel to this conversation's own list (empty unless it has one in flight). Without this the
    // previous conversation's todos stayed on screen, looking as though they belonged to the conversation just opened.
    setTodos(todosFor(id));
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
        if (m.reasoning) disp.push({ kind: "reasoning", content: m.reasoning });
        // Final reply with no tool calls: the body is shown as-is. For the round that issues tool calls, its body —
        //  - Dev mode (phased streaming): shown as that phase's summary (phaseSummaryText strips the chain of thought / leftover </think>),
        //    consistent with the real-time display;
        //  - Daily mode: skipped (reasoning models often put the chain of thought / a stray </think> here; the real-time display already skips it, and the rebuild must skip it too).
        // storedIndex=mi + rating feed the action-bar rating: clicking persists it to that StoredMessage and highlights the chosen rating.
        if (m.content) {
          if (!m.tool_calls?.length) {
            disp.push({ kind: "assistant", content: m.content, rating: m.rating, storedIndex: mi });
          } else if (conv.mode === "dev") {
            // The phase summary of a tool-call round: rebuilt as a "thinking process" timeline entry (phase), consistent with the real-time display —
            // collected into the same card, not a standalone block, with no action bar (rating only belongs to the final reply).
            const summary = phaseSummaryText(m.content);
            if (summary) disp.push({ kind: "phase", content: summary });
          }
        }
      }
    });
    displayRef.current = disp;
    setDisplay(disp);
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
        let seen = -1;
        for (const cm of convoRef.current) {
          if (cm.role === "system") continue;
          seen++;
          if (seen === storedIndex) {
            if (cm.role === "assistant") {
              if (rating) cm.rating = rating;
              else delete cm.rating;
            }
            break;
          }
        }
      }
      const next = displayRef.current.map((m, i) =>
        i === displayIndex && m.kind === "assistant" ? { ...m, rating: rating ?? undefined } : m,
      );
      displayRef.current = next;
      setDisplay(next);
    },
    [],
  );

  /**
   * A single request (non-streaming, OpenAI-compatible).
   * Under Electron it is forwarded via the main-process proxy (bypassing CORS); in the browser it falls back to a direct fetch (which may be blocked by CORS).
   *
   * Wrapped by requestChat below, which owns the retry-without-images fallback — this function just sends
   * what it is given.
   */
  const sendChatOnce = async (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    // Passing onDelta requests "streaming": callbacks the accumulated content/reasoning chunk by chunk, for real-time display.
    // Downstream still treats it as a "non-streaming complete response" — this function reassembles the SSE deltas back into a complete ChatResponse before returning.
    onDelta?: (d: { content: string; reasoning: string }) => void,
    // Usage-log attribution (who is spending these tokens). Undefined while logging is off, and the
    // proxy is what actually writes the entry — see src/lib/ai/usageLog.ts.
    log?: { actor: string; convId?: string; turnId?: string },
  ): Promise<ChatResponse> => {
    const body = {
      model: modelName,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    };
    const wantStream = !!onDelta;
    const actor = log?.actor ?? "main";
    const startedAt = Date.now();
    // selfLogged: this function records the invocation below, whichever transport it ends up using.
    // It must, because the branch further down sends cloud requests with a direct fetch that never
    // reaches the main-process proxy where the other hook lives.
    const meta = buildLogMeta({
      source: "chat",
      actor,
      convId: log?.convId,
      turnId: log?.turnId,
      provider: activeModel?.providerId,
      selfLogged: true,
    });

    // Streaming increment accumulator: reassemble the OpenAI SSE deltas back into a complete message (content / reasoning_content / tool_calls).
    const accum = {
      content: "",
      reasoning: "",
      toolCalls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
      usage: undefined as ChatResponse["usage"],
    };
    const handleChunk = (raw: unknown) => {
      const chunk = raw as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: ChatResponse["usage"];
      };
      if (chunk.usage) accum.usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) accum.content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) accum.reasoning += r;
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let cur = accum.toolCalls[idx];
        if (!cur) {
          cur = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          accum.toolCalls[idx] = cur;
        }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      }
      onDelta?.({ content: accum.content, reasoning: accum.reasoning });
    };
    const assemble = (): ChatResponse => {
      const calls = accum.toolCalls.filter(Boolean);
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: accum.content || null,
              ...(calls.length ? { tool_calls: calls } : {}),
              ...(accum.reasoning ? { reasoning_content: accum.reasoning } : {}),
            },
          },
        ],
        usage: accum.usage,
      };
    };
    // Local llama-server failures are cryptic (raw llama.cpp text). For local endpoints, map the known template / tool-call
    // failures to an actionable message; everything else keeps the raw "HTTP <status> — <text>" form.
    const localErr = (status: number, raw?: string): string => {
      const base = `HTTP ${status}${raw ? ` — ${raw.slice(0, 300)}` : ""}`;
      if (!isLocalEndpoint(endpoint)) return base;
      const r = (raw || "").toLowerCase();
      if (r.includes("generate parser") || r.includes("raise_exception") || r.includes("chat template") || r.includes("system message must be"))
        return t("chat.localTemplateError");
      if (r.includes("peg-native") || r.includes("unparsed") || r.includes("tool call") || r.includes("tool_call"))
        return t("chat.localToolCallError");
      return base;
    };
    const streamErr = (res: { ok: boolean; status: number; error?: string }): ChatResponse | never => {
      if (!res.ok) {
        if (signal?.aborted) return assemble(); // Aborted: return the accumulated part (the caller then exits on aborted and will not use it)
        throw new Error(localErr(res.status, res.error));
      }
      return assemble();
    };

    // Tell llama-server which conversation this request belongs to, so its disk tier can restore that conversation's own KV by id
    // (T1) instead of re-prefilling, and can spill the tip back under the same id when the turn ends. Local only: it means nothing
    // to a cloud provider, and a non-standard header on a strict endpoint is a needless risk.
    const localHeaders =
      log?.convId && isLocalEndpoint(endpoint) ? { "X-Conversation-Id": log.convId } : undefined;

    // Browser fallback: connect directly to the provider endpoint.
    let data: ChatResponse;
    // Local llama-server (127.0.0.1): forced through the main-process proxy (a Node environment, with no render-layer cross-origin (CORS) restriction).
    if (isLlmProxyAvailable() && isLocalEndpoint(endpoint)) {
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(
          await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body, headers: localHeaders, meta }, handleChunk, signal),
        );
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body, headers: localHeaders, meta });
        if (!res.ok) {
          throw new Error(localErr(res.status, res.error));
        }
        data = res.data as ChatResponse;
      }
    } else if (!proxyReady) {
      // The proxy is a single IPC and cannot abort an in-flight network request; instead the caller checks signal.aborted after the await to exit.
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim(), body, meta }, handleChunk, signal));
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim(), body, meta });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${res.error ? ` — ${res.error.slice(0, 300)}` : ""}`);
        }
        data = res.data as ChatResponse;
      }
    } else {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
          ...(wantStream ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify(wantStream ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
      }
      if (wantStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              handleChunk(JSON.parse(payload));
            } catch {
              /* Skip an unparseable chunk */
            }
          }
        }
        data = assemble();
      } else {
        data = (await res.json()) as ChatResponse;
      }
    }

    // Accumulate this round's token usage (including every request of tool rounds and subagents).
    // Prefer the provider-returned usage (exact); when missing, estimate with tiktoken and mark it estimated.
    const u = data.usage;
    // The same numbers go to the usage log below, so it reports exactly what the context bar reports.
    let logged: { prompt: number; completion: number; total: number; cached: number; estimated: boolean };
    if (u) {
      const p = u.prompt_tokens ?? 0;
      const c = u.completion_tokens ?? 0;
      turnUsageRef.current.prompt += p;
      turnUsageRef.current.completion += c;
      turnUsageRef.current.total += u.total_tokens ?? p + c;
      // Input tokens served from the prefix cache: the field differs by provider (DeepSeek uses prompt_cache_hit_tokens,
      // OpenAI-compatible uses prompt_tokens_details.cached_tokens); accumulate whichever is present, for the UI to show the cache effect.
      const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      turnUsageRef.current.cached += cached;
      logged = { prompt: p, completion: c, total: u.total_tokens ?? p + c, cached, estimated: false };
    } else {
      const p = countMessagesTokens(messages);
      const c = countMessageTokens(data.choices?.[0]?.message);
      turnUsageRef.current.prompt += p;
      turnUsageRef.current.completion += c;
      turnUsageRef.current.total += p + c;
      turnUsageRef.current.estimated = true;
      logged = { prompt: p, completion: c, total: p + c, cached: 0, estimated: true };
    }

    // Usage log entry for this invocation. Written here rather than in the proxy because a cloud model
    // in the desktop app is fetched straight from the renderer (see the transport branch above), so the
    // proxy sees only local endpoints; the request carries selfLogged so it is never counted twice.
    logModelCall({
      actor,
      model: modelName,
      provider: activeModel?.providerId,
      endpoint: hostOfEndpoint(endpoint),
      promptTokens: logged.prompt,
      completionTokens: logged.completion,
      totalTokens: logged.total,
      cachedTokens: logged.cached,
      estimated: logged.estimated,
      stream: wantStream,
      ms: Date.now() - startedAt,
      // An abort returns whatever streamed in before the stop, which is a cancelled call, not a clean one.
      ok: !signal?.aborted,
      error: signal?.aborted ? "cancelled" : undefined,
      convId: log?.convId,
      turnId: log?.turnId,
    });

    // Official direct-connection models are billed by the platform per request, so the balance moves with
    // every step of a tool loop — not just at the end of the turn. Refresh as each step lands so the
    // sidebar tracks spending live. Throttled and de-duped inside the store, and a no-op for guests,
    // local models and BYO-key providers, which never touch the platform wallet.
    if (activeModel?.providerId === OFFICIAL_PROVIDER_ID) {
      void useAuthStore.getState().refreshWallet();
    }
    return data;
  };

  /**
   * One request, with a fail-safe for models that cannot accept images.
   *
   * Image capability is no longer predicted before sending (see modelAcceptsImages): a wrong prediction
   * used to delete the user's image and tell the model "1 image(s) omitted", which reads to the user as
   * "the AI can't see my picture" with nothing indicating the app removed it. Images now always go out,
   * and this is what makes that safe — if a request carrying images fails, it is retried once with the
   * images stripped. Succeeding on the retry is the proof the images were the problem, so the model is
   * marked visionUnsupported and later turns strip up front, costing one extra request once per model.
   *
   * Retrying on ANY failure rather than pattern-matching the error text is deliberate: providers word
   * this rejection every possible way ("unknown variant `image_url`", "invalid_image_url", "does not
   * support image input", a bare 400), and a signature that misses one puts us back to a hard failure on
   * a picture the user can see on screen. The cost of guessing wrong here is one request that was
   * already failing.
   */
  const requestChat = async (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    onDelta?: (d: { content: string; reasoning: string }) => void,
    log?: { actor: string; convId?: string; turnId?: string },
  ): Promise<ChatResponse> => {
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    // A request that never returned has no usage to report, but "the model was called and it failed"
    // is precisely what someone reading the log at 3am needs to see. sendChatOnce logs only the calls
    // that come back, so the throwing ones are recorded here.
    const startedAt = Date.now();
    const logFailure = (e: unknown) =>
      logModelCall({
        actor: log?.actor ?? "main",
        model: modelName,
        provider: activeModel?.providerId,
        endpoint: hostOfEndpoint(endpoint),
        ms: Date.now() - startedAt,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        convId: log?.convId,
        turnId: log?.turnId,
      });
    try {
      return await sendChatOnce(messages, tools, signal, onDelta, log);
    } catch (e) {
      // No images to blame, or the user cancelled: this failure is genuine, surface it unchanged.
      if (!hasImages || signal?.aborted) {
        logFailure(e);
        throw e;
      }
      logFailure(e); // the first attempt failed on its own terms, whatever the retry goes on to do
      const stripped = stripAllImagesForText(messages);
      // The retry is logged as its own invocation: it is a second request that the provider bills for.
      let data: ChatResponse;
      try {
        data = await sendChatOnce(stripped, tools, signal, onDelta, log); // throws the retry's own error if it also fails
      } catch (retryErr) {
        logFailure(retryErr);
        throw retryErr;
      }
      if (activeModel?.id) markVisionUnsupported(activeModel.id);
      return data;
    }
  };

  // ── Context compaction ────────────────────────────────────────────────────────────────
  /** Render a span of history messages into a plain-text transcript for the "summarizer model" (tool results truncated, to control the summary input size). */
  const renderTranscript = (msgs: ApiMsg[]): string => {
    // Reminders are part of what the model was shown, so the summariser sees them too — nothing is excluded from its input.
    msgs = materializeReminders(msgs);
    const lines: string[] = [];
    for (const m of msgs) {
      if (m.role === "user") {
        // A multimodal turn used to collapse to the bare marker, throwing away the user's own question along with any change
        // event carried on that turn — so a nudge emitted on a message with an attached image vanished at compaction. Keep the
        // text parts and mark the images separately.
        const txt =
          typeof m.content === "string"
            ? m.content
            : m.content
                .map((p) => (p.type === "text" ? p.text : "[image]"))
                .filter(Boolean)
                .join("\n");
        lines.push(`[User] ${txt}`);
      } else if (m.role === "assistant") {
        if (m.content) lines.push(`[Assistant] ${m.content}`);
        for (const tc of m.tool_calls ?? [])
          lines.push(`[Assistant · tool call] ${tc.function.name}(${(tc.function.arguments || "").slice(0, 300)})`);
      } else if (m.role === "tool") {
        // No second truncation: tool results are already limited to ≤8000 chars by capToolOutput before entering convoRef,
        // so hand them to the summarizer as-is, ensuring the key analysis data enters the summary in full.
        const c = typeof m.content === "string" ? m.content : "";
        lines.push(`[Tool result] ${c}`);
      }
    }
    return lines.join("\n");
  };

  /**
   * Call the current model to compress earlier history into a summary body (throws on failure; the caller
   * falls back to dedup-only). Counted toward this round's usage.
   * priorSummary (§8.1 incremental): when set, `msgs` is only the NEWLY-covered span and the model updates
   * the existing summary rather than re-summarising the whole span from scratch — far cheaper. When null,
   * `msgs` is the full covered span (from-scratch: first summary, or a B1 forced drift reset).
   */
  const summarizeHistory = async (
    msgs: ApiMsg[],
    signal?: AbortSignal,
    log?: { actor: string; convId?: string; turnId?: string },
    priorSummary?: string | null,
  ): Promise<{ summary: string; extracted: ExtractedTaskState | null }> => {
    const sys: ApiMsg = {
      role: "system",
      content:
        (priorSummary
          ? "You are a conversation summarizer maintaining a running summary. Below is the EXISTING summary of the earlier conversation, then ADDITIONAL newer conversation. Produce an UPDATED summary that folds the new content into the existing one, preserving everything important from BOTH — do not drop details already captured in the existing summary. "
          : "You are a conversation summarizer. Compress the following earlier AI-assistant conversation into a concise but information-complete summary, so the subsequent conversation can seamlessly continue the context. ") +
        "Be sure to preserve completely (better a bit long than to lose anything): " +
        "① the goal and key requirements of each user question; " +
        "② the conclusion / solution for each question — what was ultimately done and how it turned out; " +
        "③ the reasons and basis for reaching that conclusion and choosing that approach — why it was done this way, which alternatives were ruled out, and based on which findings; " +
        "④ key analysis findings and important data — do not just write \"read/checked some file\", write the concrete conclusions / key content / values derived from it; " +
        "⑤ the files / paths / commands involved; ⑥ what is done and what is still pending; ⑦ any pitfalls and caveats. " +
        "Do not fabricate information that did not appear; do not restate irrelevant intermediate steps sentence by sentence.\n\n" +
        // Compaction-time task-state extraction: the summary is lossy, so separately capture the DURABLE
        // mission state so it can be preserved verbatim even as this prose is later re-summarised.
        "After the summary, output a task-state capture wrapped EXACTLY in these markers, on their own lines:\n" +
        "<<<TASK_STATE>>>\n" +
        "{\"notes\": \"<a few sentences capturing the CURRENT MISSION found in this history: the overall goal, the plan/phases, any hard constraints the user stated, and key decisions and why>\", \"todos\": [{\"title\": \"...\", \"status\": \"pending|in_progress|completed\"}]}\n" +
        "<<<END_TASK_STATE>>>\n" +
        "Include only what is genuinely present as a durable plan / goal / constraint / decision (omit todos if none). If there is no clear mission or plan in this history, output {} between the markers. Output the summary first, then the markers.",
    };
    const transcript = renderTranscript(msgs);
    const user: ApiMsg = {
      role: "user",
      content: priorSummary
        ? `[Existing summary]\n${priorSummary}\n\n[Additional newer conversation]\n${transcript}`
        : transcript,
    };
    // Logged under the "compact" actor: these tokens are the app's own housekeeping, not the answer
    // the user asked for, and a usage report that hid them would under-count the turn.
    const data = await requestChat([sys, user], undefined, signal, undefined, log ?? { actor: "compact" });
    const raw = data.choices?.[0]?.message?.content ?? "";
    // Split the prose summary from the appended task-state JSON (pure helper; robust to malformed markers).
    const { summary, extracted } = parseSummaryWithTaskState(raw);
    if (!summary) throw new Error("Summary is empty");
    // C1 (error-hardening §9): advisory-only hallucination check — flag distinctive facts (paths / large
    // numbers) that appear in the summary but not in its source. Observability, gated to when diagnostics
    // are on; never rejects/retries or edits the summary (summaries legitimately omit facts).
    if (isUsageLogEnabledSync()) {
      const sourceText = typeof user.content === "string" ? user.content : "";
      const unverified = findUnverifiedFacts(summary, sourceText);
      if (unverified.length) {
        console.warn(
          `[compaction] summary has ${unverified.length} fact(s) absent from the source (possible hallucination): ${unverified.slice(0, 8).join(", ")}`,
        );
      }
    }
    return { summary, extracted };
  };

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
  const commitCompaction = (convId: string | null, state: CompactionState | null) => {
    const savings = state ? compactionSavings(state) : null;
    const compactedNow = !!savings && (savings.summarizedTurns > 0 || savings.dedupedReads > 0);
    if (convId && convId !== convIdRef.current) {
      const cached = convId ? compactionCacheRef.current.get(convId) : undefined;
      const ctxTokens = cached?.ctxTokens ?? 0;
      const manual = cached?.manual ?? false;
      compactionCacheRef.current.set(convId, { state, manual, compacted: compactedNow, ctxTokens });
      persistCompaction(convId, { state, manual, ctxTokens });
      return;
    }
    compactionRef.current = state;
    setCompacted(compactedNow);
    persistCompaction(convId);
  };

  /**
   * Compose messages[0], and build the tool array.
   *
   * Both are pulled out of send() so seed generation can obtain the EXACT prefix the app sends without driving the UI and without
   * reimplementing the composition. A seed is keyed on the bytes of [messages[0] + tools]; if the generator built those bytes by
   * its own route, a divergence would show up as a seed that silently never matches. One code path, two callers.
   */
  /**
   * messages[0] and the tool array both come from src/lib/ai/promptPrefix.ts, so send() and the seed generator compose them by
   * exactly one code path. The native schemas are fetched over IPC here; the generator reads them straight off disk.
   */
  const composeSystemPrompt = (): string =>
    buildSystemPrompt(mode, { toolsReady: toolsReadyRef.current, memory: isMemoryFilesAvailable() });

  const buildToolSet = async () =>
    buildToolSet_(mode, toolsReadyRef.current ? await listTools("openai") : [], { memory: isMemoryFilesAvailable() });

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
    if (!ROUTED_TOOLS[mode].has(name) && !content.startsWith("Unknown tool")) return content;
    try {
      const all = (await listTools("openai")) as Array<{ function?: { name?: string; parameters?: unknown } }>;
      const hit = all.find((t) => t.function?.name === name);
      if (!hit) return `${content}\n\n${unknownToolResult(name, all.flatMap((t) => (t.function?.name ? [t.function.name] : [])))}`;
      return ROUTED_TOOLS[mode].has(name) ? content + routedFailureHint(name, hit.function?.parameters) : content;
    } catch {
      return content; // The hint is an optimisation; never let looking it up turn a tool error into a broken turn.
    }
  };

  const maybeCompact = async (
    opts: {
      force?: boolean;
      signal?: AbortSignal;
      log?: { actor: string; convId?: string; turnId?: string };
      /** The round's own buffer and conversation, captured before any await. Omitted → the active view (manual "compact now"). */
      messages?: ApiMsg[];
      convId?: string | null;
    } = {},
  ): Promise<CompactionState | null> => {
    // Both captured before the first await: everything below must act on the conversation this round started in.
    const targetConvId = opts.convId !== undefined ? opts.convId : convIdRef.current;
    const full = opts.messages ?? convoRef.current;
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    const currentTokens = countMessagesTokens(full);
    // Hybrid working-set budget: cap the trigger/target at an absolute token budget (configurable in
    // Settings → General, default 120K, 0 = off) so a large-window model can't defer compaction until
    // it has hoarded hundreds of thousands of tokens. null when disabled → original window-relative path.
    const budget = resolveHybridBudget(cw, getContextBudgetK());
    // prev: pass in the previous compaction state so planCompaction "freezes the boundary" — reuse the old summary boundary until the tail again
    // exceeds the threshold; if coversCount is stable, the old summary body is reused below, so the post-compaction prefix is byte-stable and hits the prefix cache (§4.1).
    const res = planCompaction(full, {
      contextWindow: cw,
      currentTokens,
      force: opts.force,
      prev: compactionRef.current,
      triggerTokens: budget?.triggerTokens,
      targetTokens: budget?.targetTokens,
    });
    if (!res) {
      // Below the threshold: if it is not a manual compaction, clear it (wire view == full conversation, most stable prefix cache); a manual compaction is kept as-is.
      if (!manualCompactRef.current) {
        commitCompaction(targetConvId, null); // Sync to disk after clearing (remove the old snapshot)
        return null;
      }
      return compactionRef.current;
    }
    const { plan, summarizeMessages } = res;
    let summaryText: string | null = null;
    let reuseCount = 0;
    if (plan.coversCount > 0) {
      const prev = compactionRef.current;
      const prevReuse = prev?.reuseCount ?? 0;
      const canReuse = !!prev?.summaryText && prev.coversCount === plan.coversCount;
      if (canReuse && prevReuse < MAX_SUMMARY_REUSE) {
        // Coverage unchanged and under the reuse cap → reuse the old summary (saves a model call), but
        // COUNT it so a slowly-growing conversation can't keep an unverified summary alive forever (§B1).
        summaryText = prev!.summaryText;
        reuseCount = prevReuse + 1;
      } else {
        // Regenerate. Three shapes:
        //  - forced-from-scratch: the reuse cap was hit (canReuse but over MAX) → re-read the FULL covered
        //    span from the verbatim originals, so drift/errors reset (§B1). Planner returned no
        //    summarizeMessages (freeze-reuse signals reuse with an empty list), so reconstruct the span.
        //  - incremental (§8.1): the boundary advanced past a usable prior summary → summarise only
        //    (prior summary + the newly-covered span), avoiding a from-scratch pass over everything.
        //  - first summary: no prior summary → from-scratch of the covered span.
        const hasSystem = full[0]?.role === "system";
        const body = hasSystem ? full.slice(1) : full;
        const prevCovers = prev?.coversCount ?? 0;
        const canIncrement =
          !canReuse && !!prev?.summaryText && prevCovers > 0 && prevCovers < plan.coversCount;
        const toSummarize = canIncrement
          ? body.slice(prevCovers, plan.coversCount) // only the newly-folded messages
          : summarizeMessages.length
            ? summarizeMessages
            : body.slice(0, plan.coversCount); // full covered span (first summary / forced reset)
        const priorSummary = canIncrement ? prev!.summaryText : null;
        try {
          const { summary, extracted } = await summarizeHistory(toSummarize, opts.signal, opts.log, priorSummary);
          summaryText = summary;
          // The guarantee: capture any mission/plan/constraints from the span being discarded into Task
          // Memory, non-destructively. Fills an empty brief or refreshes a prior auto-extracted one (§B2),
          // never clobbering a model-authored brief. See docs/context-memory-tiers-design.md §5.3.
          if (extracted) {
            const convId = opts.log?.convId ?? convIdRef.current;
            const prevTm = taskMemoryFor(convId);
            const merged = mergeExtracted(prevTm, extracted);
            if (merged.notes !== prevTm.notes) setTaskMemoryFor(convId, merged);
          }
        } catch {
          summaryText = null; // Summary failed → fall back to dedup-only (buildWireContext ignores an empty summary)
        }
        reuseCount = 0; // fresh summary
      }
    }
    const next: CompactionState = { ...plan, summaryText, reuseCount };
    if (opts.force) manualCompactRef.current = true;
    commitCompaction(targetConvId, next);
    // Refresh the progress bar immediately: estimate usage from the post-compaction wire size, without waiting for the next
    // request. Only meaningful for the conversation actually on screen — a background round must not move the active view's bar.
    if (!targetConvId || targetConvId === convIdRef.current) {
      setCtxTokens(countMessagesTokens(buildWireContext(full, next)));
    }
    return next;
  };

  /** The manual "compact now" button: compact once ignoring the auto threshold, but disallowed when usage is too low (<20%), reporting the result. */
  const compactNow = async () => {
    if (compacting || loading) return;
    // When usage is below 20% of the window AND below any absolute budget, there is too little content
    // and compaction is meaningless, so reject directly (consistent with the button's disabled condition).
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    const budgetK = getContextBudgetK();
    const overBudget = budgetK > 0 && contextTokensRef.current >= budgetK * 1000;
    if (!overBudget && cw > 0 && contextTokensRef.current / cw < MANUAL_COMPACT_MIN_PCT) {
      toast.message(t("chat.compactMinTitle"));
      return;
    }
    setCompacting(true);
    try {
      await maybeCompact({ force: true });
      const s = compactionSavings(compactionRef.current);
      if (s.summarizedTurns === 0 && s.dedupedReads === 0) {
        toast.message(t("chat.compactTooShort"));
      } else {
        toast.success(t("chat.compactDone"));
      }
    } finally {
      setCompacting(false);
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
  const execToolCall = async (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    // Usage-log attribution: "main" for the primary agent, "sub:<id>" when a sub-agent is acting.
    // Every tool call funnels through here, so this is the one place a delegation's actions are recorded.
    actor = "main",
  ): Promise<string> => {
    ctx.status(toolStatusText(name, args));
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
    // Consent policy lives in toolNeedsConsent (constants.ts) so mode rules can grow in one place. Currently: dev mode
    // confirms sensitive tools, daily mode runs them directly. The "always" allowance still short-circuits repeat prompts.
    if (toolNeedsConsent(name, mode) && !allowedToolsRef.current.has(name)) {
      const previewDiff = await buildPreviewDiff(name, args);
      // §A1: warn when this mutation targets a file the model only "knows" from compressed history — its
      // latest read/write was folded into the summary and never re-verified at the tail. Pure lookup, no cost.
      const targetPath =
        typeof args.path === "string" ? args.path : typeof args.destination === "string" ? args.destination : "";
      const warning =
        targetPath && pathProvenance(convoRef.current, compactionRef.current, targetPath) === "digest-only"
          ? t("chat.provenanceWarning")
          : null;
      const decision = await requestConsent(ctx.convId, name, args, previewDiff, warning);
      if (decision === "always") allowedToolsRef.current.add(name);
      if (decision === "no") {
        const denied = "The user rejected this operation.";
        ctx.push({ kind: "tool", name: displayName, args, ok: false, result: denied });
        // A refused call is logged too: "what did the agent try to do" is exactly the question the log
        // exists to answer, and a silent gap there reads as if it never asked.
        log(false, denied, true);
        return denied;
      }
    }
    const result = await callTool(name, args);
    ctx.push({ kind: "tool", name: displayName, args, ok: result.ok, result: result.content });
    log(result.ok, result.content);
    // The schema hint is model-facing only: the bubble above and the log entry keep the tool's own error, because a parameter
    // dump is what the model needs to retry and noise to everyone reading the timeline.
    return result.ok ? result.content : await explainToolFailure(name, result.content);
  };

  // Run a subagent: run an independent small loop with its dedicated system prompt + restricted tool set, and return the final conclusion text.
  const runSubAgent = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const agentId = String(rawArgs.agent ?? "");
    const task = String(rawArgs.task ?? "").trim();
    const def = SUBAGENTS.find((a) => a.id === agentId);
    if (!def) return `Unknown subagent: ${agentId}`;
    if (!task) return "task must not be empty.";

    // Repeat-delegation guard. Scoped to this turn, and reset by turnId rather than cleared anywhere:
    // there is no single point where a turn is known to have ended (it can abort, be cancelled, or run in
    // the background while another conversation is active), so keying the bucket is the only way that
    // cannot leak one turn's delegations into the next.
    const bucket = delegationsRef.current;
    if (bucket.turnId !== ctx.turnId) {
      bucket.turnId = ctx.turnId;
      bucket.done = [];
    }
    const repeat = findRepeatDelegation(agentId, task, bucket.done);
    if (repeat) {
      const answer = repeatDelegationResult(repeat);
      // Shown and logged like any other delegation, or the saving would be invisible: a delegation that
      // silently never happened looks in the timeline exactly like one that was never requested.
      ctx.push({ kind: "tool", name: `run_subagent → ${agentId}`, args: { agent: agentId, task }, ok: true, result: answer });
      logSubagentRun({
        agent: agentId, task, rounds: 0, steps: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        ms: 0, ok: true, error: "repeat: answered from an earlier delegation this turn",
        convId: ctx.convId, turnId: ctx.turnId,
      });
      return answer;
    }
    ctx.status(t("chat.subagentProcessing", { agent: agentId }));

    // Usage-log bookkeeping for this delegation. The sub-agent's own rounds are counted here rather
    // than read back off turnUsageRef: that ref accumulates every conversation generating at the same
    // time, so a background turn running in parallel would be billed to whichever delegation was open.
    const startedAt = Date.now();
    const actor = `sub:${agentId}`;
    const subLog = { actor, convId: ctx.convId, turnId: ctx.turnId };
    const subUsage = { prompt: 0, completion: 0, total: 0 };
    let rounds = 0;

    // Show a "delegate" bubble, so the user can see what task the main model handed to which subagent.
    // Its `steps` grow in place as the subagent works, so the delegation is not an opaque wait.
    const steps: SubAgentStep[] = [];
    // Typed as the tool variant, not the DisplayMsg union: `...bubble` below must keep the tool shape.
    let bubble: Extract<DisplayMsg, { kind: "tool" }> = {
      kind: "tool",
      name: `run_subagent → ${agentId}`,
      args: { agent: agentId, task },
      ok: true,
      result: task,
      steps,
    };
    ctx.push(bubble);
    lastSubagentStepsRef.current = steps; // consumed by the persist step once this delegation returns

    // The subagent's internal tool calls are nested INTO the delegate bubble above rather than pushed as
    // sibling bubbles. Siblings were the obvious approach and are wrong: the whole delegation persists as
    // a single run_subagent tool message, so N sibling bubbles seen live would collapse to one on reload.
    // Nesting keeps live and reloaded identical, because `steps` is persisted with that one message
    // (StoredMessage.steps) — and the user still sees every operation.
    const collectCtx: RunCtx = {
      ...ctx,
      push: (m) => {
        if (m.kind !== "tool") return; // the subagent has no path to choice cards / usage rows
        steps.push({ name: m.name, args: m.args, ok: m.ok, result: m.result });
        // New object identity so memoized message components re-render; the array is copied for the same reason.
        const next = { ...bubble, steps: [...steps] };
        replaceDisplay(bubble, next);
        bubble = next;
      },
    };

    // Subagent tool set: reuse the same tool set, filtered by def.tools (the subagent does not include run_subagent, so there is no nesting).
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
    const sys = [
      workdir ? `${def.systemPrompt}\n${workdirPrompt(workdir)}\n${WORKDIR_SCOPE_RULE}` : def.systemPrompt,
      SUBAGENT_TOOL_DISCIPLINE,
      sandboxEnvHint(sandboxStatusRef.current),
    ].join("\n");
    let convo: ApiMsg[] = [
      { role: "system", content: sys },
      { role: "user", content: task },
    ];

    // Settle the bubble on the conclusion the sub-agent reported. Live and reloaded views must agree, and the
    // reload path rebuilds `result` from the persisted tool content — which is the conclusion, not the task.
    // Without this the bubble showed the task while running and the conclusion after reopening.
    const finish = (conclusion: string, error?: string): string => {
      const next = { ...bubble, result: conclusion, steps: [...steps] };
      replaceDisplay(bubble, next);
      bubble = next;
      // One line per delegation, beside the per-round model entries and the per-call tool entries it
      // produced: the summary answers "what did handing this off cost", the others show how it got there.
      logSubagentRun({
        agent: agentId,
        task,
        rounds,
        steps: steps.length,
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
        bucket.done.push({ agent: agentId, task, subject: delegationSubject(task), conclusion });
      }
      return conclusion;
    };

    // No upper limit on subagent rounds: loop until the subagent produces final text, or the user interrupts (using this run's own signal).
    while (true) {
      if (ctx.signal.aborted) return finish("(canceled)", "cancelled");
      ctx.status(t("chat.subagentThinking", { agent: agentId }));
      // The subagent bypasses the main wire pipeline, so the policy is applied here too — without it the thinking text carried
      // on `convo` below would reach every provider, including the ones that reject the field.
      const data = await requestChat(applyReasoningPolicy(convo, isLocalModel), subTools, ctx.signal, undefined, subLog);
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
          const content = await execToolCall(collectCtx, tc.function.name, a, `${agentId}→${tc.function.name}`, actor);
          return { tc, content };
        };

        // Same batching rule as the main loop: consecutive read-only calls run concurrently, everything else serial.
        const groups: (typeof msg.tool_calls)[] = [];
        for (const tc of msg.tool_calls) {
          const prev = groups[groups.length - 1];
          if (
            prev &&
            PARALLEL_SAFE_TOOLS.has(tc.function.name) &&
            PARALLEL_SAFE_TOOLS.has(prev[0].function.name)
          ) {
            prev.push(tc);
          } else {
            groups.push([tc]);
          }
        }

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

  // Runtime skills = the installed skills the user enabled + conditionally-equipped built-in skills: when commands actually run in the sandbox,
  // the "document / media processing toolbox" is automatically attached (so the model directly uses the tools preinstalled in the image, rather than suggesting a pip/apt install).
  // Built-in skills are not persisted to storage and do not appear in the skills panel; they are rebuilt on every send based on the sandbox status, taking effect immediately on ready/downgrade.
  const runtimeSkills = () => {
    // The installed skills the user enabled + the enabled project skills (.claude/.cursor/.zeraix) + conditionally-equipped built-in skills.
    const list = [...enabledSkills(installedSkillsRef.current), ...projectSkillsRef.current];
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

  // load_skill: return the full instructions of an enabled skill (progressive disclosure), fed back to the model; also show a bubble.
  const loadSkill = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const id = String(rawArgs.id ?? "");
    const enabled = runtimeSkills();
    // The built-in toolbox is advertised in messages[0] unconditionally — it has to be, or the prompt prefix would differ per
    // install — so the model can legitimately ask for it. But its whole toolchain (imagemagick, ffmpeg, pandoc, OCR) lives in the
    // sandbox image, so handing over the instructions while running natively would send it off to call tools that do not exist.
    // Only resolve it while the sandbox is actually up.
    const sandboxUp = isSandboxEngine(sandboxStatusRef.current?.active);
    const text =
      id === SANDBOX_TOOLBOX_SKILL.id && !sandboxUp
        ? `Skill not enabled: ${id} requires the Linux sandbox, which is not running right now (commands are executing directly on the host). ` +
          "Its tools are not installed on this machine — do not try to run them. Tell the user that media / document processing needs the sandbox, " +
          "and that it can be restarted from the sandbox status indicator."
        : getSkillInstructions(sandboxUp ? [...enabled, SANDBOX_TOOLBOX_SKILL] : enabled, id);
    const ok = !text.startsWith("Skill not enabled");
    ctx.status(ok ? t("chat.loadingSkill", { id }) : t("chat.skillDisabled"));
    ctx.push({ kind: "tool", name: `load_skill → ${id}`, args: { id }, ok, result: text });
    return text;
  };

  // openBrowser: open the built-in browser panel on the right and (optionally) navigate; show a bubble and return the text fed back to the model.
  const openBrowserAction = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const url = String(rawArgs.url ?? "").trim();
    if (url) detectServices(url); // A local address opened by the AI is also registered with the running indicator
    requestOpenBrowser(url);
    const result = url ? `Opened the built-in browser and navigated to ${url}` : "Opened the built-in browser";
    ctx.push({ kind: "tool", name: "openBrowser", args: { url }, ok: true, result });
    return `${result}.`;
  };

  /**
   * Write a generated artifact into the working directory and return its absolute path (null when
   * tools are unavailable or the write fails — the caller treats the path as a bonus, never a
   * precondition). fetch() handles both artifact shapes uniformly: a data: URL decodes locally, a
   * vendor URL downloads once, which also rescues the pixels before the vendor link expires.
   */
  const saveGeneratedArtifact = async (src: string, mime: string, prompt: string): Promise<string | null> => {
    if (!toolsReady) return null;
    try {
      const bytes = await (await fetch(src)).arrayBuffer();
      // Name from the prompt so a directory of generated images stays readable; saveAttachment
      // sanitizes the name and de-duplicates collisions (-1/-2…), so no timestamp is needed.
      const slug =
        prompt
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .split("-")
          .slice(0, 6)
          .join("-") || "image";
      const ext = /png|jpeg|jpg|webp|gif/.exec(mime)?.[0].replace("jpeg", "jpg") ?? "png";
      return await saveAttachment({ name: `generated-${slug}.${ext}`, bytes });
    } catch {
      return null; // The user already has the image on screen; a missing file is a degraded path, not a failure.
    }
  };

  // image_generation: text-to-image through the user's own provider key. The engine is derived from
  // the configured keys (their chat vendor first, then any keyed vendor) — never picked by the model
  // and never shown in the model picker. See docs/generation-capabilities-design.md.
  const generateImageAction = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const prompt = String(rawArgs.prompt ?? "").trim();
    if (!prompt) return "(image_generation is missing prompt)";

    ctx.status?.(t("image.generating"));
    const res = await generate({ capability: "image_generation", prompt, chatProviderId: activeModel?.providerId });

    if (!res.ok) {
      ctx.push({ kind: "tool", name: "image_generation", args: { prompt }, ok: false, result: t(imageErrorKey(res.error.kind)) });
      // The model relays this to the user in its own words, so it must be plain and actionable.
      return `Image generation failed (${res.error.kind}): ${res.error.message}`;
    }

    // The artifact must NOT be fed back to the model: a base64 payload is 1-3 MB and would be
    // re-sent on every subsequent turn, wrecking the context window and the prompt cache.
    // The bubble carries the pixels; the model gets metadata only.
    ctx.push({
      kind: "tool",
      name: "image_generation",
      args: { prompt },
      ok: true,
      result: res.artifact.src,
      image: res.artifact.src,
      servedBy: res.artifact.servedBy,
    });
    // Stash the artifact so the persist step can store it (display-only) and the image survives a conversation switch.
    lastImageArtifactRef.current = { image: res.artifact.src, servedBy: res.artifact.servedBy };

    // Also drop the pixels into the working directory. The artifact reaches the renderer as a data: or
    // vendor URL, neither of which exists for the sandbox — so a model asked to "generate frames, then
    // stitch them with ffmpeg" would find nothing on disk and fall back to drawing the frames in code.
    // A real path is what makes a generated image composable with every other tool. Best-effort: the
    // image is already shown to the user, so a failed write must not turn into a failed generation.
    const savedPath = await saveGeneratedArtifact(res.artifact.src, res.artifact.mime, prompt);

    return (
      `Generated the image with ${res.artifact.servedBy}. It is already displayed to the user — do not repeat the URL or embed it in markdown.` +
      (savedPath
        ? ` The file is saved in the working directory at ${savedPath} — use that path if you need to process it further (edit, convert, compose into a video); do not redraw it in code.`
        : "")
    );
  };

  // save_memory: write a memory as a standalone Markdown file (retained across conversations), show a bubble, and feed the result back to the model.
  const saveMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const title = String(rawArgs.title ?? "").trim();
    const content = String(rawArgs.content ?? "").trim();
    const id = typeof rawArgs.id === "string" && rawArgs.id.trim() ? rawArgs.id.trim() : undefined;
    if (!title && !content) return "(save_memory is missing title / content)";
    const saved = await saveMemoryFile({ title, content, id });
    if (!saved) {
      ctx.push({ kind: "tool", name: "save_memory", args: { title }, ok: false, result: "Failed to save memory" });
      return "Failed to save memory (the current environment does not support it, or a write error occurred).";
    }
    ctx.push({ kind: "tool", name: "save_memory", args: { title: saved.title }, ok: true, result: `Remembered: ${saved.title}` });
    return `Saved the memory "${saved.title}" (id: ${saved.id}).`;
  };

  // delete_memory: permanently delete a memory by id (deleting its Markdown file), show a bubble, and feed it back to the model.
  const deleteMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const id = String(rawArgs.id ?? "").trim();
    if (!id) return "(delete_memory is missing id)";
    const ok = await deleteMemoryFile(id);
    ctx.push({
      kind: "tool",
      name: "delete_memory",
      args: { id },
      ok,
      result: ok ? `Deleted memory ${id}` : `Memory ${id} not found`,
    });
    return ok ? `Permanently deleted the memory (id: ${id}).` : `No memory found with id ${id} (it may already be deleted).`;
  };

  // search_memory: retrieve relevant memories from the memory store by query (reads the current file each time → memories added / modified in this conversation are immediately visible),
  // formatted and fed back to the model as the tool result. This is the retrieval side of "RAG": results land at the end of the wire, do not enter the frozen prefix, and do not disturb the prefix cache.
  const searchMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const query = String(rawArgs.query ?? "").trim();
    const limit = Math.max(1, Math.min(50, Number(rawArgs.limit) || 20));
    const all = await listMemoryFiles(); // Reads the current file each time: additions / modifications are immediately visible
    const hits = searchMemories(all, query, limit);
    ctx.push({
      kind: "tool",
      name: "search_memory",
      args: query ? { query } : {},
      ok: true,
      result: `Retrieved ${hits.length}/${all.length} memories`,
    });
    if (all.length === 0) return "The memory store is empty: no long-term memories about the user have been saved yet.";
    if (hits.length === 0) return `No memories related to "${query}" (${all.length} saved in total).`;
    const body = hits
      .map((m) => `- [${m.id}] ${m.title}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 800)}`)
      .join("\n");
    const scope = query ? `Memories related to "${query}"` : "All saved memories";
    return `${scope} (${hits.length}/${all.length}, earlier means more relevant / more recent):\n${body}`;
  };

  // browser: operate the built-in browser via CDP (read / list links / click / type / navigate), with the result fed back to the model.
  const browserControl = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const action = String(rawArgs.action ?? "") as BrowserAction;
    ctx.status(t("chat.browserAction", { action }));
    // When the AI operates the browser, ensure the panel is visible (the user may have manually closed it); no url, just expand without re-navigating.
    // Only the active conversation drives the browser panel / halo; a background conversation operates silently.
    if (ctx.convId === convIdRef.current) {
      requestOpenBrowser();
      // Mark "the AI is operating the browser": turn on the glowing halo, lasting until the end of this round (closed in send's finally),
      // so the halo spins continuously during multi-step browser operations, rather than flickering on each call.
      setBrowserBusy(true);
    }
    const res = await browserAction(action, rawArgs);
    const text = res.ok
      ? typeof res.result === "string"
        ? res.result
        : JSON.stringify(res.result)
      : `Operation failed: ${res.error ?? "unknown error"}`;
    ctx.push({ kind: "tool", name: `browser → ${action}`, args: rawArgs, ok: res.ok, result: text });
    return text;
  };

  // ask_user: render a choice card and wait for the user to click; return the text fed back to the model.
  const askUserChoice = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const question = String(rawArgs.question ?? "").trim();
    const options = Array.isArray(rawArgs.options)
      ? rawArgs.options.map((o) => String(o)).filter(Boolean)
      : [];
    if (!question && options.length === 0) return "(ask_user is missing question / options)";
    const id = ++choiceIdRef.current;
    // The choice card stays globally displayed (interactive prompts must be answerable, otherwise a background conversation would be stuck forever).
    pushDisplay({ kind: "choice", id, question, options, selected: null });
    // Trigger condition 4: question notification — the AI needs user input to continue (only pops when the app is unfocused).
    notifyQuestion(ctx.convId, question);
    // Store the resolver keyed by card id (concurrent questions do not overwrite each other and are answered independently).
    return new Promise<string>((resolve) => {
      choiceResolversRef.current.set(id, { convId: ctx.convId, resolve });
    });
  };

  // The user clicks an option on a card: fetch the corresponding resolver by id, mark the card as selected, and wake its waiting Promise.
  // useCallback keeps the reference stable, to avoid invalidating the memoized MessageItem on every render.
  const answerChoice = useCallback((id: number, value: string, discuss: boolean) => {
    const entry = choiceResolversRef.current.get(id);
    if (!entry) return; // Already handled / no such card, ignore
    choiceResolversRef.current.delete(id);
    setDisplay((d) =>
      d.map((m) => (m.kind === "choice" && m.id === id ? { ...m, selected: value } : m)),
    );
    entry.resolve(
      discuss
        ? "The user chose \"discuss this question\" and wants to talk it through further. Do not draw a conclusion directly; first ask the user about this question or provide deeper analysis, and continue only after discussing it with them."
        : `The user chose: ${value}`,
    );
  }, []);

  // The implementation of "edit user message / regenerate": updated to the latest closure on every render (capturing the latest send / states),
  // so the stably-referenced regenerate / editUser below call the latest version when clicked (avoiding useCallback capturing a stale send).
  const resendRef = useRef<(displayIndex: number, newText: string, feedbackNudge?: string | null) => void>(() => {});

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

  // Discard all pending-answer ask_user prompts of a conversation (unblocking them with the given text as the result). Used to release by conversation on cancel / clear.
  const dropChoicesFor = (convId: string | null, message: string) => {
    for (const [id, e] of choiceResolversRef.current) {
      if (e.convId === convId) {
        choiceResolversRef.current.delete(id);
        e.resolve(message);
      }
    }
  };

  // Attachment size limits: images go multimodal (≤10MB); text-type files are inlined into the prompt, with a stricter limit (≤2MB) to avoid consuming too many tokens.
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const pushAttachment = (a: Attachment) => setAttachments((list) => [...list, a]);

  // Select a file of any type: images defer the upload decision to send time based on the model (local → base64, not uploaded; cloud → uploaded to OSS at send time);
  // text-type files are read as text and inlined; binary/oversized files attach only a file-name note.
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
      } else if (file.size > MAX_TEXT_BYTES) {
        // Too large to inline: capture the host path, and copy it to the working directory (Electron) at send time for the tools to process.
        pushAttachment({ ...meta, kind: "binary", hostPath, file });
        setError(t("chat.fileTooLarge", { name: file.name }));
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result ?? "");
          // Treat content with NUL bytes as binary and do not inline it (to avoid stuffing garbled text into the prompt).
          if (text.includes("\u0000")) pushAttachment({ ...meta, kind: "binary", hostPath, file });
          else pushAttachment({ ...meta, kind: "text", text });
        };
        reader.onerror = () => pushAttachment({ ...meta, kind: "binary", hostPath, file });
        reader.readAsText(file);
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

  // opts is used for programmatic sends (e.g. the home page's pending auto-send / queue resume); when omitted, the input box / attachment state is used.
  const send = async (opts?: { text?: string; attachments?: Attachment[]; _fromQueue?: boolean }) => {
    const text = (opts?.text ?? input).trim();
    const atts = opts?.attachments ?? attachments; // Snapshot: cleared later
    if (!text && atts.length === 0) return;
    // Generation in progress: enqueue the new message (auto-sent in order after this round ends) rather than dropping it. _fromQueue is the queue resume itself, so let it through.
    if (loading && !opts?._fromQueue) {
      const convId = convIdRef.current;
      if (convId) {
        enqueueMessage(convId, text, atts);
        setInput("");
        setAttachments([]); // The attachment objects have been handed over to the queue (their previewUrl is released at send time), so do not revoke here
      }
      return;
    }
    // Do not send while an image is still uploading to OSS, to avoid a missing publicUrl. Local models are the exception: they use inline base64 (the bytes are on this machine) and need not wait for an upload.
    if (!isLocalModel && atts.some((a) => a.kind === "image" && a.uploading)) {
      setError(t("chat.imageUploading"));
      return;
    }
    // Local models (127.0.0.1 llama-server) need no API key (the proxy layer substitutes "local" as a placeholder, see chatOnce).
    if (!activeModel || !endpoint || !modelName || (!apiKey.trim() && !isLocalEndpoint(endpoint))) {
      setError(t("chat.noModel"));
      return;
    }
    // A local model is selected but llama-server is not running (e.g. after an app restart): do not auto-start, pop a dialog guiding the user to start it manually in the model library.
    if (isLocalModel && localLlmReady === false) {
      setLocalStartDialog(true);
      return;
    }

    // Working-directory policy (only when Electron tools are available):
    //  - Dev mode: a folder must be explicitly chosen first, otherwise the send is rejected and the settings area is expanded to guide the choice;
    //  - Daily mode: optional; if not chosen, it falls back to the default working directory (under userData/agent, created once on the first message only).
    let effectiveWorkdir = workdir;
    if (toolsReady) {
      if (mode === "dev" && !workdirChosen) {
        // If the input box already has a path (e.g. a default prefill) → adopt and apply it directly, without first clicking "apply" manually; only intercept when it is truly empty.
        // Fall back to reading the persisted AGENT_WORKDIR_KEY: after the home page WorkdirSelector chooses a directory it is already persisted, but the permanently-mounted chat page may
        // still have workdirChosen false and workdirInput empty because it did not receive WORKDIR_SET_EVENT — in that case recover it from storage, to avoid a false interception.
        const savedDir = getStorage(AGENT_WORKDIR_KEY);
        const dir = workdirInput.trim() || (typeof savedDir === "string" ? savedDir.trim() : "");
        if (dir) {
          try {
            const resolved = await setWorkingDir(dir);
            effectiveWorkdir = resolved;
            setWorkdir(resolved);
            setWorkdirInput(resolved);
            setWorkdirChosen(true);
            putStorage(AGENT_WORKDIR_KEY, resolved); // Persist, reused across pages / reopens
          } catch (e) {
            setError(t("chat.workdirSetFail", { err: e instanceof Error ? e.message : String(e) }));
            setSettingsOpen(true);
            return;
          }
        } else {
          setError(t("chat.devNeedWorkdir"));
          setSettingsOpen(true);
          return;
        }
      }
      if (mode === "daily" && !workdirChosen && !defaultAppliedRef.current) {
        try {
          const dir = await defaultWorkingDir();
          effectiveWorkdir = dir;
          defaultAppliedRef.current = true;
          setDefaultApplied(true);
          setWorkdir(dir);
          setWorkdirInput(dir);
        } catch (e) {
          setError(t("chat.workdirDefaultFail", { err: e instanceof Error ? e.message : String(e) }));
          return;
        }
      }
    }

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
    // Images are persisted too, not just binaries: image_url only lets the model LOOK at the picture.
    // Anything it is asked to DO with it — edit the pixels, run OCR, feed it to ffmpeg — happens through
    // sandbox commands, which can only reach files under the working directory. Without this the model
    // has to ask the user to copy the file in by hand.
    const savedPaths = new Map<number, string>();
    if (toolsReady) {
      for (const a of atts) {
        if (a.kind !== "binary" && a.kind !== "image") continue;
        try {
          if (a.hostPath) {
            // A real disk file: the main process does a kernel-level copy by host path, with bytes not going through IPC (efficient even for large files).
            savedPaths.set(a.id, await saveAttachment({ name: a.name, srcPath: a.hostPath }));
          } else if (a.file && a.size <= 100 * 1024 * 1024) {
            // A synthetic file (a Blob dragged out of the webview / generated) has bytes only in memory with no other source — pass them in via IPC to persist.
            savedPaths.set(a.id, await saveAttachment({ name: a.name, bytes: await a.file.arrayBuffer() }));
          } else if (a.kind === "image" && a.url) {
            // A URL-only image: no local File / hostPath, only a link — happens when the user edits/resends a
            // message (images are rebuilt from their stored URLs), on a home-page handoff, or from restored
            // history. Materialize it from the URL (OSS link or data: URI) so it too exists in the working
            // directory and can be EDITED, not just viewed; the main process does the download (no renderer CORS).
            savedPaths.set(a.id, await saveAttachment({ name: a.name, url: a.url }));
          }
        } catch (e) {
          // Surface the reason rather than swallowing it: a silent failure here is exactly why the model
          // later reports "the image isn't in the working directory" and fabricates a replacement.
          console.error(`[attachment] failed to save "${a.name}" to the working directory:`, e);
        }
      }
    }
    // Assemble this round's content:
    //  - text-type attachments' content is concatenated into the body (separated by file name); binary/oversized files note the persisted path (or leave just a note);
    //  - images go multimodal via image_url. When there are images, use a content array, otherwise a plain string (compatible with non-vision models).
    //    Cloud models use the OSS publicUrl (the provider's server fetches it itself); local llama-server cannot fetch remote URLs
    //   (it reports 400 Failed to load image / download failure), so switch to an inline base64 data URI — usable offline too.
    //    The byte source prefers a.file (the File object, unaffected by the previewUrl being revoked — the send flow releases the preview blob URL first),
    //    falling back to fetch(a.url) (converting the OSS link to base64).
    const toDataUrl = async (src: Blob | string): Promise<string> => {
      const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
    };
    const imageAtts = atts.filter((a) => a.kind === "image" && (a.url || a.file));
    const imageParts: { type: "image_url"; image_url: { url: string } }[] = [];
    for (const a of imageAtts) {
      let url = a.url || "";
      if (isLocalModel && a.file) {
        try {
          url = await toDataUrl(a.file); // Original bytes → data URI (bypassing OSS/CDN, avoiding WebP transcoding and usable offline)
        } catch {
          url = a.url || ""; // Read failed: fall back to the URL (likely still fails, but at least does not drop the message)
        }
      } else if (!isLocalModel && !url && a.file) {
        // An image attached in local mode (not uploaded), then switched to a cloud model before sending: upload to OSS now.
        try {
          url = await uploadFileToOSS(a.file, () => {});
        } catch (e) {
          setError(t("chat.uploadFail", { name: a.name, err: e instanceof Error ? e.message : String(e) }));
          setLoading(false);
          return;
        }
      }
      if (url) imageParts.push({ type: "image_url" as const, image_url: { url } });
    }
    let composed = text;
    for (const a of atts) {
      if (a.kind === "text" && a.text != null) {
        composed += `${composed ? "\n\n" : ""}----- File: ${a.name} (${formatBytes(a.size)}) -----\n${a.text}`;
      } else if (a.kind === "binary") {
        const saved = savedPaths.get(a.id);
        composed += saved
          ? `${composed ? "\n\n" : ""}[Attachment: ${a.name} (${formatBytes(a.size)}) has been saved to the working directory: ${saved} — please process this file directly with file tools or commands]`
          : `${composed ? "\n\n" : ""}[Attachment: ${a.name} (${formatBytes(a.size)}) — binary/oversized file, content not inlined]`;
      } else if (a.kind === "image") {
        // The path note is worth its tokens even for a vision model: the picture in the wire is
        // something it can only read, while this is the same picture as an editable file. It also keeps
        // a text-only model useful — the image_url part gets stripped, but the file is still there to
        // run through a command-line tool.
        const saved = savedPaths.get(a.id);
        if (saved) {
          composed += `${composed ? "\n\n" : ""}[Image: ${a.name} (${formatBytes(a.size)}) has been saved to the working directory: ${saved} — to edit or process it (crop, annotate, OCR, convert, feed to a script), work on this file directly with file tools or commands; do not ask the user to place the file anywhere]`;
        } else {
          // Save failed (or there was nothing to save from). Tell the model the truth so it does NOT
          // recreate the image from scratch — a redrawn copy differs from the original and is never what
          // the user wants. It can still see the picture via image_url above.
          composed += `${composed ? "\n\n" : ""}[Image: ${a.name} (${formatBytes(a.size)}) is attached and visible to you in this message, but it could NOT be auto-saved to the working directory. Do NOT recreate, redraw, or regenerate it from scratch — a rebuilt image will differ from the original. If you need it as an editable file on disk, ask the user to save it into the working directory (or attach it again), then edit that file.]`;
        }
      }
    }
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

    // Persistence: the conversation record is created as soon as the user starts chatting (regardless of daily / dev mode), then appended to one by one.
    const store = useAgentChatStore.getState();
    if (!convIdRef.current) {
      // Projects are grouped by folder: an explicitly chosen folder → that folder's project; not chosen in daily mode → the default project.
      convIdRef.current = store.createConversation({
        mode,
        workdir: effectiveWorkdir || undefined,
        projectWorkdir: workdirChosen ? effectiveWorkdir : undefined,
      });
      // Dev mode: firmly bind the new conversation to the currently selected model (conversation-level binding). Daily mode uses the global one by default, with no binding.
      if (mode === "dev" && selectedModelId) {
        store.setConversationModel(convIdRef.current, selectedModelId);
      }
      // Freeze messages[0] on the brand-new record (it was composed above, before this record existed).
      if (pendingSystemPromptRef.current) {
        store.setConversationSystemPrompt(convIdRef.current, pendingSystemPromptRef.current);
        pendingSystemPromptRef.current = "";
      }
    }
    store.appendMessage(convIdRef.current, {
      role: "user",
      content: text,
      // `text` is what the bubble shows; `composed` is what the model was actually sent (it also carries
      // inlined text-file contents and saved attachment paths). Store the difference so replaying this
      // conversation reproduces the message the model saw, not just the one the user typed.
      ...(composed !== text ? { wireText: composed } : {}),
      images: userImages.length ? userImages : undefined,
      files: userFiles.length ? userFiles : undefined,
      ts: Date.now(),
    });
    const userStoredIdx = (store.getConversation(convIdRef.current)?.messages.length ?? 0) - 1;

    // The conversation id this round of generation belongs to (captured as a stable local value, unaffected by switching conversations): drives the spinner on that conversation's sidebar row,
    // and lays the groundwork for later "background concurrent generation" — always record / clear by genConvId, rather than relying on the current active conversation.
    const genConvId = convIdRef.current;
    store.setConversationGenerating(genConvId, true);
    runsRef.current.set(genConvId, ctrl); // Register this conversation's run, for cancel (active conversation) / background concurrency
    // "Whether in the active view": apply view side effects only while active; a background conversation persists silently.
    const active = () => convIdRef.current === genConvId;
    // One id per generation, shared by everything this turn spends (see RunCtx.turnId).
    const turnId = `${genConvId}-${Date.now().toString(36)}`;
    const ctx: RunCtx = {
      convId: genConvId,
      turnId,
      signal: ctrl.signal,
      push: (m) => { if (active()) pushDisplay(m); },
      status: (s) => { if (active()) setStatus(s); },
    };

    try {
      // Tool set = ask_user + update_todos + load_skill + (local tools + run_subagent, Electron only).
      //
      // Every declaration here must be byte-identical across installs and independent of which keys are configured: on templates
      // that render tools BEFORE the system prompt, any difference in any declaration re-prefills the whole prompt. So nothing in
      // this array is conditional on user state — where a capability genuinely varies, the tool is still declared and its
      // unavailability is announced as a change event. Only `mode` is allowed to vary it, because messages[0] is mode-determined
      // anyway. See docs/cache-stable-prompt-context.md.
      const tools = await buildToolSet();
      // Critical-change review guard (dev mode only): when a risky path (auth / data / security …) has been changed but no reviewer was run before wrapping up,
      // inject one forced reminder and continue the loop, nudging the model to delegate a reviewer first. Cleared after a reviewer is delegated; forced at most once per round, to avoid a deadlock.
      let riskyChangePending = false;
      // Project-memory guard state: set when this turn modifies source files, cleared the moment it records
      // something. If it is still set when the turn tries to wrap up, the model gets one reminder (memoryNudged).
      let learnedWithoutRecording = false;
      let memoryNudged = false;
      let reviewForced = false;
      // Wrap-up guard: whether a tool was executed this round (including subagents). If a tool was executed yet the model ends with empty content (no user-facing
      // final answer, common when the main model "assumes it's done" and stays silent after a subagent returns a result, or writes the conclusion into reasoning),
      // inject one FINALIZE_NUDGE to nudge it to answer formally. finalizeNudged ensures at most once per round, to avoid an infinite loop.
      let didToolCall = false;
      let finalizeNudged = false;
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
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        let tz = "";
        try {
          tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        } catch {
          /* Leave empty if reading the time zone fails */
        }
        const current: ReminderState = {
          workdir: effectiveWorkdir || "",
          // The command environment, announced on change rather than baked into messages[0]. It depends on the VM being up, and
          // the VM can fall back to native mid-conversation — a system prompt frozen at the first send cannot express either.
          env: sandboxEnvHint(sandboxStatusRef.current),
          ctx: {
            date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
            model: activeModel ? `${activeModel.label} (${activeModel.model})` : "unknown",
            tz: tz || "unknown",
          },
          skills: enabled.map((s) => ({ id: s.id, description: s.description })),
          // Declared but unusable — the declaration stays byte-identical across installs, and this is what tells the model it
          // cannot actually be called (see docs/cache-stable-prompt-context.md §"Tool declarations are static").
          disabledTools: capabilityAvailable("image_generation") ? [] : ["image_generation"],
          task: renderTaskMemory(taskMemoryFor(genConvId)),
        };
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
      while (true) {
        if (ctrl.signal.aborted) return;
        ctx.status(t("chat.thinking"));
        // Wire view: the "sent to the model" version of this round's local buffer derived through the compaction plan (a background conversation does not depend on the active view).
        // Also backfill tool-call pairing as a fallback: prevents assistant.tool_calls with missing results from getting a 400 from the provider when "reopening an interrupted / backend-crashed conversation".
        let wire = sanitizeToolCallPairs(buildWireContext(convo, compaction));
        // Fold each turn's <system-reminder> block into its content — on this outgoing copy only, never on the buffer or on disk.
        // Done after compaction so a stubbed tool result keeps the event that rode it, and after the summary fold so the banner
        // stays adjacent to the text it summarises.
        wire = materializeReminders(wire);
        // Remove the app's own bookkeeping keys (rating, reminder) — this is the only place either is stripped before the body is built.
        wire = stripWireMetadata(wire);
        // Replay thinking text to local models on exactly the turns their chat template renders it back on, and to nobody else.
        wire = applyReasoningPolicy(wire, isLocalModel);
        // The runtime context (time zone, date, current model) used to be concatenated into messages[0] here on every request,
        // which re-prefilled the entire conversation from token 0 at every midnight and every model switch — on cloud models too,
        // since this path was never gated on isLocalModel. It is now announced once, when it changes, as a change event above.
        // Image handling, applied to the wire only (never the persisted buffer). `multimodal` here resolves
        // through modelAcceptsImages, which now answers "yes" unless the model is a local build with no
        // mmproj, or a provider actually rejected images for it before — so this strips only when we KNOW
        // it is needed, instead of guessing and silently dropping the user's picture. If the guess is
        // still wrong in the permissive direction, requestChat retries without images and records it.
        //  - Known text-only: strip EVERY image_url part (such a provider 400s on any image anywhere in
        //    history, even one sent turns ago to a different model).
        //  - Multimodal local model: keep inline base64 images, but downgrade remote http images (llama can't fetch them).
        //  - Multimodal cloud model: leave images as-is.
        if (!activeModel?.multimodal) wire = stripAllImagesForText(wire);
        else if (isLocalModel) wire = stripRemoteImagesForLocal(wire);
        // The interrupt-resume hint and the rating-feedback hint used to be appended here, wire-only, on the first request of the
        // round. Both are now written into the user turn itself before the loop starts (see the change-events block above), so
        // they persist and the turn renders identically on every later request.
        // Task Memory (CRITICAL tier) is no longer re-injected here on every request. Re-sending it each round kept the block
        // current but cost a full re-prefill on local models, where the hoist below drags any system message to messages[0]. The
        // brief is announced as a change event when it changes — including when the summariser extracts one during compaction,
        // which is why change events are emitted after maybeCompact rather than at the persist site.
        // Local models: strict llama.cpp chat templates reject any system message that is not at the very front. Nothing appends
        // trailing system messages any more, so this is a never-firing guard (see hoistSystemToFront) kept against future callers.
        if (isLocalModel) wire = hoistSystemToFront(wire);
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
        // Two kinds of streaming:
        //  - Daily mode: incrementally render the final reply's content / reasoning chunk by chunk; discard the body of a tool-call round (often containing reasoning remnants).
        //  - Dev-mode "phased streaming": likewise streaming, but show each "tool-call round" body as that phase's summary
        //    (phaseSummaryText strips the chain-of-thought remnants), presenting the process of "phase summary → execute → next phase summary …".
        const wantIncremental = true;
        const showPhaseSummary = mode === "dev";
        // This round's display baseline = the display array before this round started (only meaningful in the active view; a background conversation does not touch the active view).
        const liveBase = active() ? displayRef.current : [];
        // Shared by finalization / increments: rebuild this round's display as [baseline, deep-thinking?, body?] (only effective in the active view).
        // asPhase: the body is "the phase summary of a tool-call round" (dev mode) — collected into the card as a "thinking process" timeline entry,
        // rather than a standalone final reply; a final reply with no tool calls goes to assistant (a standalone bubble + action bar).
        const renderTurn = (reasoning: string, content: string, asPhase = false) => {
          if (!active()) return;
          const items: DisplayMsg[] = [];
          if (reasoning) items.push({ kind: "reasoning", content: reasoning });
          if (content) items.push(asPhase ? { kind: "phase", content } : { kind: "assistant", content });
          const next = [...liveBase, ...items];
          displayRef.current = next;
          setDisplay(next);
        };
        const onDelta =
          wantIncremental && active()
            ? (d: { content: string; reasoning: string }) =>
                // Streaming always renders incrementally as a normal reply bubble (so the final reply forms smoothly); if this round ultimately carries tool calls,
                // the finalization below with asPhase=true folds that body into the "thinking process" timeline (exactly in sync with the tools starting to execute).
                renderTurn(d.reasoning, showPhaseSummary ? phaseSummaryText(d.content) : d.content)
            : undefined;
        const data = await requestChat(wire, tools, ctrl.signal, onDelta, {
          actor: "main",
          convId: genConvId,
          turnId,
        });
        if (ctrl.signal.aborted) return;
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error(t("chat.emptyResponse"));
        // Context usage: this request's input tokens (refresh the progress bar only while active; a background conversation does not touch the current view).
        if (active()) setCtxTokens(data.usage?.prompt_tokens ?? countMessagesTokens(wire));
        // Deep thinking (a reasoning model's reasoning_content): not fed back to the model (only content/tool_calls enter convo).
        const reasoningText = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
        // Finalize this round's display: the deep-thinking block + body. A final reply with no tool calls always shows the body; the body of a tool-call round —
        // shown as a "phase summary" in dev mode (after cleanup), discarded in daily mode (consistent with non-streaming).
        const finalContent = msg.tool_calls?.length
          ? showPhaseSummary
            ? phaseSummaryText(msg.content ?? "")
            : ""
          : msg.content ?? "";
        // The phase summary of a tool-call round enters the "thinking process" timeline (asPhase); a final reply with no tool calls becomes a standalone bubble.
        renderTurn(reasoningText, finalContent, !!msg.tool_calls?.length);
        // reasoning_content rides the buffer so it is available to replay, but applyReasoningPolicy decides whether it reaches
        // the wire: local models only, and only for turns after the last user query, which is exactly what their chat template
        // renders back. Remote providers never see it — some reject the field outright.
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
          type ToolCall = (typeof calls)[number];

          // Resolve every call ONCE, before anything dispatches or groups.
          //
          // A cold tool arrives wrapped as call_tool{name, arguments} (see toolRouter.ts), and everything downstream of this
          // point keys on the tool NAME: the consent gate (toolNeedsConsent / SENSITIVE_TOOLS — open_path is routed AND
          // sensitive, so a late unwrap would run it with no confirmation prompt, and one "don't ask again" on call_tool would
          // whitelist every routed tool at once), the read-only batching below, the usage log, the risky-change and
          // project-memory guards, and the persisted display name. Resolving here means none of them need to know the
          // dispatcher exists.
          //
          // Keyed on the ToolCall object rather than tc.id: the objects are the same references the grouping and the settled
          // loop iterate, so nothing depends on ids being present or unique. `tc` itself is never rewritten — the wire and the
          // persisted tool_calls keep exactly what the model emitted, which is what keeps the prefix stable and the assistant
          // turn valid on the next request.
          const resolved = new Map<ToolCall, { name: string; args: Record<string, unknown> }>();
          for (const tc of calls) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(tc.function.arguments || "{}");
            } catch {
              /* Invalid JSON arguments, call with an empty object */
            }
            resolved.set(tc, resolveToolCall(tc.function.name, parsed));
          }
          const callOf = (tc: ToolCall) => resolved.get(tc) ?? { name: tc.function.name, args: {} };

          // ask_user: pop a choice card and wait for the user to click.
          // update_todos: update the task list above the input box.
          // load_skill: feed back the full instructions of an enabled skill as the tool result (progressive disclosure).
          // run_subagent: delegate to a subagent and feed back its final conclusion as the tool result.
          // Other tools: executed through the unified path (including sensitive-operation confirmation).
          const runToolCall = async (tc: ToolCall) => {
            const { name, args } = callOf(tc);
            const startedAt = Date.now();
            // Renderer-handled tools dispatch by name to their local handler (each closes over component
            // state); everything else falls through to execToolCall (the unified sandbox/consent path).
            // A table rather than a ternary chain so adding a tool is one line and the control flow stays flat.
            const rendererTool: Record<
              string,
              (ctx: RunCtx, a: Record<string, unknown>) => string | Promise<string>
            > = {
              ask_user: askUserChoice,
              update_todos: updateTodos,
              set_task_state: setTaskState,
              openBrowser: openBrowserAction,
              browser: browserControl,
              image_generation: generateImageAction,
              load_skill: loadSkill,
              save_memory: saveMemory,
              delete_memory: deleteMemory,
              search_memory: searchMemory,
              run_subagent: runSubAgent,
            };
            const handler = rendererTool[name];
            const content = handler
              ? await handler(ctx, args)
              : await execToolCall(ctx, name, args, name);
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
            return { tc, name, args, content };
          };

          // The model is told to issue independent calls together; awaiting them one at a time threw that away and
          // made every extra read cost another round of latency. Read-only calls the model issued together now run
          // concurrently. Only *consecutive* ones are batched, so a read can never overtake an edit issued in the
          // same round, and anything with a side effect, a consent prompt, or UI interaction stays strictly serial.
          const groups: ToolCall[][] = [];
          for (const tc of calls) {
            const prev = groups[groups.length - 1];
            if (
              prev &&
              PARALLEL_SAFE_TOOLS.has(callOf(tc).name) &&
              PARALLEL_SAFE_TOOLS.has(callOf(prev[0]).name)
            ) {
              prev.push(tc);
            } else {
              groups.push([tc]);
            }
          }

          for (const group of groups) {
            if (ctrl.signal.aborted) break;
            // Results are consumed in the original order regardless of which call settled first, so the tool
            // messages stay aligned with assistant.tool_calls.
            const settled =
              group.length > 1
                ? await Promise.all(group.map(runToolCall))
                : [await runToolCall(group[0])];

            for (const { tc, name, args, content } of settled) {
              // Delegating to a reviewer is treated as reviewed, clearing the pending-risky-change flag.
              if (name === "run_subagent" && String(args.agent ?? "") === "reviewer") {
                riskyChangePending = false;
              }
              // Recording anything at all satisfies the memory guard — the reminder exists to make the model
              // consider the question once per turn, not to demand a note per file touched.
              if (name === "remember_project") learnedWithoutRecording = false;
              // Risky-change detection: a tool that modifies source files hitting the risky-path signature (taking path-like args such as path/file/dest) → mark as pending review.
              if (MUTATING_FILE_TOOLS.has(name)) {
                learnedWithoutRecording = true;
                const pathVals = Object.entries(args)
                  .filter(([k, v]) => typeof v === "string" && /path|file|dir|dest|src|source|target|name/i.test(k))
                  .map(([, v]) => v as string);
                if (pathVals.some((p) => RISKY_PATH_PATTERN.test(p))) riskyChangePending = true;
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
              const imageArtifact =
                name === "image_generation" ? lastImageArtifactRef.current : null;
              lastImageArtifactRef.current = null;
              // Likewise for a sub-agent's inner steps: display-only, stored beside the conclusion so reopening
              // the conversation shows the same operations the user watched happen.
              const subSteps =
                name === "run_subagent" ? lastSubagentStepsRef.current : null;
              lastSubagentStepsRef.current = null;
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
                ...(imageArtifact
                  ? { image: imageArtifact.image, servedBy: imageArtifact.servedBy }
                  : {}),
                ...(subSteps?.length ? { steps: subSteps } : {}),
              });
              lastToolStoredIdx = (store.getConversation(genConvId)?.messages.length ?? 0) - 1;

              // Detect local service addresses in the tool output (e.g. an http://localhost:5173 printed by a dev server),
              // using the full output (the elided middle section may also contain a URL). Once registered, the bottom-left floating indicator displays it and polls its health.
              if (typeof content === "string") detectServices(content);
            }
          }
          // Wrap-up alignment: for any tool_call with no result yet (this round was cut short early because the user canceled), append a placeholder result,
          // ensuring assistant.tool_calls and tool results correspond one-to-one — otherwise, when continuing the chat / reopening, it would be rejected by the provider because "tool_calls were not answered".
          // The placeholder is also persisted, staying consistent with the conversation fed back to the model.
          const answered = new Set(
            convo.flatMap((mm) => (mm.role === "tool" ? [mm.tool_call_id] : [])),
          );
          for (const tc of msg.tool_calls) {
            if (answered.has(tc.id)) continue;
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
          if (ctrl.signal.aborted) return;
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
          if (mode === "dev" && riskyChangePending && !reviewForced) {
            reviewForced = true;
            nudgeIntoLastTool(FORCE_REVIEW_NUDGE);
          }
          if (mode === "dev" && learnedWithoutRecording && !memoryNudged) {
            memoryNudged = true;
            nudgeIntoLastTool(RECORD_MEMORY_NUDGE);
          }
          continue;
        }

        // Wrap-up guard: this round executed a tool (e.g. a subagent already returned a result), yet the model ends with empty content — the user saw nothing.
        // Inject one FINALIZE_NUDGE to nudge it to answer formally based on the obtained information, then continue the loop. Only once, to avoid a deadlock.
        if (didToolCall && !finalizeNudged && !(msg.content ?? "").trim()) {
          finalizeNudged = true;
          nudgeIntoLastTool(FINALIZE_NUDGE);
          continue;
        }

        // Normal reply → end (the body was already finalized and displayed by renderTurn above, and archiving was done when the message was produced, so it is not repeated here).
        // A background conversation does not write the current view; when switched back to, its display is rebuilt from the store by loadConversation.
        // End of conversation: archive this conversation's task list into the chat record, and collapse the floating panel
        // above the input box. Keyed by genConvId, so a background conversation retires its own list rather than the
        // viewed conversation's; the archived bubble is only pushed when that conversation is the one on screen.
        const finishedTodos = todosFor(genConvId);
        if (finishedTodos.length > 0) {
          if (active()) pushDisplay({ kind: "todos", todos: finishedTodos });
          setTodosFor(genConvId, []);
        }
        // Trigger condition 1: the AI reply is complete. Choose the notification channel by "whether the window is always on top":
        //  - Always on top (always-on-top, the window is certainly visible) → in-app hint (toast);
        //  - Not on top (may be obscured by other windows) → system notification (following the existing preference / unfocused gating, clicking jumps to that conversation).
        // Use the captured genConvId rather than the active conversation id, to ensure correct ownership (reserved for background concurrent generation).
        if (await isWindowAlwaysOnTop()) {
          const title = store.getConversation(genConvId)?.title?.trim();
          toast.success(title ? t("chat.replyDoneNamed", { title }) : t("chat.replyDone"));
        } else {
          notifyReplyComplete(genConvId, msg.content);
        }
        return;
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
      // Queue resume: after a normal end (not a user interruption), if this conversation still has queued messages and is still the current conversation, auto-send the next one.
      // Interruption (the user clicked "stop") does not resume — cancel() clears this conversation's queue at the same time.
      if (!ctrl.signal.aborted) processQueue(genConvId);
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

  return (
    <div className="relative flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface-muted text-ink">
      {/* Header */}
      <div className="border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto w-full px-4 py-3">
          {/* Title row */}
          <div className="flex min-w-0 items-center gap-2">
            {/* Conversation title + dropdown: token usage, rename, clear. The right-side badges/buttons are unchanged. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 max-w-[min(45vw,320px)] items-center gap-1 rounded-lg px-1 py-0.5 text-left transition hover:bg-surface-muted"
                  title={activeConvTitle || t("chat.title")}
                >
                  <span className="truncate text-base font-bold">
                    {activeConvTitle || t("chat.title")}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-ink-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[15rem]">
                <DropdownMenuLabel className="whitespace-nowrap font-normal text-ink-subtle">
                  {t("chat.tokenUsageLine", {
                    approx: sessionUsage.estimated ? "≈" : "",
                    total: sessionUsage.total,
                    prompt: sessionUsage.prompt,
                    completion: sessionUsage.completion,
                  })}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!activeConvId}
                  onClick={() => setRenameDraft(activeConvTitle)}
                >
                  <Pencil className="size-4" /> {t("ctx.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={display.length === 0}
                  onClick={clearActiveConversationContent}
                  className="text-destructive focus:text-destructive"
                >
                  <Eraser className="size-4" /> {t("chat.clearChat")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                toolsReady
                  ? "bg-emerald-500/15 text-emerald-600"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              }`}
              title={toolsReady ? "Local file / command tools connected" : "Local tools are only available when opened in the desktop app (Electron)"}
            >
              {toolsReady ? "🛠 Local tools enabled" : "⚠️ Local tools unavailable"}
            </span> */}
            {/* Sandbox status badge: where commands actually execute (sandbox VM / host machine) + initialization progress and failure reason. */}
            {toolsReady && sandboxStatus && sandboxStatus.phase !== "idle" && (
              <span
                onClick={() => setSandboxDialogTick((t) => t + 1)}
                role="button"
                className={`hidden cursor-pointer rounded-full px-2 py-0.5 text-[11px] font-medium transition hover:brightness-95 sm:inline ${
                  isSandboxEngine(sandboxStatus.active)
                    ? "bg-emerald-500/15 text-emerald-600"
                    : sandboxStatus.phase === "error"
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : sandboxStatus.phase === "installing-runtime" ||
                          sandboxStatus.phase === "pulling-image" ||
                          sandboxStatus.phase === "starting"
                        ? "bg-sky-500/15 text-sky-600"
                        : "bg-surface-muted text-ink-muted"
                }`}
                title={
                  isSandboxEngine(sandboxStatus.active)
                    ? t("sbx.title.sandbox", { engine: sandboxStatus.active })
                    : sandboxStatus.phase === "ready"
                      ? t("sbx.title.ready")
                      : sandboxStatus.phase === "error"
                        ? t("sbx.title.error", { reason: sandboxStatus.reason })
                        : sandboxStatus.phase === "pulling-image"
                          ? t("sbx.title.pulling")
                          : sandboxStatus.phase === "installing-runtime" || sandboxStatus.phase === "starting"
                            ? t("sbx.title.starting")
                            : sandboxStatus.reason || t("sbx.title.unsupported")
                }
              >
                {isSandboxEngine(sandboxStatus.active)
                  ? t("sbx.badge.sandbox")
                  : sandboxStatus.phase === "pulling-image"
                    ? t("sbx.badge.pulling", { pct: sandboxStatus.pct ?? 0 })
                    : sandboxStatus.phase === "installing-runtime" || sandboxStatus.phase === "starting"
                      ? t("sbx.badge.starting")
                      : sandboxStatus.phase === "error"
                        ? t("sbx.badge.error")
                        : t("sbx.badge.host")}
                {/* The runtime environment has an updatable version: the badge appends a hint (click the badge to open the dialog and update). */}
                {vmUpdatable && <span className="ml-1 text-amber-600 dark:text-amber-400">{t("sbx.badge.updatable")}</span>}
              </span>
            )}
            {/* The current model (read-only; chosen in settings / home page). Green dot = available (cloud has a key configured / the local service is running);
                amber = missing key or the local service is not started — when local is not started, clicking jumps directly to "Settings → Local model" to start it. */}
            <span
              className={`hidden max-w-[220px] items-center gap-1.5 truncate rounded-full bg-surface-muted px-2.5 py-0.5 text-[11px] text-ink-muted sm:flex ${isLocalModel && localLlmReady === false ? "cursor-pointer hover:bg-surface" : ""}`}
              title={
                !activeModel
                  ? t("lm.chipNoModel")
                  : isLocalModel && localLlmReady === false
                    ? t("lm.notStartedTip")
                    : activeModel.label
              }
              onClick={() => { if (isLocalModel && localLlmReady === false) router.push("/agent/models"); }}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeModel && (isLocalModel ? localLlmReady === true : !!activeModel.apiKey.trim()) ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              <span className="truncate">{activeModel?.label ?? t("lm.noModelShort")}</span>
            </span>
            <button
              onClick={() => setSkillsOpen(true)}
              className="ml-auto shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
              title={t("chat.selectSkills")}
            >
              🧩 {t("chat.skills")}
              {enabledSkills(installedSkills).length > 0 && (
                <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {enabledSkills(installedSkills).length}
                </span>
              )}
            </button>
            {display.length > 0 && (
              <button
                onClick={clearActiveConversationContent}
                className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
              >
                {t("chat.clearChat")}
              </button>
            )}
          </div>

          {settingsOpen && (
            <div className="mt-3 border-t border-line/60 pt-3">
          {/* The model and API key are managed in "Settings · Model / API key"; the working directory is now determined automatically by the project / at send time.
              Run parameters (round limits / deadlock protection) have been removed, and this area only shows this session's token usage. */}
          {sessionUsage.total > 0 && (
            <p className="text-[11px] text-ink-subtle">
              {t("chat.sessionTokens", {
                approx: sessionUsage.estimated ? "≈" : "",
                total: sessionUsage.total,
                prompt: sessionUsage.prompt,
                completion: sessionUsage.completion,
              })}
            </p>
          )}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <CustomScrollbar
        viewportRef={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1"
        viewportClassName="flex flex-col bg-surface"
        config={PAGE_SCROLLBAR}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5">
          {/* Switching conversations: a skeleton stands in for the message area, so the previous conversation's
              messages are not left on screen (or the "start a conversation" placeholder flashed) mid-swap. */}
          {switching && <TranscriptSkeleton label={t("chat.loadingConversation")} />}

          {!switching && display.length === 0 && (
            <div className="mt-16 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-lg font-bold text-white shadow-lg shadow-primary/25">
                AI
              </div>
              <p className="text-sm font-medium text-ink-muted">{t("chat.emptyTitle")}</p>
              <p className="mt-1 text-xs text-ink-subtle">
                {t("chat.emptyHint")}
                {toolsReady ? t("chat.emptyHintTools") : ""}
              </p>
            </div>
          )}

          {/* Earlier turns exist but are not mounted: the sentinel pulls in the next batch as it scrolls into view,
              and the button does the same for a transcript too short to scroll (or with the observer unavailable). */}
          {!switching && hasEarlier && (
            <div ref={earlierSentinelRef} className="flex justify-center py-1">
              <button
                type="button"
                onClick={loadEarlier}
                className="rounded-full border border-line/60 px-3 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
              >
                {t("chat.loadEarlier")}
              </button>
            </div>
          )}

          {!switching && (() => {
            // Gather consecutive "deep thinking + tool calls" (the AI's thinking / operation trace) into a single collapsible
            // "thinking process" card, while the rest of the messages (user / reply / usage / todos / choice) are rendered one by one as usual.
            const nodes: React.ReactNode[] = [];
            // Mount only the current window; `i` stays an absolute index into `display` because MessageItem's index is
            // what edit / regenerate / rating resolve against (and what the React keys are built from).
            let i = visibleStart;
            // A tool call carrying an artifact (image_generation) is the deliverable, not a step in
            // the trace: it renders standalone rather than being swallowed into the collapsed
            // "Thinking process" card, where the user would never see the thing they asked for.
            const inProcess = (m: DisplayMsg) =>
              (m.kind === "tool" && !m.image) || m.kind === "reasoning" || m.kind === "phase";
            // The index of the last AI reply: only it shows "regenerate" (regenerating discards everything after it, to avoid an old reply being triggered by mistake).
            let lastAssistantIndex = -1;
            for (let j = display.length - 1; j >= 0; j--) {
              if (display[j].kind === "assistant") { lastAssistantIndex = j; break; }
            }
            while (i < display.length) {
              if (inProcess(display[i])) {
                const start = i;
                const group: ProcessItem[] = [];
                while (i < display.length && inProcess(display[i])) {
                  group.push(display[i] as ProcessItem);
                  i++;
                }
                // This group is at the end of the message list and still generating → treated as "in progress", auto-expanded.
                const live = loading && i === display.length;
                nodes.push(<ProcessGroup key={`pg-${start}`} items={group} live={live} />);
              } else {
                nodes.push(
                  <MessageItem
                    key={i}
                    index={i}
                    m={display[i]}
                    onPick={answerChoice}
                    onEditUser={editUser}
                    onRegenerate={regenerate}
                    onRateMessage={rateMessage}
                    canRegenerate={!loading && i === lastAssistantIndex}
                    busy={loading}
                  />,
                );
                i++;
              }
            }
            return nodes;
          })()}

          {/* The skeleton already reads as "loading"; the outgoing conversation's thinking dots would double up on it. */}
          {!switching && loading && !display.some((m) => m.kind === "choice" && m.selected === null) && (
            <div className="flex items-center gap-2 px-1 py-0.5">
              <span className="flex shrink-0 items-center gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
              </span>
              <span className="text-sm text-ink-muted">{status || t("chat.thinking")}</span>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {/* Local model not started: a modal dialog guide (more prominent than an inline error); after confirming, it jumps directly to Settings → Local model. */}
          <Dialog open={localStartDialog} onOpenChange={setLocalStartDialog}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>{t("lm.notStartedTitle")}</DialogTitle>
                <DialogDescription>
                  {t("lm.notStartedDesc", { label: activeModel?.label ?? "llama.cpp" })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button
                  onClick={() => setLocalStartDialog(false)}
                  className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition hover:bg-surface-muted"
                >
                  {t("lm.cancel")}
                </button>
                <button
                  onClick={() => {
                    setLocalStartDialog(false);
                    router.push("/agent/models");
                  }}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105"
                >
                  {t("lm.goStart")}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Sandbox startup progress dialog (daily mode): downloading the runtime environment image / downloaded + startup progress; can also be opened by clicking the top badge. */}
          <SandboxStartupDialog status={sandboxStatus} mode={mode} openTick={sandboxDialogTick} />

          {/* Rename the current conversation (opened from the header title dropdown). */}
          <Dialog open={renameDraft !== null} onOpenChange={(o) => !o && setRenameDraft(null)}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>{t("ctx.renameConversation")}</DialogTitle>
              </DialogHeader>
              <input
                autoFocus
                value={renameDraft ?? ""}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameDraft?.trim() && activeConvId) {
                    renameConversation(activeConvId, renameDraft.trim());
                    setRenameDraft(null);
                  }
                }}
                placeholder={t("ctx.renamePlaceholder")}
                className={selCls}
              />
              <DialogFooter>
                <button
                  onClick={() => {
                    if (renameDraft?.trim() && activeConvId) {
                      renameConversation(activeConvId, renameDraft.trim());
                    }
                    setRenameDraft(null);
                  }}
                  disabled={!renameDraft?.trim()}
                  className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition hover:brightness-105 disabled:opacity-50"
                >
                  {t("ctx.save")}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Context usage: a frosted-glass bar, sticky-pinned to the bottom of the message area; messages scroll behind its semi-transparent background,
            and backdrop-filter blurs it, giving a frosted-glass texture (see figure 2). */}
        {activeModel &&
          (() => {
            const contextWindow = activeModel.contextWindow ?? resolveContextWindow(activeModel.model);
            const pct = contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
            const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
            // Manual compaction is allowed once there's enough to compress: ≥20% of the window, OR — when an
            // absolute budget is set — once context has passed that budget (so a 1M-window model isn't stuck
            // "below 20%" while already carrying 200K). Keep this in sync with compactNow's guard.
            const ctxBudgetK = getContextBudgetK();
            const canCompact =
              pct >= MANUAL_COMPACT_MIN_PCT * 100 || (ctxBudgetK > 0 && contextTokens >= ctxBudgetK * 1000);
            // Auto-compaction handles trimming on its own, so the fill bar only carries signal at the limit.
            // Show it once usage passes the maximum (red/danger) threshold (≥90%), or reveal it on hover;
            // otherwise the row is just label + Compressed badge + manual "Compress now" + the numbers.
            const showBar = pct >= 90;
            return (
              <div className="group sticky bottom-0 z-10 mt-auto border-t border-line/70 bg-surface/60 px-4 py-2 backdrop-blur-md supports-[backdrop-filter]:bg-surface/60">
                <div className="mx-auto w-full max-w-3xl">
                  <div
                    className={`flex items-center justify-between text-[11px] text-ink-subtle ${
                      showBar ? "mb-1" : "group-hover:mb-1"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{t("chat.contextUsage")}</span>
                      {compacted && (
                        <span
                          className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary"
                          title={t("chat.compactedTip")}
                        >
                          {t("chat.compacted")}
                        </span>
                      )}
                      {/* Manual "compact now": available only once usage reaches 20%, letting the user proactively trim before approaching the limit. */}
                      <button
                        type="button"
                        onClick={compactNow}
                        disabled={compacting || loading || !canCompact}
                        className="rounded px-1 py-px text-[10px] font-medium text-ink-subtle transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        title={!canCompact ? t("chat.compactMinTitle") : t("chat.compactNowHint")}
                      >
                        {compacting ? t("chat.compacting") : t("chat.compactNow")}
                      </button>
                    </div>
                    <span className="tabular-nums">
                      {abbreviateNumber(contextTokens)} / {abbreviateNumber(contextWindow)} · {pct}%
                    </span>
                  </div>
                  <div
                    className={`w-full overflow-hidden rounded-full bg-surface-hover/70 transition-all ${
                      showBar
                        ? "h-1.5 opacity-100"
                        : "h-0 opacity-0 group-hover:h-1.5 group-hover:opacity-100"
                    }`}
                  >
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
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
      {pending && pending.convId === convIdRef.current && (
        <ConsentPanel
          pending={pending}
          currentConvId={convIdRef.current}
          consentSel={consentSel}
          onHover={setConsentSel}
          onAnswer={answerConsent}
          onKey={onConsentKey}
          panelRef={consentPanelRef}
        />
      )}

      {/* Task list: fixed above the input box, showing progress.
          Lowest priority — it yields and hides when the sensitive-operation confirmation panel is present, to avoid competing for space with it. */}
      {todos.length > 0 && !(pending && pending.convId === convIdRef.current) && (
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
