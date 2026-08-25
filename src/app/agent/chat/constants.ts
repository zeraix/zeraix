/** Static constants and system prompts for the chat page (extracted from page.tsx). */

// The system prompt body is now maintained in Markdown, imported as a string via the Turbopack raw-loader (see systemPromptFor below).
import baseSystemMd from "./system/base.system.md";
import developmentModeMd from "./system/development.mode.md";

// MAX_TOOL_ROUNDS / MAX_SUBAGENT_ROUNDS / MAX_SAME_TOOL_CALLS / MAX_CONSECUTIVE_TIMEOUTS lived here and are
// gone (M3). Nothing had imported any of them since the run-parameter settings were removed, so they read as
// enforced limits — "MAX_TOOL_ROUNDS = 100" in particular — while the loop was in fact unbounded. A limit
// nothing reads is worse than no limit: docs/agent-runtime-loop.md §20 rule 7 forbids competing Stop
// Policies, and a plausible-looking dead constant is how a second one gets written by mistake. Every real
// limit now lives in lib/agent/stopPolicy.ts. Their storage keys in constants/Agent.ts are left alone: those
// are a persisted config surface (§16), not code.

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

/**
 * The tools that hand work to a sub-agent.
 *
 * A sub-agent runs in its own isolated context and its conversation is never persisted, so the ONLY durable
 * trace of what it did is the one tool result it returns — which compaction is free to summarise away. These
 * names are the choke point where that conclusion is written back into Goal State as evidence, so the goal
 * still knows what was established after the messages that established it are gone.
 */
