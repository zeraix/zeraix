/**
 * Data model and persistence for projects / conversation records (one file per project + lazy loading).
 *
 * Storage layout:
 *  - Index: project metadata only (lightweight), loaded once at app startup;
 *  - Each project's conversations live in their own file, loaded only when that project is first opened, to avoid an oversized single file.
 * Persistence:
 *  - Electron: written via window.agentStore (preload) to the index and per-project files under <storage directory>;
 *  - Browser: falls back to localStorage (@zzcpt/zztool, keys agent.store.*).
 * A failed read always falls back to empty and never throws.
 *
 * A project's "identity" = its working directory. It used to be "working directory + mode", so one folder was two independent
 * projects (separate files) in daily vs. dev mode; the two mode tags merged into one, so a folder is now exactly one project.
 */
import { getStorage, removeStorage, setStorage } from "@zzcpt/zztool";
import { AGENT_STORE_KEY } from "@/constants/Agent";
import type { AgentMode } from "@/constants/Agent";

/** A single archived message (user / assistant body + tool-call trace, so the model still knows what it did after a session is reopened). */
export interface StoredMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  images?: string[]; // accessible URLs of image attachments
  /**
   * The user turn as the MODEL saw it, when that differs from `content`.
   *
   * `content` is the text the user typed, because the chat bubble renders it — so it deliberately omits
   * what send() appends for the model: inlined text-file contents, and the working-directory paths of
   * saved binary/image attachments. Replaying `content` on reload therefore handed the model a message
   * missing the attachment it was asked about. Written only when the two actually differ, so ordinary
   * messages are unchanged. Model-facing (unlike images/steps, which are display-only).
   */
  wireText?: string;
  /**
   * The <system-reminder> block(s) this turn carried when it was sent (user and tool turns).
   *
   * Kept OUT of `content` on purpose: `content` stays "what the user typed" / "what the tool returned", so the UI renders it
   * unchanged and any transform over it (stubbing a stale tool result, stripping images) cannot destroy operator text the model
   * has already seen. The two are merged only when the wire is built. Not part of the integrity hash (same as rating / name /
   * image / reasoning). See docs/cache-stable-prompt-context.md.
   */
  reminderText?: string;
  /**
   * Structured copy of the standing state that `reminderText` announces (only when role==="user").
   *
   * Exists so compaction can fold the state without re-parsing prose. Stripped from the wire before sending, so nothing the model
   * needs may depend on it. Not part of the integrity hash.
   */
  reminder?: {
    workdir?: string;
    env?: string;
    ctx?: { date: string; model: string; tz: string };
    skills?: { id: string; description: string }[];
    disabledTools?: string[];
    task?: string;
  };
  files?: { name: string; size: number; embedded: boolean }[]; // metadata of non-image attachments
  /** Tool calls initiated by the assistant (OpenAI-compatible structure); only present on "assistant messages that called tools". */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** The call id corresponding to a tool-result message; only present when role==="tool". */
  tool_call_id?: string;
  /** Tool name (only when role==="tool", used to rebuild the UI bubble; not part of the integrity hash). */
  name?: string;
  /** A generated image's artifact URL and engine (only on an image_generation tool result): used to rebuild the image
   *  bubble after reload — the tool's text content is only a note, so without this the picture vanishes on switching
   *  conversations. Display-only, not fed to the model, not part of the integrity hash (same as name / steps). */
  image?: string;
  /** A generated video's artifact URL, for the same reason and with the same rules as `image`. Kept as its
   *  own field rather than reusing `image`: a reload that put a video URL in an <img> would render nothing,
   *  and the failure would look like the artifact was lost rather than mis-typed. */
  video?: string;
  servedBy?: string;
  /**
   * LEGACY: a sub-agent's inner tool calls, as written by builds before the Sub-agent Inspector existed.
   *
   * No longer written and no longer rendered — a delegation's run is now a page in the Inspector, and
   * duplicating it inside the transcript said the same thing twice in the place least able to afford the
   * room. Kept in the type so that conversations already on disk stay describable, and so the name is not
   * quietly reused for something else.
   */
  steps?: { name: string; args: unknown; ok: boolean; result: string }[];
  /** The reasoning model's "deep thinking" body (only when role==="assistant"): rebuilds the UI thinking block, and — for LOCAL
   *  models only — is replayed to the model as `reasoning_content` on the turns their chat template renders it back on (see
   *  applyReasoningPolicy). Remote providers never receive it. Not part of the integrity hash, which covers persisted content
   *  for tamper-detection and signing, not what a prompt renders to. */
  reasoning?: string;
  /**
   * The user's rating of this assistant reply (only when role==="assistant"): thumbs-up = up / thumbs-down = down.
   * This is user-feedback "metadata": not written into content and not part of the integrity hash (see canonical.ts, whose projectMessage projects
   * only fixed fields, so adding this field doesn't invalidate existing signatures, and changing the rating doesn't trigger re-signing). When reading history, a
   * rating is kept for audit only and is stripped from the wire before sending (see stripWireMetadata); the archived entry is never modified.
   */
  rating?: "up" | "down";
  /**
   * How long the model took on the round this message came from, in milliseconds (only when role==="assistant").
   *
   * Display-only, like name / image / steps: it feeds the "took 6s" label on the thinking-process header, is never fed
   * to the model, and is not part of the integrity hash. Measured around the request itself rather than derived from
   * `ts` deltas — the gap between two stored messages also contains tool execution and, for a background conversation,
   * however long the user left it alone.
   */
  thinkMs?: number;
  ts: number;
}

