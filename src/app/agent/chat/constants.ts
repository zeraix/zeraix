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

/** Read-only tools with no side effects and no UI interaction: when the model issues several of them together,
 *  they can run concurrently instead of one await at a time. Only consecutive runs are batched, so a read never
 *  overtakes an edit issued in the same round. */
export const PARALLEL_SAFE_TOOLS = new Set([
  "read_file",
  "search_files",
  "search_in_files",
  "list_directory",
  "file_info",
]);

/** Tools the chat page executes itself instead of handing to the toolkit: they drive UI (a choice card,
 *  the todo list, the browser panel) or renderer-local state (skills, memory files). Every other tool goes
 *  through execToolCall, which is where the usage log records it — so these are logged from the dispatcher
 *  instead. run_subagent is deliberately absent: runSubAgent logs the delegation, with its rounds and tokens. */
export const RENDERER_HANDLED_TOOLS = new Set([
  "ask_user",
  "update_todos",
  "set_task_state",
  "openBrowser",
  "browser",
  "image_generation",
  "load_skill",
  "save_memory",
  "delete_memory",
  "search_memory",
]);

/** Tools exempt from capToolOutput. read_file bounds itself by line range (offset/limit), so its output is already
 *  the slice the model asked for — running it through a head+tail cap would punch a hole in the middle of the very
 *  code the model is reasoning about, and the model cannot tell elided code from absent code. Everything else
 *  (run_command, fetch_url, search_*, browser) is genuinely unbounded and stays capped. */
export const UNCAPPED_TOOLS = new Set(["read_file"]);

/** Resume-after-interrupt nudge (model-facing only, never displayed; persisted into the carrying user turn's wireText — see reminders.ts): written when the user sends again after interrupting the previous turn, to prompt the model to reuse existing analysis and continue. */
export const RESUME_NUDGE =
  "At this point the user interrupted your previous response before it finished. The tool results and analysis above it were " +
  "still valid, so from here you should reuse them and continue rather than starting over — no re-running tool calls, no " +
  "repeating analysis already completed.";

/** Finalize reminder (model-facing only, never displayed; persisted into the last tool result's wireText — see reminders.ts): a tool has run this turn (e.g. a sub-agent returned a result),
 *  yet the model ended with an empty body (no final reply for the user — often because it wrote the conclusion into reasoning or mistook a tool result for the reply).
 *  Injected to prompt it to give a complete final reply directly, in the user's language, based on the information already gathered. Injected at most once per turn to avoid infinite loops. */
export const FINALIZE_NUDGE =
  "You ended your turn with an empty reply, but the user has not received any answer yet. " +
  "You already have everything needed — including any results returned by sub-agents (run_subagent) and " +
  "other tools shown above. Now write the FINAL answer directly to the user, in the user's language, " +
  "as normal message content (NOT inside hidden reasoning, and WITHOUT calling more tools). " +
  "Synthesize and present the complete result rather than replying with a blank body.";

/** Written into the regenerated user turn when the user rated the previous reply "unhelpful" (model-facing only, never displayed; persisted with the turn): prompts it to take a different approach and improve. */
export const FEEDBACK_DOWN_NUDGE =
  "The user rated your previous answer to this request as UNHELPFUL (thumbs down). " +
  "Regenerate a better response: take a different approach, address what was likely missing or wrong, " +
  "and be more accurate, complete, and useful. Do not simply repeat the previous answer.";

/** Written into the regenerated user turn when the user rated the previous reply "helpful" (model-facing only, never displayed; persisted with the turn): prompts it to keep that approach and style. */
export const FEEDBACK_UP_NUDGE =
  "The user rated your previous answer to this request as HELPFUL (thumbs up). " +
  "Regenerate along the same lines: keep the approach, depth, and style that the user liked, " +
  "while making the answer at least as good.";

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

