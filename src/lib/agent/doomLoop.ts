/**
 * Doom-loop detection — noticing that a turn has stopped getting anywhere.
 *
 * Spec: docs/agent-runtime-loop.md §12. Supersedes `app/agent/chat/loopGuard.ts`, which was the first version
 * of this and is now deleted: §20 rule 7 forbids two competing Stop Policies, and a detector that decides on
 * its own to withdraw the model's tools was already one.
 *
 * What carries over unchanged, because it was right and is load-bearing:
 *
 *  - the detector does NOT count rounds. Counting rounds punishes long work, which is the thing worth
 *    protecting; a forty-round task that is getting somewhere must not be treated like a four-round task that
 *    is not. What it looks for is the absence of NEW INFORMATION;
 *  - a single unproductive call earns a reminder, never a stop. Re-reading a file whose earlier result was
 *    stubbed by compaction is a legitimate identical repeat, and a third failure can still be the one before
 *    the fix;
 *  - a round is only stalled when EVERY call in it was unproductive. One genuine result means the round
 *    advanced the task, and it resets the streak however much repetition it was mixed with. The cost of
 *    missing a loop for one more round is a round; the cost of stopping a turn that was working is the work.
 *
 * What §12 adds beyond that first version, and why each one is a distinct signal rather than a variation:
 *
 *  - **equivalent arguments.** `{path: "./a.ts"}` and `{path: "a.ts"}` are the same call wearing different
 *    clothes. Byte-identity misses it, and a model that has started varying its arguments cosmetically is
 *    exactly the model that is stuck.
 *  - **repeated resource access.** Reading one file six times in a turn with six different line ranges is not
 *    an identical call and never will be, but it is still six rounds spent on one file.
 *  - **repeated searches.** A search whose query differs only in whitespace or case is the same search.
 *
 * The response stays proportional (§12): first repetition is recorded, repeated behaviour makes the model
 * aware through the existing `reminders.ts` injection path, persistent repetition escalates to the Stop
 * Policy — which is what `stopPolicy.ts` reads this state for. This module never stops anything itself. That
 * separation is the whole reason it can be one module: detection is a fact, stopping is a decision.
 */

/** A second identical call+result earns a reminder. The first repeat is where a loop becomes visible at all. */
export const REPEAT_NOTE_AT = 2;

/**
 * Consecutive failures of ONE tool before it is called out. Two is normal — a wrong path, then the right one.
 * Three is a model that has stopped reading the error it is being handed.
 */
export const FAIL_NOTE_AT = 3;

/**
 * Distinct accesses to one resource within a turn before it counts as unproductive.
 *
 * Higher than the identical-call threshold on purpose: reading three different parts of a large file is
 * ordinary work, and a sequential walk through a file legitimately produces several non-overlapping reads.
 * Four is where "working through it" becomes "circling it".
 */
export const RESOURCE_NOTE_AT = 4;

/**
 * Fully unproductive rounds, back to back, before the Stop Policy is asked to intervene.
 *
 * Three rather than two because the first stalled round has only just been warned about, and a model given a
 * reminder usually acts on it in the very next round. Breaking at two would cut off the recovery the reminder
 * is asking for; at three, the reminder was delivered, read, and ignored twice.
 */
export const STALLED_ROUNDS_TO_ESCALATE = 3;

/** What one tool call looked like to the detector. */
export interface CallObservation {
  /** Resolved tool name — never the dispatcher's, or every routed call would share one identity. */
  name: string;
  args: unknown;
  /** The result text as the model will see it (i.e. after capping). */
  result: string;
  ok: boolean;
}

/** Which signal fired, if any. Ordered by specificity when several apply. */
export type DoomSignal = "identical" | "equivalent" | "resource" | "failing";

export interface CallVerdict {
  /** How many times this exact call has returned this exact result, including this one. 1 = first. */
  repeat: number;
  /** Consecutive failures of this tool, including this one. 0 when the call succeeded. */
  failStreak: number;
  /** Distinct accesses to the resource this call touched, including this one; 0 when it touches none. */
  resourceHits: number;
  /** True when the call taught the model nothing it did not already have. */
  unproductive: boolean;
  /** The most specific signal that fired, or null. Drives which reminder the caller injects. */
  signal: DoomSignal | null;
}

export interface RoundVerdict {
  /** Consecutive rounds, up to and including this one, in which nothing new was learned. */
  stalledRounds: number;
  /** True on the round the Stop Policy should act on — and only that round, so it is reported once. */
  escalate: boolean;
}

export interface DoomLoopState {
  /** callKey → result hash → occurrences. */
  seen: Map<string, Map<string, number>>;
  /** Normalised call key + result hash → occurrences, for the equivalent-argument signal. */
  equivalents: Map<string, number>;
  /** "tool:resource" → occurrences, for the repeated-access signal. */
  resources: Map<string, number>;
  /** Tool name → consecutive failures. */
  failStreaks: Map<string, number>;
  stalledRounds: number;
  /** Latched once escalation has been reported, so a later round cannot report it twice. */
  escalated: boolean;
}

/** One detector per turn: everything it knows is about the turn in progress. */
export function createDoomLoopState(): DoomLoopState {
  return {
    seen: new Map(),
    equivalents: new Map(),
    resources: new Map(),
    failStreaks: new Map(),
    stalledRounds: 0,
    escalated: false,
  };
}

