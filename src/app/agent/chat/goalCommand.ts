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
 * The one genuinely ambiguous case is a single-word argument: `/goal clear` is a subcommand, `/goal ship` could
 * be either. It is read as a SUBCOMMAND attempt, so an unrecognised one is reported rather than silently
 * becoming the goal. The cost is that a one-word condition has to be written as a phrase; the benefit is that a
 * typo'd `/goal stpo` cannot start a self-driving loop toward a nonsense condition. Anything with whitespace in
 * it is unambiguously a condition and is never treated as a subcommand.
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

  // Single word → a subcommand attempt. Case-insensitive, because nobody capitalises consistently here.
  if (!/\s/.test(arg)) {
    const lower = arg.toLowerCase();
    if (CLEAR_ALIASES.has(lower)) return { kind: "clear" };
    return { kind: "error", code: "unknownSub", detail: arg };
  }

  // Long conditions are accepted in full — never rejected, never truncated. The flag only lets the caller say
  // that this one will be re-sent on every round, which is the part a user cannot see for themselves.
  return { kind: "set", condition: arg, long: arg.length > GOAL_CONDITION_WARN };
}

/** The clear aliases, for the error message that lists what was expected. Sorted so the text is stable. */
export const GOAL_CLEAR_ALIASES: string[] = [...CLEAR_ALIASES].sort();
