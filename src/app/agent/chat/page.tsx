"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { isLocalEndpoint, localLlm, LOCAL_PROVIDER_ID } from "@/lib/ai/localModel";
import { setSandboxMode, onSandboxStatus, getSandboxStatus, getSandboxVmInfo, sandboxEnvHint, isSandboxEngine, type SandboxStatus } from "@/lib/ai/sandbox";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";
import { SUBAGENTS, subAgentTool } from "@/lib/ai/subagents";
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
import { notifyReplyComplete, notifyAgentError, notifyPermissionRequest, notifyQuestion } from "@/lib/ai/agentNotify";
import { isWindowAlwaysOnTop } from "@/lib/electron/windowControls";
import { useAgentChatStore } from "@/store/agentChatStore";
import { enabledSkills, loadInstalled } from "@/lib/ai/skills/store";
import { getSkillInstructions, loadSkillTool, skillSystemHint } from "@/lib/ai/skills/runtime";
import { SANDBOX_TOOLBOX_SKILL } from "@/lib/ai/skills/builtin";
import { loadEnabledProjectSkills, type LoadedProjectSkill } from "@/lib/ai/skills/project";
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
  MANUAL_COMPACT_MIN_PCT,
  type CompactionState,
} from "./contextCompress";
import type { StoredCompaction } from "@/lib/ai/conversation";
import { countMessagesTokens, countMessageTokens } from "@/lib/ai/tokenizer";
// ── Extracted modules (data / types / constants / tool declarations / display components) ──────────────────────
import {
  resolveActiveModel,
  resolveModelById,
  ensureModelListSeeded,
  loadModelList,
  getSelectedModel,
  setSelectedModelId,
  resolveContextWindow,
  PROVIDERS,
  OFFICIAL_PROVIDER_ID,
  MODEL_LIST_CHANGE_EVENT,
  type ResolvedModel,
  type AgentModel,
} from "@/lib/ai/models";
import {
  CONSENT_OPTIONS,
  DELEGATE_NUDGE,
  FEEDBACK_DOWN_NUDGE,
  FEEDBACK_UP_NUDGE,
  FINALIZE_NUDGE,
  FLAT_SEARCH_NUDGE_AT,
  FLAT_SEARCH_TOOLS,
  FORCE_REVIEW_NUDGE,
  MUTATING_FILE_TOOLS,
  RATING_DOWN_FEEDBACK,
  RATING_UP_FEEDBACK,
  RESUME_NUDGE,
  RISKY_PATH_PATTERN,
  SENSITIVE_TOOLS,
  systemPromptFor,
  selCls,
  toolStatusText,
  workdirPrompt,
  type ConsentDecision,
} from "./constants";
import type {
  ApiMsg,
  Attachment,
  ChatResponse,
  ContentPart,
  DisplayMsg,
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
import { Composer } from "./Composer";
import { ProjectSkillsPrompt } from "./ProjectSkillsPrompt";
import { ConsentPanel } from "./ConsentPanel";

/**
 * Dynamically builds the runtime info appended to the end of the system prompt: user time zone, current date (YYYY-MM-DD), and the current model and provider.
 * Called each time the system prompt is assembled for a send, so it automatically reflects the latest time zone / date / selected model.
 */
function userTimeContext(model: ResolvedModel | null): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    /* Leave empty if reading the time zone fails */
  }
  const modelPart = model ? `\nCurrent Model: ${model.label} (${model.model})` : "";
  return `User Time Zone: ${tz || "unknown"}\nCurrent Date: ${y}-${m}-${d}${modelPart}`;
}

/**
 * The run context for a single send (generation). send() and the tool executions / subagents it invokes share it, to support "background concurrent generation":
 *  - convId: the conversation this generation belongs to (captured stably, unchanged when switching conversations); always used for persistence;
 *  - signal: this run's own independent abort signal (one per conversation, mutually isolated);
 *  - push / status: view side effects that only actually affect the UI while convId is still the current active conversation, otherwise silent
 *    (a background conversation only persists to disk and never pollutes the display or state of the currently viewed conversation; it is rebuilt from the store by loadConversation when switched back to).
 */
type RunCtx = {
  convId: string;
  signal: AbortSignal;
  push: (m: DisplayMsg) => void;
  status: (s: string) => void;
};

/**
 * Local-model only: downgrade the image_url parts of "remote http images" in history to textual XML references (keeping the URL),
 * while inline data:base64 images (local send / the previous local image) are still kept as image_url.
 * Reason: llama-server cannot fetch remote URLs (it errors with 400 Failed to load image), but most of these history images are links
 * uploaded to OSS by cloud models at send time, with no original bytes to convert. Turning them into `<image url="…"/>` text avoids the error
 * and still lets the model know "there was an image here and its address". It does not modify convoRef / persistence, and only affects this send's wire view.
 */
function stripRemoteImagesForLocal(messages: ApiMsg[]): ApiMsg[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const kept: ContentPart[] = [];
    const remoteUrls: string[] = [];
    for (const part of m.content) {
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        if (/^data:/i.test(url)) kept.push(part); // Locally readable inline image, keep it
        else if (url) remoteUrls.push(url); // Remote URL, convert to text
      } else kept.push(part);
    }
    if (remoteUrls.length === 0) return m;
    const xml = remoteUrls.map((u) => `<image url="${u}" note="Historical image, not viewable by the local model" />`).join("\n");
    const out: ContentPart[] = [];
    let appended = false;
    for (const part of kept) {
      if (part.type === "text" && !appended) {
        out.push({ type: "text", text: `${part.text}${part.text ? "\n" : ""}${xml}` }); // New object, does not modify the original part
        appended = true;
      } else out.push(part);
    }
    if (!appended) out.unshift({ type: "text", text: xml });
    if (out.length === 1 && out[0].type === "text") return { ...m, content: out[0].text }; // Only text left → plain string
    return { ...m, content: out };
  });
}

/**
 * Dev-mode "phase summary" cleanup: reasoning models sometimes stuff the chain of thought + a leftover </think> into the body of a "tool-call round".
 * Phased streaming shows this body as that phase's summary, so keep only the body after the last </think> (returned as-is if none),
 * and strip leading whitespace, to avoid displaying chain-of-thought remnants as the summary.
 */
function phaseSummaryText(raw: string): string {
  const marker = "</think>";
  const i = raw.lastIndexOf(marker);
  return (i >= 0 ? raw.slice(i + marker.length) : raw).replace(/^\s+/, "");
}

/**
 * User rating (thumbs up / down) → dynamically injected wire feedback: each assistant message that carries a rating is kept as-is
 * after "stripping the rating field in place", with an English feedback system message inserted immediately after it. This only affects the temporary
 * wire view (wire) "sent to the model" — the archived assistant content contains no rating, and the rating field is never sent to the provider. The rating is
 * stored in StoredMessage.rating and dynamically rebuilt from it on every request when reading history, so as long as that reply is still in context, its feedback stays visible to the model (effective across rounds).
 */
