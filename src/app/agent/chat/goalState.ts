/**
 * Goal State — the condition a task must reach, and the bookkeeping of the loop driving it there.
 *
 * A goal is a CONDITION plus a verdict about it. The condition is text: either the user's own words from
 * `/goal <condition>`. The model cannot set one: set_goal was removed from the tool surface entirely.
 * The verdict is not made here and is not made by the acting model — after every turn an independent evaluator
 * reads the transcript and answers met / not-met (goalEvaluator.ts). Nothing in this module, and no tool the
 * model can call, sets `achieved`.
 *
 * That asymmetry is the whole design. The model owns its strategy and may rewrite it as often as reality
 * demands; it does not own the finish line:
 *
 *   Goal      the condition the user requires — only the evaluator may declare it met
 *    └─ Plan  the strategy currently in use — rewritten freely, and its failure is not the goal's failure
 *        └─ Todo   the plan's steps, mirrored into the checklist above the composer
 *             └─ Execution   tools and sub-agents, whose conclusions are written back here as evidence
 *
 * Everything is PURE and JSON-serialisable. There is no clock and no randomness: ids are positional (`c1`,
 * `s2`), ordering is a counter, and the one genuinely temporal field (`startedAt`) is passed in by the caller.
 * That is what lets the loop's rules be tested without React, without a model and without a fake timer.
 *
 * It is deliberately NOT held in the conversation buffer. It rides the road Task Memory already uses: kept per
 * conversation, persisted with the conversation record, and announced to the model as a change event — so
 * compaction can discard every message that produced it without losing the condition, the plan or the reason
 * the last evaluation failed.
 */

import type { Todo } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `active` — the loop is enforcing it. `achieved` — the evaluator said met. `cleared` — the user dropped it.
 *
 * Only `active` is persisted. An achieved or cleared goal is session-scoped: it stays in memory so `/goal` can
 * show the last run, and is deliberately lost on reload, so nothing can resurrect a finished goal.
 */
export type GoalStatus = "active" | "achieved" | "cleared";

/** Who wrote the condition. A user-authored one can never be overwritten by the model — see setCriteria. */
export type ConditionSource = "user" | "model";

/**
 * Counters for ONE activation.
 *
 * Reset to zero when a goal is restored from disk, because the run they describe is no longer happening:
 * showing "18 rounds, 240K tokens" against a loop that is not running reads as progress and is not.
 */
export interface GoalRun {
  /** Epoch ms when this activation started; 0 when the goal was restored and has not run since. */
  startedAt: number;
  /** Evaluations performed — not tool rounds. One per completed turn. */
  turnCount: number;
  /** Tokens spent under this goal: the turns themselves plus the evaluator's own calls. */
  tokenSpend: number;
  /** The evaluator's most recent justification, shown in the UI and injected as the next round's guidance. */
  lastReason: string;
  /** True when the last evaluation could not be obtained (bad JSON, network, timeout). Never a verdict. */
  lastEvalFailed: boolean;
}

/** One condition the model derived from the goal, handed to the evaluator as its checklist. */
export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface GoalPlan {
  steps: PlanStep[];
  /** Bumped on every re-plan, so "the strategy changed" is a fact in the state rather than an inference. */
  revision: number;
  rationale: string;
}

/** Something that actually happened, written back from execution so it survives compaction. */
export interface EvidenceEntry {
  seq: number;
  source: string;
  summary: string;
}

export interface GoalState {
  /** The condition to be met, verbatim. Never paraphrased, never narrowed. */
  condition: string;
  conditionSource: ConditionSource;
  status: GoalStatus;
  run: GoalRun;
  /** Advisory checklist for the evaluator, which judges the CONDITION. Empty since set_goal was removed — the
   *  evaluator was always the authority on the condition, so an empty list changes nothing about its verdict. */
  criteria: AcceptanceCriterion[];
  plan: GoalPlan;
  blockers: string[];
  evidence: EvidenceEntry[];
}

