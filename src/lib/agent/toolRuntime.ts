/**
 * Tool runtime — the obligations a turn accumulates as its tools run.
 *
 * Spec: docs/agent-runtime-loop.md §8, §9, §14. Milestone M5b.
 *
 * Executing a tool is not just producing a result. Some tools leave the turn owing something: editing a file
 * under `auth/` owes a security review before the turn concludes; changing source at all owes a moment's
 * thought about whether anything durable was learned. Those obligations were tracked by four `let` flags
 * inside `send()`, mutated from six places across a 200-line block, and they are exactly the kind of state
 * that is impossible to reason about in situ and trivial to reason about as a reducer.
 *
 * The rules themselves are unchanged; this is the same behaviour with a boundary drawn around it.
 *
 * ── Why the latches matter more than the flags ──────────────────────────────────────────────────────────────
 *
 * Each obligation fires AT MOST ONCE per turn, and that is not a detail — it is what stops a guard from
 * becoming a deadlock. A reminder the model reads and declines to act on must not be re-injected, or the turn
 * cannot end: the model tries to conclude, is told to review, declines, tries to conclude again, forever. The
 * original code recorded this decision explicitly ("if the model still insists, let it through, to avoid a
 * deadlock"), and it is preserved here as `nudged` state that is set and never cleared.
 *
 * The one exception is deliberate and worth its asymmetry: the review guard can fire again on a LATER turn.
 * It is a safety check, so a risky change on turn 40 must be caught even though turn 5 was.
 *
 * Nothing here executes anything. Dispatch, consent and the sandbox stay where they are — this module answers
 * "what does the Runtime now owe", which is a question about state, not about I/O.
 */
import type { ToolCall } from "@/app/agent/chat/types";
import type { ToolResult } from "./turn";

/** What a turn currently owes. */
export interface TurnObligations {
  /** A risky path was modified and no reviewer has run since. */
  riskyChangePending: boolean;
  /** Source files were modified and nothing was recorded to project memory. */
  learnedWithoutRecording: boolean;
  /** The review reminder has already been delivered this turn; never delivered twice. */
  reviewNudged: boolean;
  /** The memory reminder has already been delivered this turn. */
  memoryNudged: boolean;
}

export const noObligations = (): TurnObligations => ({
  riskyChangePending: false,
  learnedWithoutRecording: false,
  reviewNudged: false,
  memoryNudged: false,
});

/**
 * Which reminder, if any, is due now.
 *
 * Returned rather than injected, because injection is the host's business — the reminder rides a tool result
 * through `reminders.ts`, and this module has no opinion about how that works.
 */
export type DueReminder = "review" | "memory";

export interface ToolRuntimeRules {
  /** Tools that modify source files. `run_command` is excluded: its target is unknowable from its arguments. */
  mutatingTools: ReadonlySet<string>;
  /** Paths whose modification demands a review. */
  riskyPath: RegExp;
  /** Delegation tools, for spotting that a reviewer was dispatched. */
  delegationTools: ReadonlySet<string>;
}

/**
 * Argument keys that plausibly name a file the call will write.
 *
 * A heuristic, and only ever used to make the review guard MORE likely to fire — a missed key means a review
 * is not demanded, never that a wrong file is reported. Kept broad for that reason.
 */
const PATH_KEY = /path|file|dir|dest|src|source|target|name/i;

/** The path-like argument values of a call. */
export function pathArguments(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([k, v]) => typeof v === "string" && PATH_KEY.test(k))
    .map(([, v]) => v as string);
}

/** Did this call dispatch a reviewer, by either delegation route? */
export function dispatchesReviewer(name: string, args: Record<string, unknown>): boolean {
  if (name === "run_subagent") return String(args.agent ?? "") === "reviewer";
  if (name === "spawn_subagents") {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    // A review spawned alongside other delegations is still a review.
    return tasks.some((t) => String(((t ?? {}) as Record<string, unknown>).agent ?? "") === "reviewer");
  }
  return false;
}

/**
 * Fold one executed tool into the turn's obligations.
 *
 * Order within the function matters in one place: a reviewer dispatched in the same round as a risky edit
 * clears the obligation, and it is cleared before the edit could set it only if the two arrived in that
 * order — which is why clearing is evaluated per call rather than per round. A model that edits and then
 * reviews in one round has genuinely reviewed.
 */
export function recordTool(
  prev: TurnObligations,
  call: { name: string; args: Record<string, unknown> },
  rules: ToolRuntimeRules,
): TurnObligations {
  let next = prev;
  if (dispatchesReviewer(call.name, call.args)) {
    next = { ...next, riskyChangePending: false };
  }
  // Recording anything at all satisfies the memory guard — the reminder exists to make the model consider the
  // question once per turn, not to demand a note per file touched.
  if (call.name === "remember_project") {
    next = { ...next, learnedWithoutRecording: false };
  }
  if (rules.mutatingTools.has(call.name)) {
    const risky = pathArguments(call.args).some((p) => rules.riskyPath.test(p));
    next = {
      ...next,
      learnedWithoutRecording: true,
      riskyChangePending: next.riskyChangePending || risky,
    };
  }
  return next;
}

/**
 * What is due after a round of tools, and the state to carry forward.
 *
 * Both reminders can be due at once and both are delivered — they are about different things, and suppressing
 * one because the other fired would silently drop a safety check.
 */
export function dueReminders(prev: TurnObligations): { due: DueReminder[]; next: TurnObligations } {
  const due: DueReminder[] = [];
  let next = prev;
  if (next.riskyChangePending && !next.reviewNudged) {
    due.push("review");
    next = { ...next, reviewNudged: true };
  }
  if (next.learnedWithoutRecording && !next.memoryNudged) {
    due.push("memory");
    next = { ...next, memoryNudged: true };
  }
  return { due, next };
}

/**
 * Tool calls that never got a result.
 *
 * Reached when a round is cut short — the user cancels mid-execution, or the turn ends with work in flight.
 * The wire requires every `assistant.tool_calls` entry to be answered: an unanswered one makes the provider
 * reject the ENTIRE conversation on the next request, so a conversation left in that state cannot be
 * reopened. The host back-fills a placeholder for each of these, which is why they must be identified
 * exactly rather than approximately.
 */
export function unansweredCalls(calls: ToolCall[], results: Pick<ToolResult, "toolCallId">[]): ToolCall[] {
  const answered = new Set(results.map((r) => r.toolCallId));
  return calls.filter((c) => !answered.has(c.id));
}

/**
 * Should this round's calls run concurrently?
 *
 * §8 is precise about the limit of the Runtime's authority here: it may parallelise calls the model issued
 * INDEPENDENTLY, and it must never infer a task-level dependency on the model's behalf. `read_file(A)` then
 * deciding whether `edit_file(A)` is needed stays two Provider Turns; the Runtime does not collapse them.
 *
 * So the test is purely mechanical — every call in the group is read-only — and never semantic.
 */
export function canRunConcurrently(names: string[], parallelSafe: ReadonlySet<string>): boolean {
  return names.length > 1 && names.every((n) => parallelSafe.has(n));
}
