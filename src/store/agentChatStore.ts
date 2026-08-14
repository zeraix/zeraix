import { create } from "zustand";
import { localLlm } from "@/lib/ai/localModel";
import type { AgentMode } from "@/constants/Agent";
import type { Attachment } from "@/lib/ai/attachments";
import {
  deleteProjectFile,
  loadIndex,
  loadProjectConversations,
  saveIndex,
  saveProjectConversations,
  type Conversation,
  type Project,
  type StoredCompaction,
  type StoredMessage,
  type StoredTaskMemory,
  type StoredGoalState,
} from "@/lib/ai/conversation";

/** Temporary storage for the "initial message" to be sent when transitioning from Home to Chat page (passed in-memory via SPA client navigation). */
export type PendingSend = { text: string; attachments: Attachment[] };

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const DEFAULT_PROJECT_NAME = "Default project";
const DEFAULT_TITLE = "New Chat";

/** Gets the last segment of a path to use as the folder name (cross-platform compatible with Windows `\` and POSIX `/`). */
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

type AgentChatState = {
  /** Project index (loaded upon startup). */
  projects: Project[];
  /** Conversations of loaded projects (lazy-loaded: only contains projects that have been opened). */
  conversations: Conversation[];
  /** Set of project IDs for projects that have been loaded. */
  loadedProjectIds: Set<string>;
  activeProjectId: string | null;
  activeConversationId: string | null;
  loaded: boolean;
  /** Temporary storage for the "initial message" to be sent when transitioning from Home to Chat page (passed in-memory via SPA client navigation). */
  pendingSend: PendingSend | null;
  /** Record of conversations that are currently generating (AI output in progress): used by the sidebar to display spinners. Controlled by conversation ID, supports background concurrency. */
  generating: Record<string, boolean>;
  /** Record of conversations that have a sensitive-tool confirmation waiting for the user: used by the sidebar to show an "approval needed" badge, so a request made in a background conversation is discoverable. Transient (not persisted). */
  pendingConsent: Record<string, boolean>;

  /** Initially loads the project index (idempotent, does not load conversations). */
  init: () => Promise<void>;
  /** Reloads the index and clears loaded conversations (e.g., after switching storage directories). */
  reload: () => Promise<void>;
  /** Lazy-loads conversations for a specific project (idempotent). */
  ensureProjectLoaded: (projectId: string) => Promise<void>;
  setPendingSend: (p: PendingSend | null) => void;
  consumePendingSend: () => PendingSend | null;
  /** Finds or creates a project based on "working directory + mode" and returns its ID. */
  ensureProject: (workdir: string | undefined, mode: AgentMode) => string;
  /** Creates a new conversation (assigned to the project matching projectWorkdir + mode), sets it as the active conversation, and returns its ID. */
  createConversation: (opts: { mode: AgentMode; workdir?: string; projectWorkdir?: string }) => string;
  /** Appends a message to a conversation (the first user message will automatically generate a title). */
  appendMessage: (convId: string, msg: StoredMessage) => void;
  /** Truncates a conversation to retain only the first `count` messages (used to resend from a specific point during "edit user message / regenerate"). */
  truncateMessages: (convId: string, count: number) => void;
  /** Sets or clears the user rating for a specific message (like/dislike). Only persists to storage. */
  setMessageRating: (convId: string, index: number, rating: "up" | "down" | null) => void;
  /** Attach a change event to a message that is already on disk. Never touches `content`. */
  setMessageReminder: (
    convId: string,
    index: number,
    reminderText: string,
    reminder?: StoredMessage["reminder"],
  ) => void;
  /** Attach a sub-agent's tool trace to a tool message already on disk. Never touches `content`. */
  setMessageSteps: (convId: string, index: number, steps: NonNullable<StoredMessage["steps"]>) => void;
  setActiveProject: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  /** Flags or clears a conversation as "generating" (drives the sidebar loading spinner). Keyed by conversation ID, independent of the active conversation. */
  setConversationGenerating: (id: string, on: boolean) => void;
  /** Replaces the set of conversations that have a pending sensitive-tool confirmation (drives the sidebar approval-needed badge). */
  setPendingConsentIds: (ids: Set<string>) => void;
  getConversation: (id: string) => Conversation | undefined;
  /** Binds or clears the model for a conversation (conversation-level model binding; null falls back to global configuration). */
  setConversationModel: (id: string, modelId: string | null) => void;
  /** Saves or clears the context compaction snapshot for a conversation (persists to disk only). */
  setConversationCompaction: (id: string, compaction: StoredCompaction | null) => void;
  /** Saves or clears the Task Memory (prose brief + todos) for a conversation (persists to disk only). */
  setConversationTaskMemory: (id: string, taskMemory: StoredTaskMemory | null) => void;
  /** Saves or clears the Goal State (objective / criteria / plan / verification) for a conversation (persists to disk only). */
  setConversationGoal: (id: string, goal: StoredGoalState | null) => void;
  /** Freeze this conversation's composed system message, so reopening it replays the same prefix instead of recomputing one. */
  setConversationSystemPrompt: (id: string, systemPrompt: string) => void;
  /** Record a sub-agent's own conversation id, so deleting this conversation can forget its KV too (Conversation.subConvIds). */
  addSubConvId: (id: string, subConvId: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  /** Renames a project (changes its display name). */
  renameProject: (id: string, name: string) => void;
  /** Deeply deletes an entire project: wipes out the project along with all its associated conversations and files. */
  deleteProjectDeep: (id: string) => Promise<void>;
};

export const useAgentChatStore = create<AgentChatState>((set, get) => {
  // Debounced per-project persistence: records dirty projects and index changes, 
  // batch-saving them to disk after a brief delay.
  const dirtyProjects = new Set<string>();
  let indexDirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const { projects, conversations } = get();
      if (indexDirty) {
        indexDirty = false;
        void saveIndex(projects);
      }
      const pids = [...dirtyProjects];
      dirtyProjects.clear();
      for (const pid of pids) {
        void saveProjectConversations(pid, conversations.filter((c) => c.projectId === pid));
      }
    }, 250);
  };
  const markProjectDirty = (pid: string) => {
    dirtyProjects.add(pid);
    scheduleFlush();
  };
  const markIndexDirty = () => {
    indexDirty = true;
    scheduleFlush();
  };

  return {
    projects: [],
    conversations: [],
    loadedProjectIds: new Set<string>(),
    activeProjectId: null,
    activeConversationId: null,
    loaded: false,
    pendingSend: null,
    generating: {},
    pendingConsent: {},

    setPendingSend: (p) => set({ pendingSend: p }),
    consumePendingSend: () => {
      const p = get().pendingSend;
      if (p) set({ pendingSend: null });
      return p;
    },

    init: async () => {
      if (get().loaded) return;
      const projects = await loadIndex();
      set({ projects, loaded: true });
    },

    reload: async () => {
      const projects = await loadIndex();
      set({
        projects,
        conversations: [],
        loadedProjectIds: new Set<string>(),
        activeProjectId: null,
        activeConversationId: null,
        loaded: true,
      });
    },

    ensureProjectLoaded: async (projectId) => {
      if (get().loadedProjectIds.has(projectId)) return;
      const convs = await loadProjectConversations(projectId);
      set((s) => {
        if (s.loadedProjectIds.has(projectId)) return s; // Deduplicate concurrent requests
        const loaded = new Set(s.loadedProjectIds);
        loaded.add(projectId);
        return {
          loadedProjectIds: loaded,
          conversations: [...s.conversations.filter((c) => c.projectId !== projectId), ...convs],
        };
      });
    },

    ensureProject: (workdir, mode) => {
      const key = workdir ?? ""; // Empty string = default project (daily mode without selected folder)
      const found = get().projects.find((p) => (p.workdir ?? "") === key && p.mode === mode);
      if (found) {
        set({ activeProjectId: found.id });
        return found.id;
      }
      const project: Project = {
        id: uid(),
        name: key ? basename(key) : DEFAULT_PROJECT_NAME,
        workdir: key,
        mode,
        createdAt: Date.now(),
      };
      set((s) => {
        const loaded = new Set(s.loadedProjectIds);
        loaded.add(project.id); // New project (with no conversations) is considered loaded
        return { projects: [...s.projects, project], activeProjectId: project.id, loadedProjectIds: loaded };
      });
      markIndexDirty();
      return project.id;
    },

    createConversation: ({ mode, workdir, projectWorkdir }) => {
      const pid = get().ensureProject(projectWorkdir, mode);
      const now = Date.now();
      const conv: Conversation = {
        id: uid(),
        projectId: pid,
        title: DEFAULT_TITLE,
        mode,
        workdir,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({
        conversations: [conv, ...s.conversations],
        activeConversationId: conv.id,
        activeProjectId: pid,
      }));
      markProjectDirty(pid);
      return conv.id;
    },

    appendMessage: (convId, msg) => {
      const pid = get().getConversation(convId)?.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== convId) return c;
          const isFirstUser = msg.role === "user" && c.messages.length === 0;
          const title =
            isFirstUser && (c.title === DEFAULT_TITLE || !c.title)
              ? msg.content.replace(/\s+/g, " ").trim().slice(0, 30) || DEFAULT_TITLE
              : c.title;
          return { ...c, title, messages: [...c.messages, msg], updatedAt: Date.now() };
        }),
      }));
      if (pid) markProjectDirty(pid);
    },

    truncateMessages: (convId, count) => {
      const conv = get().getConversation(convId);
      if (!conv || count >= conv.messages.length) return; // No truncation required
      const pid = conv.projectId;
      const kept = Math.max(0, count);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === convId ? { ...c, messages: c.messages.slice(0, kept), updatedAt: Date.now() } : c,
        ),
      }));
      if (pid) markProjectDirty(pid);
    },

    setMessageRating: (convId, index, rating) => {
      const conv = get().getConversation(convId);
      if (!conv || index < 0 || index >= conv.messages.length) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== convId) return c;
          const messages = c.messages.map((m, i) => {
            if (i !== index) return m;
            if (rating) return { ...m, rating };
            const { rating: _drop, ...rest } = m; // Clear rating
            return rest;
          });
          return { ...c, messages, updatedAt: Date.now() };
        }),
      }));
      // Rating: Disk write only.
      if (pid) markProjectDirty(pid);
    },

    /**
     * Attach a change event to a message that is already on disk.
     *
     * The turn is always persisted before the event is known — a user turn is stored before compaction runs, and a tool result is
     * stored before the guard that may nudge on it. Without this the reminder would live only in memory: in the wire on one turn,
     * gone on the next, and back after a reload, which is exactly the prefix break the design exists to prevent.
     *
     * Writes `reminderText`, never `content`. See docs/cache-stable-prompt-context.md.
     */
    setMessageReminder: (convId, index, reminderText, reminder) => {
      const conv = get().getConversation(convId);
      if (!conv || index < 0 || index >= conv.messages.length) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== convId) return c;
          const messages = c.messages.map((m, i) =>
            i === index ? { ...m, reminderText, ...(reminder ? { reminder } : {}) } : m,
          );
          return { ...c, messages, updatedAt: Date.now() };
        }),
      }));
      if (pid) markProjectDirty(pid);
    },

    /**
     * Attach a sub-agent's tool trace to a tool message already on disk.
     *
     * Concurrent delegations settle *after* the tool result that started them was persisted, so their
     * steps cannot be written by appendMessage the way a blocking run_subagent's are. Without this the
     * trace would exist only in memory: visible while the user watched it happen, gone on reload — the
     * exact live/reloaded divergence the nesting design exists to prevent.
     */
    setMessageSteps: (convId, index, steps) => {
      const conv = get().getConversation(convId);
      if (!conv || index < 0 || index >= conv.messages.length) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => {
          if (c.id !== convId) return c;
          const messages = c.messages.map((m, i) => (i === index ? { ...m, steps } : m));
          return { ...c, messages, updatedAt: Date.now() };
        }),
      }));
      if (pid) markProjectDirty(pid);
    },

    setActiveProject: (id) => {
      set({ activeProjectId: id });
      void get().ensureProjectLoaded(id);
    },
    setActiveConversation: (id) => set({ activeConversationId: id }),

    setConversationGenerating: (id, on) =>
      set((s) => {
        if (!!s.generating[id] === on) return s; // No changes; avoid unnecessary re-rendering.
        const next = { ...s.generating };
        if (on) next[id] = true;
        else delete next[id];
        return { generating: next };
      }),

    setPendingConsentIds: (ids) =>
      set((s) => {
        const prev = s.pendingConsent;
        const prevKeys = Object.keys(prev);
        // No change (same set of ids) → skip the update to avoid a needless sidebar re-render.
        if (prevKeys.length === ids.size && prevKeys.every((k) => ids.has(k))) return s;
        const next: Record<string, boolean> = {};
        ids.forEach((id) => (next[id] = true));
        return { pendingConsent: next };
      }),
    getConversation: (id) => get().conversations.find((c) => c.id === id),

    setConversationModel: (id, modelId) => {
      const pid = get().getConversation(id)?.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, modelId: modelId || undefined } : c,
        ),
      }));
      if (pid) markProjectDirty(pid);
    },

    setConversationCompaction: (id, compaction) => {
      const conv = get().getConversation(id);
      if (!conv) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, compaction: compaction ?? undefined } : c,
        ),
      }));
      // Compaction involves only flushing to disk.
      if (pid) markProjectDirty(pid);
    },

    addSubConvId: (id, subConvId) => {
      const conv = get().getConversation(id);
      if (!conv || !subConvId || conv.subConvIds?.includes(subConvId)) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, subConvIds: [...(c.subConvIds ?? []), subConvId] } : c,
        ),
      }));
      // Called BEFORE the sub-agent's first request, so the id is known for the whole time KV can exist under it.
      // Persistence is debounced like every other runtime artifact, so process death inside that window still loses
      // the id and orphans its KV — bounded by the server's byte budget, and not worth a synchronous write per
      // delegation to close.
      if (pid) markProjectDirty(pid);
    },

    setConversationTaskMemory: (id, taskMemory) => {
      const conv = get().getConversation(id);
      if (!conv) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, taskMemory: taskMemory ?? undefined } : c,
        ),
      }));
      // Like compaction: a runtime artifact, flushed to disk only.
      if (pid) markProjectDirty(pid);
    },

    setConversationGoal: (id, goal) => {
      const conv = get().getConversation(id);
      if (!conv) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, goal: goal ?? undefined } : c)),
      }));
      // Like compaction and taskMemory: a runtime artifact, flushed to disk only.
      if (pid) markProjectDirty(pid);
    },

    setConversationSystemPrompt: (id, systemPrompt) => {
      const conv = get().getConversation(id);
      if (!conv || conv.systemPrompt === systemPrompt) return;
      const pid = conv.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, systemPrompt } : c)),
      }));
      // Like compaction: a runtime artifact, flushed to disk only.
      if (pid) markProjectDirty(pid);
    },

    renameConversation: (id, title) => {
      const pid = get().getConversation(id)?.projectId;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
      }));
      if (pid) markProjectDirty(pid);
    },

    deleteConversation: (id) => {
      const conv = get().getConversation(id);
      if (!conv) return;
      // Drop this conversation's KV on the local server too. The server keeps it on disk for as long as its tip manifest
      // exists and nothing else removes one, so without this the KV outlives the conversation permanently. Its sub-agents
      // are named as well: each ran under its own conversation id, and this record is the only thing that knows which.
      // Fire-and-forget: no local model running is the common case, and the ids are queued on disk until one is.
      void localLlm()?.eraseConversationsKv([id, ...(conv.subConvIds ?? [])]);
      const pid = conv.projectId;
      const remaining = get().conversations.filter((c) => c.projectId === pid && c.id !== id);
      set((s) => ({
        conversations: s.conversations.filter((c) => c.id !== id),
        activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
      }));
      if (remaining.length === 0) {
        // Project is empty → Remove project and its files.
        set((s) => {
          const loaded = new Set(s.loadedProjectIds);
          loaded.delete(pid);
          return {
            projects: s.projects.filter((p) => p.id !== pid),
            loadedProjectIds: loaded,
            activeProjectId: s.activeProjectId === pid ? null : s.activeProjectId,
          };
        });
        markIndexDirty();
        void deleteProjectFile(pid);
      } else {
        markProjectDirty(pid);
      }
    },

    renameProject: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      }));
      markIndexDirty();
    },

    deleteProjectDeep: async (id) => {
      // First, ensure that the conversation for the project has loaded.
      await get().ensureProjectLoaded(id);
      const convs = get().conversations.filter((c) => c.projectId === id);
      // Same reason as deleteConversation, for every conversation in the project — this path used to erase nothing at
      // all, so deleting a project left all of its KV on disk. ensureProjectLoaded above is what makes the list complete.
      void localLlm()?.eraseConversationsKv(convs.flatMap((c) => [c.id, ...(c.subConvIds ?? [])]));
      dirtyProjects.delete(id);
      set((s) => {
        const loaded = new Set(s.loadedProjectIds);
        loaded.delete(id);
        const removingActiveConv = convs.some((c) => c.id === s.activeConversationId);
        return {
          projects: s.projects.filter((p) => p.id !== id),
          conversations: s.conversations.filter((c) => c.projectId !== id),
          loadedProjectIds: loaded,
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
          activeConversationId: removingActiveConv ? null : s.activeConversationId,
        };
      });
      markIndexDirty();
      void deleteProjectFile(id);
    },
  };
});