// ── Bounds ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The length at which a condition is worth mentioning to the user — a WARNING, not a limit.
 *
 * There is deliberately no maximum. A condition is user-authored text, and refusing to accept it (as this once
 * did at 4,000 characters) means telling someone their own requirement is inadmissible; truncating it silently
 * is worse still, because the loop would then spend real tokens driving toward a condition that was quietly cut
 * in half. Neither is ours to do.
 *
 * The warning exists because length here is not free the way it is in an ordinary message: the condition is
 * re-rendered into the wire on every turn and handed to the evaluator on every round, so it is paid for
 * repeatedly rather than once. That is a thing worth knowing, not a thing worth forbidding.
 */
export const GOAL_CONDITION_WARN = 10000;

/**
 * How many automatic rounds one activation may run before the loop stops on its own.
 *
 * A SAFETY limit, never a completion condition. Reaching it does NOT mark the goal achieved — it stops the loop
 * and says why, leaving the goal active so the user can decide. Without it, a condition the agent cannot satisfy
 * (or one the evaluator keeps reading as unmet) would spend unattended until someone noticed.
 */
export const MAX_GOAL_AUTO_ROUNDS = 25;

/**
 * How long an achieved goal stays on screen before it clears itself.
 *
 * The bar is meant to show "the run that just finished" — a transient idea that previously had no transition
 * behind it, so an achieved goal sat above the composer until the user typed `/goal clear`. Ten seconds is
 * long enough to read the rounds/elapsed/spend line and short enough not to be mistaken for a goal still in
 * force.
 */
export const GOAL_ACHIEVED_LINGER_MS = 10_000;

const MAX_CRITERION = 300;
const MAX_STEP_TITLE = 200;
const MAX_RATIONALE = 800;
const MAX_EVIDENCE_TEXT = 400;
const MAX_REASON = 600;
const MAX_CRITERIA = 20;
const MAX_STEPS = 30;
const MAX_BLOCKERS = 10;
/** Evidence is state, not a log: keep the recent past, because it is persisted and re-read every turn. */
const MAX_EVIDENCE_ENTRIES = 12;

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Trim and stringify, with NO length limit — for the condition and the objective it becomes.
 *
 * Separate from clamp() below so the absence of a bound is deliberate and visible at every call site, rather
 * than a `clamp(x, HUGE)` that reads like an oversight and invites someone to "fix" it.
 */
const text = (s: unknown): string => (typeof s === "string" ? s : s == null ? "" : String(s)).trim();

const clamp = (s: unknown, max: number): string => {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  const t = str.trim();
  return t.length > max ? t.slice(0, max) : t;
};

/** Loose comparison, for matching a plan step the model addressed by title rather than by id. */
const key = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").replace(/[.。,，;；:：!！?？]+$/g, "").trim();

const STEP_STATUSES: PlanStepStatus[] = ["pending", "in_progress", "completed", "skipped", "failed"];
const GOAL_STATUSES: GoalStatus[] = ["active", "achieved", "cleared"];

// ── Construction / normalisation ─────────────────────────────────────────────────────────────────

export function emptyRun(): GoalRun {
  return { startedAt: 0, turnCount: 0, tokenSpend: 0, lastReason: "", lastEvalFailed: false };
}

export function emptyGoal(): GoalState {
  return {
    condition: "",
    conditionSource: "user",
    status: "cleared",
    run: emptyRun(),
    criteria: [],
    plan: { steps: [], revision: 0, rationale: "" },
    blockers: [],
    evidence: [],
  };
}

/** A goal exists once it has a condition. */
export function isGoalEmpty(g: GoalState | null | undefined): boolean {
  return !g || !g.condition.trim();
}

/** An active goal is one the loop must keep driving. */
export function isGoalActive(g: GoalState | null | undefined): boolean {
  return !isGoalEmpty(g) && g!.status === "active";
}

/**
 * Repair any (persisted, partial, or model-supplied) object into a well-formed, bounded GoalState.
 *
 * Total by construction: a record written by an older build must reopen as a usable goal rather than throwing
 * inside the chat page. Ids are re-derived positionally, so a record whose ids were lost still addresses cleanly.
 */
