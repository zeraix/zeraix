import { deepRenameKey } from '@zzcpt/zztool';
/**
 * The slash-command registry, and the rule for when the composer should offer it.
 *
 * A command that only works if you already know it exists is not a feature, it is a secret. `/goal` was
 * shipped with no affordance at all: nothing in the UI mentioned it, so the only users who would ever type it
 * are the ones who read the source. This module is what the composer's `/` menu is built from, and it is the
 * place any future command is added — one entry, and it becomes discoverable, filterable and documented at the
 * same time.
 *
 * Pure and free of React so the matching rule can be tested directly. Descriptions are i18n KEYS, never text:
 * the app ships 11 locales and this menu is user-facing.
 */

/** One row in the `/` menu. */
export interface SlashCommand {
  /**
   * Stable id, also the i18n key suffix. Rows for the same command differ here (`goal.set` / `goal.status`),
   * because the menu teaches the SHAPES a command takes, not just its name.
   */
  id: string;
  /** The text put into the composer when this row is picked. A trailing space means "an argument follows". */
  insert: string;
  /**
   * The literal part, slash included: `/goal`. Rendered in the accent colour — it is what you TYPE, and
   * separating it from the placeholder is what makes the row readable at a glance.
   */
  name: string;
  /** The argument placeholder, if any: `<condition>`. Rendered dimmed — it is what you FILL IN, not literal. */
  args?: string;
  /** i18n key for the one-line description shown beside the name. */
  descriptionKey: string;
}

/** The whole invocation as one string, for matching and for anywhere a single label is wanted. */
export const commandLabel = (c: SlashCommand): string => (c.args ? `${c.name} ${c.args}` : c.name);

/**
 * Every command the composer accepts.
 *
 * Ordered by what a first-time reader should see first: the form that DOES something, then the ways to inspect
 * and undo it. Keep that shape when adding a command — the menu is read top-down and the first row is the one
 * people learn.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "goal.set",
    insert: "/goal ",
    name: "/goal",
    args: "<condition>",
    descriptionKey: "slash.goal.set",
  },
  {
    id: "goal.status",
    insert: "/goal",
    name: "/goal",
    descriptionKey: "slash.goal.status",
  },
  {
    id: "goal.clear",
    insert: "/goal clear",
    name: "/goal clear",
    descriptionKey: "slash.goal.clear",
  },
  {
    id: "clear",
    insert: "/clear",
    name: "/clear",
    descriptionKey: "slash.clear",
  }
];

/**
 * Split a recognised command off the front of the input: `{ name: "goal", rest: "all tests pass" }`.
 *
 * The dispatcher for the composer, and the reason each command's own parser only has to understand its own
 * arguments. Null for anything that is not a registered command — including an unknown `/word`, which is sent
 * as an ordinary message rather than rejected. People type paths and dates; being permissive about what is NOT
 * a command costs nothing, while being strict about it would refuse messages the user meant to send.
 */
export function parseSlashCommand(input: string): { name: string; rest: string } | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([A-Za-z_][\w-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  const [, word, rest] = match;
  const name = word.toLowerCase();
  return SLASH_COMMANDS.some((c) => wordOf(c) === name) ? { name, rest: rest.trim() } : null;
}

/** The command word of a row, without the slash — `/goal clear` → `goal`. */
const wordOf = (c: SlashCommand): string => c.name.slice(1).split(/\s+/)[0].toLowerCase();

/**
 * How many leading characters form a COMPLETE command word, or 0 when the input does not open with one.
 *
 * This is what the composer draws its tag behind. Deliberately stricter than the menu's filter: the menu opens
 * on a prefix (`/go` still offers `/goal`), but a half-typed word is not yet a command and decorating it would
 * promise something that will not happen when the user hits Enter. Only the command WORD is measured — the
 * subcommand in `/goal clear` and the condition in `/goal ship it` are arguments, and tagging them would blur
 * the very distinction the tag exists to draw.
 */
export function commandTokenLength(input: string): number {
  if (!input.startsWith("/")) return 0;
  // The word runs to the first whitespace, or to the end when nothing has been typed after it yet.
  const token = input.split(/\s/, 1)[0] ?? "";
  const word = token.slice(1).toLowerCase();
  return SLASH_COMMANDS.some((c) => wordOf(c) === word) ? token.length : 0;
}

/**
 * Which commands to offer for the text currently in the composer, or null when the menu must stay shut.
 *
 * Open only while the command WORD is still being typed: the input starts with `/` and contains no whitespace
 * yet. Two consequences, both deliberate. A slash inside a sentence (`look in src/app`) never opens it, because
 * the input does not start with one. And the moment a space is typed the menu closes, because everything after
 * the command word is a free-text argument — a goal condition is a sentence, and a menu hovering over it while
 * the user writes would be in the way and would swallow their Enter.
 */
export function matchSlashCommands(input: string): SlashCommand[] | null {
  if (!input.startsWith("/")) return null;
  if (/\s/.test(input)) return null;
  const typed = input.slice(1).toLowerCase();
  // A bare "/" offers everything — that is the discovery case this module exists for.
  const hits = typed ? SLASH_COMMANDS.filter((c) => wordOf(c).startsWith(typed)) : SLASH_COMMANDS;
  // No match means the user is typing something that is not a command; an empty popup would be noise.
  return hits.length ? hits : null;
}