/**
 * Persisted snapshot of context compaction (used only for the "wire view" sent to the model; not part of the integrity hash — see canonical.ts,
 * whose projectChat projects only messages). The summary is a runtime artifact; after being written to disk, compaction is preserved across close/reopen without re-summarizing.
 * stubs is the key-value array form of a Map (JSON-friendly).
 */
export interface StoredCompaction {
  frozenLen: number;
  coversCount: number;
  summarizedTurns: number;
  summaryText: string | null;
  reuseCount?: number; // how many turns this summary has been reused (error-hardening §B1); forces re-summary at a cap
  stubs: [string, string][];
  manual: boolean; // whether the user manually triggered "compact now" (kept even when usage falls back below the threshold)
  compacted: boolean; // whether the wire view is actually compacted right now (drives the "compacted" marker)
  ctxTokens: number; // estimated usage after compaction (the progress bar has a value immediately on reopen, no need to wait for the next request)
}

/** A single conversation (belonging to a project). */
export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  mode: AgentMode;
  workdir?: string;
  /**
   * Session-level bound model id (AgentModel.id): each session binds its own model.
   * When absent / pointing to a deleted model, falls back to the globally selected model.
   */
  modelId?: string;
  /**
   * Secure environment: whether THIS session's commands run inside the sandbox VM (true) or directly on the host (false).
   *
   * Bound to the conversation, never to the project. A project spans many sessions, and the instructions accumulated in one
   * ("the binary is at /workspace/bin", "use the host's node", a path the model was told to reuse) are wrong under the other
   * environment — a project-level setting propagated that stale context into every later chat, which is the confusion this
   * replaces. Undefined on records written before the switch existed, and on any session that never had one resolved; readers
   * fall back to the project's most recent session and then to DEFAULT_SECURE_ENV (see agentChatStore.secureEnvDefaultFor).
   *
   * A runtime artifact like compaction / taskMemory: it steers execution, and its consequences reach the model as the
   * command-environment change event (reminders.ts), not as a persisted field. Not part of the integrity hash.
   */
  secureEnv?: boolean;
  messages: StoredMessage[];
  /** Context-compaction snapshot (optional): restores the compaction state after close/reopen. Not part of the integrity hash. */
  compaction?: StoredCompaction;
  /** Task Memory (optional): the pinned per-mission prose brief (internal, model-only). A runtime artifact
   *  like compaction; restored on reopen so the mission survives, and not part of the integrity hash. */
  taskMemory?: StoredTaskMemory;
  /** Goal State (optional): objective, acceptance criteria, plan, blockers and the verification record (see
   *  app/agent/chat/goalState.ts). Persisted for the same reason as taskMemory and one more: the wrap-up gate
   *  refuses to end a turn on an unmet goal, so a goal that did not survive reopen would silently turn a
   *  half-finished task into a finished one. A runtime artifact, not part of the integrity hash. */
  goal?: StoredGoalState;
  /**
   * The task checklist (optional): what `update_todos` last recorded, and what the panel above the composer
   * shows.
   *
   * Persisted since 2026-08-25. Before that the list lived only in memory and was archived as a display
   * bubble when a turn ended, so reopening a conversation mid-task showed the transcript of a checklist and
   * no checklist — the model's plan survived in Goal State while the user's view of it did not. A conversation
   * written by an older build simply has no field here; `normalizeTodos` reads that as an empty list, which is
   * exactly what those conversations behaved as.
   *
   * A runtime artifact like compaction / taskMemory / goal: it steers and displays execution, and it is not
   * part of any signature over the message list.
   */
  todos?: StoredTodo[];
  /**
   * The composed system message (messages[0]) as this conversation first sent it.
   *
   * It has to be frozen, not recomputed: it is the very front of the prefix, so re-deriving it against the current workdir,
   * sandbox status and skill set would invalidate the whole conversation's cache with no user-visible trigger — which is what
   * happened on every reload, because the rebuilt buffer contains no system message and the compose step ran again.
   * A runtime artifact like compaction / taskMemory, and not part of the integrity hash.
   */
  systemPrompt?: string;
  /**
   * Conversation ids of the sub-agents this conversation has run.
   *
   * A sub-agent is an isolated context, so it gets its own conversation id on the local server rather than reusing
   * this one — sharing an id would route it onto this conversation's slot and overwrite the KV it is resident in.
   * The server has no notion of a sub-conversation, so this list is the only record that they belong together, and
   * deleting this conversation has to name them all or their KV outlives it.
   *
   * A runtime artifact like compaction / taskMemory: persisted with the conversation, never sent to a model.
   */
  subConvIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Persisted Task Memory (see app/agent/chat/taskMemory.ts). Structurally identical to TaskMemory; kept
 *  here to avoid a lib→app import. Read back through normalizeTaskMemory, which repairs any partial data. */
