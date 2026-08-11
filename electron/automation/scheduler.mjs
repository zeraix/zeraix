/**
 * The catch-up scheduler. See docs/automation-workflow-design.md §12.2.
 *
 * This is NOT "a timer that fires while we happen to be alive". A desktop app is closed for most of
 * the calendar, so liveness is explicitly not a correctness mechanism here. On every tick *and* every
 * app start the scheduler asks one question per trigger:
 *
 *   which fires were due between `lastFiredAt` and now?
 *
 * and applies `missedRunPolicy` to the answer. A 5-second gap and a 5-day gap take the identical code
 * path -- window closed, machine asleep, process killed, all collapse into "there was a gap".
 *
 * Two orderings here are load-bearing and easy to get backwards:
 *
 *   1. `lastFiredAt` is persisted BEFORE the runs are enqueued. A crash in between loses a window,
 *      which is a missed run; the other order replays the window on next launch, which turns
 *      `backfill` into an infinite loop.
 *   2. Over-cap backfill is dropped with a log line, never silently. A silent truncation reads as
 *      "we covered everything" when we did not (§8's no-silent-caps principle).
 *
 * No `electron` import (§9.1): the manager, the clock and the log sink are all injected, so the whole
 * catch-up mechanism is exercisable under `npm test` against a fake clock.
 */
import { fireTimesBetween, nextFireAfter, parseCron } from "./cron.mjs";
import { listWorkflows, getWorkflow } from "./definitions.mjs";
import * as repo from "./repo.mjs";

/**
 * Most runs a single `backfill` catch-up will enqueue. An app left closed over a holiday must not
 * wake up and start three hundred runs at once.
 */
export const BACKFILL_CAP = 10;

/** How often to re-ask the question while the app is alive. */
const DEFAULT_TICK_MS = 60_000;

/**
 * @param {object} deps
 * @param {() => (object|null)} deps.getManager Execution Manager accessor; null before init.
 * @param {() => number} [deps.now] Injected clock -- tests drive catch-up without waiting.
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.tickMs]
 */
