/**
 * How tool calls get approved, as one setting on the chat composer.
 *
 * The app has always gated the tools that touch the user's files or run commands (SENSITIVE_TOOLS)
 * and let everything else through. That is one policy, and it is the right default — but it is the
 * only one, and two kinds of session want something else: a long refactor where every write pausing
 * for a click is the friction, and a "what would you do here" where the user wants the model to
 * investigate and propose rather than act. So the policy is now a mode:
 *
 *   default — pause on writes, deletes and commands. What the app has always done.
 *   trust   — never pause. The agent acts, including deletes and shell commands.
 *   manual  — pause on EVERY tool call, reads included, except tools you have allowed outright.
 *   plan    — nothing that changes anything runs at all; the agent researches and proposes.
 *
 * `approvalDecision` is the whole policy, as one pure function, so the rules can be read and tested
 * in one place rather than inferred from branches in the tool loop (test/approval-mode.test.mjs).
 *
 * The setting is global and persisted like the model and thinking gears, not per-conversation: it
 * describes how the user wants to work right now, and having it silently differ between two open
 * conversations is how someone ends up trusting a session they meant to supervise.
 */
import { getStorage } from "@zzcpt/zztool";
import { putStorage } from "@/lib/ai/agentStorage";
import { AGENT_APPROVAL_MODE_KEY } from "@/constants/Agent";
import type { CommandClass } from "./commandSafety";

/** In the order they are offered, which is also the order of increasing autonomy after `default`. */
export const APPROVAL_MODES = ["default", "trust", "manual", "plan"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "default";

/** What happens to one tool call. */
export type ApprovalOutcome =
  /** Run it without asking. */
  | "run"
  /** Put it to the user and wait. */
  | "ask"
  /** Refuse it outright — plan mode; the model is told why (PLAN_MODE_REFUSAL). */
  | "refuse";

export const approvalLabelKey = (m: ApprovalMode) => `composer.approval.${m}`;
export const approvalDescKey = (m: ApprovalMode) => `composer.approval.${m}Desc`;

export function loadApprovalMode(): ApprovalMode {
  const stored = String(getStorage(AGENT_APPROVAL_MODE_KEY) ?? "");
  return (APPROVAL_MODES as readonly string[]).includes(stored)
    ? (stored as ApprovalMode)
    : DEFAULT_APPROVAL_MODE;
}

/**
 * Change broadcast, for the same reason thinking has one: the chat page is mounted permanently by
 * AgentShell, so a setting written by anything else would never be re-read by the sender.
 */
export const APPROVAL_MODE_CHANGE_EVENT = "agent:approval-mode-changed";

export function saveApprovalMode(mode: ApprovalMode): void {
  // The default is stored as an absence, so a build that adds a new default does not inherit a
  // stale explicit copy of the old one.
  putStorage(AGENT_APPROVAL_MODE_KEY, mode === DEFAULT_APPROVAL_MODE ? null : mode);
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(APPROVAL_MODE_CHANGE_EVENT));
  } catch {
    /* A window that will not take an event is one nobody is listening on. */
  }
}

/**
 * The policy, in full.
 *
 * `sensitive` is the existing question — does this tool write, delete or run something (see
 * toolNeedsConsent). The rest shape what each mode does with it:
 *
 *  - `command`: for `run_command` only, what kind of command it is (see commandSafety.ts). Shell
 *    commands are ROUTED by this rather than treated as one thing, which is what lets plan mode be
 *    useful: `git log` and `rm -rf /` are not the same request and must not share a rule.
 *  - `alreadyAllowed`: the user answered "don't ask again" for this tool in this conversation. It is
 *    honoured in `manual` too, and deliberately: the alternative is a panel offering an option that
 *    silently does nothing, and a user who picked "ask me about everything" is entitled to carve out
 *    the one tool they got tired of.
 *  - `fromSubagent`: an autonomous delegation is asking, not the agent the user is talking to. Such a
 *    call still asks in `default` and `manual`, because the earlier yes was given about work the user
 *    had requested and was watching; inheriting it would quietly make sub-agents more powerful than
 *    the agent in front of the user.
 *
 * Two rules override everything above, in this order:
 *
 *  1. **A critical command always asks.** A destructive command aimed at a filesystem root, a home
 *     directory or a system directory routes to the panel in every mode — past "don't ask again", and
 *     past full trust. Full trust's own dialog promises the agent will act "in your working
 *     directory"; `rm -rf /` is by definition outside it, so this is the promise being kept rather
 *     than an exception to it.
 *  2. **In plan mode, an allowance is not consent.** `alreadyAllowed` does nothing there: the user
 *     switched to plan mode after granting it, and the later choice is the one that counts.
 */
