/**
 * The prompt prefix — messages[0] and the tool declarations — as a pure function of mode.
 *
 * Lifted out of the chat component so seed generation can compute the exact bytes the app sends without running the app. It used
 * to be reachable only through a React component, which is why capturing a prefix had grown a whole CDP dance: launch Electron,
 * open a window, wait for the tool bridge. None of that was ever necessary — everything here is static text selected by mode.
 *
 * One code path, two callers: send() and scripts/capture-prefix.mjs. A generator holding its own copy of this composition would
 * drift from send(), and the failure mode is a published seed that silently never matches.
 */
import { systemPromptFor, WORKDIR_RULES } from "@/app/agent/chat/constants";
import { TASK_STATE_EXPLAINER } from "@/app/agent/chat/taskMemory";
import { skillSystemHint, loadSkillTool } from "@/lib/ai/skills/runtime";
import { SANDBOX_TOOLBOX_SKILL } from "@/lib/ai/skills/builtin";
import {
  askUserTool, updateTodosTool, setTaskStateTool, openBrowserTool, browserTool, imageGenerationTool,
  saveMemoryTool, deleteMemoryTool, searchMemoryTool,
} from "@/app/agent/chat/agentTools";
import { subAgentTool } from "@/lib/ai/subagents";

export type PrefixMode = "daily" | "dev";

/** The built-in skill menu as it appears in messages[0]: fixed text, identical on every install. */
export const BUILTIN_SKILL_MENU =
  "[Built-in skills] Always installed and always listed here:\n" +
  `- ${SANDBOX_TOOLBOX_SKILL.id}: ${SANDBOX_TOOLBOX_SKILL.description}`;

/**
 * Compose messages[0].
 *
 * `toolsReady` / `memory` mirror the two environment capabilities the app probes — is the Electron native tool bridge present
 * (window.aiTools), and is the memory bridge. Named `toolsReady`, not `tools`, because it is a one-shot environment probe rather
 * than "the tools have finished loading": nothing arrives late, and the name reading as async readiness has already caused a bug.
 * Both are always true under Electron, the only place a
 * seed is ever used; they are parameters rather than calls so this module stays loadable outside the renderer.
 */
export function buildSystemPrompt(mode: PrefixMode, { toolsReady = true, memory = true } = {}): string {
  const parts: string[] = [];
  // Select the system prompt by the current mode: dev mode leans toward writing code / modifying projects, daily mode leans toward everyday tasks.
  const sysPrompt = systemPromptFor(mode);
  if (toolsReady)
    parts.push(
      [
        // Only the invariant rules live here. The sentence that names the actual path is per-conversation, so it would break
        // the shared prefix (and any resident KV seed) if it sat in messages[0]; it is announced as a change event instead.
        `${sysPrompt}\n${WORKDIR_RULES}`,
        // The command-execution environment used to sit here. It does not belong: it depends on whether the sandbox VM came up,
        // so the SAME machine rendered two different prompts across restarts — and the VM can fall back to native mid-session,
        // which messages[0] cannot represent at all. It is a change event now.
        //
        // The built-in toolbox skill DOES belong here: its description is fixed text, identical on every install. Only whether
        // the sandbox can currently run it varies, and that rides the same environment event.
        BUILTIN_SKILL_MENU,
      ].join("\n"),
    );
  // Invariant explanation of the task-state block; the brief itself arrives as a change event.
  parts.push(TASK_STATE_EXPLAINER);
  // Unconditional: gating this on "are any skills enabled" would make messages[0] differ per install. It points at the
  // available-skills reminder rather than asserting skills exist, so it reads correctly when there are none.
  parts.push(skillSystemHint());
  // Long-term memory switched to "retrieve on demand" (RAG, see docs/prompt-cache-optimization.md §4.3): the full memory bodies are no longer
  // poured into the frozen system prefix — that would both bloat the prefix and, when memories are added / modified mid-conversation, only show the old snapshot from the conversation's start
  // (i.e. the user's feedback that "I added a memory but the AI doesn't know it"). Here we only put one stable hint; the model pulls memory bodies on demand with search_memory
  // (reads the current file each time → always latest, results land at the end of the wire → no bloat and no disturbance to the prefix cache).
  if (memory) {
    parts.push(
      "[Long-term memory] You have saved a set of long-term memories for the user (retained across conversations, and possibly added / modified during this conversation). " +
        "When you need to recall the user's identity / preferences / facts / agreements, or the user mentions things like \"do you still remember…\", \"I told you…\", \"I just added a memory\", " +
        "call search_memory to retrieve the current memories (always the latest) and answer based on them; do not speculate out of thin air, and do not assume what you saw at the conversation's start is the latest. " +
        "Use save_memory to write / update memories (pass id to overwrite an existing one), and delete_memory to delete.",
    );
  }
  return parts.join("\n\n");
}

/**
 * The tool array, in wire order.
 *
 * `native` is the Electron toolkit's schema list. Passed in rather than imported so this module has no main-process dependency:
 * the renderer gets it over IPC, a build script reads electron/tools/toolSchemas.mjs directly.
 */
export function buildToolSet(mode: PrefixMode, native: unknown[], { memory = true } = {}): unknown[] {
  return [
    askUserTool(),
    updateTodosTool(),
    setTaskStateTool(),
    openBrowserTool(mode),
    browserTool(),
    // Declared even with no image key configured. Gating it here used to be the earliest per-install difference in the array;
    // the model is told it is unusable through the disabledTools reminder instead, which costs nothing when it never changes.
    imageGenerationTool(),
    ...(memory
      ? [saveMemoryTool(), deleteMemoryTool(), searchMemoryTool()]
      : []),
    ...(native.length ? [...native, subAgentTool()] : []),
    loadSkillTool(),
  ];
}
