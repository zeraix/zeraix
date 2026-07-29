/**
 * Sub-agent definitions.
 *
 * A sub-agent is a small self-contained loop with "a dedicated system prompt + a restricted tool set": the main model can use the `run_subagent` tool
 * to delegate a self-contained subtask to a sub-agent; the sub-agent completes it on its own with local tools and feeds only the "final conclusion"
 * back to the main model. This keeps the main conversation from being drowned in intermediate steps and lets different sub-agents each do their own job.
 *
 * Execution happens in the renderer (see runSubAgent in src/app/app/testtest/page.tsx): the sub-agent reuses the main conversation's
 * LLM config (vendor / model / key) and the same tool set (electron/tools/aiToolkit.mjs),
 * and sensitive operations still go through user confirmation.
 */

/** Read-only tool set: for "explore / plan" style sub-agents, to keep them from accidentally changing files or running commands. */
export const READONLY_TOOLS = [
  "read_file",
  "list_directory",
  "file_info",
  "search_files",
  "search_in_files",
];

/** Review tool set: read-only + compile/test verification (check_project), but still can't modify any file or run arbitrary commands. */
export const REVIEW_TOOLS = [...READONLY_TOOLS, "check_project"];

/**
 * Coding execution tool set: read + write + run commands + compile/test. Listed explicitly (rather than omitted = everything) —
 * deliberately excludes delete_file (irreversible deletion is only done by the main agent while the user is present); sub-agents naturally don't include run_subagent (no nesting).
 */
export const CODER_TOOLS = [
  ...READONLY_TOOLS,
  "write_file",
  "edit_file",
  "append_file",
  "create_directory",
  "copy_file",
  "move_file",
  "run_command",
  "check_project",
  "remember_project",
];

/**
 * Tool discipline shared by every sub-agent, appended to each one's system prompt at run time.
 *
 * The main agent gets this from base.system.md; sub-agents run on `def.systemPrompt` alone and never
 * saw it, so they issued one tool call per round even though runSubAgent batches consecutive read-only
 * calls exactly like the main loop (PARALLEL_SAFE_TOOLS). The capability was there and unused — a
 * sub-agent reading six files took six sequential round trips instead of one.
 */
export const SUBAGENT_TOOL_DISCIPLINE =
  "Tool use: issue independent tool calls TOGETHER in a single response — read-only calls " +
  "(read_file / search_files / search_in_files / list_directory / file_info) in the same batch execute " +
  "concurrently, so batching them is much faster than one per round. If you know you need three files, " +
  "request all three at once rather than waiting for each result. Serialize only when one call genuinely " +
  "depends on another's result. Prefer the narrowest tool, and read the specific line range you need " +
  "(offset/limit) rather than whole files.";

export interface SubAgentDef {
  /** The value for the tool's agent argument. */
  id: string;
  /** Display name. */
  label: string;
  /** The "when to use this sub-agent" description shown to the main model. */
  description: string;
  /** The sub-agent's own system prompt. */
  systemPrompt: string;
  /** The tool names this sub-agent is allowed to use; omitted means "all tools". */
  tools?: string[];
}

