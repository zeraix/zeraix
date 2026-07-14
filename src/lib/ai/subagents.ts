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
];

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
    description: "General Execution: Can read and write files, run commands, and complete specific multi-step modification tasks (sensitive operations like writing files require user confirmation; irreversible deletions are not allowed).",
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
        "Delegate a self-contained subtask to a dedicated sub-agent for execution, retrieving only its final conclusion." +
        "Prioritize using this over sending multiple search_in_files / read_file requests: when a question requires investigation across multiple files," +
        "delegate it to explore — it will run a round of tool iterations and return a concise answer, keeping the main conversation streamlined and more efficient. Available sub-agents: \n" +
        menu +
        "\nNote: Sub-agents do not see the main conversation history; tasks must be self-contained (including necessary context and expected output).",
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
