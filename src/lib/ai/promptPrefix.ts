/**
 * The prompt prefix — messages[0] and the tool declarations — as static text.
 *
 * Lifted out of the chat component so seed generation can compute the exact bytes the app sends without running the app. It used
 * to be reachable only through a React component, which is why capturing a prefix had grown a whole CDP dance: launch Electron,
 * open a window, wait for the tool bridge. None of that was ever necessary — nothing here depends on the runtime.
 *
 * It used to be a pure function of the daily/dev mode. The two tags merged into one, so the parameter is gone and there is a
 * single prefix. The bytes are byte-for-byte what the old dev branch produced — the published KV seed
 * (electron/versions.json seedPrefix) is keyed by their hash, and a prefix that differs from the seed's is a seed that never
 * matches, so the collapse deliberately kept the surviving branch rather than tidying its wording.
 *
 * One code path, two callers: send() and scripts/capture-prefix.mjs. A generator holding its own copy of this composition would
 * drift from send(), and the failure mode is a published seed that silently never matches.
 */
import { SYSTEM_PROMPT, WORKDIR_RULES } from "@/app/agent/chat/constants";
import { TASK_STATE_EXPLAINER } from "@/app/agent/chat/taskMemory";
import { GOAL_EXPLAINER } from "@/app/agent/chat/goalState";
import { skillSystemHint, loadSkillTool } from "@/lib/ai/skills/runtime";
import { SANDBOX_TOOLBOX_SKILL } from "@/lib/ai/skills/builtin";
import {
  askUserTool, updateTodosTool, setTaskStateTool, openBrowserTool, browserTool, imageGenerationTool,
  saveMemoryTool, deleteMemoryTool, searchMemoryTool, callToolTool,
  setGoalTool, updatePlanTool,
} from "@/app/agent/chat/agentTools";
import { joinSubagentsTool, spawnSubagentsTool, subAgentTool } from "@/lib/ai/subagents";
import { isMcpToolName, isRouted, ROUTED_TOOLS } from "@/lib/ai/toolRouter";
import { spawnSubAgentTool } from "@/lib/ai/orchestration/orchestrator-tool";

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
export function buildSystemPrompt({ toolsReady = true, memory = true } = {}): string {
  const parts: string[] = [];
  const sysPrompt = SYSTEM_PROMPT;
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
  // Invariant explanation of the goal block, ahead of the task-state one because it outranks it: Task Memory is
  // whatever the model decides is worth remembering, the goal is what it is not allowed to decide. Like every other
  // explainer here it is fixed text; only the goal itself varies, and that arrives as a change event.
  parts.push(GOAL_EXPLAINER);
  // Invariant explanation of the task-state block; the brief itself arrives as a change event.
  parts.push(TASK_STATE_EXPLAINER);
  // Unconditional: gating this on "are any skills enabled" would make messages[0] differ per install. It points at the
  // available-skills reminder rather than asserting skills exist, so it reads correctly when there are none.
  parts.push(skillSystemHint());
  // Long-term memory switched to "retrieve on demand" (RAG, see docs/prompt-cache-optimization.md §4.3): the full memory bodies are no longer
  // poured into the frozen system prefix — that would both bloat the prefix and, when memories are added / modified mid-conversation, only show the old snapshot from the conversation's start
  // (i.e. the user's feedback that "I added a memory but the AI doesn't know it"). Here we only put one stable hint; the model pulls memory bodies on demand with search_memory
  // (reads the current file each time → always latest, results land at the end of the wire → no bloat and no disturbance to the prefix cache).
  // The catalog entries for the memory tools live HERE, not in the mode markdown, because this block is the one part of the
  // prefix that varies with a capability: an install without the memory bridge must not be told about tools it does not have,
  // and the markdown is static. Keeping the three names inside the same `if (memory)` that already gated their prose means the
  // announcement and the capability cannot drift apart.
  if (memory) {
    parts.push(
      "[Long-term memory] You have saved a set of long-term memories for the user (retained across conversations, and possibly added / modified during this conversation). " +
        "When you need to recall the user's identity / preferences / facts / agreements, or the user mentions things like \"do you still remember…\", \"I told you…\", \"I just added a memory\", " +
        "retrieve the current memories (always the latest) and answer based on them; do not speculate out of thin air, and do not assume what you saw at the conversation's start is the latest.\n" +
        // Derived from the routing set, not hardcoded. Telling the model to reach a declared tool through call_tool — or to
        // "call search_memory" when it cannot see it — are the same class of mistake, and deriving the sentence prevents
        // both however the routing set is later edited.
        (ROUTED_TOOLS.has("search_memory")
          ? "These three are not in your tool list — reach them with `call_tool`, passing the name and arguments shown:\n"
          : "The tools:\n") +
        "- `search_memory(query?, limit?)` — read the current memories. Do this before answering from recall.\n" +
        "- `save_memory(title, content, id?)` — write or update a memory (pass `id` to overwrite an existing one).\n" +
        "- `delete_memory(id)` — delete one.",
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
export function buildToolSet(native: unknown[], { memory = true } = {}): unknown[] {
  const nameOf = (t: unknown): string =>
    (t as { function?: { name?: string } })?.function?.name ?? "";
  // MCP tools are removed from `native` here, before composition, not just by the routing filter at the
  // end. They must not count toward `native.length` either: that length gates the delegation block, so
  // leaving them in would make those declarations depend on whether this user happens to have a server
  // connected — the per-install prefix difference this function exists to avoid. Today the toolkit always
  // ships built-ins alongside, so the gate is safe by accident; this makes it safe by construction.
  const nativeCore = native.filter((t) => !isMcpToolName(nameOf(t)));
  const declared = [
    askUserTool(),
    updateTodosTool(),
    setTaskStateTool(),
    // Composed unconditionally; whether each actually reaches the wire is decided by the routing filter at the end.
    // `set_goal` is routed now and `update_plan` is not — the rules their descriptions used to carry live in
    // GOAL_EXPLAINER (always in messages[0]) and in the catalog, so routing one of them deletes no argument. See
    // toolRouter.ts. There is deliberately no third tool for "declare the goal met": that verdict is the
    // evaluator's, and giving the model a way to ask for it would be giving it a way to grant it.
    setGoalTool(),
    updatePlanTool(),
    openBrowserTool(),
    browserTool(),
    // Declared even with no image key configured. Gating it here used to be the earliest per-install difference in the array;
    // the model is told it is unusable through the disabledTools reminder instead, which costs nothing when it never changes.
    imageGenerationTool(),
    ...(memory
      ? [saveMemoryTool(), deleteMemoryTool(), searchMemoryTool()]
      : []),
    // The delegation family is composed only when local tools exist (a sub-agent with no tools has nothing to
    // delegate to). All four are routed now, so none of this reaches the wire — the gate still matters because
    // composition order is prefix bytes for everything that does, and because `nativeCore.length` deciding
    // membership keeps that decision in one place if any of them is ever declared again. Their roster and
    // signatures live in the catalog (development.mode.md); see toolRouter.ts for why.
    ...(nativeCore.length
      ? [...nativeCore, subAgentTool(), spawnSubagentsTool(), joinSubagentsTool(), spawnSubAgentTool()]
      : []),
    loadSkillTool(),
  ];
  // Tool lazy loading: drop the cold declarations and leave them reachable through the catalog + call_tool (see
  // toolRouter.ts). Filtered here, after composition, rather than by editing the list above: membership is decided by rules
  // about the runtime (what the compression layer keys on, what the model under-uses), so it belongs in one reviewable set
  // beside those rules — not scattered across a dozen conditional entries.
  //
  // call_tool goes at the END, at a fixed position, and unconditionally. Position and presence are prefix bytes: a dispatcher
  // that moved with the memory flag, or appeared only under Electron, would be exactly the kind of per-install difference the
  // rest of this function exists to avoid.
  //
  // isRouted, not ROUTED_TOOLS directly: it also carries the `mcp__` prefix rule, so any MCP tool that
  // reached this point despite nativeCore above is still dropped. Belt and braces on purpose — a declared
  // set that varies per install is the one failure here that is invisible locally and expensive in
  // production. MCP tools are reached through `mcp_tools` (inventory + schemas) and then `call_tool`.
  return [...declared.filter((t) => !isRouted(nameOf(t))), callToolTool()];
}
