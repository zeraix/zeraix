/**
 * Tool lazy loading: which tools are declared on the wire, and how a dispatched call is resolved back to a real one.
 *
 * Every model call re-sends the whole tool block, and it is the single largest fixed item in the prefix — 5,486 tokens across 32
 * declarations, of which 3,239 belonged to tools that were never called once in a 319-call production sample. Cold tools are
 * therefore declared as one line of prose in the system prompt's tool catalog instead of a JSON schema, and reached through a
 * single `call_tool` dispatcher. See docs/tool-lazy-loading-design.md.
 *
 * Two properties this module exists to guarantee:
 *
 *  - **The declared set never changes within a conversation.** Tools sit ahead of `messages` in the cached prefix, so adding a
 *    declaration mid-conversation would re-prefill from token 0 and invalidate the resident KV seed — spending tens of thousands
 *    of tokens to save two thousand. Routing changes EXECUTION, never DECLARATION: the sets below are constant per mode, and
 *    `call_tool` is always present. See docs/cache-stable-prompt-context.md.
 *  - **Nothing downstream of dispatch ever sees `call_tool`.** Consent, the usage log, batching, stale-read dedup and provenance
 *    all key on the tool NAME; a wrapped call would slip past every one of them. `resolveToolCall` is applied once, before any of
 *    that, and the rest of the pipeline goes on reading real names.
 */

/** The dispatcher's tool name. One place, because the declaration, the resolver and the catalog text all have to agree. */
export const DISPATCHER_NAME = "call_tool";

/**
 * Tools reached through the dispatcher rather than declared, by mode.
 *
 * The two lists are currently IDENTICAL, and are still written out separately on purpose. Routing changes how a tool is CALLED,
 * not whether it is available or how the prompt talks about it, so the modes' genuine disagreement about what is central —
 * `daily.mode.md` builds its whole web-research workflow on `openBrowser` / `browser`, `development.mode.md` declares them
 * off-limits — turned out not to affect which tools can be routed. But each mode's set travels with its own markdown catalog, and
 * pointing both names at one Set would mean an edit made for one mode silently changing the other. Duplication is the cheaper
 * mistake here: adding a tool in two places is a chore, changing a mode you did not mean to touch is a bug.
 *
 * What is left DECLARED, and why — the rule that survived several rounds of widening this set:
 *  1. NOT "anything contextCompress.ts keys on". That was the original rule and it dissolved: `indexCalls` and `describeCall`
 *     resolve the wrapper on the read side, and `releaseCallArguments` rewrites the elided payload back INSIDE the envelope on the
 *     write side, so even `read_file` and `edit_file` — 76% of all tool calls — are routed with the compression layer intact.
 *  2. A tool stays declared when its own DESCRIPTION is what prompts its use. `set_task_state`, `load_skill` and `web_search`
 *     argue for themselves in their descriptions, so routing them would delete the argument along with the schema; `run_subagent`
 *     carries the explore/plan/coder/reviewer roster the model needs in order to pick one. The memory family looks like this class
 *     but is not — the [Long-term memory] block and How-to-work #8 do that work and both survive — so it is routed.
 *  3. `run_command`, `ask_user` and `update_todos` stay declared as the unbounded / interactive core.
 */
export const ROUTED_TOOLS: Record<"daily" | "dev", ReadonlySet<string>> = {
  dev: new Set([
    "browser",
    "openBrowser",
    "image_generation",
    "open_path",
    "stop_service",
    "refine_question",
    "file_info",
    "copy_file",
    "move_file",
    "delete_file",
    "create_directory",
    "save_memory",
    "delete_memory",
    "search_memory",
    "remember_project",
    "read_file",
    "edit_file",
    "write_file",
    "append_file",
    "list_directory",
    "search_files",
    "search_in_files",
    "check_project",
    "init_command",
    "mcp_discover",
    "mcp_connect",
  ]),
  daily: new Set([
    "browser",
    "openBrowser",
    "image_generation",
    "open_path",
    "stop_service",
    "refine_question",
    "file_info",
    "copy_file",
    "move_file",
    "delete_file",
    "create_directory",
    "save_memory",
    "delete_memory",
    "search_memory",
    "remember_project",
    "read_file",
    "edit_file",
    "write_file",
    "append_file",
    "list_directory",
    "search_files",
    "search_in_files",
    "check_project",
    "init_command",
    "mcp_discover",
    "mcp_connect",
  ]),
};

export const isRouted = (mode: "daily" | "dev", name: string): boolean => ROUTED_TOOLS[mode].has(name);

/**
 * Resolve what the model emitted into the call to actually run.
 *
 * A `call_tool` wrapper unwraps to its inner name and arguments; everything else passes through untouched. Deliberately
 * total — it never throws and never reports failure — because the alternative is a dispatch path with two error channels.
 * A malformed wrapper resolves to itself and falls through to the toolkit, which already answers unknown names with a clean
 * `{ ok: false, content: "Unknown tool: …" }`.
 *
 * A DECLARED tool's name arriving through `call_tool` resolves normally rather than erroring. Models do this — the catalog lists
 * every tool, so a model that reads the catalog and ignores which entries also have schemas is behaving reasonably, and there is
 * nothing to gain by refusing it.
 */
export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  if (name !== DISPATCHER_NAME) return { name, args };
  const inner = typeof args.name === "string" ? args.name.trim() : "";
  if (!inner) return { name, args };
  const raw = args.arguments;
  // Tolerated because models emit both: the declared shape is an object, but a JSON string is a common near-miss and
  // rejecting it would cost a whole round trip to correct something we can simply read.
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { name: inner, args: parsed as Record<string, unknown> };
      }
    } catch {
      /* Not JSON: fall through to the empty-argument case, where the tool reports what it actually needs. */
    }
    return { name: inner, args: {} };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { name: inner, args: raw as Record<string, unknown> };
  }
  return { name: inner, args: {} };
}

/** Levenshtein distance, bounded use: called once on a failed dispatch against ~32 candidates. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The result for a dispatch to a name no tool answers to.
 *
 * Returns the nearest real name rather than a bare rejection: the failure is nearly always a near-miss on a name the model read
 * once in the catalog, and a correction it can act on costs one round trip where "unknown tool" costs a guess and then another.
 */
export function unknownToolResult(name: string, known: readonly string[]): string {
  const near = known
    .map((k) => ({ k, d: distance(name.toLowerCase(), k.toLowerCase()) }))
    .filter(({ k, d }) => d <= Math.max(2, Math.floor(k.length / 3)))
    .sort((x, y) => x.d - y.d)[0]?.k;
  return near
    ? `No tool named "${name}". Did you mean "${near}"? Use the exact name from the tool catalog in the system prompt.`
    : `No tool named "${name}". Use one of the exact names listed in the tool catalog in the system prompt.`;
}

/**
 * Appended to a FAILED routed call's result: the schema the model never saw.
 *
 * Only routed tools get this, and only on failure. A declared tool's schema is already in every request, so repeating it would be
 * pure duplication; a routed tool was called from a one-line signature, so a rejected call is the one moment the full parameter
 * list is worth its tokens. Bounds the cost of hiding a schema at one extra round trip per tool per conversation, paid only when
 * the model actually gets the arguments wrong.
 */
export function routedFailureHint(name: string, parameters: unknown): string {
  return (
    `\n\n[${name} is called through ${DISPATCHER_NAME}, so its full parameter schema is not in your tool list. ` +
    `It is: ${JSON.stringify(parameters)}. Correct the arguments and call it again.]`
  );
}