export function normalizeGoal(raw: unknown): GoalState {
  const r = (raw ?? {}) as Partial<GoalState>;
  const condition = text(r.condition);
  if (!condition) return emptyGoal();
  const runRaw = (r.run ?? {}) as Partial<GoalRun>;
  const planRaw = (r.plan ?? {}) as Partial<GoalPlan>;
  const num = (v: unknown, d = 0) => (Number.isFinite(v) ? Math.max(0, Number(v)) : d);
  const steps = (Array.isArray(planRaw.steps) ? planRaw.steps : [])
    .map((s, i) => {
      const o = (s ?? {}) as Partial<PlanStep>;
      return {
        id: typeof o.id === "string" && o.id ? o.id : `s${i + 1}`,
        title: clamp(o.title, MAX_STEP_TITLE),
        status: STEP_STATUSES.includes(o.status as PlanStepStatus) ? (o.status as PlanStepStatus) : "pending",
      };
    })
    .filter((s) => s.title)
    .slice(0, MAX_STEPS);
  return {
    condition,
    conditionSource: r.conditionSource === "model" ? "model" : "user",
    status: GOAL_STATUSES.includes(r.status as GoalStatus) ? (r.status as GoalStatus) : "active",
    run: {
      startedAt: num(runRaw.startedAt),
      turnCount: num(runRaw.turnCount),
      tokenSpend: num(runRaw.tokenSpend),
      lastReason: clamp(runRaw.lastReason, MAX_REASON),
      lastEvalFailed: runRaw.lastEvalFailed === true,
    },
    criteria: (Array.isArray(r.criteria) ? r.criteria : [])
      .map((c, i) => {
        const o = (c ?? {}) as Partial<AcceptanceCriterion>;
        return { id: typeof o.id === "string" && o.id ? o.id : `c${i + 1}`, text: clamp(o.text, MAX_CRITERION) };
      })
      .filter((c) => c.text)
      .slice(0, MAX_CRITERIA),
    plan: { steps, revision: num(planRaw.revision, steps.length ? 1 : 0), rationale: clamp(planRaw.rationale, MAX_RATIONALE) },
    blockers: (Array.isArray(r.blockers) ? r.blockers : []).map((b) => clamp(b, MAX_CRITERION)).filter(Boolean).slice(0, MAX_BLOCKERS),
    evidence: (Array.isArray(r.evidence) ? r.evidence : [])
      .map((e, i) => {
        const o = (e ?? {}) as Partial<EvidenceEntry>;
        return {
          seq: Number.isFinite(o.seq) ? Number(o.seq) : i + 1,
          source: clamp(o.source, 60),
          summary: clamp(o.summary, MAX_EVIDENCE_TEXT),
        };
      })
      .filter((e) => e.summary)
      .slice(-MAX_EVIDENCE_ENTRIES),
  };
}

/**
 * What gets written to disk: an ACTIVE goal only.
 *
 * An achieved or cleared goal is session state. Persisting one would mean a reopened conversation could show —
 * or worse, resume — a goal whose run is over, which is the failure the doc's resume rule exists to prevent.
 */
export function toStoredGoal(g: GoalState | null | undefined): Record<string, unknown> | null {
  if (!isGoalActive(g)) return null;
  return g as unknown as Record<string, unknown>;
}

/**
 * Restore a persisted goal for a reopened conversation.
 *
 * The condition, the derived criteria and the plan come back; the RUN COUNTERS DO NOT. They describe an
 * activation that is no longer happening, and carrying them forward would show accumulated rounds and token
 * spend against a loop that is not running. The goal comes back active but idle: the next send re-arms the
 * loop, so reopening the app never silently resumes spending on a loop nobody re-authorised.
 */
