/**
 * Parsing the `/goal` command.
 *
 * Kept as its own pure module — no React, no state, no i18n — because command parsing is where a slash command
 * quietly does the wrong thing: `/goal stap` setting a goal called "stap" is worse than any error message. The
 * result is a discriminated union carrying CODES rather than prose, so the page can render every outcome in the
 * user's language (the app ships 11 locales) while the rules stay testable on their own.
 */

import { GOAL_CONDITION_WARN } from "./goalState";

/** The command word itself, without the slash. */
const COMMAND = "goal";

/**
 * Words that clear the goal.
 *
 * `clear` is the documented one; the rest are what people actually type when they want a loop to stop. Matching
 * them is cheaper than an error message, and none of them is a plausible one-word goal condition.
 */
const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/**
 * The explicit setter: `/goal set <condition>`.
 *
 * Exists so there is always an unambiguous way to say "this text is the goal, whatever it looks like". Without
 * it `/goal set deploy` set a goal literally called "set deploy" — the word survived into the condition, and
 * the loop then drove toward an instruction the user never wrote.
 */
const SET_WORD = "set";

/**
 * Is `word` one typo away from `target`?
 *
 * One substitution, insertion, deletion — or one ADJACENT TRANSPOSITION, which plain Levenshtein scores as two
 * edits and which is the most common typo there is. `stpo` for `stop` is exactly that, and a check without it
 * misses the very case this guard exists for.
 *
 * Bounded rather than a full distance matrix: only "0 or 1" matters, so each branch can exit early.
 */
function isLikelyTypoOf(word: string, target: string): boolean {
  if (word === target) return true;

  if (word.length === target.length) {
    const differing: number[] = [];
    for (let i = 0; i < word.length; i++) {
      if (word[i] !== target[i]) differing.push(i);
      if (differing.length > 2) return false;
    }
    // One substitution.
    if (differing.length === 1) return true;
    // Two adjacent positions holding each other's characters: a transposition.
    if (differing.length === 2) {
      const [a, b] = differing;
      return b === a + 1 && word[a] === target[b] && word[b] === target[a];
    }
    return false;
  }

  // One insertion or deletion: walk both, allowing a single skip on the longer side.
  const [short, long] = word.length < target.length ? [word, target] : [target, word];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let skipped = false;
  for (let j = 0; j < long.length; j++) {
    if (i < short.length && short[i] === long[j]) {
      i++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
  }
  return true;
}

export type GoalCommand =
  /** Not a `/goal` command at all — the caller sends the text normally. */
  | { kind: "none" }
  /** `/goal` with no argument: show the current state. */
  | { kind: "status" }
  /**
   * `/goal <condition>`: set (or replace) the goal, then run the condition as this round's instruction.
   *
   * `long` flags a condition past GOAL_CONDITION_WARN. It is advisory and NEVER blocks: the goal is set either
   * way, and the caller simply mentions the cost. Length is not a reason to refuse someone's own requirement.
   */
  | { kind: "set"; condition: string; long: boolean }
  /** `/goal clear` and its aliases. */
  | { kind: "clear" }
  /**
   * Something was typed that cannot be honoured. `detail` carries whatever the message needs to quote — the
   * offending word — so the caller can format it without re-parsing.
   */
  | { kind: "error"; code: "unknownSub"; detail: string };

/**
 * Parse one composer input.
 *
 * ## The single-word case, and why it changed
 *
 * `/goal clear` is a subcommand and `/goal ship` is a goal, and nothing in the text distinguishes them. This
 * used to resolve the ambiguity by treating EVERY single word as a subcommand attempt, so `/goal ship` was
 * refused — which contradicted the error message it produced, since that message tells the user
 * "/goal <condition> to set a goal". The code did not do what its own error said.
 *
 * The ambiguity is real, but it is narrow: it only exists for words that could plausibly be a fumbled
 * subcommand. So a single word is now refused only when it is one edit from a clear alias — `/goal stpo` asks
 * again, `/goal ship` sets a goal. That keeps the protection the refusal was written for (a typo must not start
 * a self-driving loop toward a nonsense condition) and drops the cost it was paying everywhere else.
 *
 * `/goal set <anything>` is the escape hatch for the words that remain ambiguous: `/goal set clean` sets a goal
 * called "clean" with no guessing at all.
 */
export function parseGoalCommand(input: string): GoalCommand {
  const text = (input ?? "").trim();
  if (!text.startsWith("/")) return { kind: "none" };
  // Split off the command word. The rest is kept verbatim (including newlines) — a condition may be a paragraph.
  const match = text.match(/^\/([A-Za-z_][\w-]*)\s*([\s\S]*)$/);
  if (!match) return { kind: "none" };
  const [, word, rest] = match;
  if (word.toLowerCase() !== COMMAND) return { kind: "none" };

  const arg = rest.trim();
  if (!arg) return { kind: "status" };

  // `/goal set <condition>` — the explicit form. The subcommand word is consumed, never carried into the goal.
  const explicit = arg.match(/^set\s+([\s\S]+)$/i);
  if (explicit) return asSet(explicit[1].trim());
  // `/goal set` with nothing after it. Reported rather than made into a goal called "set", which is what a
  // fall-through would do; the message already says how to supply a condition.
  if (arg.toLowerCase() === SET_WORD) return { kind: "error", code: "unknownSub", detail: arg };

  // Single word. Case-insensitive, because nobody capitalises consistently here.
  if (!/\s/.test(arg)) {
    const lower = arg.toLowerCase();
    if (CLEAR_ALIASES.has(lower)) return { kind: "clear" };
    // Close enough to a clear alias to be a typo of one — ask rather than guess. Everything else is a goal.
    if ([...CLEAR_ALIASES].some((alias) => isLikelyTypoOf(lower, alias))) {
      return { kind: "error", code: "unknownSub", detail: arg };
    }
  }

  return asSet(arg);
}

/**
 * Build a `set`, flagging a long condition.
 *
 * Long conditions are accepted in full — never rejected, never truncated. The flag only lets the caller say
 * that this one will be re-sent on every round, which is the part a user cannot see for themselves.
 */
function asSet(condition: string): GoalCommand {
  return { kind: "set", condition, long: condition.length > GOAL_CONDITION_WARN };
}

/** The clear aliases, for the error message that lists what was expected. Sorted so the text is stable. */
export const GOAL_CLEAR_ALIASES: string[] = [...CLEAR_ALIASES].sort();
