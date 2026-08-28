"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentChatStore } from "@/store/agentChatStore";
import { normalizeTodos } from "@/lib/ai/conversation";
import type { StoredGoalState, StoredTaskMemory, StoredTodo } from "@/lib/ai/conversation";
import type { Attachment, Todo } from "./types";
import {
  emptyTaskMemory,
  isTaskMemoryEmpty,
  normalizeTaskMemory,
  type TaskMemory,
} from "./taskMemory";
import {
  emptyGoal,
  isGoalEmpty,
  isGoalActive,
  restoreGoal,
  toStoredGoal,
  clearGoal,
  GOAL_ACHIEVED_LINGER_MS,
  applyTodoStatuses,
  type GoalState,
} from "./goalState";

type QueuedMsg = { id: number; text: string; attachments: Attachment[] };

/** What the queue panel renders: the payload stays in the ref, only the labels reach React. */
export type QueuedView = { id: number; text: string; hasAttachments: boolean };

/** The slice of a stored conversation record this hook restores itself from. */
export interface PerConvRecord {
  todos?: StoredTodo[];
  taskMemory?: StoredTaskMemory;
  goal?: StoredGoalState;
}

export interface PerConvState {
  // ── Message queue ────────────────────────────────────────────────────────────────────────────────────────
  queued: QueuedView[];
  /** Mirror a conversation's queue onto the panel, when that conversation is the one being viewed. */
  syncQueued: (convId: string | null) => void;
  enqueueMessage: (convId: string, text: string, attachments: Attachment[]) => void;
  /** Drop one queued message by id, from the viewed conversation. */
  removeQueued: (id: number) => void;
  /** Drop a conversation's whole queue, releasing its attachment previews. */
  clearQueue: (convId: string) => void;
  /** Take the front of a conversation's queue, or undefined when it is empty. */
  shiftQueued: (convId: string) => QueuedMsg | undefined;
  queueLength: (convId: string) => number;

  // ── Task list ────────────────────────────────────────────────────────────────────────────────────────────
  todos: Todo[];
  todosFor: (convId: string | null) => Todo[];
  setTodosFor: (convId: string | null, next: Todo[]) => void;
  /** Manual toggle: the USER ticking a box, which is also a statement about the plan. */
  toggleTodo: (index: number) => void;

  // ── Task Memory ──────────────────────────────────────────────────────────────────────────────────────────
  taskMemoryFor: (convId: string | null) => TaskMemory;
  setTaskMemoryFor: (convId: string | null, tm: TaskMemory) => void;

  // ── Goal State ───────────────────────────────────────────────────────────────────────────────────────────
  displayedGoal: GoalState | null;
  goalExpanded: boolean;
  setGoalExpanded: (v: boolean) => void;
  goalFor: (convId: string | null) => GoalState;
  setGoalFor: (convId: string | null, g: GoalState) => void;
  /** Clear an achieved goal after a short readable window (see GOAL_ACHIEVED_LINGER_MS). */
  scheduleGoalClear: (convId: string, achieved: GoalState) => void;
  /**
   * Show a goal that has no conversation to belong to yet — `/goal` typed before the first message. There is
   * no record to write to, so the bar is driven directly and the goal is stamped onto the record when
   * `send` creates it.
   */
  showPendingGoal: (g: GoalState | null) => void;

  // ── Conversation switch ──────────────────────────────────────────────────────────────────────────────────
  /**
   * Restore a conversation's checklist / brief / goal from its record and put them on screen. Called by
   * swapInConversation; the in-session refs win over disk, so a conversation that has been open stays live.
   */
  adoptConversation: (id: string, conv: PerConvRecord) => void;
  /** Wipe everything this hook holds for a conversation (the "clear chat" / "new chat" paths). */
  resetConversation: (convId: string | null) => void;
}

/**
 * The four pieces of state that belong to a CONVERSATION rather than to the page: the pending-message queue,
 * the visible checklist, the model's internal mission brief, and Goal State.
 *
 * All four follow the same shape, and for the same reasons. The authority is a ref keyed by conversation id —
 * the send loop reads and writes them from async closures that must see the current value synchronously, and a
 * single shared value let two conversations generating at once overwrite each other. Beside each ref is one
 * piece of React state mirroring whichever conversation is on screen, because a panel gated on a ref is
 * invisible to React and would only update when something else happened to re-render.
 *
 * Three of the four are persisted (todos, Task Memory, an ACTIVE goal): they are runtime artifacts flushed to
 * disk like compaction, so reopening a conversation mid-task brings back the work rather than a transcript of
 * it. The queue is deliberately not — a message the user queued and then quit on should not be sent on reopen.
 */
export function usePerConvState({ convIdRef }: { convIdRef: React.RefObject<string | null> }): PerConvState {
  // Message queue: while generating, a new send by the user is no longer dropped but enqueued per conversation (FIFO), and auto-sent in order after this round of generation ends.
  // The queue lives in the component (AgentShell keeps it permanently mounted), so switching pages inside /agent does not affect the queue or resume. Keyed by conversation id.
  const queueRef = useRef<Map<string, QueuedMsg[]>>(new Map());
  const queueIdRef = useRef(0);
  const [queued, setQueued] = useState<QueuedView[]>([]);

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

  const clearQueue = (convId: string) => {
    const q = queueRef.current.get(convId);
    if (!q?.length) return;
    q.forEach((m) => m.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)));
    queueRef.current.delete(convId);
    syncQueued(convId);
  };

  const shiftQueued = (convId: string) => {
    const q = queueRef.current.get(convId);
    if (!q || q.length === 0) return undefined;
    const next = q.shift();
    syncQueued(convId);
    return next;
  };

  const queueLength = (convId: string) => queueRef.current.get(convId)?.length ?? 0;

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

  const adoptConversation = (id: string, conv: PerConvRecord) => {
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
  };

  const resetConversation = (convId: string | null) => {
    setQueued([]); // Clear the queue panel (a new conversation has no queue yet)
    setTodosFor(convId, []); // Clear this conversation's task list
    setTaskMemoryFor(convId, emptyTaskMemory()); // ...and its Task Memory brief
    setGoalFor(convId, emptyGoal()); // ...and its goal, so no loop survives into a new conversation
  };

  return {
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
    showPendingGoal: setDisplayedGoal,
    adoptConversation,
    resetConversation,
  };
}
