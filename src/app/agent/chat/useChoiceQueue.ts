"use client";

import { useCallback, useRef } from "react";
import { notifyQuestion } from "@/lib/ai/agentNotify";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { ChoiceAnswer, ChoiceQuestion, DisplayMsg } from "./types";

export interface ChoiceQueue {
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
  askUser: (convId: string, questions: ChoiceQuestion[]) => Promise<string>;
  /**
   * Re-show the unanswered questions of the conversation being opened.
   *
   * Choice cards live only in the display, which a conversation switch rebuilds from the store — so without
   * this a card asked while the user was elsewhere would vanish, and the tool call parked on its promise
   * would never be answerable. Ordered by card id, which is the order they were asked in.
   */
  restorePendingChoices: (convId: string) => void;
  /** The user submits a card: mark it answered, and wake the waiting tool call with every answer at once. */
  submitChoice: (id: number, answers: ChoiceAnswer[]) => void;
  /**
   * Discard all pending-answer prompts of a conversation, unblocking them with the given text as the result.
   * Used to release by conversation on cancel / clear.
   */
  dropChoicesFor: (convId: string | null, message: string) => void;
}

/**
 * The ask_user choice cards: one pending promise per card, keyed by card id.
 *
 * Keyed by card rather than by conversation, so concurrent questions never overwrite each other and are
 * answered independently. Each entry records the conversation that issued it, which is what lets a cancel or
 * a clear release exactly that conversation's waits — and what keeps a background conversation's question
 * from appearing inside whichever conversation happens to be on screen.
 *
 * The sibling of useConsentQueue, and the two sync their sidebar badges the same way and for the same reason:
 * a prompt raised by a conversation the user is not looking at has to be discoverable from outside it.
 */
export function useChoiceQueue({
  convIdRef,
  /**
   * Draw a card. Passed as a lazy wrapper because the page's `pushDisplay` is a plain const declared below
   * this hook call — only the invocation happens later, by which time it is initialised.
   */
  onPush,
  setDisplay,
}: {
  convIdRef: React.RefObject<string | null>;
  onPush: (m: DisplayMsg) => void;
  setDisplay: React.Dispatch<React.SetStateAction<DisplayMsg[]>>;
}): ChoiceQueue {
  const choiceResolversRef = useRef<
    Map<number, { convId: string | null; questions: ChoiceQuestion[]; resolve: (v: string) => void }>
  >(new Map());
  const choiceIdRef = useRef(0);

  /**
   * Push the set of conversations with an unanswered question into the store, so the sidebar can badge them.
   *
   * Called wherever the pending set changes — asked, answered, dropped. It reads only the ref and the store,
   * so there is nothing render-scoped in it to go stale in a stable callback.
   */
  const syncQuestionBadges = () => {
    useAgentChatStore.getState().setPendingQuestionIds(
      new Set([...choiceResolversRef.current.values()].flatMap((e) => (e.convId ? [e.convId] : []))),
    );
  };

  const askUser = (convId: string, questions: ChoiceQuestion[]): Promise<string> => {
    const id = ++choiceIdRef.current;
    // Trigger condition 4: question notification — the AI needs user input to continue (only pops when the
    // app is unfocused). This is also what makes a question asked by a BACKGROUND conversation discoverable,
    // now that its card no longer appears in whichever conversation happens to be on screen.
    notifyQuestion(convId, questions[0].question);
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
        onPush({ kind: "choice", id, questions, answers: questions.map(() => null), submitted: false });
      }
      syncQuestionBadges();
    });
  };

  const restorePendingChoices = (convId: string) => {
    const pending = [...choiceResolversRef.current.entries()]
      .filter(([, e]) => e.convId === convId)
      .sort(([a], [b]) => a - b);
    for (const [id, entry] of pending) {
      onPush({
        kind: "choice",
        id,
        questions: entry.questions,
        answers: entry.questions.map(() => null),
        submitted: false,
      });
    }
  };

  // useCallback keeps the reference stable, to avoid invalidating the memoized MessageItem on every render.
  // Everything it touches is a ref or the store, so an empty dependency list captures nothing that can go stale.
  const submitChoice = useCallback((id: number, answers: ChoiceAnswer[]) => {
    const entry = choiceResolversRef.current.get(id);
    if (!entry) return; // Already handled / no such card, ignore
    choiceResolversRef.current.delete(id);
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
  }, [setDisplay]);

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
    syncQuestionBadges();
  };

  return { askUser, restorePendingChoices, submitChoice, dropChoicesFor };
}