export const DELEGATION_TOOLS = new Set([
  "run_subagent",
  "spawn_subagents",
  "join_subagents",
  "spawn_sub_agent",
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

/**
 * Loop reminders (model-facing only, never displayed; persisted into the tool result's wireText — see reminders.ts).
 *
 * The tool loop has no round limit, so nothing but the model itself ends a turn that has stopped getting
 * anywhere. These are what the loop guard says on the way to breaking it (see loopGuard.ts): the first two
 * are warnings the model can act on, the third is the announcement that it no longer can.
 *
 * All three name the specific thing that is repeating rather than saying "you are looping", because a model
 * told it is looping generally will apologise and loop; a model told that THIS call returned THIS same output
 * three times has something to act on.
 */
export const repeatedCallNudge = (name: string, times: number): string =>
  `You have now called \`${name}\` with these exact arguments ${times} times in this turn, and it returned exactly the ` +
  "same output every time. That output is already in your context above — calling it again cannot tell you anything new. " +
  "Whatever you are trying to establish, this call is not the way to establish it. Either act on what the result already " +
  "says, or take a genuinely different route: a different tool, a different path, a different query. Do not repeat this call.";

export const repeatedFailureNudge = (name: string, times: number): string =>
  `\`${name}\` has now failed ${times} times in a row in this turn. Retrying it with slightly different arguments is not ` +
  "working. Stop and read the error text above literally: it is telling you that an assumption you are holding is wrong — " +
  "the file is not where you think, its contents are not what you think, or the arguments are not the shape the tool wants. " +
  "Verify that assumption with a different tool (read the file, list the directory) before calling this one again, or solve " +
  "the problem another way.";

/**
 * Written when the guard breaks the loop. Every round after it is sent with NO tools declared, so this is not
 * a request the model can decline by calling something — it is a description of what has already been decided.
 * It says so plainly rather than pretending the model still has the choice, because a model told to "consider
 * wrapping up" reliably calls one more tool.
 */
export const equivalentCallNudge = (name: string, times: number): string =>
  `You have now called \`${name}\` ${times} times in this turn with arguments that differ only cosmetically — a trimmed ` +
  "path, a changed case, a rephrased query. Those are the same call, and they return the same thing. Rewording the " +
  "arguments is not a different approach; it is the same approach spelled differently. Change what you are actually doing: " +
  "a different tool, a different file, or act on what you already know.";

export const repeatedResourceNudge = (name: string, times: number): string =>
  `This turn has now used \`${name}\` on the same target ${times} times. Going back to one file or one query over and over ` +
  "usually means the answer is not there. Either you already have what it can tell you, or what you need is somewhere else — " +
  "widen the search, look at a different file, or state plainly what you could not find and move on.";

export const LOOP_BREAK_NUDGE =
  "STOP. The last three rounds of this turn produced no new information at all — every tool call either repeated an earlier " +
  "call verbatim and returned the identical result, or failed the same way again. The turn is looping, so tool access has " +
  "been withdrawn for the rest of it: there are no tools available to you now and there is nothing further you can run.\n" +
  "Write your final answer to the user, in the user's language, from what you already have. Tell them honestly where the " +
  "task actually stands: what you established, what you were trying to do when you got stuck, what specifically blocked you " +
  "(quote the error or the result you kept getting), and what you would need from them — a correct path, a decision, a " +
  "different approach — to continue. Do not claim the task is finished if it is not, and do not apologise at length; a " +
  "clear account of the blocker is what is useful here.";

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
 * Consent policy: whether a tool call must be confirmed by the user before it runs. Centralized here (rather than inline in
 * the run loop) so future rules have one obvious place to grow:
 *   - per-tool exemptions,
 *   - a user setting to opt out of prompting.
 *
 * Current policy: confirm every sensitive tool, because it operates on the user's real project files.
 *
 * This used to depend on the mode — dev confirmed, daily did not, on the grounds that daily's run_command was sandboxed and
 * its working directory app-managed. Neither half of that survives the merge. The surviving mode's directory is a real
 * project, and the secure-environment switch does NOT make it safe to skip: the sandbox mounts the session's working
 * directory at /workspace, so a delete inside the VM deletes the user's actual file. Sandboxing bounds what a command can
 * reach, not what it can destroy within the folder it was pointed at.
 *
 * A tool not in SENSITIVE_TOOLS never needs consent.
 */
/**
 * Gated even if it were ever exempted from the rule above.
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

export function toolNeedsConsent(name: string): boolean {
  return ALWAYS_CONFIRM_TOOLS.has(name) || SENSITIVE_TOOLS.has(name);
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
 * The system prompt: tells the model it runs locally, which tools are available, plus the working principles and execution loop.
 *
 * TWO maintained bodies, composed at build time (see system/*.md, imported as strings via the Turbopack raw-loader):
 *  - base.system.md: principles that hold for any model and any task — tool discipline, failure handling, safety,
 *    attachments, communication, the execution loop.
 *  - development.mode.md: the variable half — writing code / changing the project (read-change-verify; always run
 *    check_project after changes).
 *
 * The split is KEPT ON PURPOSE, not left over. It used to carry the daily/dev mode selection, and that selection is gone
 * — the two tags merged into one, so `composePrompt` now has exactly one caller and could be collapsed into a single
 * file. It is not, because the seam is the intended place for model-specific prompts: the invariant half stays in
 * base.system.md while the variable half is swapped per model. Inlining it would have to be undone to do that.
 * (daily.mode.md, the third body this once selected between, is deleted — git history has it.)
 *
 * The bytes are unchanged from the old dev branch, deliberately: they are the front of the cached prefix and the
 * published KV seed (electron/versions.json seedPrefix) is keyed by their hash, so a cosmetic edit here retires every
 * seed on disk. Run `npm run seed:capture` after any real change and republish.
 *
 * See page.tsx for the actual injection (which also appends the working-directory constraint and the sandbox-environment hint).
 */

/**
 * Combine the variable body with the shared base body.
 *
 * Takes its body as a parameter despite having one caller: that parameter IS the extension point described above, and a
 * function that reads its input from a module-level import would have to be rewritten rather than simply called again.
 */
const composePrompt = (modeBody: string) => `${modeBody.trim()}\n\n${baseSystemMd.trim()}`;

export const SYSTEM_PROMPT = composePrompt(developmentModeMd);

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
