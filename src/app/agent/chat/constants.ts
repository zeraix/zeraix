/** Static constants and system prompts for the chat page (extracted from page.tsx). */

// The system prompt body is now maintained in Markdown, imported as a string via the Turbopack raw-loader (see systemPromptFor below).
import baseSystemMd from "./system/base.system.md";
import dailyModeMd from "./system/daily.mode.md";
import developmentModeMd from "./system/development.mode.md";

export const MAX_TOOL_ROUNDS = 100; // Prevent infinite tool-call loops
export const MAX_SUBAGENT_ROUNDS = 30; // Cap on a sub-agent's own tool-call rounds
// Infinite-loop guard: when the same "tool + args" is repeated this many times within a turn, treat it as no progress and abort,
// to keep the model from spinning by retrying commands that keep failing / timing out (e.g. launching a GUI program).
export const MAX_SAME_TOOL_CALLS = 3;
// Infinite-loop guard: abort the turn after this many consecutive commands are killed by timeout (usually programs that keep running / open a window).
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** "Flat search" read-only tools: calling these many times in a row in the main loop without delegating usually signals a lack of triage and blind rummaging. */
export const FLAT_SEARCH_TOOLS = new Set([
  "read_file",
  "search_files",
  "search_in_files",
  "list_directory",
  "file_info",
]);

/** When the main loop has made this many "flat search" calls in a turn and still hasn't used run_subagent, inject a one-time delegation reminder. */
export const FLAT_SEARCH_NUDGE_AT = 8;

/** Resume-after-interrupt nudge (fed back to the model only; not displayed / not persisted): injected when the user sends again after interrupting the previous turn, to prompt the model to reuse existing analysis and continue. */
export const RESUME_NUDGE =
  "Your previous response was interrupted by the user before it finished. All tool results and analysis " +
  "already shown above remain valid — reuse them and continue from where you left off. Do NOT re-run tool " +
  "calls or repeat analysis you have already completed; build on the existing results to answer.";

/** Delegation reminder (fed back to the model only; not displayed / not persisted): prompts it to hand off cross-file investigation to the explore sub-agent instead of continuing to search / read by hand. */
export const DELEGATE_NUDGE =
  "You have made several direct search/read calls in this turn without delegating. " +
  "If the answer requires exploring across multiple files, STOP the flat searching and call " +
  'run_subagent with agent "explore" and a self-contained task — it runs its own investigation ' +
  "and returns a concise conclusion, keeping this conversation small. Prefer delegation now over " +
  "more manual search_in_files / read_file calls.";

/** Finalize reminder (fed back to the model only; not displayed / not persisted): a tool has run this turn (e.g. a sub-agent returned a result),
 *  yet the model ended with an empty body (no final reply for the user — often because it wrote the conclusion into reasoning or mistook a tool result for the reply).
 *  Injected to prompt it to give a complete final reply directly, in the user's language, based on the information already gathered. Injected at most once per turn to avoid infinite loops. */
export const FINALIZE_NUDGE =
  "You ended your turn with an empty reply, but the user has not received any answer yet. " +
  "You already have everything needed — including any results returned by sub-agents (run_subagent) and " +
  "other tools shown above. Now write the FINAL answer directly to the user, in the user's language, " +
  "as normal message content (NOT inside hidden reasoning, and WITHOUT calling more tools). " +
  "Synthesize and present the complete result; do not reply with blank content again.";

/** Injected when regenerating after the user rated the previous reply "unhelpful" (fed back to the model only; not displayed / not persisted): prompts it to take a different approach and improve. */
export const FEEDBACK_DOWN_NUDGE =
  "The user rated your previous answer to this request as UNHELPFUL (thumbs down). " +
  "Regenerate a better response: take a different approach, address what was likely missing or wrong, " +
  "and be more accurate, complete, and useful. Do not simply repeat the previous answer.";

/** Injected when regenerating after the user rated the previous reply "helpful" (fed back to the model only; not displayed / not persisted): prompts it to keep that approach and style. */
export const FEEDBACK_UP_NUDGE =
  "The user rated your previous answer to this request as HELPFUL (thumbs up). " +
  "Regenerate along the same lines: keep the approach, depth, and style that the user liked, " +
  "while making the answer at least as good.";

/**
 * Feedback hint injected dynamically into the wire view based on StoredMessage.rating when reading history (English; goes only into the
 * "sent to the model" wire view, not written to the archived content, and not sent with that assistant message — see injectRatingFeedback).
 * Persistent: as long as that reply remains rated in the context, every request appends this hint after it, so the model stays aware of
 * the user's feedback across turns.
 */
export const RATING_UP_FEEDBACK =
  "[User feedback] The user marked the assistant's response above as HELPFUL. " +
  "Keep the approach, depth, and style of that response in your following replies.";
export const RATING_DOWN_FEEDBACK =
  "[User feedback] The user marked the assistant's response above as UNHELPFUL. " +
  "Take this into account: avoid repeating its shortcomings and improve the accuracy, " +
  "completeness, and usefulness of your following replies.";