export const SUBAGENTS: SubAgentDef[] = [
  {
    id: "explore",
    label: "Explore",
    description:
      "Read-only investigation: Search across files within the workspace to locate files, code, or content, then summarize the findings." +
      "For any question that requires searching or reading more than one or two files to answer, prefer using this tool instead of repeatedly performing search / read operations yourself. It will not modify any files.",
    tools: READONLY_TOOLS,
    systemPrompt:
      "You are a read-only exploration sub-agent. Your goal is to locate the answer in as few steps as possible, not to scan the whole directory.\n" +
      "Strategy:\n" +
      "1) If a ZERAIX.md (project memory / map) exists at the working-directory root, read it first and use it to decide which files to look at, instead of blind searching.\n" +
      "2) Be precise: search_in_files supports regex / ignore_case / pattern (scope by filename, e.g. *.ts) and returns context lines around each hit — read that context first; you usually won't need to open the file. One precise search beats many broad substring searches.\n" +
      "3) Narrow first: use search_files (by filename) / list_directory to find candidates, then search content within that small set; only read_file the specific parts you need — don't dump whole files.\n" +
      "4) Converge: conclude once you have enough evidence. If you've searched six or seven times and are still diverging, you're probably searching too broadly — switch to a more precise regex / filename scope, or just answer; don't keep scanning the whole directory.\n" +
      "You cannot write files or run commands. Finish with a concise conclusion and list the most relevant path:line references as evidence.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Architecture / Implementation Planning: Investigate first, then provide a step-by-step implementation plan with trade-offs. Only plan, do not modify code.",
    tools: READONLY_TOOLS,
    systemPrompt:
      "You are a planning sub-agent. First investigate the relevant code with read-only tools, then output an implementation plan — do not write or change any code. " +
      "Your output must include: the goal, the key files (path + why), ordered steps, trade-offs and risks (with a recommendation), and how to verify.",
  },
  {
    id: "coder",
    label: "Coder",
    description:
      "Execute ONE specific change you have already decided on: reads/writes files and runs commands (writes require user confirmation; it cannot delete files). " +
      "Use it only for work you could fully brief a stranger on in a paragraph — not for a change you are still working out, and not because the task is large or hard. " +
      "If you understand the change well enough to describe it here, make it yourself instead: you will see the actual code, which this returns only a summary of.",
    tools: CODER_TOOLS,
    systemPrompt:
      "You are a general execution sub-agent: you can read/write files and run commands to complete a task (you cannot delete files). Before changing anything, confirm the current state with read-only tools; " +
      "make the smallest change that fits the existing style, then run check_project to compile / run tests. When done, briefly summarize: what you changed, how you verified it, and what remains unverified.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description:
      "Critical Review: Verify the correctness of a change or code, check for defects, regressions, and security vulnerabilities. Can only read and search, but not modify any files.",
    tools: REVIEW_TOOLS,
    systemPrompt:
      "You are a strict review sub-agent. Check the given change or code against the requirements, point by point: correctness, edge cases, error handling, " +
      "security (authentication / injection / secret leakage), and whether it introduces regressions. Inspect the relevant code with read-only tools, and use check_project to compile / run tests when needed. " +
      "Never modify any file. Finish with a verdict (pass / needs changes) and list concrete issues — each with path:line, a description, and a suggested fix; if there genuinely are no issues, say so explicitly.",
  },
];

/** Build the `run_subagent` tool declaration for the main model (OpenAI-compatible format). */
export function subAgentTool() {
  const menu = SUBAGENTS.map((a) => `- ${a.id}：${a.description}`).join("\n");
  return {
    type: "function" as const,
    function: {
      name: "run_subagent",
      description:
        "Delegate ONE self-contained subtask to a dedicated sub-agent and receive only its final conclusion. " +
        "You are the one doing the work: use this only when a subtask is separable enough that a whole extra model loop beats doing it yourself. " +
        "Separability is the criterion — difficulty is not. Delegating a task because it is hard is backwards: the sub-agent returns a summary rather than the code it read or wrote, " +
        "so the harder the problem, the more of it you lose. Available sub-agents: \n" +
        menu +
        "\nCost of delegating: the sub-agent cannot see this conversation, cannot ask the user anything, and cannot be steered once started — " +
        "so the task must be complete and self-contained (all necessary context, plus what the output should be), and a vague task returns a vague summary. " +
        // Each delegation is a fresh context that starts from nothing, so N narrow delegations pay N start-up costs and each one
        // re-discovers the same project basics. Measured: six delegations in one turn re-read ZERAIX.md six times and App.tsx five
        // times, and two of them asked the identical question.
        "Each delegation also starts from an empty context, so it re-discovers the project from scratch: do NOT split one " +
        "investigation into several narrow ones. If you need the same kind of investigation for several targets, ask for all of " +
        "them in ONE delegation. Never delegate the same question twice — if you already have a conclusion, build on it.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            enum: SUBAGENTS.map((a) => a.id),
            description: "The sub-agent role to use.",
          },
          task: {
            type: "string",
            description: "The complete task description for the sub-agent (self-contained, including necessary context and expected output).",
          },
        },
        required: ["agent", "task"],
      },
    },
  };
}