/** Stable identity for "the same call again": name plus arguments with object keys sorted. */
export function callKey(name: string, args: unknown): string {
  return `${name} ${stable(args)}`;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Identity after cosmetic differences are removed.
 *
 * Strings are trimmed, lower-cased, internal whitespace collapsed, and leading `./` dropped — the four ways a
 * model rephrases an argument without changing what it asked for. Numbers and booleans are left alone: a
 * different `limit` is a genuinely different read, and treating it as equivalent would flag a sequential walk
 * through a file as a loop.
 *
 * Deliberately NOT path resolution. Resolving `../` against a working directory would need I/O and would be
 * wrong for the many arguments that are not paths; this is a similarity test used only to decide whether to
 * warn, so over-normalising costs more than it saves.
 */
export function equivalentKey(name: string, args: unknown): string {
  return `${name} ${normalize(args)}`;
}

function normalize(v: unknown): string {
  if (typeof v === "string") {
    return JSON.stringify(v.trim().toLowerCase().replace(/\s+/g, " ").replace(/^\.\//, ""));
  }
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null) ?? "null";
  if (Array.isArray(v)) return `[${v.map(normalize).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${normalize((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Argument keys that name the thing a call is *about*.
 *
 * `path` and its relatives identify a file; `query` identifies a search. Both are resources in the sense §12
 * means — "repeated access to the same resource, repeated searches" — even though a file and a query are
 * nothing alike, because the failure mode is identical: the turn keeps going back to one thing.
 */
const RESOURCE_KEYS = ["path", "file", "filename", "dir", "directory", "query", "pattern", "url"];

/** The resource a call touches, normalised, or null when it touches none the detector can name. */
export function resourceOf(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const o = args as Record<string, unknown>;
  for (const key of RESOURCE_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim().toLowerCase().replace(/\s+/g, " ").replace(/^\.\//, "");
    }
  }
  return null;
}

/**
 * FNV-1a over the result text, with the length appended.
 *
 * A hash because a turn can hold hundreds of results, several of them large; the detector only ever asks "is
 * this the same output as last time". The length guards the collision: two different results must collide in
 * 32 bits AND share a length to be mistaken for one, and the consequence would be a single reminder.
 */
export function resultHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${text.length}`;
}

/**
 * Record one call and say what it was worth.
 *
 * Repetition is counted per (call, result) pairing rather than per call: a `run_command` that runs the test
 * suite five times while the code changes underneath it returns five different results and is productive
 * every time — the case a naive "same call again" counter would flag and this one does not.
 */
export function observeCall(g: DoomLoopState, obs: CallObservation): CallVerdict {
  const key = callKey(obs.name, obs.args);
  const hash = resultHash(obs.result);
  const byHash = g.seen.get(key) ?? new Map<string, number>();
  const repeat = (byHash.get(hash) ?? 0) + 1;
  byHash.set(hash, repeat);
  g.seen.set(key, byHash);

  // Keyed on the RESULT as well as the normalised call, for the same reason the identical signal is: a call
  // that returned something new taught the model something, however similar its arguments looked. Without
  // the result in the key, re-running the test suite after an edit — same command, different output, obvious
  // progress — would be flagged as a loop, which is the precise false positive this detector must not have.
  const eqKey = `${equivalentKey(obs.name, obs.args)}\u0000${hash}`;
  const equivalent = (g.equivalents.get(eqKey) ?? 0) + 1;
  g.equivalents.set(eqKey, equivalent);

  const resource = resourceOf(obs.args);
  let resourceHits = 0;
  if (resource) {
    const rKey = `${obs.name}:${resource}`;
    resourceHits = (g.resources.get(rKey) ?? 0) + 1;
    g.resources.set(rKey, resourceHits);
  }

  const failStreak = obs.ok ? 0 : (g.failStreaks.get(obs.name) ?? 0) + 1;
  g.failStreaks.set(obs.name, failStreak);

  const identical = repeat >= REPEAT_NOTE_AT;
  // Only counts once byte-identity has been ruled out — otherwise every identical call would also report as
  // "equivalent", and the reminder would name the vaguer of the two diagnoses.
  const equivalentRepeat = !identical && equivalent >= REPEAT_NOTE_AT;
  const overResource = resourceHits >= RESOURCE_NOTE_AT;
  const failing = failStreak >= FAIL_NOTE_AT;

  return {
    repeat,
    failStreak,
    resourceHits,
    unproductive: identical || equivalentRepeat || overResource || failing,
    // Most specific first: "you made this exact call again" is actionable in a way "you keep touching this
    // file" is not, and a model told the vaguer thing tends to vary its arguments rather than change course.
    signal: identical ? "identical" : equivalentRepeat ? "equivalent" : failing ? "failing" : overResource ? "resource" : null,
  };
}

/**
 * Close a round and decide whether the turn is still going anywhere.
 *
 * A round with no tool calls is not a round the detector sees (the loop exits on it), so `verdicts` is never
 * empty in practice; an empty array leaves the streak alone rather than counting as productive or stalled.
 */
export function closeRound(g: DoomLoopState, verdicts: CallVerdict[]): RoundVerdict {
  if (verdicts.length === 0) return { stalledRounds: g.stalledRounds, escalate: false };
  const stalled = verdicts.every((v) => v.unproductive);
  g.stalledRounds = stalled ? g.stalledRounds + 1 : 0;
  const escalate = !g.escalated && g.stalledRounds >= STALLED_ROUNDS_TO_ESCALATE;
  if (escalate) g.escalated = true;
  return { stalledRounds: g.stalledRounds, escalate };
}