/** Tools that modify source files (used for the "risky change → forced review" check; run_command is excluded because its path is uncertain). */
export const MUTATING_FILE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "append_file",
  "delete_file",
  "copy_file",
  "move_file",
  "create_directory",
]);

/** Risky-path patterns: a match is treated as a "critical change", and a reviewer sub-agent should run before the turn ends. */
export const RISKY_PATH_PATTERN =
  /(auth|login|logout|session|token|password|secret|credential|\.env|payment|billing|invoice|checkout|wallet|migration|schema|security|permission|crypto)/i;

/** Forced-review reminder (fed back to the model only): injected when a risky path was modified but not reviewed and the model tries to wrap up, prompting it to delegate to a reviewer first. */
export const FORCE_REVIEW_NUDGE =
  "You modified files on a risky path (auth / data / security / payment / secrets) but have not run a " +
  'review. Before concluding, call run_subagent with agent "reviewer" and a self-contained task describing ' +
  "the change, so it can verify correctness, regressions, and security. Only report done after the review.";

/** Sensitive tools: they modify the file system or run commands, and require user confirmation before being called.
 *  Read-only tools (read_file / list_directory / file_info / search_*) are not included here and can run directly. */
export const SENSITIVE_TOOLS = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "delete_file",
  "copy_file",
  "move_file",
  "create_directory",
  "run_command",
  "open_path", // Open a file / folder with the system default app: may launch an executable, so it goes through confirmation
]);

/** Human-friendly tool labels, used in the progress status text. */
const TOOL_LABELS: Record<string, string> = {
  read_file: "Reading file",
  write_file: "Writing file",
  edit_file: "Editing file",
  append_file: "Appending content",
  delete_file: "Deleting file",
  copy_file: "Copying file",
  move_file: "Moving file",
  create_directory: "Creating directory",
  search_files: "Searching files",
  search_in_files: "Searching content",
  list_directory: "Listing directory",
  file_info: "Viewing info",
  open_path: "Opening file",
  run_command: "Running command",
  check_project: "Building and testing",
  update_todos: "Updating todos",
  web_search: "Searching the web",
  fetch_url: "Fetching page",
};

/** Builds status text from the tool name + args, e.g. "Editing file style.css…". */
export function toolStatusText(name: string, args: unknown): string {
  const label = TOOL_LABELS[name] ?? name;
  const o = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hint = o.path ?? o.command ?? o.pattern ?? o.query ?? o.url;
  const extra = hint ? ` ${String(hint).slice(0, 40)}` : "";
  return `${label}${extra}…`;
}

/** The three options on the confirmation panel (order is the up/down navigation order):
 *  yes = allow this time / always = don't ask again (auto-approve this tool for the rest of the session) / no = reject. */
export type ConsentDecision = "yes" | "always" | "no";
export const CONSENT_OPTIONS: { key: ConsentDecision; label: string }[] = [
  { key: "yes", label: "Allow" },
  { key: "always", label: "Don't ask again" },
  { key: "no", label: "Reject" },
];

/**
 * System prompts (two sets, by mode): tell the model it runs locally, which tools are available, plus the working principles and execution loop.
 * The prompt bodies are now maintained in Markdown files (see system/*.md, imported as strings via the Turbopack raw-loader):
 *  - development.mode.md: development mode, for writing code / changing the project (read-change-verify; always run check_project after changes).
 *  - daily.mode.md: daily mode, for non-developers' everyday tasks (organizing files, handling documents, searching online).
 *  - base.system.md: general principles shared by both modes (tool discipline / failure handling / safety / attachments / communication / execution loop).
 * Each prompt = the corresponding mode body + the shared base body; selected via systemPromptFor(mode).
 * See page.tsx for the actual injection (which also appends the working-directory constraint and the sandbox-environment hint).
 */

/** Combine the mode body and the shared base body into a complete prompt. */
const composePrompt = (modeBody: string) => `${modeBody.trim()}\n\n${baseSystemMd.trim()}`;

export const DEV_SYSTEM_PROMPT = composePrompt(developmentModeMd);

export const DAILY_SYSTEM_PROMPT = composePrompt(dailyModeMd);

/** Kept for backward compatibility: defaults to the development-mode prompt. New code should use systemPromptFor(mode) instead. */
export const SYSTEM_PROMPT = DEV_SYSTEM_PROMPT;

/** Get the system prompt for the current mode: dev → development mode, otherwise (daily) → daily mode. */
export const systemPromptFor = (mode: "daily" | "dev") =>
  mode === "dev" ? DEV_SYSTEM_PROMPT : DAILY_SYSTEM_PROMPT;

/** Append the "working directory" constraint after the system prompt: all file / command tools are restricted to this directory. */
export const workdirPrompt = (dir: string) =>
  `All your tool calls are restricted to the working directory: ${dir}. ` +
  "Use paths relative to this directory (access outside it is rejected); run_command also executes inside it.";

export const selCls =
  "rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10";