// ── Repeat-delegation guard ───────────────────────────────────────────────────────────────

/**
 * A delegation already completed in the current turn, kept so an identical one can be answered from it.
 *
 * Measured (2026-07-29, turn ms5u17a5): six `explore` delegations, two of which asked the same question —
 * "find all files related to the MarketingBuilder module" — for 140,560 and 106,767 prompt tokens and 96s
 * of wall clock. The second produced the same answer as the first and re-read the same eight files.
 */
export interface PriorDelegation {
  agent: string;
  task: string;
  subject: ReadonlySet<string>;
  conclusion: string;
}

/**
 * Directory names too generic to identify a subject: every task about this project mentions some of them,
 * so counting them would make unrelated delegations look alike.
 */
const GENERIC_PATHS = new Set([
  "src", "src/pages", "src/components", "src/features", "src/modules", "src/utils", "src/hooks",
  "src/lib", "src/auth", "src/api", "src/styles", "src/assets", "src/services", "src/store",
]);

/**
 * The tokens that say what a task is ABOUT: PascalCase identifiers and specific source paths.
 *
 * Deliberately NOT lexical similarity of the whole task. Measured on the six real delegations, plain
 * Jaccard is actively misleading — the duplicate pair scores 0.500 while three pairs asking about
 * *different* modules score 0.895, because the model writes them all from one template and only the
 * module name varies. Any threshold that catches the duplicate fires on the others. Weighting the rare,
 * naming tokens instead separates them completely: 1.00 for the duplicate, 0.00 for every other pair.
 *
 * A task with no such tokens yields an empty set and can never match, which is the safe direction.
 */
export function delegationSubject(task: string): Set<string> {
  const ids = task.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  const paths = (task.match(/src\/[A-Za-z0-9_/.-]+/g) ?? [])
    .map((p) => p.replace(/[/.,'")\]]+$/, ""))
    .filter((p) => !GENERIC_PATHS.has(p));
  return new Set([...ids, ...paths]);
}

/** Overlap threshold. The measured gap is 1.00 (duplicate) against 0.00 (everything else), so anything in between works; this sits in the middle rather than on either edge. */
export const REPEAT_DELEGATION_MIN_OVERLAP = 0.5;

/**
 * The earlier delegation this one repeats, or null.
 *
 * Scoped to the current turn by the caller, matching the existing MAX_SAME_TOOL_CALLS rule — across turns
 * the project has usually changed and re-asking is legitimate.
 */
export function findRepeatDelegation(
  agent: string,
  task: string,
  prior: readonly PriorDelegation[],
): PriorDelegation | null {
  const subject = delegationSubject(task);
  if (subject.size === 0) return null;
  for (const p of prior) {
    if (p.agent !== agent || p.subject.size === 0) continue;
    let shared = 0;
    for (const s of subject) if (p.subject.has(s)) shared++;
    const union = subject.size + p.subject.size - shared;
    if (union > 0 && shared / union >= REPEAT_DELEGATION_MIN_OVERLAP) return p;
  }
  return null;
}

/**
 * What the model gets back instead of a second identical investigation.
 *
 * The prior conclusion, not a refusal: the answer is the same one the delegation would have produced, so
 * returning it costs nothing and keeps the model moving. Saying which task it came from is what lets the
 * model notice the overlap and ask something genuinely different if it meant to.
 */
export function repeatDelegationResult(prior: PriorDelegation): string {
  return (
    `You already delegated this to \`${prior.agent}\` earlier in this turn — the task was: "${prior.task}"\n` +
    `Rather than run the same investigation again, here is what it reported:\n\n${prior.conclusion}\n\n` +
    `If you need something this does not cover, ask for that specifically rather than repeating the request.`
  );
}
