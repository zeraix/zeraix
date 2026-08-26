/**
 * How often an async generation job is asked whether it has finished.
 *
 * Its own module because two very different places have to agree on it: the runtime that does the polling,
 * and the Settings form that validates what the user types. A constant duplicated across those two drifts the
 * moment either is edited, and the symptom would be a form that accepts a value the runtime silently
 * overrides — the user sets one second, sees it saved, and never learns why it polls every three.
 *
 * It cannot live in `index.ts` with the loop that uses it: `custom.ts` needs it too, and `index.ts` already
 * depends on `registry.ts`, which depends on `custom.ts`. Importing it back would be a cycle.
 */

/** What a job polls at when the engine says nothing. Tuned for a video that finishes in a couple of minutes. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * The floor, and it is a floor rather than a suggestion.
 *
 * A job does not finish sooner for being asked more often — the only thing a shorter interval buys is a
 * faster notice, paid for out of the vendor's rate limit. Below a few seconds that trade stops making sense:
 * a minutes-long job polled every half second spends hundreds of requests to learn nothing, and some vendors
 * bill or throttle the status endpoint itself.
 */
export const MIN_POLL_INTERVAL_MS = 3_000;

/**
 * How long a job may run before it is reported as timed out.
 *
 * A hard failure, so it is deliberately generous: a job cut off here has usually been generated and PAID for,
 * and reporting that as a timeout is the worst of both outcomes.
 */
export const POLL_BUDGET_MS = 5 * 60_000;

/**
 * The interval to actually use.
 *
 * Clamps rather than rejects: a stored engine may predate the floor, or carry a value hand-edited in
 * `index.json`, and refusing to poll at all would turn a configuration mistake into a video that never
 * arrives. Anything unusable — absent, not a number, zero, negative — falls back to the default.
 */
export function clampPollInterval(ms?: number | null): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.round(ms));
}

/** How many polls a job gets at a given interval — what a user is really choosing when they widen it. */
export const pollsWithinBudget = (intervalMs: number): number =>
  Math.floor(POLL_BUDGET_MS / clampPollInterval(intervalMs));