function injectRatingFeedback(wire: ApiMsg[]): ApiMsg[] {
  // Fast-return the original array when there is no rating at all (the vast majority of requests take this path: zero overhead, no disturbance to the prefix cache).
  if (!wire.some((m) => m.role === "assistant" && m.rating)) return wire;
  const out: ApiMsg[] = [];
  for (const m of wire) {
    if (m.role === "assistant" && m.rating) {
      const { rating, ...clean } = m; // Strip the memory-only rating field; never send it to the provider
      out.push(clean);
      out.push({
        role: "system",
        content: rating === "up" ? RATING_UP_FEEDBACK : RATING_DOWN_FEEDBACK,
      });
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Project skill (LoadedProjectSkill) → InstalledSkill shape, so it can be merged into the runtime skill set and progressively disclosed by load_skill.
 *  The id is prefixed with "project:" to avoid clashing with installed skills; description falls back to name (load_skill relies on it to be discovered by the model). */
function toInstalledProjectSkill(p: LoadedProjectSkill): InstalledSkill {
  return {
    id: `project:${p.path}`,
    name: p.name,
    version: "1",
    description: p.description || p.name,
    instructions: p.instructions,
    installedAt: 0,
    enabled: true,
  };
}

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
  const [status, setStatus] = useState(""); // While generating, show the user "what it is doing"
  const [error, setError] = useState<string | null>(null);
  const [toolsReady, setToolsReady] = useState(false);
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
  // The "static" part of the system message (tools / directory / skills / memory): built and cached on the first send,
  // then on every subsequent send the refreshed runtime context (date + current model) is appended to its end, without rebuilding the static part.
  const systemStaticRef = useRef<string>("");
  // The "pending confirmation" state of a sensitive tool call: shown to the user for approval; resolveRef is used to wake the waiting Promise on selection.
  // Sensitive-operation confirmation queue: when multiple conversations (including background ones) request sensitive operations at once, they queue FIFO and pop one at a time, to avoid overwriting each other and deadlocking.
  // pending = the display info of the front-of-queue request; consentQueueRef holds the full queue (including each one's resolve and owning conversation).
  const [pending, setPending] = useState<{
    name: string;
    args: unknown;
    diff: string | null; // File-change preview (with line numbers); null means no diff (e.g. run_command)
    convId: string | null; // The conversation that issued this request (used to indicate which conversation it is on the panel)
    queued: number; // The number of requests still queued after it (excluding the current one)
  } | null>(null);
  const [consentSel, setConsentSel] = useState(0); // The currently highlighted option (supports up/down key navigation)
  const consentQueueRef = useRef<
    Array<{ convId: string | null; name: string; args: unknown; diff: string | null; resolve: (d: ConsentDecision) => void }>
  >([]);
  const consentPanelRef = useRef<HTMLDivElement>(null); // Auto-focus when the panel appears, to ease keyboard operation
  // The set of tools allowed via "don't ask again" within this conversation (added after choosing always).
  const allowedToolsRef = useRef<Set<string>>(new Set());
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
  // A one-time "rating feedback" hint: set when the user thumbs up / down the previous reply and triggers a regeneration; appended to the wire only for this round's first request,
  // not displayed and not persisted (same one-time nudge mechanism as RESUME_NUDGE). Used to let the rating influence the current conversation's next generation in real time.
  const feedbackNudgeRef = useRef<string | null>(null);
  // Token usage: turnUsageRef accumulates all requests of "this round" (including tool rounds and subagents); sessionUsage is the whole-session accumulation.
  // estimated indicates that part of this round / session was estimated with tiktoken (the provider did not return usage).
  const turnUsageRef = useRef({ prompt: 0, completion: 0, total: 0, cached: 0, estimated: false });
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

  // Task list (update_todos): fixed above the input box.
  const [todos, setTodos] = useState<Todo[]>([]);
  const todosRef = useRef<Todo[]>([]); // Mirror, for the async send loop to read the latest value
  const setTodosBoth = (next: Todo[]) => {
    todosRef.current = next;
    setTodos(next);
  };

  // The model calls update_todos: overwrite the current list with the full list, returning a short confirmation.
  // When ctx.convId is not the active conversation, do not update the on-screen list (a background conversation does not pollute the todo panel of the currently viewed conversation).
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
    if (ctx.convId === convIdRef.current) setTodosBoth(parsed);
    const done = parsed.filter((t) => t.status === "completed").length;
    return `Updated the todo list (${done}/${parsed.length} completed).`;
  };

  // Manual toggle: switch this item between "completed / not completed".
  const toggleTodo = (index: number) => {
    const next = todosRef.current.map((t, i) =>
      i === index ? { ...t, status: t.status === "completed" ? "pending" : "completed" } : t,
    );
    setTodosBoth(next as Todo[]);
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

  // Sync the front of the confirmation queue to pending (for rendering); collapse the panel if the queue is empty.
  const showFrontConsent = () => {
    const front = consentQueueRef.current[0];
    if (front) {
      setPending({
        name: front.name,
        args: front.args,
        diff: front.diff,
        convId: front.convId,
        queued: consentQueueRef.current.length - 1,
      });
      setConsentSel(0);
    } else {
      setPending(null);
    }
  };

  // Pop up the confirmation panel and wait for the user's decision; the first option (Yes) is highlighted by default. diff is the change preview (may be null).
  // convId: the conversation that issued this confirmation. When multiple conversations (including background ones) request sensitive operations at once, they enqueue FIFO and pop one at a time,
  // never overwriting each other — otherwise an earlier request would be stuck forever. The result bubble is separately gated to the active conversation via ctx.push.
  const requestConsent = (convId: string | null, name: string, args: unknown, diff: string | null) =>
    new Promise<ConsentDecision>((resolve) => {
      const wasEmpty = consentQueueRef.current.length === 0;
      consentQueueRef.current.push({ convId, name, args, diff, resolve });
      if (wasEmpty) showFrontConsent(); // Queue was empty → show immediately; otherwise queue and wait for the ones ahead to finish
      // Queued behind: do not change the front of the queue (do not interrupt the current choice), only refresh the "N more pending" count.
      else setPending((p) => (p ? { ...p, queued: consentQueueRef.current.length - 1 } : p));
      // Trigger condition 3: permission notification — the AI requests a sensitive operation and awaits authorization (only pops when the app is unfocused).
      notifyPermissionRequest(convId, name);
    });
  // The user makes a choice on the front of the queue (click or Enter): resolve its Promise, dequeue it, then show the next one.
  const answerConsent = (d: ConsentDecision) => {
    const req = consentQueueRef.current.shift();
    req?.resolve(d);
    // Choosing "don't ask again" allows this tool at the conversation level (allowedToolsRef, global), and additionally allows the remaining requests for the same tool in the queue with "allow",
    // to avoid re-prompting for the same tool right after authorizing it.
    if (d === "always" && req) {
      consentQueueRef.current = consentQueueRef.current.filter((r) => {
        if (r.name === req.name) {
          r.resolve("yes");
          return false;
        }
        return true;
      });
    }
    showFrontConsent();
  };
  // Discard all pending-confirmation requests of a conversation in the queue (ending them with "reject") and refresh the panel. Used to unblock it on cancel / clear.
  const dropConsentsFor = (convId: string | null) => {
    let changed = false;
    consentQueueRef.current = consentQueueRef.current.filter((r) => {
      if (r.convId === convId) {
        r.resolve("no");
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) showFrontConsent();
  };
  // Auto-focus when the panel appears, so up/down keys and Enter take effect directly.
  useEffect(() => {
    if (pending) consentPanelRef.current?.focus();
  }, [pending]);
  // Keyboard navigation: ↑/↓ cycle options, Enter confirms, Esc is treated as reject.
  const onConsentKey = (e: ReactKeyboardEvent) => {
    const n = CONSENT_OPTIONS.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setConsentSel((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setConsentSel((i) => (i - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      answerConsent(CONSENT_OPTIONS[consentSel].key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      answerConsent("no");
    }
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

  // After mount, restore the last selection / key + probe whether local tools are available (Electron only).
  useEffect(() => {
    void (async () => {
      hydrateAppConfig(); // First seed local storage from app.config (an INI next to the executable); the file wins
      migrateLegacyAgentStorage(); // Merge the old flat keys into the agent object before the first read
      ensureModelListSeeded(); // On first run, migrate the model list out of the legacy single-select config
      setActiveModel(resolveActiveModel()); // The currently selected model → the endpoint / model / key used for sending
      const ready = isToolkitAvailable();
      setToolsReady(ready);
      setProxyReady(isLlmProxyAvailable());
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
    atBottomRef.current = true; // New conversation: follow from the bottom
    setAtBottom(true);
    setQueued([]); // New conversation: clear the queue panel (the new conversation has no queue yet)
    setAttachments([]); // Clear unsent attachments
    setTodosBoth([]); // Clear the task list
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

  // Discard the current conversation: revoke the signature + delete local content / metadata, and reset the view to a clean state.
  // Shared by the "clear conversation" button and "delete tampered conversation" — clearing discards this current one, to avoid it lingering in the sidebar
  // and coexisting with the newly started conversation as two entries. When there is no current conversation, it only resets the view.
  const discardActiveConversation = () => {
    const id = useAgentChatStore.getState().activeConversationId;
    if (id) useAgentChatStore.getState().deleteConversation(id);
    clearAll();
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

  // Load a historical conversation: rebuild the display and the API conversation (system will be filled in on demand on the next send).
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
  const persistCompaction = (convId: string | null) => {
    if (!convId) return;
    const state = compactionRef.current;
    let stored: StoredCompaction | null = null;
    if (state) {
      const s = compactionSavings(state);
      stored = {
        ...serializeCompaction(state),
        manual: manualCompactRef.current,
        compacted: s.summarizedTurns > 0 || s.dedupedReads > 0,
        ctxTokens: contextTokensRef.current,
      };
    }
    useAgentChatStore.getState().setConversationCompaction(convId, stored);
  };

  const loadConversation = async (id: string, projectId?: string) => {
    const store = useAgentChatStore.getState();
    if (projectId) await store.ensureProjectLoaded(projectId);
    const conv = store.getConversation(id);
    if (!conv) return;
    snapshotCompaction(convIdRef.current); // Save the old conversation's compaction state before switching away
    interruptedRef.current = false; // Switching conversations: the interrupt-resume flag does not carry across conversations
    convIdRef.current = id;
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
    }
    // Rebuild the conversation sent to the model: faithfully restore the tool-call trace (the assistant's tool_calls + tool result messages),
    // so that when continuing the chat the model still "remembers" what it called and what results it got. system is filled back on demand on the next send.
    convoRef.current = conv.messages.map((m): ApiMsg => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
      if (m.role === "assistant")
        return {
          role: "assistant",
          content: m.content,
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
          // The rating (thumbs up / down) is restored from the archive into the in-memory wire buffer; before sending, injectRatingFeedback strips the field and injects the feedback.
          ...(m.rating ? { rating: m.rating } : {}),
        };
      return { role: "user", content: m.content };
    });
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
          callArgs.set(tc.id, { name: tc.function.name, args: a });
        }
      }
    }
    const disp: DisplayMsg[] = [];
    conv.messages.forEach((m, mi) => {
      if (m.role === "user") {
        disp.push({ kind: "user", content: m.content, images: m.images, files: m.files });
      } else if (m.role === "tool") {
        const info = m.tool_call_id ? callArgs.get(m.tool_call_id) : undefined;
        disp.push({ kind: "tool", name: m.name ?? info?.name ?? "tool", args: info?.args ?? {}, ok: true, result: m.content });
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
  // synchronously update the rating in the in-memory wire buffer (reflected by injectRatingFeedback on the next request), and highlight it in the display.
  // useCallback keeps the reference stable (independent of send / state), to avoid a full re-render of the memoized MessageItem.
  const rateMessage = useCallback(
    (displayIndex: number, storedIndex: number | undefined, rating: "up" | "down" | null) => {
      const convId = convIdRef.current;
      if (convId && storedIndex != null) {
        useAgentChatStore.getState().setMessageRating(convId, storedIndex, rating);
        // Sync the in-memory wire buffer: archived messages are all non-system, so "the storedIndex-th non-system message in convoRef" corresponds
        // to that StoredMessage — locating by this correctly skips the leading system prompt and the runtime-inserted nudges (DELEGATE /
        // FINALIZE / FORCE_REVIEW, which only enter convoRef and are not persisted), which is more robust than index + offset.
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
   */
  const requestChat = async (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    // Passing onDelta requests "streaming": callbacks the accumulated content/reasoning chunk by chunk, for real-time display.
    // Downstream still treats it as a "non-streaming complete response" — this function reassembles the SSE deltas back into a complete ChatResponse before returning.
    onDelta?: (d: { content: string; reasoning: string }) => void,
  ): Promise<ChatResponse> => {
    const body = {
      model: modelName,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    };
    const wantStream = !!onDelta;

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
    const streamErr = (res: { ok: boolean; status: number; error?: string }): ChatResponse | never => {
      if (!res.ok) {
        if (signal?.aborted) return assemble(); // Aborted: return the accumulated part (the caller then exits on aborted and will not use it)
        throw new Error(`HTTP ${res.status}${res.error ? ` — ${res.error.slice(0, 300)}` : ""}`);
      }
      return assemble();
    };

    // Browser fallback: connect directly to the provider endpoint.
    let data: ChatResponse;
    // Local llama-server (127.0.0.1): forced through the main-process proxy (a Node environment, with no render-layer cross-origin (CORS) restriction).
    if (isLlmProxyAvailable() && isLocalEndpoint(endpoint)) {
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(
          await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body }, handleChunk, signal),
        );
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${res.error ? ` — ${res.error.slice(0, 300)}` : ""}`);
        }
        data = res.data as ChatResponse;
      }
    } else if (!proxyReady) {
      // The proxy is a single IPC and cannot abort an in-flight network request; instead the caller checks signal.aborted after the await to exit.
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim(), body }, handleChunk, signal));
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim(), body });
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
    if (u) {
      const p = u.prompt_tokens ?? 0;
      const c = u.completion_tokens ?? 0;
      turnUsageRef.current.prompt += p;
      turnUsageRef.current.completion += c;
      turnUsageRef.current.total += u.total_tokens ?? p + c;
      // Input tokens served from the prefix cache: the field differs by provider (DeepSeek uses prompt_cache_hit_tokens,
      // OpenAI-compatible uses prompt_tokens_details.cached_tokens); accumulate whichever is present, for the UI to show the cache effect.
      turnUsageRef.current.cached +=
        u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    } else {
      const p = countMessagesTokens(messages);
      const c = countMessageTokens(data.choices?.[0]?.message);
      turnUsageRef.current.prompt += p;
      turnUsageRef.current.completion += c;
      turnUsageRef.current.total += p + c;
      turnUsageRef.current.estimated = true;
    }
    return data;
  };

  // ── Context compaction ────────────────────────────────────────────────────────────────
  /** Render a span of history messages into a plain-text transcript for the "summarizer model" (tool results truncated, to control the summary input size). */
  const renderTranscript = (msgs: ApiMsg[]): string => {
    const lines: string[] = [];
    for (const m of msgs) {
      if (m.role === "user") {
        const txt = typeof m.content === "string" ? m.content : "[message with image]";
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

  /** Call the current model to compress the earlier history into a summary body (throws on failure, and the caller falls back to dedup-only). Counted toward this round's usage. */
  const summarizeHistory = async (msgs: ApiMsg[], signal?: AbortSignal): Promise<string> => {
    const sys: ApiMsg = {
      role: "system",
      content:
        "You are a conversation summarizer. Compress the following earlier AI-assistant conversation into a concise but information-complete summary, so the subsequent conversation can seamlessly continue the context. " +
        "Be sure to preserve completely (better a bit long than to lose anything): " +
        "① the goal and key requirements of each user question; " +
        "② the conclusion / solution for each question — what was ultimately done and how it turned out; " +
        "③ the reasons and basis for reaching that conclusion and choosing that approach — why it was done this way, which alternatives were ruled out, and based on which findings; " +
        "④ key analysis findings and important data — do not just write \"read/checked some file\", write the concrete conclusions / key content / values derived from it; " +
        "⑤ the files / paths / commands involved; ⑥ what is done and what is still pending; ⑦ any pitfalls and caveats. " +
        "Do not fabricate information that did not appear; do not restate irrelevant intermediate steps sentence by sentence. Output only the summary body.",
    };
    const user: ApiMsg = { role: "user", content: renderTranscript(msgs) };
    const data = await requestChat([sys, user], undefined, signal);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Summary is empty");
    return text;
  };

  /**
   * Plan and freeze compaction at the start of each round (or manually). force=true is the manual "compact now", which ignores the threshold and compacts as much as possible.
   * Reuse memory: if a summary with the same coversCount already exists (history is append-only, so the earlier prefix is unchanged), reuse it directly, to avoid re-summarizing every round.
   */
  const maybeCompact = async (opts: { force?: boolean; signal?: AbortSignal } = {}) => {
    const full = convoRef.current;
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    const currentTokens = countMessagesTokens(full);
    // prev: pass in the previous compaction state so planCompaction "freezes the boundary" — reuse the old summary boundary until the tail again
    // exceeds the threshold; if coversCount is stable, the old summary body is reused below, so the post-compaction prefix is byte-stable and hits the prefix cache (§4.1).
    const res = planCompaction(full, {
      contextWindow: cw,
      currentTokens,
      force: opts.force,
      prev: compactionRef.current,
    });
    if (!res) {
      // Below the threshold: if it is not a manual compaction, clear it (wire view == full conversation, most stable prefix cache); a manual compaction is kept as-is.
      if (!manualCompactRef.current) {
        compactionRef.current = null;
        setCompacted(false);
        persistCompaction(convIdRef.current); // Sync to disk after clearing (remove the old snapshot)
      }
      return;
    }
    const { plan, summarizeMessages } = res;
    let summaryText: string | null = null;
    if (plan.coversCount > 0) {
      const prev = compactionRef.current;
      if (prev?.summaryText && prev.coversCount === plan.coversCount) {
        summaryText = prev.summaryText; // Coverage unchanged → reuse the old summary, saving a model call
      } else {
        try {
          summaryText = await summarizeHistory(summarizeMessages, opts.signal);
        } catch {
          summaryText = null; // Summary failed → fall back to dedup-only (buildWireContext ignores an empty summary)
        }
      }
    }
    compactionRef.current = { ...plan, summaryText };
    if (opts.force) manualCompactRef.current = true;
    const savings = compactionSavings(compactionRef.current);
    setCompacted(savings.summarizedTurns > 0 || savings.dedupedReads > 0);
    // Refresh the progress bar immediately: estimate usage from the post-compaction wire size, without waiting for the next request (refreshed with the provider's exact value on the next request).
    setCtxTokens(countMessagesTokens(buildWireContext(convoRef.current, compactionRef.current)));
    persistCompaction(convIdRef.current); // Persist: keep compaction after close and reopen
  };

  /** The manual "compact now" button: compact once ignoring the auto threshold, but disallowed when usage is too low (<20%), reporting the result. */
  const compactNow = async () => {
    if (compacting || loading) return;
    // When usage is below 20%, there is too little content and compaction is meaningless, so reject directly (consistent with the button's disabled condition, a double safeguard).
    const cw = activeModel?.contextWindow ?? resolveContextWindow(activeModel?.model ?? "");
    if (cw > 0 && contextTokensRef.current / cw < MANUAL_COMPACT_MIN_PCT) {
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
  ): Promise<string> => {
    ctx.status(toolStatusText(name, args));
    if (SENSITIVE_TOOLS.has(name) && !allowedToolsRef.current.has(name)) {
      const previewDiff = await buildPreviewDiff(name, args);
      const decision = await requestConsent(ctx.convId, name, args, previewDiff);
      if (decision === "always") allowedToolsRef.current.add(name);
      if (decision === "no") {
        const denied = "The user rejected this operation.";
        ctx.push({ kind: "tool", name: displayName, args, ok: false, result: denied });
        return denied;
      }
    }
    const result = await callTool(name, args);
    ctx.push({ kind: "tool", name: displayName, args, ok: result.ok, result: result.content });
    return result.content;
  };

  // Run a subagent: run an independent small loop with its dedicated system prompt + restricted tool set, and return the final conclusion text.
  const runSubAgent = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const agentId = String(rawArgs.agent ?? "");
    const task = String(rawArgs.task ?? "").trim();
    const def = SUBAGENTS.find((a) => a.id === agentId);
    if (!def) return `Unknown subagent: ${agentId}`;
    if (!task) return "task must not be empty.";
    ctx.status(t("chat.subagentProcessing", { agent: agentId }));

    // Show a "delegate" bubble, so the user can see what task the main model handed to which subagent.
    ctx.push({
      kind: "tool",
      name: `run_subagent → ${agentId}`,
      args: { agent: agentId, task },
      ok: true,
      result: task,
    });

    // The subagent's internal steps show only the single "delegate" bubble above: its internal tool calls no longer each surface a bubble.
    // Reason: the whole delegation is persisted as just one run_subagent tool message (the subagent conversation is not persisted), so if the N internal
    // calls were spread into N bubbles in real time, they would collapse into 1 step after reopening / switching back to the conversation, making the real-time view inconsistent with the reloaded view.
    // So the internal loop uses a ctx whose push is a no-op — only showing "ran the subagent", while the main AI's own steps display as usual.
    const silentCtx: RunCtx = { ...ctx, push: () => {} };

    // Subagent tool set: reuse the same tool set, filtered by def.tools (the subagent does not include run_subagent, so there is no nesting).
    let subTools: unknown[] | undefined;
    if (toolsReady) {
      const all = (await listTools("openai")) as Array<{ function?: { name?: string } }>;
      subTools = def.tools ? all.filter((t) => def.tools!.includes(t.function?.name ?? "")) : all;
    }

    // The subagent and the main agent share the same execution engine, and system likewise injects the command-execution environment description.
    const sys = [workdir ? `${def.systemPrompt}\n${workdirPrompt(workdir)}` : def.systemPrompt, sandboxEnvHint(sandboxStatusRef.current)].join("\n");
    let convo: ApiMsg[] = [
      { role: "system", content: sys },
      { role: "user", content: task },
    ];

    // No upper limit on subagent rounds: loop until the subagent produces final text, or the user interrupts (using this run's own signal).
    while (true) {
      if (ctx.signal.aborted) return "(canceled)";
      ctx.status(t("chat.subagentThinking", { agent: agentId }));
      const data = await requestChat(convo, subTools, ctx.signal);
      if (ctx.signal.aborted) return "(canceled)";
      const msg = data.choices?.[0]?.message;
      if (!msg) return "(no response from subagent)";
      convo = [...convo, msg];

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          if (ctx.signal.aborted) return "(canceled)";
          let a: Record<string, unknown> = {};
          try {
            a = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* Invalid JSON arguments, call with an empty object */
          }
          const content = await execToolCall(silentCtx, tc.function.name, a, `${agentId}→${tc.function.name}`);
          if (typeof content === "string") detectServices(content);
          // Compress overly long tool output, to avoid bloating the subagent context (the subagent conversation is not persisted and only lives for this delegation).
          convo = [...convo, { role: "tool", tool_call_id: tc.id, content: capToolOutput(content) }];
        }
        continue;
      }
      return msg.content || "(no output from subagent)";
    }
  };

  // Runtime skills = the installed skills the user enabled + conditionally-equipped built-in skills: when commands actually run in the sandbox,
  // the "document / media processing toolbox" is automatically attached (so the model directly uses the tools preinstalled in the image, rather than suggesting a pip/apt install).
  // Built-in skills are not persisted to storage and do not appear in the skills panel; they are rebuilt on every send based on the sandbox status, taking effect immediately on ready/downgrade.
  const runtimeSkills = () => {
    // The installed skills the user enabled + the enabled project skills (.claude/.cursor/.zeraix) + conditionally-equipped built-in skills.
    const list = [...enabledSkills(installedSkillsRef.current), ...projectSkillsRef.current];
    const withBuiltin = isSandboxEngine(sandboxStatusRef.current?.active)
      ? [...list, SANDBOX_TOOLBOX_SKILL]
      : list;
    // Stable order (sorted by id): keeps the load_skill tool description and skill hints byte-stable across multiple sends,
    // so a change in insertion order does not disturb the prefix cache (see docs/prompt-cache-optimization.md §5.1).
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
    const text = getSkillInstructions(enabled, id);
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
    return `Generated the image with ${res.artifact.servedBy}. It is already displayed to the user — do not repeat the URL or embed it in markdown.`;
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
  const resendRef = useRef<(displayIndex: number, newText: string) => void>(() => {});

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
    feedbackNudgeRef.current =
      rating === "down" ? FEEDBACK_DOWN_NUDGE : rating === "up" ? FEEDBACK_UP_NUDGE : null;
    resendRef.current(userIdx, um.kind === "user" ? um.content : "");
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
        const previewUrl = URL.createObjectURL(file);
        pushAttachment({ ...meta, kind: "image", file, previewUrl });
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

    // Inject system (local capabilities + working-directory constraint + enabled-skill hints): only when the current conversation has no system message yet,
    // so that continuing to send after loading a historical conversation also backfills system.
    const enabled = runtimeSkills();
    if (convoRef.current[0]?.role !== "system") {
      const parts: string[] = [];
      // Select the system prompt by the current mode: dev mode leans toward writing code / modifying projects, daily mode leans toward everyday tasks.
      const sysPrompt = systemPromptFor(mode);
      if (toolsReady)
        parts.push(
          [
            effectiveWorkdir ? `${sysPrompt}\n${workdirPrompt(effectiveWorkdir)}` : sysPrompt,
            // The command-execution environment (host system or Linux sandbox) — the model chooses the command style accordingly.
            sandboxEnvHint(sandboxStatusRef.current),
          ].join("\n"),
        );
      const hint = skillSystemHint(enabled);
      if (hint) parts.push(hint);
      // Long-term memory switched to "retrieve on demand" (RAG, see docs/prompt-cache-optimization.md §4.3): the full memory bodies are no longer
      // poured into the frozen system prefix — that would both bloat the prefix and, when memories are added / modified mid-conversation, only show the old snapshot from the conversation's start
      // (i.e. the user's feedback that "I added a memory but the AI doesn't know it"). Here we only put one stable hint; the model pulls memory bodies on demand with search_memory
      // (reads the current file each time → always latest, results land at the end of the wire → no bloat and no disturbance to the prefix cache).
      if (isMemoryFilesAvailable()) {
        parts.push(
          "[Long-term memory] You have saved a set of long-term memories for the user (retained across conversations, and possibly added / modified during this conversation). " +
            "When you need to recall the user's identity / preferences / facts / agreements, or the user mentions things like \"do you still remember…\", \"I told you…\", \"I just added a memory\", " +
            "call search_memory to retrieve the current memories (always the latest) and answer based on them; do not speculate out of thin air, and do not assume what you saw at the conversation's start is the latest. " +
            "Use save_memory to write / update memories (pass id to overwrite an existing one), and delete_memory to delete.",
        );
      }
      // Cache the static part into the ref (excluding the runtime context); the runtime context is refreshed on each send below.
      systemStaticRef.current = parts.join("\n\n");
      convoRef.current = [{ role: "system", content: systemStaticRef.current }, ...convoRef.current];
    }
    // The runtime context (user time zone + current date + current model/provider) is no longer written into the system message, but appended
    // to the "end of the wire" on each request (see the wire assembly below §4.4). Reason (prefix cache): system is at the very front of the prefix, so putting the
    // possibly-changing runtime info there per round would invalidate the entire conversation prefix once it changes (across a day / switching models); putting it at the end of the wire
    // only affects the last message and does not touch the history prefix. It is still generated with the current activeModel each round, so switching the conversation-bound model takes effect immediately.
    // convoRef[0] is therefore always the purely static systemStaticRef, keeping the prefix byte-stable.
    // Binary/oversized attachments: under Electron, persist them to the working directory first (workdir is already mounted into the sandbox),
    // so the model can process them directly with file tools / sandbox commands; the browser environment keeps to file names only.
    const savedPaths = new Map<number, string>();
    if (toolsReady) {
      for (const a of atts) {
        if (a.kind !== "binary") continue;
        try {
          if (a.hostPath) {
            // A real disk file: the main process does a kernel-level copy by host path, with bytes not going through IPC (efficient even for large files).
            savedPaths.set(a.id, await saveAttachment({ name: a.name, srcPath: a.hostPath }));
          } else if (a.file && a.size <= 100 * 1024 * 1024) {
            // A synthetic file (a Blob dragged out of the webview / generated) has bytes only in memory with no other source — pass them in via IPC to persist.
            savedPaths.set(a.id, await saveAttachment({ name: a.name, bytes: await a.file.arrayBuffer() }));
          }
        } catch {
          /* Persist failed → fall back to a file-name note only */
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
      }
    }
    const userContent: string | ContentPart[] =
      imageParts.length > 0
        ? [...(composed ? [{ type: "text" as const, text: composed }] : []), ...imageParts]
        : composed;
    convoRef.current = [...convoRef.current, { role: "user", content: userContent }];
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
    }
    store.appendMessage(convIdRef.current, {
      role: "user",
      content: text,
      images: userImages.length ? userImages : undefined,
      files: userFiles.length ? userFiles : undefined,
      ts: Date.now(),
    });

    // The conversation id this round of generation belongs to (captured as a stable local value, unaffected by switching conversations): drives the spinner on that conversation's sidebar row,
    // and lays the groundwork for later "background concurrent generation" — always record / clear by genConvId, rather than relying on the current active conversation.
    const genConvId = convIdRef.current;
    store.setConversationGenerating(genConvId, true);
    runsRef.current.set(genConvId, ctrl); // Register this conversation's run, for cancel (active conversation) / background concurrency
    // "Whether in the active view": apply view side effects only while active; a background conversation persists silently.
    const active = () => convIdRef.current === genConvId;
    const ctx: RunCtx = {
      convId: genConvId,
      signal: ctrl.signal,
      push: (m) => { if (active()) pushDisplay(m); },
      status: (s) => { if (active()) setStatus(s); },
    };

    try {
      // Tool set = ask_user + update_todos (always available) + load_skill (when there are enabled skills, rebuilt each round to reflect newly installed skills)
      //        + (local tools + run_subagent, Electron only).
      const skillTool = loadSkillTool(enabled);
      const tools = [
        askUserTool(),
        updateTodosTool(),
        openBrowserTool(),
        browserTool(),
        // Only offered when some configured key can actually serve it — otherwise the model would
        // promise an image and then fail. Read fresh each round, since keys can change mid-session.
        ...(capabilityAvailable("image_generation") ? [imageGenerationTool()] : []),
        ...(isMemoryFilesAvailable()
          ? [saveMemoryTool(), deleteMemoryTool(), searchMemoryTool()]
          : []),
        ...(skillTool ? [skillTool] : []),
        ...(toolsReady ? [...(await listTools("openai")), subAgentTool()] : []),
      ];
      // Delegation triage: count the flat searches "since the last delegation". Once the threshold is reached, inject a reminder to nudge the model to hand cross-file investigation to
      // the explore subagent, or answer directly, rather than blindly search / read in the main loop. Reset to zero and re-arm after a delegation — to avoid
      // "delegate once token-symbolically, then search by hand endlessly with no further constraint" (a hole in the old logic).
      let flatSinceDelegate = 0;
      let delegateNudged = false;
      // Critical-change review guard (dev mode only): when a risky path (auth / data / security …) has been changed but no reviewer was run before wrapping up,
      // inject one forced reminder and continue the loop, nudging the model to delegate a reviewer first. Cleared after a reviewer is delegated; forced at most once per round, to avoid a deadlock.
      let riskyChangePending = false;
      let reviewForced = false;
      // Wrap-up guard: whether a tool was executed this round (including subagents). If a tool was executed yet the model ends with empty content (no user-facing
      // final answer, common when the main model "assumes it's done" and stays silent after a subagent returns a result, or writes the conclusion into reasoning),
      // inject one FINALIZE_NUDGE to nudge it to answer formally. finalizeNudged ensures at most once per round, to avoid an infinite loop.
      let didToolCall = false;
      let finalizeNudged = false;
      // Interrupt resume: consume the previous round's "was interrupted" flag (cleared once read). If the previous round was stopped, this round's first request appends a
      // system hint, nudging the model to reuse the analysis / tool results already retained above and continue, without repeating completed work. firstRequest ensures it is added only once.
      const resumeFromInterrupt = interruptedRef.current;
      interruptedRef.current = false;
      // Rating feedback hint: consume the one-time nudge set by the previous "regenerate after thumbs up / down" (cleared once read), appended to the wire on this round's first request.
      const feedbackNudge = feedbackNudgeRef.current;
      feedbackNudgeRef.current = null;
      let firstRequest = true;
      // Start of this round: plan and freeze context compaction (only acts above the threshold, and may trigger one summarizer-model call).
      // Once frozen, any messages added during this round's tool loop are sent as-is, keeping the wire prefix stable throughout the round and hitting the prefix cache.
      await maybeCompact({ signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      // This round's conversation buffer and compaction plan: captured as local values; afterwards the loop only mutates these two locals and never again directly reads/writes convoRef /
      // compactionRef (those belong to the "active view" and are rebuilt by loadConversation when switching conversations). Mirror them back to the view while active.
      let convo = convoRef.current;
      const compaction = compactionRef.current;
      const syncView = () => { if (active()) convoRef.current = convo; };
      // No upper limit on tool-call rounds: loop until the model gives a final reply with no tool calls, or the user interrupts.
      while (true) {
        if (ctrl.signal.aborted) return;
        ctx.status(t("chat.thinking"));
        // Wire view: the "sent to the model" version of this round's local buffer derived through the compaction plan (a background conversation does not depend on the active view).
        // Also backfill tool-call pairing as a fallback: prevents assistant.tool_calls with missing results from getting a 400 from the provider when "reopening an interrupted / backend-crashed conversation".
        let wire = sanitizeToolCallPairs(buildWireContext(convo, compaction));
        // User rating → dynamically injected wire feedback (when reading history, derived to convo from StoredMessage.rating; here it lands in the wire).
        wire = injectRatingFeedback(wire);
        // The runtime context (user time zone + current date + current model/provider) is appended to the "end of the wire" (§4.4): placed after all
        // history, so its per-round change (across a day / switching models) only affects the last message and does not invalidate the history prefix → most stable prefix cache.
        // Generated with the current activeModel each round (switching the conversation-bound model takes effect immediately); it only enters the wire and is not written back to the buffer / not persisted.
        wire = [...wire, { role: "system", content: userTimeContext(activeModel) }];
        // let wire = buildWireContext(convo, compaction);
        // Local model: remote http images in history (mostly OSS links uploaded by cloud models) cannot be fetched by llama → downgrade to a textual XML
        // reference to avoid a 400; inline base64 images are still kept as multimodal images. Continuing a chat across cloud↔local no longer errors on history images.
        if (isLocalModel) wire = stripRemoteImagesForLocal(wire);
        // Interrupt-resume hint: appended only on this round's first request, and only enters the wire, not written back to the buffer, to avoid residue in later rounds / conversations.
        if (resumeFromInterrupt && firstRequest) {
          wire = [...wire, { role: "system", content: RESUME_NUDGE }];
        }
        // Rating feedback: appended only on this round's first request, and only enters the wire, not written back to the buffer (one-time, leaving no residue in later rounds / conversations).
        if (feedbackNudge && firstRequest) {
          wire = [...wire, { role: "system", content: feedbackNudge }];
        }
        firstRequest = false;
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
        const data = await requestChat(wire, tools, ctrl.signal, onDelta);
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
        // Only merge content + tool_calls into the wire buffer: reasoning_content is an output-side artifact and feeding it back would be rejected by some providers.
        convo = [
          ...convo,
          msg.tool_calls?.length
            ? { role: "assistant", content: msg.content, tool_calls: msg.tool_calls }
            : { role: "assistant", content: msg.content },
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

        // Has tool calls → execute them one by one, feed the results back, and continue to the next round.
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          didToolCall = true; // A tool was executed this round: provides the basis for the "empty-content wrap-up" guard
          for (const tc of msg.tool_calls) {
            if (ctrl.signal.aborted) break;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              /* Invalid JSON arguments, call with an empty object */
            }

            // ask_user: pop a choice card and wait for the user to click.
            // update_todos: update the task list above the input box.
            // load_skill: feed back the full instructions of an enabled skill as the tool result (progressive disclosure).
            // run_subagent: delegate to a subagent and feed back its final conclusion as the tool result.
            // Other tools: executed through the unified path (including sensitive-operation confirmation).
            const content =
              tc.function.name === "ask_user"
                ? await askUserChoice(ctx, args)
                : tc.function.name === "update_todos"
                  ? updateTodos(ctx, args)
                  : tc.function.name === "openBrowser"
                    ? openBrowserAction(ctx, args)
                    : tc.function.name === "browser"
                      ? await browserControl(ctx, args)
                      : tc.function.name === "image_generation"
                        ? await generateImageAction(ctx, args)
                        : tc.function.name === "load_skill"
                        ? loadSkill(ctx, args)
                        : tc.function.name === "save_memory"
                          ? await saveMemory(ctx, args)
                          : tc.function.name === "delete_memory"
                            ? await deleteMemory(ctx, args)
                            : tc.function.name === "search_memory"
                              ? await searchMemory(ctx, args)
                              : tc.function.name === "run_subagent"
                            ? await runSubAgent(ctx, args)
                            : await execToolCall(ctx, tc.function.name, args, tc.function.name);

            // Delegation triage count: a delegation resets to zero and re-arms (if a lot of flat searches happen again later, it will remind again); otherwise accumulate the flat-search count.
            // Also: delegating to a reviewer is treated as reviewed, clearing the pending-risky-change flag.
            if (tc.function.name === "run_subagent") {
              flatSinceDelegate = 0;
              delegateNudged = false;
              if (String(args.agent ?? "") === "reviewer") riskyChangePending = false;
            } else if (FLAT_SEARCH_TOOLS.has(tc.function.name)) {
              flatSinceDelegate++;
            }
            // Risky-change detection: a tool that modifies source files hitting the risky-path signature (taking path-like args such as path/file/dest) → mark as pending review.
            if (MUTATING_FILE_TOOLS.has(tc.function.name)) {
              const pathVals = Object.entries(args)
                .filter(([k, v]) => typeof v === "string" && /path|file|dir|dest|src|source|target|name/i.test(k))
                .map(([, v]) => v as string);
              if (pathVals.some((p) => RISKY_PATH_PATTERN.test(p))) riskyChangePending = true;
            }

            // Compress overly long tool output before feeding back / persisting (the full text is already in each tool's display bubble, so the UI is unaffected).
            const cappedContent = capToolOutput(content);
            convo = [...convo, { role: "tool", tool_call_id: tc.id, content: cappedContent }];
            syncView();
            // Persist the tool result to this conversation (store the compressed version, to avoid bloating storage / the integrity hash).
            store.appendMessage(genConvId, {
              role: "tool",
              content: cappedContent,
              tool_call_id: tc.id,
              name: tc.function.name,
              ts: Date.now(),
            });

            // Detect local service addresses in the tool output (e.g. an http://localhost:5173 printed by a dev server),
            // using the full output (the elided middle section may also contain a URL). Once registered, the bottom-left floating indicator displays it and polls its health.
            if (typeof content === "string") detectServices(content);
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
            syncView();
            store.appendMessage(genConvId, {
              role: "tool",
              content: placeholder,
              tool_call_id: tc.id,
              name: tc.function.name,
              ts: Date.now(),
            });
          }
          if (ctrl.signal.aborted) return;
          // Delegation reminder: the flat searches since the last delegation have reached the threshold yet there has been no further delegation / no convergence, so inject a system reminder (only fed back to the model,
          // not displayed and not persisted). This message only enters this round's local buffer, lives in the conversation's memory, and disappears after a reload; some() dedups to avoid stacking.
          if (!delegateNudged && flatSinceDelegate >= FLAT_SEARCH_NUDGE_AT) {
            delegateNudged = true;
            if (!convo.some((mm) => mm.role === "system" && mm.content === DELEGATE_NUDGE)) {
              convo = [...convo, { role: "system", content: DELEGATE_NUDGE }];
              syncView();
            }
          }
          continue;
        }

        // Critical-change review guard: in dev mode, when a risky path has been changed but not reviewed and it wants to wrap up, inject one forced reminder and continue the loop,
        // nudging the model to delegate a reviewer first. Forced only once (reviewForced); if the model still insists, let it through, to avoid a deadlock.
        if (mode === "dev" && riskyChangePending && !reviewForced) {
          reviewForced = true;
          if (!convo.some((mm) => mm.role === "system" && mm.content === FORCE_REVIEW_NUDGE)) {
            convo = [...convo, { role: "system", content: FORCE_REVIEW_NUDGE }];
            syncView();
          }
          continue;
        }

        // Wrap-up guard: this round executed a tool (e.g. a subagent already returned a result), yet the model ends with empty content — the user saw nothing.
        // Inject one FINALIZE_NUDGE to nudge it to answer formally based on the obtained information, then continue the loop. Only once, to avoid a deadlock.
        if (didToolCall && !finalizeNudged && !(msg.content ?? "").trim()) {
          finalizeNudged = true;
          if (!convo.some((mm) => mm.role === "system" && mm.content === FINALIZE_NUDGE)) {
            convo = [...convo, { role: "system", content: FINALIZE_NUDGE }];
            syncView();
          }
          continue;
        }

        // Normal reply → end (the body was already finalized and displayed by renderTurn above, and archiving was done when the message was produced, so it is not repeated here).
        // A background conversation does not write the current view; when switched back to, its display is rebuilt from the store by loadConversation.
        // End of conversation: archive the task list into the chat record, and collapse the floating panel above the input box (active conversation only).
        if (active() && todosRef.current.length > 0) {
          pushDisplay({ kind: "todos", todos: todosRef.current });
          setTodosBoth([]);
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
          });
        setSessionUsage((s) => ({
          prompt: s.prompt + u.prompt,
          completion: s.completion + u.completion,
          total: s.total + total,
          cached: s.cached + u.cached,
          estimated: s.estimated || u.estimated,
        }));
      }
      // Queue resume: after a normal end (not a user interruption), if this conversation still has queued messages and is still the current conversation, auto-send the next one.
      // Interruption (the user clicked "stop") does not resume — cancel() clears this conversation's queue at the same time.
      if (!ctrl.signal.aborted) processQueue(genConvId);
    }
  };

  // On every render, refresh the "resend from a user message" implementation, capturing the latest send / state (see the note at the resendRef declaration).
  resendRef.current = (displayIndex, newText) => {
    if (loading) return; // Editing / regenerating is not allowed while generating
    if (!newText.trim()) return;
    const disp = displayRef.current;
    const target = disp[displayIndex];
    if (!target || target.kind !== "user") return;
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
    // Resend from this point with the new text (without the staged attachments, to avoid mistakenly merging in input-box attachments).
    void send({ text: newText, attachments: [] });
  };

  return (
    <div className="relative flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface-muted text-ink">
      {/* Header */}
      <div className="border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto w-full px-4 py-3">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-white shadow-sm">
              AI
            </span>
            <h1 className="text-base font-bold">{t("chat.title")}</h1>
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
              onClick={() => setSettingsOpen((o) => !o)}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
              title={t("chat.settingsTitle")}
              aria-expanded={settingsOpen}
            >
              ⚙ {t("chat.settings")}
              <span
                className={`inline-block text-ink-subtle transition-transform ${settingsOpen ? "rotate-180" : ""}`}
              >
                ▾
              </span>
            </button>
            <button
              onClick={() => setSkillsOpen(true)}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-line hover:bg-surface-muted active:scale-[0.98]"
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
                onClick={discardActiveConversation}
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
      <div ref={scrollRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-auto bg-surface">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5">
          {display.length === 0 && (
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

          {(() => {
            // Gather consecutive "deep thinking + tool calls" (the AI's thinking / operation trace) into a single collapsible
            // "thinking process" card, while the rest of the messages (user / reply / usage / todos / choice) are rendered one by one as usual.
            const nodes: React.ReactNode[] = [];
            let i = 0;
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

          {loading && !display.some((m) => m.kind === "choice" && m.selected === null) && (
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
        </div>

        {/* Context usage: a frosted-glass bar, sticky-pinned to the bottom of the message area; messages scroll behind its semi-transparent background,
            and backdrop-filter blurs it, giving a frosted-glass texture (see figure 2). */}
        {activeModel &&
          (() => {
            const contextWindow = activeModel.contextWindow ?? resolveContextWindow(activeModel.model);
            const pct = contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
            const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div className="sticky bottom-0 z-10 mt-auto border-t border-line/70 bg-surface/60 px-4 py-2 backdrop-blur-md supports-[backdrop-filter]:bg-surface/60">
                <div className="mx-auto w-full max-w-3xl">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-ink-subtle">
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
                        disabled={compacting || loading || pct < MANUAL_COMPACT_MIN_PCT * 100}
                        className="rounded px-1 py-px text-[10px] font-medium text-ink-subtle transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        title={
                          pct < MANUAL_COMPACT_MIN_PCT * 100
                            ? t("chat.compactMinTitle")
                            : t("chat.compactNowHint")
                        }
                      >
                        {compacting ? t("chat.compacting") : t("chat.compactNow")}
                      </button>
                    </div>
                    <span className="tabular-nums">
                      {abbreviateNumber(contextTokens)} / {abbreviateNumber(contextWindow)} · {pct}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover/70">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
      </div>
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
          Auto-focused on appearance; use ↑/↓ to select, Enter to confirm, Esc to reject. */}
      {pending && (
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
      {todos.length > 0 && !pending && (
        <TodoPanel todos={todos} onToggle={toggleTodo} onClear={() => setTodosBoth([])} />
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
