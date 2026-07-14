/**
 * Constants for the Agent (/agent module): modes, event names, and the localStorage "categorized storage" dot paths.
 *
 * Storage strategy: all of this module's localStorage data is consolidated under a top-level `agent` object,
 * read/written by "dot path" via @zzcpt/zztool's getStorage / setStorage / removeStorage,
 * avoiding a scattering of flat keys (such as llm_provider / llm_key_xxx / agent_mode …).
 *
 *   agent: {
 *     mode: "daily" | "dev",
 *     skills: InstalledSkill[],
 *     llm: { provider, customEndpoint, customModel, keys: {<id>:key}, models: {<id>:model} },
 *   }
 */

/** Conversation mode: daily mode / dev mode. */
export type AgentMode = "daily" | "dev";

/** Custom event name for broadcasting a mode change within the same tab (storage events don't fire in the originating tab, so this notifies the chat page). */
export const MODE_CHANGE_EVENT = "agent-mode-change";
/** Custom event name for broadcasting "the selected working directory has been cleared" within the same tab (fired on mode switch / new conversation). */
export const WORKDIR_CLEAR_EVENT = "agent-workdir-clear";
/** Custom event name for broadcasting "the working directory has been set" within the same tab (clicking a project sets its directory as the working directory; detail is the path). */
export const WORKDIR_SET_EVENT = "agent-workdir-set";

/** Top-level storage key: all of this module's data hangs under it (this value is the e.key of cross-tab storage events). */
export const AGENT_STORAGE_ROOT = "agent";

/** Dot path: current conversation mode (daily / dev). */
export const AGENT_MODE_KEY = "agent.mode";
/** Dot path: the most recently selected project and conversation per mode (daily / dev), used to restore the previous selection when switching modes. */
export const AGENT_MODE_SELECTION_KEY = "agent.modeSelection";
/** Dot path: list of installed skills (shared by /agent/skills download management and /agent/chat enablement). */
export const AGENT_SKILLS_KEY = "agent.skills";
/** Dot path: the working directory the user explicitly selected (chosen on the /agent home page, then carried over by the /agent/chat page). */
export const AGENT_WORKDIR_KEY = "agent.workdir";
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
 * Paths of /agent sub-pages that require "fullscreen, hide the left main sidebar" (prefix match, including their sub-routes).
 * After AgentShell detects a page registered here, it does not render AgentSidebar, and the page provides its own back entry.
 * To add such a page, just add its path to this array.
 */
export const AGENT_FULLSCREEN_PATHS: string[] = ["/agent/settings"];

/** Determine whether a given path should hide the left main sidebar (fullscreen display). */
export function shouldHideAgentSidebar(pathname: string): boolean {
  return AGENT_FULLSCREEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