export function createScheduler({ getManager, now = () => Date.now(), log = console.log, tickMs = DEFAULT_TICK_MS } = {}) {
  let timer = null;

  /**
   * When this scheduler last evaluated, or null before its first pass.
   *
   * This is what separates "the fire is due and we were here to see it" from "the fire came due while
   * we were gone", and that distinction is the whole meaning of `missedRunPolicy`. Held in memory on
   * purpose: it is a fact about *this process's* liveness, so a fresh start must begin as null and
   * treat everything outstanding as missed — which is exactly right, because the app was closed.
   */
  let lastTickAt = null;

  /**
   * Slack on the liveness check, for a tick that ran late.
   *
   * setInterval is best-effort; a busy main process or a GC pause can push a tick past its slot. A
   * tick arriving a little late is still a live scheduler, and treating it as a gap would apply the
   * missed-run policy to a fire nobody actually missed.
   */
  const GRACE_MS = Math.max(15_000, Math.floor(tickMs / 2));

  /**
   * Run one catch-up pass over every cron trigger of every workflow.
   *
   * Returns a summary rather than nothing, so a test can assert on what was decided instead of
   * inferring it from side effects.
   */
  function catchUp() {
    const at = now();
    // Four distinct outcomes, deliberately not collapsed into one "skipped" bucket: a fire the policy
    // declined and a run the concurrency limit refused are different events, and a summary that
    // merges them cannot answer "did my schedule work". Counts are of *windows* for skipped, because
    // the walk is capped and reporting a capped count as a total would be a quiet lie.
    const summary = { enqueued: 0, skippedWindows: 0, refused: 0, dropped: 0, errors: [] };
    const manager = getManager();

    // The instant from which this scheduler can vouch that it was awake, or null if it cannot.
    // Everything after it was watched come due; everything before it fell into a gap. Passed down
    // rather than a boolean because a trigger's stored position can predate this process entirely
    // (a schedule removed and re-added keeps its old row), and those two spans need different answers.
    const prevTick = lastTickAt;
    const liveSince = prevTick !== null && at - prevTick <= tickMs + GRACE_MS ? prevTick : null;
    lastTickAt = at;

    for (const listed of listWorkflows()) {
      // listWorkflows returns summaries; the triggers live on the full definition.
      const def = getWorkflow(listed.id);
      for (const trigger of def?.triggers ?? []) {
        if (trigger.type !== "cron") continue;

        try {
          catchUpTrigger({ def, trigger, at, liveSince, manager, summary });
        } catch (e) {
          // One malformed expression must not stop every other workflow's schedule.
          const msg = `${def.id}/${trigger.id}: ${e?.message || e}`;
          summary.errors.push(msg);
          log(`[scheduler] ${msg}`);
        }
      }
    }

    return summary;
  }

  function catchUpTrigger({ def, trigger, at, liveSince, manager, summary }) {
    // Parse first: an unparseable expression should be reported once, not silently never fire.
    parseCron(trigger.config?.expression);

    const last = repo.getTriggerLastFired(def.id, trigger.id);
    if (last === null) {
      // First sight of this trigger. Start the clock now rather than treating "never fired" as
      // "due since the epoch" -- enabling a daily schedule must not backfill the workflow's history.
      repo.setTriggerLastFired(def.id, trigger.id, at);
      return;
    }

    const policy = trigger.missedRunPolicy;
    // `backfill` is the only policy that needs the fires counted; the others need to know whether
    // *any* were due, so cap the walk at what the decision actually consumes. A live pass splits its
    // results, so it needs them counted too — capped, rather than trusted to be few.
    const limit = policy === "backfill" || liveSince !== null ? BACKFILL_CAP : 1;
    const { times, truncated } = fireTimesBetween(trigger.config.expression, last, at, { limit });
    if (times.length === 0) return;

    // (1) Persist the new position BEFORE enqueueing. See the module header.
    repo.setTriggerLastFired(def.id, trigger.id, at);

    /**
     * Split the due fires at the edge of what this process actually witnessed.
     *
     * Fires after `liveSince` came due while the scheduler was ticking: they are *on time*, and
     * `missedRunPolicy` has no say over them. Getting this wrong is not a subtle degradation — the
     * policy would then apply to every fire, and `skip` (the safe default for anything with side
     * effects) would mean a scheduled workflow never runs at all: each tick notices the fire,
     * advances the position past it and enqueues nothing, forever, in silence.
     *
     * Fires at or before the edge fell into a gap — app closed, machine asleep, process killed — and
     * are the only ones the policy is actually about. The two spans coexist in a single pass when a
     * trigger's stored position predates this process, which is why the split is by timestamp rather
     * than by a whole-pass boolean.
     */
    const edge = liveSince ?? at;
    const onTime = times.filter((t) => t > edge);
    const missed = times.filter((t) => t <= edge);

    for (let i = 0; i < onTime.length; i += 1) enqueue({ def, manager, summary });
    if (missed.length === 0) return;

    let toRun;
    switch (policy) {
      case "skip":
        // Only future fires matter; the gap is deliberately forgotten. Counted as one window rather
        // than N fires, because the walk is capped and N is therefore a floor, not a total --
        // reporting it as a count would be a quiet lie about how much was dropped.
        summary.skippedWindows += 1;
        return;
      case "backfill":
        // Only the gap's fires: any on-time ones were already enqueued above.
        toRun = missed.length;
        if (truncated) {
          // (2) Never a silent cap.
          summary.dropped += 1;
          log(
            `[scheduler] ${def.id}/${trigger.id}: more than ${BACKFILL_CAP} fires were due since ` +
              `${new Date(last).toISOString()}; running ${BACKFILL_CAP} and dropping the rest`,
          );
        }
        break;
      case "run-once-on-launch":
      default:
        // The sensible default: a gap of any size means "this is stale, refresh it once".
        toRun = 1;
        break;
    }

    for (let i = 0; i < toRun; i += 1) enqueue({ def, manager, summary });
  }

  /** Start one run. Shared by the on-time and catch-up paths so they cannot diverge. */
  function enqueue({ def, manager, summary }) {
    const res = manager?.createRun({ workflowId: def.id, triggerType: "cron" });
    // `concurrency: single` legitimately refuses while a run is in flight; that is the limit doing
    // its job, not an error, so it is counted as refused rather than logged as a failure.
    if (res?.ok) {
      summary.enqueued += 1;
      void manager.executeRun(res.runId).catch((e) => log(`[scheduler] run failed: ${e?.message || e}`));
    } else {
      summary.refused += 1;
    }
  }

  return {
    catchUp,

    /** Catch up immediately (the app-start pass), then keep asking on a timer. */
    start() {
      const first = catchUp();
      if (first.enqueued) log(`[scheduler] ${first.enqueued} run(s) enqueued on start`);
      clearInterval(timer);
      timer = setInterval(() => {
        try {
          catchUp();
        } catch (e) {
          log(`[scheduler] tick failed: ${e?.message || e}`);
        }
      }, tickMs);
      // Never hold the process open just to tick.
      timer.unref?.();
      return first;
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * When each of a workflow's cron triggers is next due, for the dashboard.
 *
 * Derived from the same walk the scheduler uses rather than a parallel estimate, so the time shown
 * cannot disagree with the time that fires. Returns null when the workflow has no cron trigger.
 */
export function nextScheduledFire(def, from = Date.now()) {
  let soonest = null;
  for (const trigger of def?.triggers ?? []) {
    if (trigger.type !== "cron") continue;
    try {
      const at = nextFireAfter(trigger.config?.expression, from);
      if (at !== null && (soonest === null || at < soonest)) soonest = at;
    } catch {
      // A malformed expression has no next fire; the scheduler logs it, the dashboard just omits it.
    }
  }
  return soonest;
}
