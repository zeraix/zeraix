import { toast } from "sonner";
import { getStorage } from "@zzcpt/zztool";
import { AGENT_MAX_GOAL_ROUNDS_KEY } from "@/constants/Agent";
import { notifyReplyComplete } from "@/lib/ai/agentNotify";
import { isWindowAlwaysOnTop } from "@/lib/electron/windowControls";
import { useAgentChatStore } from "@/store/agentChatStore";
import type { TurnUsage } from "./chatRequest";
import type { ApiMsg, DisplayMsg, Todo } from "./types";
import {
  isGoalActive,
  achieveGoal,
  clearGoal,
  recordEvaluation,
  addTurnSpend,
  decideNextRound,
  MAX_GOAL_AUTO_ROUNDS,
  type GoalState,
} from "./goalState";
import type { createGoalEvaluator } from "./goalEvaluator";

type EvaluateGoal = ReturnType<typeof createGoalEvaluator>;
type Translate = (key: string, vars?: Record<string, string>) => string;

/** Elapsed time of a goal run, as h:mm:ss or m:ss. */
export function formatGoalElapsed(startedAt: number, now: number = Date.now()): string {
  if (!startedAt) return "—";
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  return h > 0
    ? `${h}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
    : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export interface GoalCheckDeps {
  convId: string;
  turnId: string;
  signal: AbortSignal;
  t: Translate;
  /** Whether this conversation is the one on screen — a background turn must not write the visible view. */
  active: () => boolean;
  status: (text: string) => void;
  goalFor: (convId: string | null) => GoalState;
  setGoalFor: (convId: string | null, g: GoalState) => void;
  scheduleGoalClear: (convId: string, achieved: GoalState) => void;
  /** Background jobs this conversation is still owed a result from. */
  awaitingJobs: number;
  /** What this turn spent, before the evaluator's own cost is added. */
  turnUsage: TurnUsage;
  /** The transcript this round actually sent, and the answer it produced. */
  lastWire: ApiMsg[];
  lastContent: string;
  evaluateGoal: EvaluateGoal;
  /** One-shot permission for a report round the now-cleared goal would otherwise gate out. */
  allowExhaustedRound: (convId: string) => void;
}

/**
 * The end-of-turn goal check.
 *
 * The turn is over and the model has answered. If a goal is in force, this is where an INDEPENDENT evaluator
 * reads what just happened and decides whether the condition is met — the model does not get a vote, and there
 * is no tool through which it could ask for one.
 *
 * Called from inside send()'s try, rather than from its `finally`: the wire view and the abort signal are both
 * live, the user sees the check as part of the turn rather than as a pause after it, and cancelling stops it
 * like anything else. The continuation it returns is handed to `finally`, which fires the next round after the
 * normal end-of-turn cleanup has run.
 *
 * Returns the instruction the goal loop should run next, or null when the turn is simply over.
 */
export async function checkTurnGoal(deps: GoalCheckDeps): Promise<string | null> {
  const {
    convId, turnId, signal, t, active, status,
    goalFor, setGoalFor, scheduleGoalClear,
    awaitingJobs, turnUsage, lastWire, lastContent, evaluateGoal, allowExhaustedRound,
  } = deps;

  const before = goalFor(convId);
  // Deferred while a `notify` job this conversation started has not reported yet. The turn ended because the
  // model was told to end it and wait — there is nothing new for the evaluator to read, so a check now can
  // only say "not met", and continuing would race a build that was always going to take minutes. The job's
  // arrival opens its own turn, and that one is evaluated.
  if (!isGoalActive(before) || signal.aborted || awaitingJobs > 0) return null;

  status(t("chat.goalChecking"));
  // The turn's own spend is attributed to the goal before the evaluator's is added, so the figure in the bar
  // is what this goal has cost in total, not what the evaluator alone cost.
  const turnTokens = turnUsage.total || turnUsage.prompt + turnUsage.completion;
  // `lastWire` is what the model was actually sent this round; the reply it produced arrived afterwards, so it
  // is appended here — without it the evaluator would judge a transcript missing its conclusion.
  const judged: ApiMsg[] = [...lastWire, { role: "assistant", content: lastContent }];
  const outcome = await evaluateGoal(
    {
      condition: before.condition,
      criteria: before.criteria.map((c) => c.text),
      // Sub-agent conclusions, which may pre-date compaction and so be absent from the transcript while still
      // being the reason a criterion holds.
      established: before.evidence.map((e) => `${e.source}: ${e.summary}`),
      messages: judged,
    },
    signal,
    { actor: "goal", convId, turnId },
  );

  const met = outcome.ok && outcome.verdict.met;
  // A failed evaluation is NOT a verdict. It is recorded and flagged in the UI, but it neither completes the
  // goal nor drives another round: with an evaluator that is down, continuing would work blind for every
  // round the cap allows.
  const reason = outcome.ok ? outcome.verdict.reason : outcome.error;
  const scored = addTurnSpend(before, turnTokens);
  const evaluated = recordEvaluation(scored, { reason, tokens: outcome.tokens, failed: !outcome.ok });

  if (met) {
    const done = achieveGoal(evaluated, reason);
    setGoalFor(convId, done);
    // The achievement record the doc asks for: condition, duration, rounds and spend. Display-only and
    // deliberately not persisted — an achieved goal is session state, so nothing here can bring a finished run
    // back after a reload.
    if (active()) {
      toast.success(
        t("goal.achieved", {
          rounds: String(done.run.turnCount),
          elapsed: formatGoalElapsed(done.run.startedAt),
          tokens: String(done.run.tokenSpend),
        }),
      );
    }
    // Then clear it. `achieved` deactivates the loop, but GoalBar renders anything that is not `cleared`, and
    // nothing ever left `achieved` — so the finished goal sat above the composer for the rest of the session
    // and only `/goal clear` removed it. The bar was meant to show "the run that just finished", which is a
    // transient idea that had no transition behind it.
    //
    // Delayed rather than immediate so that record is actually readable; the impossible/exhausted paths clear
    // at once because they queue an explaining round that must not be re-evaluated, whereas nothing follows a
    // success.
    scheduleGoalClear(convId, done);
    return null;
  }

  setGoalFor(convId, evaluated);
  const maxRounds = Number(getStorage(AGENT_MAX_GOAL_ROUNDS_KEY)) || MAX_GOAL_AUTO_ROUNDS;
  const decision = decideNextRound(evaluated, {
    met: false,
    reason,
    maxRounds,
    impossible: outcome.ok && outcome.verdict.impossible === true,
    failed: !outcome.ok,
  });

  if (decision.action === "impossible" || decision.action === "exhausted") {
    // Neither is an achievement, and neither may read as one. The goal is cleared FIRST so the final
    // explaining round cannot itself be evaluated and re-trigger the same ending, then the instruction is
    // queued. Re-issuing `/goal` is how the user asks for more.
    setGoalFor(convId, clearGoal(evaluated));
    if (active()) {
      toast.error(
        decision.action === "impossible"
          ? t("goal.impossible", { reason })
          : t("goal.stoppedAtLimit", { rounds: String(evaluated.run.turnCount) }),
      );
    }
    allowExhaustedRound(convId);
    return decision.prompt;
  }
  if (decision.action === "continue") return decision.prompt;
  if (!outcome.ok && active()) {
    // action "stop" with no verdict: say so, or the turn just ends and the goal appears ignored.
    toast.warning(t("goal.checkFailed", { reason }));
  }
  return null;
}

export interface TurnEndDeps {
  convId: string;
  t: Translate;
  active: () => boolean;
  /** The instruction the goal loop will run next, when there is one — it suppresses both steps below. */
  goalContinuation: string | null;
  lastContent: string;
  todosFor: (convId: string | null) => Todo[];
  setTodosFor: (convId: string | null, next: Todo[]) => void;
  pushDisplay: (m: DisplayMsg) => void;
  /** Jump to a conversation from the "reply is ready" toast. */
  openConversation: (convId: string) => void;
}

/**
 * Retire the checklist and announce the finished reply.
 *
 * Both are skipped entirely mid-goal-loop: the round is finished but the TASK is not, and telling the user
 * their reply is ready — once per round, up to the round limit — would be both wrong and unbearable. The goal
 * announces itself once, when it is met or when the loop gives up.
 */
export async function finishTurn(deps: TurnEndDeps): Promise<void> {
  const { convId, t, active, goalContinuation, lastContent, todosFor, setTodosFor, pushDisplay, openConversation } = deps;
  const store = useAgentChatStore.getState();

  // End of conversation: archive this conversation's task list into the chat record, and collapse the floating
  // panel above the input box. Keyed by convId, so a background conversation retires its own list rather than
  // the viewed conversation's; the archived bubble is only pushed when that conversation is the one on screen.
  // A goal round that is about to continue keeps its checklist: the plan is still in force, and retiring it
  // here would clear the panel on every round of the loop only to have the next one rebuild it.
  const finishedTodos = goalContinuation ? [] : todosFor(convId);
  if (finishedTodos.length > 0) {
    if (active()) pushDisplay({ kind: "todos", todos: finishedTodos });
    setTodosFor(convId, []);
  }

  // Trigger condition 1: the AI reply is complete. The channel follows where the user's attention is:
  //  - Finished in the background (a different conversation is on screen) → toast + sidebar dot, plus the
  //    system notification, which self-gates to the window being unfocused;
  //  - On screen, window always on top (certainly visible) → in-app hint (toast);
  //  - On screen, not on top (may be obscured by other windows) → system notification (following the existing
  //    preference / unfocused gating, clicking jumps to that conversation).
  // Use the captured convId rather than the active conversation id, to ensure correct ownership (reserved for
  // background concurrent generation).
  if (goalContinuation) return; // nothing to announce yet; the loop continues

  if (!active()) {
    // The conversation that finished is not the one on screen. Its sidebar spinner simply stopping is not an
    // announcement, and the system notification is gated on the window being unfocused — so with the app in
    // front of the user, reading another chat, nothing at all used to happen. Two signals, because they
    // answer different questions: a toast naming the chat (with a button that jumps to it) says "it is done
    // now", and an unread dot on its sidebar row survives until the chat is opened, so it still says so for
    // a user who was away from the keyboard. notifyReplyComplete still runs and self-gates: it pops only if
    // the window is unfocused, which is exactly the case the toast cannot cover.
    store.markConversationUnread(convId);
    const title = store.getConversation(convId)?.title?.trim();
    toast.success(title ? t("chat.replyDoneNamed", { title }) : t("chat.replyDone"), {
      action: { label: t("chat.replyDoneOpen"), onClick: () => openConversation(convId) },
    });
    notifyReplyComplete(convId, lastContent);
  } else if (await isWindowAlwaysOnTop()) {
    const title = store.getConversation(convId)?.title?.trim();
    toast.success(title ? t("chat.replyDoneNamed", { title }) : t("chat.replyDone"));
  } else {
    notifyReplyComplete(convId, lastContent);
  }
}