/** Forced-review reminder (model-facing only, never displayed; persisted into the last tool result's wireText — see reminders.ts): written when a risky path was modified but not reviewed and the model tries to wrap up, prompting it to delegate to a reviewer first. */
export const FORCE_REVIEW_NUDGE =
  "The tool call above modified files on a risky path (auth / data / security / payment / secrets), and no review has been run " +
  'for it yet. Before concluding this task, call run_subagent with agent "reviewer" and a self-contained task describing that ' +
  "change, so it can verify correctness, regressions, and security. This applies to the change just made, not to the rest of " +
  "the conversation.";

/**
 * Outstanding-delegation reminder (model-facing only, never displayed; persisted into the last tool result's wireText — see reminders.ts).
 *
 * Written when the model tries to end a turn while delegations it spawned are still running. Those
 * delegations are cancelled the moment the turn ends, so concluding here throws away work that is already
 * paid for — and the model has no way to notice, because a spawn handle looks the same whether or not it
 * was ever collected. Injected at most once per turn: if the model reads this and still concludes, the
 * work genuinely was not needed and it should not be trapped in the turn.
 */
export const PENDING_DELEGATION_NUDGE =
  "You spawned sub-agent delegations that are still running, and you are about to end the turn without collecting them — " +
  "they will be cancelled and their work discarded. If you still need them, call join_subagents now (it blocks until they " +
  "finish, so this costs you one request, not a wait loop) and use the results in your answer. If you have genuinely " +
  "decided you do not need them, say so briefly in your reply and finish.";

/**
 * Record-to-project-memory reminder (model-facing only, never displayed; persisted into the last tool result's wireText — see reminders.ts).
 *
 * Written when a turn modified source files but never called `remember_project`, which was the norm:
 * the tool exists and its description is clear, but nothing in the turn ever brings it to mind, so a
 * session would work out how a module fits together, ship the change, and drop everything it learned —
 * leaving the Module Map full of "(not yet summarised)" while the work that would have filled it in had
 * just been done. Injected at most once per turn, and it offers an explicit way out, so a turn that
 * genuinely learned nothing durable is not pushed into inventing a note.
 */
export const RECORD_MEMORY_NUDGE =
  "The tool call above changed files in this project, and nothing has been recorded into its long-term memory " +
  "(ZERAIX.md) for that work. Before concluding this task: if you worked out something durable that the project map does not " +
  "already state — what a module is responsible for, a convention or constraint the user stated, a " +
  "gotcha that cost you time — call remember_project now (pass `module` plus a one-sentence `note` to " +
  "describe a module, or `note` alone for an invariant). Record only what will still be true next week, " +
  "not what you did in this turn. If you genuinely learned nothing the map does not already have, skip " +
  "the call and just give your final answer.";

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

/**
 * Consent policy: whether a tool call must be confirmed by the user before it runs, for the given mode. Centralized
 * here (rather than inline in the run loop) so future rules have one obvious place to grow:
 *   - per-tool always-confirm entries (e.g. keep delete_file / move_file gated even in daily mode),
 *   - a user setting to opt back into prompting,
 *   - additional modes.
 * Current policy:
 *   - dev mode: confirm every sensitive tool (it operates on the user's real project files on the host).
 *   - daily mode: run sensitive tools directly (run_command is sandboxed; the default workdir is app-managed), so
 *     everyday file/command work stays friction-free.
 * A tool not in SENSITIVE_TOOLS never needs consent in any mode.
 */
/**
 * Gated in every mode, daily included.
 *
 * `mcp_connect` is here because it is the one tool that turns a chat message into a third-party
 * process running as the user: it writes an MCP server into the app's configuration, marks it
 * approved, and starts it. `approved` otherwise means "a human read this exact command line in
 * settings and accepted it", and this panel is what preserves that meaning — the model proposing
 * servers via `ask_user` is a convention it follows, whereas this is enforced by the run loop and
 * still holds if the model was talked into calling the tool by a web page it read. Discovery
 * (`mcp_discover`) is deliberately NOT gated: it only reads, and prompting for searches is how users
 * learn to click through the prompt that matters.
 */
