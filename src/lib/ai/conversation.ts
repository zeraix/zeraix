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
 * A project's "identity" = working directory + mode: the same folder is two independent projects (separate files) in daily vs. dev mode.
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
  servedBy?: string;
  /** The tool calls a sub-agent made inside its own loop (on a run_subagent or spawn_subagents tool result;
   *  a spawned batch collects every delegation's calls onto the one message, each prefixed with its job id).
   *  The sub-agent conversation itself is never persisted — only its conclusion goes into content — so
   *  without this the steps the user watched in real time would disappear the moment the conversation is
   *  reopened. A spawned delegation settles after its message is written, so these arrive by patch
   *  (setMessageSteps) rather than with the append.
   *  Display-only, never fed to the model, not part of the integrity hash (same as name / image). */
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
   * Session-level bound model id (AgentModel.id). Dev mode: each session binds its own model;
   * Daily mode: left empty by default and uses the globally selected model, but the field is kept to support a future "daily mode also binds per session".
   * When absent / pointing to a deleted model, falls back to the globally selected model.
   */
  modelId?: string;
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
   * The composed system message (messages[0]) as this conversation first sent it.
   *
   * It has to be frozen, not recomputed: it is the very front of the prefix, so re-deriving it against the current mode, workdir,
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

/** A project = working directory + mode. An empty workdir means the "default project" (daily mode with no folder chosen). */
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
