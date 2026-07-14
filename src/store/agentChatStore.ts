import { create } from "zustand";
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
  setActiveProject: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  /** Flags or clears a conversation as "generating" (drives the sidebar loading spinner). Keyed by conversation ID, independent of the active conversation. */
  setConversationGenerating: (id: string, on: boolean) => void;
  getConversation: (id: string) => Conversation | undefined;
  /** Binds or clears the model for a conversation (conversation-level model binding; null falls back to global configuration). */
  setConversationModel: (id: string, modelId: string | null) => void;
  /** Saves or clears the context compaction snapshot for a conversation (persists to disk only). */
  setConversationCompaction: (id: string, compaction: StoredCompaction | null) => void;
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