export const ALWAYS_CONFIRM_TOOLS = new Set<string>(["mcp_connect"]);

export function toolNeedsConsent(name: string, mode: "daily" | "dev"): boolean {
  if (ALWAYS_CONFIRM_TOOLS.has(name)) return true;
  if (!SENSITIVE_TOOLS.has(name)) return false;
  return mode === "dev";
}

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
  mcp_discover: "Finding MCP servers",
  mcp_connect: "Connecting MCP server",
  mcp_tools: "Checking connected integrations",
  sandbox_tools: "Checking sandbox toolchain",
  spawn_subagents: "Starting sub-agents",
  join_subagents: "Waiting for sub-agents",
};

/** Builds status text from the tool name + args, e.g. "Editing file style.css…". */
export function toolStatusText(name: string, args: unknown): string {
  const label = TOOL_LABELS[name] ?? name;
  const o = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  // The MCP tools are keyed on the server id ahead of the general chain: `command` would otherwise
  // win and render every one of them as "Connecting MCP server npx…", which names the launcher
  // rather than the server the user actually chose.
  const hint = name.startsWith("mcp_") ? (o.id ?? o.query) : (o.path ?? o.command ?? o.pattern ?? o.query ?? o.url);
  const extra = hint ? ` ${String(hint).slice(0, 40)}` : "";
  return `${label}${extra}…`;
}

/** The three options on the confirmation panel (order is the up/down navigation order):
 *  yes = allow this time / always = don't ask again (auto-approve this tool for the rest of the session) / no = reject. */
export type ConsentDecision = "yes" | "always" | "no";
/**
 * The three answers, in keyboard-navigation order — `consentSel` indexes into this array, so the order is
 * load-bearing and independent of the order they are painted in.
 *
 * Labels are translation keys rather than text: this list is shared between the panel and the queue hook,
 * and only the panel has a `t`.
 */
export const CONSENT_OPTIONS: { key: ConsentDecision; labelKey: string }[] = [
  { key: "yes", labelKey: "chat.consent.allow" },
  { key: "always", labelKey: "chat.consent.always" },
  { key: "no", labelKey: "chat.consent.reject" },
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

/**
 * The "working directory" constraint, split into the one dynamic sentence and the invariant rules.
 *
 * Only the head contains the path, so only the head can differ between installs / conversations. The rules below are identical
 * everywhere and therefore belong in messages[0], where the prefix cache (and a resident KV seed) covers them for free — see
 * docs/cache-stable-prompt-context.md. Every reference in them is to "the working directory" by name rather than "this directory"
 * / "here", because they no longer sit next to the sentence that names the path.
 */
/** `dir` is the path the agent should USE, not necessarily the host path: in the sandbox that is /workspace, which is
 *  also what keeps this sentence identical across conversations (see the call site's note on the prefix cache). */
export const workdirPrompt = (dir: string) => `All your tool calls are restricted to the working directory: ${dir}.`;

/** Scope half of the rules: what "restricted to the working directory" actually means. Also used for sub-agent prompts. */
export const WORKDIR_SCOPE_RULE =
  "Use paths relative to the working directory (access outside it is rejected); run_command also executes inside it.";

/** Upload half of the rules: only the main conversation receives user uploads, so sub-agents do not need this. */
export const WORKDIR_UPLOAD_RULES =
  "Any file or image the user uploads, pastes, or attaches is copied into the working directory before their message reaches you, and their message then carries a note with its exact saved path (e.g. \"[Image: … has been saved to the working directory: …]\"). " +
  "When you see such a note, the upload is a normal on-disk file in the working directory: open, edit, convert, OCR, annotate, or run tools on it directly at that path. Never reply that an uploaded or pasted image/file is unavailable, that you cannot access or edit it, or that it is 'not in the working directory' — it is.";

/** Both halves, for the main conversation's messages[0]. */
export const WORKDIR_RULES = `${WORKDIR_SCOPE_RULE} ${WORKDIR_UPLOAD_RULES}`;

export const selCls =
  "rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-primary/10";