export interface StoredTaskMemory {
  /** Free-form markdown task brief (mission / plan / constraints / decisions in the model's own words). */
  notes: string;
  /** Provenance: "model" (deliberate, immune) or "auto-extracted" (refreshable). Missing → treated as "model". */
  source?: "model" | "auto-extracted";
}

/**
 * Persisted Goal State (see app/agent/chat/goalState.ts).
 *
 * Deliberately typed as an opaque JSON record rather than a structural copy of GoalState. StoredTaskMemory could
 * mirror its two fields without cost; this shape has six nested arrays whose members carry their own status
 * enums, and a duplicate here would be a second definition to keep in step — for no benefit, since everything
 * read back goes through normalizeGoal(), which repairs partial and older records anyway.
 */
export type StoredGoalState = Record<string, unknown>;


/**
 * One persisted checklist item (see app/agent/chat/types.ts `Todo`).
 *
 * Structurally identical to `Todo`, and declared here for the same reason `StoredTaskMemory` is: a lib module
 * must not import from the app layer to describe its own on-disk shape. Read back through `normalizeTodos`,
 * which repairs partial or older records rather than trusting them.
 */
export interface StoredTodo {
  title: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Repair a persisted checklist.
 *
 * Absent, malformed, or written by a build that did not have this field all produce an empty list — the
 * behaviour those conversations already had. Unknown statuses fall back to "pending" rather than being
 * dropped, because losing an item silently is worse than showing it as not-yet-done.
 */
export function normalizeTodos(raw: unknown): StoredTodo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const status = o.status;
      return {
        title: String(o.title ?? "").trim(),
        status: (status === "in_progress" || status === "completed" ? status : "pending") as StoredTodo["status"],
      };
    })
    .filter((t) => t.title);
}