export function restoreGoal(raw: unknown): GoalState {
  const g = normalizeGoal(raw);
  if (!isGoalActive(g)) return emptyGoal();
  return { ...g, run: emptyRun() };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────────────────────

/**
 * Start a goal, replacing whatever was there.
 *
 * Replacing is unconditional and needs no confirmation (the caller reports which condition was displaced), but
 * it always starts a NEW run: a fresh condition inherits no rounds, no token spend and no plan from the old one.
 */
export function startGoal(condition: string, opts: { now: number; source?: ConditionSource }): GoalState {
  return {
    ...emptyGoal(),
    condition: text(condition),
    conditionSource: opts.source ?? "user",
    status: "active",
    run: { ...emptyRun(), startedAt: opts.now },
  };
}

/** The user dropping the goal. Distinct from achievement, and it never claims success. */
export function clearGoal(prev: GoalState): GoalState {
  if (isGoalEmpty(prev)) return prev;
  return { ...prev, status: "cleared" };
}

/** The evaluator declared the condition met. The ONLY road to `achieved`. */
export function achieveGoal(prev: GoalState, reason: string): GoalState {
  if (isGoalEmpty(prev)) return prev;
  return { ...prev, status: "achieved", run: { ...prev.run, lastReason: clamp(reason, MAX_REASON), lastEvalFailed: false } };
}

/**
 * Record one evaluation against the run.
 *
 * `failed` marks an evaluation that could not be obtained at all. It counts as a round and as spend — it really
 * happened — but it is explicitly not a verdict, so the caller treats it as not-met and keeps going rather than
 * either completing the goal or wedging the loop.
 */
export function recordEvaluation(
  prev: GoalState,
  ev: { reason: string; tokens?: number; failed?: boolean },
): GoalState {
  if (isGoalEmpty(prev)) return prev;
  return {
    ...prev,
    run: {
      ...prev.run,
      turnCount: prev.run.turnCount + 1,
      tokenSpend: prev.run.tokenSpend + Math.max(0, ev.tokens ?? 0),
      lastReason: clamp(ev.reason, MAX_REASON),
      lastEvalFailed: ev.failed === true,
    },
  };
}

/** Add a turn's own token usage to the run (the evaluator's is added by recordEvaluation). */
export function addTurnSpend(prev: GoalState, tokens: number): GoalState {
  if (isGoalEmpty(prev) || !(tokens > 0)) return prev;
  return { ...prev, run: { ...prev.run, tokenSpend: prev.run.tokenSpend + tokens } };
}

// ── Model-authored structure ─────────────────────────────────────────────────────────────────────

export interface GoalUpdate {
  goal: GoalState;
  /** What the tool call reports back. */
  message: string;
  /** False when nothing was applied; the caller reports `message` and leaves the state alone. */
  ok: boolean;
}

export interface CriteriaPatch {
  objective?: string;
  acceptanceCriteria?: Array<string | { text?: string }>;
}

/**
 * Derive the checkable criteria for a goal, and — only when no goal exists yet —
 * declare the objective itself.
 *
 * A condition the USER wrote is never overwritten here. That is the deterministic half of "the goal is not
 * yours": an agent that finds a condition hard cannot restate it in easier words, because this function will
 * keep the user's text and say so. It may still add criteria, which is the useful half — turning "implement
 * login" into the conditions that actually decide it.
 */
/**
 * NOTE: no production caller. `set_goal` was its only one and the tool is gone — the goal is the user's, set
 * with `/goal`. Kept rather than deleted because the READ side is still live: `toStoredGoal` persists a whole
 * active goal, so a record written by an earlier build restores with criteria populated and `renderGoalState`
 * shows them. Deleting the writer while that data can still arrive would leave a shape nothing can produce
 * and nothing explains. If `/goal` ever grows criteria, this is the reducer it should use.
 */
export function setCriteria(prev: GoalState, patch: CriteriaPatch, opts: { now: number }): GoalUpdate {
  const objective = text(patch.objective);
  const criteria = (Array.isArray(patch.acceptanceCriteria) ? patch.acceptanceCriteria : [])
    .map((c) => (typeof c === "string" ? clamp(c, MAX_CRITERION) : clamp((c ?? {}).text, MAX_CRITERION)))
    .filter(Boolean)
    .slice(0, MAX_CRITERIA)
    .map((text, i) => ({ id: `c${i + 1}`, text }));

  if (!objective) {
    return { goal: prev, ok: false, message: "No change — pass `objective`: the end state the user requires." };
  }
  if (criteria.length === 0) {
    return {
      goal: prev,
      ok: false,
      message:
        "No change — pass `acceptanceCriteria`: the concrete, checkable conditions that must all hold before this " +
        "task is done. Without them there is nothing for the evaluator to check against.",
    };
  }

  const hadGoal = !isGoalEmpty(prev) && prev.status === "active";
  const userOwned = hadGoal && prev.conditionSource === "user";
  const goal: GoalState = hadGoal
    ? {
        ...prev,
        // A user-set condition stands. A model-set one may be refined by the model that set it.
        condition: userOwned ? prev.condition : objective,
        criteria,
      }
    : { ...startGoal(objective, { now: opts.now, source: "model" }), criteria };

  const lines = [
    hadGoal ? "Goal criteria recorded." : "Goal recorded and now active.",
    `${criteria.length} acceptance criteria.`,
  ];
  if (userOwned && key(objective) !== key(prev.condition)) {
    lines.push(
      `The goal condition is the user's own and has NOT been changed — it remains: "${prev.condition}". Your criteria ` +
        "were recorded against it. If you believe the condition itself is wrong, say so to the user rather than working to a different one.",
    );
  }
  lines.push(
    goal.plan.steps.length
      ? "The existing plan is still in force."
      : "Track the steps you take with update_todos.",
  );
  return { goal, ok: true, message: lines.join(" ") };
}

export interface PlanPatch {
  steps?: Array<string | { title?: string; status?: string }>;
  rationale?: string;
  blockers?: string[];
}

/**
 * Install or revise the plan.
 *
 * The plan is the agent's own property: rewrite it as often as reality demands. A step that failed is recorded
 * as `failed` and changes nothing about the goal — "this approach did not work" is input to the next plan, not
 * a verdict on the condition. Statuses carry over by title across a revision, so re-planning around a blocker
 * does not silently discard work already done.
 */
/**
 * NOTE: no production caller — same story as `setCriteria`. `update_plan` was its only one. The plan a legacy
 * persisted goal carries is still rendered and still folded into by `applyTodoStatuses`, so the type and the
 * read paths stay live even though nothing new can write one.
 */
export function applyPlan(prev: GoalState, patch: PlanPatch): GoalUpdate {
  if (isGoalEmpty(prev)) {
    return {
      goal: prev,
      ok: false,
      message:
        "No goal is set. A goal is set by the user with /goal — a plan is a strategy for a goal, and without one there is nothing to plan for.",
    };
  }
  const incoming = (Array.isArray(patch.steps) ? patch.steps : [])
    .map((s) =>
      typeof s === "string"
        ? { title: clamp(s, MAX_STEP_TITLE), status: "" }
        : { title: clamp((s ?? {}).title, MAX_STEP_TITLE), status: String((s ?? {}).status ?? "") },
    )
    .filter((s) => s.title)
    .slice(0, MAX_STEPS);
  if (incoming.length === 0) {
    return { goal: prev, ok: false, message: "No change — pass `steps`: the full ordered plan (it replaces the previous one)." };
  }

  const byTitle = new Map(prev.plan.steps.map((s) => [key(s.title), s]));
  const steps: PlanStep[] = incoming.map((s, i) => {
    const carried = byTitle.get(key(s.title));
    const explicit = STEP_STATUSES.includes(s.status as PlanStepStatus) ? (s.status as PlanStepStatus) : null;
    return { id: `s${i + 1}`, title: s.title, status: explicit ?? carried?.status ?? "pending" };
  });
  const blockers = Array.isArray(patch.blockers)
    ? patch.blockers.map((b) => clamp(b, MAX_CRITERION)).filter(Boolean).slice(0, MAX_BLOCKERS)
    : prev.blockers;

  const goal: GoalState = {
    ...prev,
    plan: {
      steps,
      revision: prev.plan.revision + 1,
      rationale: clamp(patch.rationale, MAX_RATIONALE) || prev.plan.rationale,
    },
    blockers,
  };
  const done = steps.filter((s) => s.status === "completed").length;
  return {
    goal,
    ok: true,
    message:
      `Plan revision ${goal.plan.revision} recorded: ${steps.length} steps (${done} already completed)` +
      (blockers.length ? `, ${blockers.length} blockers noted` : "") +
      ". The goal condition is unchanged — a new plan does not change what counts as done, and finishing every step " +
      "is not the same as meeting the goal.",
  };
}

/**
 * Record something that actually happened — a sub-agent's conclusion, a delegated batch's results.
 *
 * This is what makes a delegation part of the goal rather than a side quest. A sub-agent runs in its own
 * isolated context and its conversation is never persisted, so the only durable trace is one tool result that
 * compaction is free to summarise away; this survives, and is handed to the evaluator as established fact.
 */
export function recordEvidence(prev: GoalState, entry: { source: string; summary: string }): GoalState {
  if (isGoalEmpty(prev)) return prev;
  const summary = clamp(entry.summary, MAX_EVIDENCE_TEXT);
  if (!summary) return prev;
  const seq = (prev.evidence[prev.evidence.length - 1]?.seq ?? 0) + 1;
  return {
    ...prev,
    evidence: [...prev.evidence, { seq, source: clamp(entry.source, 60), summary }].slice(-MAX_EVIDENCE_ENTRIES),
  };
}

// ── Todo bridge ──────────────────────────────────────────────────────────────────────────────────

/**
 * The plan, as the user-visible checklist.
 *
 * Todo and Plan are the same list seen from two sides: the plan is what the agent reasons about, the checklist
 * is what the user watches. `skipped` and `failed` have no checklist equivalent — the panel has three states —
 * so both render as not-completed, which is what they are from the user's point of view.
 */
export function todosFromGoal(g: GoalState | null | undefined): Todo[] {
  if (isGoalEmpty(g)) return [];
  return g!.plan.steps.map((s) => ({
    title: s.title,
    status: s.status === "completed" ? "completed" : s.status === "in_progress" ? "in_progress" : "pending",
  }));
}

/**
 * Fold checklist statuses back into the plan (the model calling update_todos, or the user ticking an item).
 *
 * Matched by title, so a checklist the model rewrote in its own words simply does not match and changes nothing
 * — the plan is never corrupted by a mismatched list. A step the checklist un-ticks returns to `pending` unless
 * the plan recorded a harder truth about it (`failed`, `skipped`), which a checkbox has no business overwriting.
 */
export function applyTodoStatuses(prev: GoalState, todos: Todo[]): GoalState {
  if (isGoalEmpty(prev) || prev.plan.steps.length === 0) return prev;
  const byTitle = new Map(todos.map((t) => [key(t.title), t.status]));
  let changed = false;
  const steps = prev.plan.steps.map((s) => {
    const status = byTitle.get(key(s.title));
    if (!status) return s;
    const next: PlanStepStatus =
      status === "completed"
        ? "completed"
        : status === "in_progress"
          ? "in_progress"
          : s.status === "failed" || s.status === "skipped"
            ? s.status
            : "pending";
    if (next === s.status) return s;
    changed = true;
    return { ...s, status: next };
  });
  return changed ? { ...prev, plan: { ...prev.plan, steps } } : prev;
}

// ── Rendering into the wire ──────────────────────────────────────────────────────────────────────

/**
 * The goal block carried by a change event.
 *
 * This is why the state is structured rather than prose: it is re-rendered from the state every turn, so the
 * model sees the current condition, criteria and plan even when every message that produced them has been
 * summarised away. The evidence log is NOT rendered here — it churns every round, and it reaches the evaluator
 * through its own payload instead.
 */
export function renderGoalState(g: GoalState | null | undefined): string {
  if (!isGoalActive(g)) return "";
  const goal = g!;
  const lines: string[] = [`[GOAL] active — ${goal.condition}`];
  if (goal.conditionSource === "user") {
    lines.push("This condition is the user's own words. You may not narrow, paraphrase or lower it.");
  }
  if (goal.criteria.length) {
    lines.push("Acceptance criteria you derived from it:");
    for (const c of goal.criteria) lines.push(`  - ${c.id}: ${c.text}`);
  }
  if (goal.plan.steps.length) {
    lines.push(`Plan (revision ${goal.plan.revision}) — your current strategy; revise it whenever it stops serving the goal:`);
    for (const s of goal.plan.steps) {
      const mark =
        s.status === "completed" ? "[x]"
        : s.status === "in_progress" ? "[~]"
        : s.status === "failed" ? "[!]"
        : s.status === "skipped" ? "[-]"
        : "[ ]";
      lines.push(`  ${mark} ${s.id}: ${s.title}`);
    }
  } else {
    lines.push("Plan: none recorded. Work the condition directly, and keep update_todos current as you go.");
  }
  if (goal.blockers.length) lines.push(`Blockers: ${goal.blockers.join("; ")}`);
  if (goal.run.turnCount > 0) {
    lines.push(
      `This is round ${goal.run.turnCount + 1} of this goal. After each round an independent evaluator reads the ` +
        "transcript and decides whether the condition is met; you do not make that call.",
    );
    if (goal.run.lastReason && !goal.run.lastEvalFailed) {
      lines.push(`The evaluator's last verdict: NOT met — ${goal.run.lastReason}`);
    }
  }
  return lines.join("\n");
}

/**
 * The invariant explanation of what a goal is and how the loop treats it.
 *
 * Sits in messages[0] with the other explainers, where the prefix cache covers it: identical for every install
 * and every conversation, with only the goal itself varying — which is why the goal travels as a change event.
 * See docs/cache-stable-prompt-context.md.
 */
export const GOAL_EXPLAINER =
  "[GOAL] A goal is a condition this task must reach. It arrives in a system-reminder marked GOAL, and it outranks " +
  "everything else you are doing.\n" +
  "- The goal is not yours. The user sets it, and there is no tool through which you can create, change, narrow or " +
  "drop one. You may not lower the bar because something turned out to be hard: the condition stands verbatim. If " +
  "it is genuinely unachievable, say so plainly and explain why — do not quietly substitute an easier one.\n" +
  "- Track your own steps with update_todos, which is the checklist the user watches. A failed step or a failed " +
  "tool call is NOT a failed goal.\n" +
  "- You do not decide that you are finished. After each round an INDEPENDENT evaluator reads the transcript and " +
  "judges whether the condition is met. It only believes what the transcript SHOWS — a command that ran and its " +
  "output, a file you read, a check that passed. Claiming success proves nothing to it, so do the work and let the " +
  "results appear in the conversation. If it says not met, its reason arrives as your next instruction: diagnose, " +
  "re-plan if the approach cannot work, and continue.";

/**
 * The guidance injected as the next round's instruction when the evaluator says not-met.
 *
 * Deliberately phrased as an operator instruction rather than as the user speaking: the user has not said
 * anything, and a model that mistakes this for a new user message tends to answer it instead of acting on it.
 */
export function goalContinuationPrompt(goal: GoalState, reason: string): string {
  return (
    "[GOAL CHECK] This is an automatic continuation, not the user speaking.\n\n" +
    `The goal is not met yet: ${goal.condition}\n\n` +
    `The evaluator's reason: ${reason}\n\n` +
    "Keep working on it. Address exactly what the reason says is missing. If your current approach cannot get " +
    "there, change it and carry on. Do not reply with a status report or ask the user what to do next — act, and " +
    "make the results visible in the conversation so the next check can see them."
  );
}

/**
 * Injected when the evaluator judges the condition unsatisfiable.
 *
 * The point of the verdict is that it is reached on round one rather than round twenty-five: an unsatisfiable
 * goal ends by being recognised, not by exhausting the budget while everyone waits for it.
 */
export function goalImpossiblePrompt(goal: GoalState, reason: string): string {
  return (
    "[GOAL CHECK] This is an automatic continuation, not the user speaking.\n\n" +
    `The goal cannot be met as stated, so the loop stops here.\n\n` +
    `Goal: ${goal.condition}\n` +
    `Why it cannot be met: ${reason}\n\n` +
    "Write the final answer now. Explain to the user, plainly, why the goal as stated is not achievable — what " +
    "blocks it, and whether it is a contradiction in the goal itself or something outside your reach. Offer the " +
    "nearest thing that IS achievable, or say exactly what you would need from them. Do not keep working, and " +
    "do not present something else as if it were the goal."
  );
}

/** Injected instead when the loop hits its safety cap. Not an achievement, and it must not read as one. */
export function goalExhaustedPrompt(goal: GoalState): string {
  return (
    "[GOAL CHECK] This is an automatic continuation, not the user speaking.\n\n" +
    `This goal has run for ${goal.run.turnCount} automatic rounds without being met, which is the limit, so the loop ` +
    "stops here.\n\n" +
    `Goal: ${goal.condition}\n` +
    (goal.run.lastReason ? `Last evaluation: ${goal.run.lastReason}\n` : "") +
    "\nStop working and write the final answer now — an HONEST one. Say plainly that the goal was not reached, what " +
    "is still missing, what you tried, and what you need from the user to get past it. Do not present partial work " +
    "as if it were the finished task."
  );
}

// ── The loop's decision ──────────────────────────────────────────────────────────────────────────

export type GoalLoopAction =
  /** No active goal, it was just met, or no verdict could be obtained: hand control back to the user. */
  | "stop"
  /** Not met, and there is budget left: inject the reason and run another round automatically. */
  | "continue"
  /** The evaluator says the condition is unsatisfiable: one final round that explains why, then stop. */
  | "impossible"
  /** The safety cap was reached: run one final round that reports honestly, then stop. */
  | "exhausted";

export interface GoalLoopDecision {
  action: GoalLoopAction;
  /** The instruction to send as the next round. Empty when action is "stop". */
  prompt: string;
}

/**
 * Decide what happens after one turn has been evaluated — the loop's completion condition.
 *
 * Pure and total, so the most important rule in the mechanism is testable without a model. Note what is NOT a
 * completion condition here: the round count. `maxRounds` can only produce `exhausted`, which forces an honest
 * report — never a quiet "close enough, we're done".
 */
export function decideNextRound(
  goal: GoalState | null | undefined,
  opts: { met: boolean; reason: string; maxRounds?: number; impossible?: boolean; failed?: boolean },
): GoalLoopDecision {
  if (!isGoalActive(goal)) return { action: "stop", prompt: "" };
  if (opts.met) return { action: "stop", prompt: "" };
  // No verdict was obtained (timeout, transport failure, unparseable answer). That is NOT not-met, and driving
  // another round on it would be working blind — with a persistently broken evaluator, blind for every round
  // the cap allows. The goal stays active, the turn ends, and the bar shows the check failed; the user's next
  // message re-arms it.
  if (opts.failed) return { action: "stop", prompt: "" };
  // Recognised as unsatisfiable, which is the whole reason the verdict exists: an impossible goal should end on
  // round one, not by spending the entire budget discovering what the evaluator already said.
  if (opts.impossible) return { action: "impossible", prompt: goalImpossiblePrompt(goal!, opts.reason) };
  const max = opts.maxRounds ?? MAX_GOAL_AUTO_ROUNDS;
  if (goal!.run.turnCount >= max) return { action: "exhausted", prompt: goalExhaustedPrompt(goal!) };
  return { action: "continue", prompt: goalContinuationPrompt(goal!, opts.reason) };
}
