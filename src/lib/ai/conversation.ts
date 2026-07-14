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
  files?: { name: string; size: number; embedded: boolean }[]; // metadata of non-image attachments
  /** Tool calls initiated by the assistant (OpenAI-compatible structure); only present on "assistant messages that called tools". */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** The call id corresponding to a tool-result message; only present when role==="tool". */
  tool_call_id?: string;
  /** Tool name (only when role==="tool", used to rebuild the UI bubble; not part of the integrity hash). */
  name?: string;
  /** The reasoning model's "deep thinking" body (only when role==="assistant"): used only to rebuild the UI thinking block, never fed back to the model, not part of the integrity hash. */
  reasoning?: string;
  /**
   * The user's rating of this assistant reply (only when role==="assistant"): thumbs-up = up / thumbs-down = down.
   * This is user-feedback "metadata": not written into content and not part of the integrity hash (see canonical.ts, whose projectMessage projects
   * only fixed fields, so adding this field doesn't invalidate existing signatures, and changing the rating doesn't trigger re-signing). When reading history, a
   * feedback hint is dynamically injected into the "wire view sent to the model" based on it (see injectRatingFeedback), but the content of this archived entry is never modified.
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
  createdAt: number;
  updatedAt: number;
}

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