/** A project = a working directory. An empty workdir means the "default project" (no folder chosen). */
export interface Project {
  id: string;
  name: string;
  workdir: string;
  mode: AgentMode;
  createdAt: number;
}

interface AgentStoreBridge {
  loadIndex(): Promise<{ projects: Project[] }>;
  loadProject(projectId: string): Promise<{ conversations: Conversation[] }>;
  saveIndex(projects: Project[]): Promise<boolean>;
  saveProject(projectId: string, conversations: Conversation[]): Promise<boolean>;
  deleteProject(projectId: string): Promise<boolean>;
  getPath(): Promise<string>; // storage directory
  setPath(dir: string): Promise<string>;
  choosePath(): Promise<string | null>;
}

declare global {
  interface Window {
    agentStore?: AgentStoreBridge;
  }
}

function bridge(): AgentStoreBridge | undefined {
  return typeof window !== "undefined" ? window.agentStore : undefined;
}

const asProjects = (v: unknown): Project[] => (Array.isArray(v) ? (v as Project[]) : []);
const asConvs = (v: unknown): Conversation[] => (Array.isArray(v) ? (v as Conversation[]) : []);

// ── localStorage dot-paths for the browser fallback ─────────────────────────────
const webIndexKey = () => `${AGENT_STORE_KEY}.index`;
const webProjKey = (id: string) => `${AGENT_STORE_KEY}.proj.${id}`;

/** Whether file storage is supported (Electron only; the browser uses localStorage, with no file path). */
export function isFileStoreAvailable(): boolean {
  return !!bridge();
}

// ── Index (project metadata) ────────────────────────────────────────────────────
export async function loadIndex(): Promise<Project[]> {
  const b = bridge();
  if (b) {
    try {
      return asProjects((await b.loadIndex())?.projects);
    } catch {
      /* fall through to the fallback */
    }
  }
  return asProjects(getStorage(webIndexKey()));
}

export async function saveIndex(projects: Project[]): Promise<void> {
  const b = bridge();
  if (b) {
    try {
      await b.saveIndex(projects);
      return;
    } catch {
      /* fall through to the fallback */
    }
  }
  // An empty array can also be written with setStorage ([] is truthy).
  setStorage(webIndexKey(), projects);
}

// ── A single project's conversations ─────────────────────────────────────────────
export async function loadProjectConversations(projectId: string): Promise<Conversation[]> {
  const b = bridge();
  if (b) {
    try {
      return asConvs((await b.loadProject(projectId))?.conversations);
    } catch {
      /* fall through to the fallback */
    }
  }
  return asConvs(getStorage(webProjKey(projectId)));
}

export async function saveProjectConversations(
  projectId: string,
  conversations: Conversation[],
): Promise<void> {
  const b = bridge();
  if (b) {
    try {
      await b.saveProject(projectId, conversations);
      return;
    } catch {
      /* fall through to the fallback */
    }
  }
  setStorage(webProjKey(projectId), conversations);
}

export async function deleteProjectFile(projectId: string): Promise<void> {
  const b = bridge();
  if (b) {
    try {
      await b.deleteProject(projectId);
      return;
    } catch {
      /* fall through to the fallback */
    }
  }
  removeStorage(webProjKey(projectId));
}

// ── Storage directory (Electron only) ──────────────────────────────────────────
export async function getStorePath(): Promise<string> {
  const b = bridge();
  if (b) {
    try {
      return await b.getPath();
    } catch {
      /* ignore */
    }
  }
  return "";
}

export async function setStorePath(dir: string): Promise<string | null> {
  const b = bridge();
  if (b) {
    try {
      return await b.setPath(dir);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function chooseStorePath(): Promise<string | null> {
  const b = bridge();
  if (b) {
    try {
      return await b.choosePath();
    } catch {
      /* ignore */
    }
  }
  return null;
}
