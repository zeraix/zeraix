import { useAgentChatStore } from "@/store/agentChatStore";
import { addBlock, wrapReminder } from "./reminders";
import type { ApiMsg } from "./types";

/**
 * This turn's conversation buffer.
 *
 * The turn works on its OWN array, captured before the first await and never re-read from `convoRef` — the
 * user can switch conversations while the summariser runs, after which that ref belongs to a different
 * conversation entirely, and re-reading it would splice this turn into someone else's history. `syncView` is
 * the one thing that mirrors back, and only while this conversation is still the one on screen.
 *
 * It also tracks where the last tool result landed, in the buffer and on disk, because the mid-loop nudges
 * ride that message and there is no reliable way to find it by scanning: they fire AFTER the assistant turn
 * has been appended and persisted, by which point the compaction plan may already have rewritten the wire view.
 */
export interface TurnBuffer {
  /** The buffer as it stands. Treat as immutable — every write goes through a method here. */
  readonly messages: ApiMsg[];
  /** Where the last tool result landed on disk, or -1 when nothing was called yet. */
  readonly lastToolStoredIdx: number;
  /** Append an assistant turn (or anything that is not a tool result). */
  push: (m: ApiMsg) => void;
  /** Append a tool result and remember it as the nudge carrier. */
  pushTool: (m: ApiMsg) => void;
  /** Record where the tool result just appended was persisted. */
  markToolStored: (storedIdx: number) => void;
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
  nudgeIntoLastTool: (text: string) => boolean;
}

export function createTurnBuffer({
  initial,
  convId,
  /** Mirror the buffer back onto the active view — a no-op while this conversation is in the background. */
  syncView,
}: {
  initial: ApiMsg[];
  convId: string;
  syncView: (messages: ApiMsg[]) => void;
}): TurnBuffer {
  let convo = initial;
  let lastToolIdx = -1;
  let lastToolStoredIdx = -1;

  return {
    get messages() {
      return convo;
    },
    get lastToolStoredIdx() {
      return lastToolStoredIdx;
    },
    push(m) {
      convo = [...convo, m];
      syncView(convo);
    },
    pushTool(m) {
      convo = [...convo, m];
      lastToolIdx = convo.length - 1;
      syncView(convo);
    },
    markToolStored(storedIdx) {
      lastToolStoredIdx = storedIdx;
    },
    nudgeIntoLastTool(text) {
      const target = lastToolIdx >= 0 ? convo[lastToolIdx] : undefined;
      if (target?.role !== "tool") return false;
      // The per-round flag at each call site already prevents a repeat within the round; this stops a double-write if the same
      // carrier is reached twice, without making the nudge once-per-conversation.
      if (target.reminderText?.includes(text)) return true;
      // Its own field, never the tool result's content: stubbing a stale read replaces that content wholesale, and a nudge the
      // model has already been shown must not disappear with it.
      const reminderText = addBlock(target.reminderText, wrapReminder(text));
      convo = convo.map((m, i) => (i === lastToolIdx ? { ...target, reminderText } : m));
      syncView(convo);
      if (convId && lastToolStoredIdx >= 0) {
        useAgentChatStore.getState().setMessageReminder(convId, lastToolStoredIdx, reminderText);
      }
      return true;
    },
  };
}
