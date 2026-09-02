/**
 * Constants for the Agent (/agent module): the mode tag, event names, and the localStorage "categorized storage" dot paths.
 *
 * Storage strategy: all of this module's localStorage data is consolidated under a top-level `agent` object,
 * read/written by "dot path" via @zzcpt/zztool's getStorage / setStorage / removeStorage,
 * avoiding a scattering of flat keys (such as llm_provider / llm_key_xxx / agent_mode …).
 *
 *   agent: {
 *     skills: InstalledSkill[],
 *     llm: { provider, customEndpoint, customModel, keys: {<id>:key}, models: {<id>:model} },
 *   }
 */

/**
 * Conversation mode — one value, because daily mode was merged into developer mode.
 *
 * The tag survives on stored Project / Conversation records so older files still parse (theirs may say
 * "daily"), but nothing branches on it any more: every session composes the developer prompt and the
 * developer tool set. What used to be the mode's real consequence — whether commands run in the sandbox
 * VM or on the host — is now the per-session secure-environment switch (Conversation.secureEnv), which is
 * chosen per conversation rather than inherited from a sidebar-global toggle.
 */
export type AgentMode = "dev";

/** The only mode. Named so call sites read as a deliberate constant rather than a magic string. */
export const AGENT_MODE: AgentMode = "dev";

/** Custom event name for broadcasting "the selected working directory has been cleared" within the same tab (fired when a new conversation starts). */
export const WORKDIR_CLEAR_EVENT = "agent-workdir-clear";
/** Custom event name for broadcasting "the working directory has been set" within the same tab (clicking a project sets its directory as the working directory; detail is the path). */
export const WORKDIR_SET_EVENT = "agent-workdir-set";

/** Top-level storage key: all of this module's data hangs under it (this value is the e.key of cross-tab storage events). */
export const AGENT_STORAGE_ROOT = "agent";

/** Dot path: the most recently selected project and conversation, restored on the next launch. */
export const AGENT_SELECTION_KEY = "agent.selection";
/** Dot path: list of installed skills (shared by /agent/skills download management and /agent/chat enablement). */
export const AGENT_SKILLS_KEY = "agent.skills";
/** Dot path: the working directory the user explicitly selected (chosen on the /agent home page, then carried over by the /agent/chat page). */
export const AGENT_WORKDIR_KEY = "agent.workdir";
/** Dot path: recently used working directories (most recent first, capped), offered in the WorkdirSelector panel so switching back doesn't need the native folder dialog. */
export const AGENT_WORKDIR_RECENTS_KEY = "agent.workdirRecents";
/** Dot path: project / conversation records (Web fallback only; under Electron these go to a JSON file in userData). */
export const AGENT_STORE_KEY = "agent.store";
/** Dot path: UI language (zh / en). */
export const AGENT_LOCALE_KEY = "agent.locale";
/** Dot path: whether the file panel (FilesPanel) is maximized, preserved across close / reopen / restart. */
export const AGENT_FILES_MAXIMIZED_KEY = "agent.filesMaximized";
/** Dot path: current provider / custom endpoint / custom model. */
export const AGENT_LLM_PROVIDER_KEY = "agent.llm.provider";
export const AGENT_LLM_CUSTOM_ENDPOINT_KEY = "agent.llm.customEndpoint";
export const AGENT_LLM_CUSTOM_MODEL_KEY = "agent.llm.customModel";
/** Dot-path builder: a provider's API key / selected model (categorized by provider id). */
export const agentLlmKeyOf = (id: string) => `agent.llm.keys.${id}`;
export const agentLlmModelOf = (id: string) => `agent.llm.models.${id}`;

/** Dot path: thinking mode — the master on/off switch and the depth used while it is on (see src/lib/ai/thinking.ts). */
export const AGENT_THINKING_ENABLED_KEY = "agent.thinking.enabled";
export const AGENT_THINKING_EFFORT_KEY = "agent.thinking.effort";
/** Dot path: replay past thinking blocks as context on later requests. Off by default — see ThinkingConfig.sendContext. */
export const AGENT_THINKING_SEND_CONTEXT_KEY = "agent.thinking.sendContext";

/** Dot path: runtime parameters (manually adjustable in settings).
 *  - maxToolRounds: the maximum number of consecutive tool-call rounds within a single conversation turn (round cap).
 *  - maxSameToolCalls: when the same "tool + params" is called repeatedly up to this count, it's judged as no progress and aborted (infinite-loop guard).
 *  - maxConsecutiveTimeouts: when consecutive command timeouts reach this count, the current turn is aborted (infinite-loop guard). */
export const AGENT_MAX_TOOL_ROUNDS_KEY = "agent.limits.maxToolRounds";
export const AGENT_MAX_SAME_TOOL_CALLS_KEY = "agent.limits.maxSameToolCalls";
export const AGENT_MAX_CONSECUTIVE_TIMEOUTS_KEY = "agent.limits.maxConsecutiveTimeouts";
/** Dot path: the sub-agent's own tool-call round cap (corresponds to the constants.MAX_SUBAGENT_ROUNDS default). */
export const AGENT_MAX_SUBAGENT_ROUNDS_KEY = "agent.limits.maxSubagentRounds";

/**
 * Dot path: how many automatic rounds one `/goal` activation may run (constants MAX_GOAL_AUTO_ROUNDS default).
 * A safety limit on unattended spending, never a completion condition — see goalState.decideNextRound.
 */
export const AGENT_MAX_GOAL_ROUNDS_KEY = "agent.limits.maxGoalRounds";

/**
 * Dot path: the model id used for goal evaluation (AgentModel.id). Empty → the conversation's own model.
 *
 * Worth configuring on local setups in particular: the evaluator runs after EVERY round and answers a yes/no,
 * so pointing it at a small fast model turns a visible stall into an imperceptible one. It is a separate model
 * binding rather than a flag because the evaluation must be able to run on a different provider entirely.
 */
export const AGENT_GOAL_EVALUATOR_MODEL_KEY = "agent.goal.evaluatorModelId";

/**
 * Paths of /agent sub-pages that require "fullscreen, hide the left main sidebar" (prefix match, including their sub-routes).
 * After AgentShell detects a page registered here, it does not render AgentSidebar, and the page provides its own back entry.
 * To add such a page, just add its path to this array.
 */
export const AGENT_FULLSCREEN_PATHS: string[] = [
  "/agent/settings",
  // The workflow builder is a focused, full-page editor (Simple/Professional) with its own back
  // entry — not a dialog. Both the editor and the "new workflow" template picker run fullscreen.
  // NB: prefix match, so this covers /agent/automation/edit/<id> but not the list at /agent/automation.
  "/agent/automation/edit",
  "/agent/automation/new",
];

/**
 * Fullscreen paths that draw the top band themselves, so AgentShell must not reserve it.
 *
 * The shell's title bar spans the whole window. That is right for a fullscreen page laid out as
 * one column (the workflow editors), but wrong for one with its own left rail: the rail then
 * starts below a full-width strip of content tone instead of reaching the window's top edge.
 * A page listed here takes on what that row provided -- its height, the window drag region, and
 * the clearance macOS's traffic lights need.
 */
export const AGENT_SELF_TITLED_PATHS: string[] = ["/agent/settings"];

/** Whether the page at this path draws its own top band instead of the shell's title bar. */
export function pageDrawsOwnTitleBar(pathname: string): boolean {
  return AGENT_SELF_TITLED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Determine whether a given path should hide the left main sidebar (fullscreen display). */
export function shouldHideAgentSidebar(pathname: string): boolean {
  return AGENT_FULLSCREEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