export function approvalDecision(
  mode: ApprovalMode,
  input: {
    sensitive: boolean;
    alreadyAllowed?: boolean;
    fromSubagent?: boolean;
    /** Set only for run_command; null or absent for every other tool. */
    command?: CommandClass | null;
  },
): ApprovalOutcome {
  // (1) Nothing below can wave through a root deletion.
  if (input.command === "critical") return "ask";

  // A read-only command is not a change, so it is not what any of these modes exist to gate — it runs
  // wherever a read would. `manual` is the exception on purpose: its whole promise is that everything
  // stops, and someone who asked for that has not asked to be surprised by `git log`.
  const readOnlyCommand = input.command === "read-only";

  switch (mode) {
    case "trust":
      return "run";

    case "plan":
      if (!input.sensitive) return "run";
      // Shell commands route to approval rather than being refused: read-only research runs, and
      // anything else is put to the user with its text on screen. Every other sensitive tool — the
      // ones that write, delete or move files — is refused outright, which is what "plan" means.
      if (input.command) return readOnlyCommand ? "run" : "ask";
      return "refuse";

    case "manual":
      if (input.fromSubagent) return "ask";
      return input.alreadyAllowed ? "run" : "ask";

    default:
      if (!input.sensitive) return "run";
      if (readOnlyCommand) return "run";
      if (input.fromSubagent) return "ask";
      return input.alreadyAllowed ? "run" : "ask";
  }
}

/**
 * What the model is told when plan mode blocks a call.
 *
 * Model-facing, so English only (the app's copy is translated; what goes on the wire is not). Worded
 * as the app's decision rather than the user's refusal: the user did not reject this call, the mode
 * did, and a model told "the user rejected this" tends to apologise and ask what to do instead of
 * getting on with the plan it was asked for.
 */
export const PLAN_MODE_REFUSAL =
  "Plan mode is on, so this call was blocked by the app before it ran — no change was made. " +
  "Do not retry it or look for another tool that would do the same thing. " +
  "Everything you need to finish investigating still works: read_file, list_directory, search_files, " +
  "search_in_files, file_info, load_skill, web_search and fetch_url all run normally, read-only shell " +
  "commands (git log, git diff, ls, rg, grep, find) run too, and update_todos is where the plan's steps " +
  "belong so the user can see them. " +
  "Then reply with a concrete plan: the exact files you would change, what each change is, and any " +
  "commands you would run. The user approves it by switching the approval mode in the composer.";

/**
 * Said when the user goes BACK to default from another mode — the retraction half of the change event
 * below, in the same shape `task` and `goal` use ("" means cleared, and the renderer says so).
 */
export const APPROVAL_RESTORED_LINE =
  "- approval mode: back to default — file changes and commands pause for the user's approval again, and nothing is blocked outright.";

/**
 * The standing-state line announcing the mode to the model (see chat/reminders.ts).
 *
 * Also model-facing English. Each one says what the model should DO differently, because "the mode is
 * X" on its own changes nothing about how it behaves.
 *
 * Default returns "" — nothing to announce. messages[0] already states that sensitive operations are
 * gated by a confirmation prompt (base.system.md), so a reminder saying it again would spend tokens
 * restating the cached prefix, on the first turn of every conversation, for users who never touched
 * this setting. Worse, a reminder is written into a user turn: emitting one where there used to be
 * none moves the first differing byte earlier and throws away KV reuse for the whole conversation.
 * Empty means the change event is skipped entirely until there is something to say — and, once
 * something has been said, "" is what retracts it (see diffReminder's isEmptyValue rule).
 */
export function approvalReminderLine(mode: ApprovalMode): string {
  switch (mode) {
    case "trust":
      return "- approval mode: full trust — writes, deletes and commands run without pausing for the user. Nobody is reviewing each step, so re-read before you overwrite, prefer narrow edits over broad ones, and never run a destructive command you have not been asked for.";
    case "manual":
      return "- approval mode: manual — EVERY tool call, reads included, pauses for the user's approval unless they have allowed that tool outright. Say what you are about to do and why before calling, and do not fan out into exploratory calls you do not need.";
    case "plan":
      return "- approval mode: plan — writing, editing and deleting files are BLOCKED by the app. Reading, searching and web lookups run normally, and so do read-only shell commands (git log, git diff, git status, ls, rg, grep, find); any other command stops for the user's approval, so use one only when the plan actually depends on what it would tell you. Investigate, lay the steps out with update_todos, then present a concrete plan (files, changes, commands) and stop. Do not attempt changes.";
    default:
      return "";
  }
}
