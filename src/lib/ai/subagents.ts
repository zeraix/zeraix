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

/**
 * The web: search, and read one page.
 *
 * Kept as its own constant rather than folded into READONLY_TOOLS, even though neither one writes anything.
 * They are read-only about the WORKSPACE and outbound about the network, which is a different property and
 * the one `capabilities.ts` classifies them `medium` for — a local grep and an HTTP request are not the same
 * risk, and a constant named READONLY_TOOLS that quietly contained one would make the two indistinguishable
 * at every call site that reads it.
 *
 * Given to every role. A sub-agent is the part of the system most likely to hit a question the workspace
 * cannot answer — a library's actual API, an error string, what a spec says — and until now it had to come
 * back and ask the main agent to look it up, which costs a round trip and loses the context that raised the
 * question. This is also what puts them on the brokered ceiling: see `deriveCeiling` in orchestration/config.ts,
 * which is the union of these lists and is the only route by which an anonymous sub-agent can be granted a tool.
 */
export const WEB_TOOLS = ["web_search", "fetch_url"];

/**
 * What every sub-agent gets, whatever its role: local lookups plus the web.
 *
 * The floor the three specialised sets are built on, so adding a capability to all four roles is one edit
 * rather than four — which is how `web_search` reaching only three of them would otherwise happen.
 */
export const BASE_TOOLS = [...READONLY_TOOLS, ...WEB_TOOLS];

/** Review tool set: the base + compile/test verification (check_project), but still can't modify any file or run arbitrary commands. */
export const REVIEW_TOOLS = [...BASE_TOOLS, "check_project"];

/**
 * Coding execution tool set: read + write + run commands + compile/test. Listed explicitly (rather than omitted = everything) —
 * deliberately excludes delete_file (irreversible deletion is only done by the main agent while the user is present); sub-agents naturally don't include run_subagent (no nesting).
 */
export const CODER_TOOLS = [
  ...BASE_TOOLS,
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
  "(offset/limit) rather than whole files.\n" +
  // Every role now carries WEB_TOOLS, and a tool the prompt never mentions is a tool the model reaches for
  // late or not at all. The ordering rule is the important half: a sub-agent is given a question about THIS
  // project, and searching the web for it wastes a round and returns something about a different codebase.
  "The web is available: web_search finds pages, fetch_url reads one. Check the workspace first — a question " +
  "about this project is nearly always answered inside it — and go online for what the workspace cannot tell " +
  "you: a library's actual API, an unfamiliar error string, a specification, anything that may have changed " +
  "since training. When a conclusion rests on something you read online, give the URL with it.";

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
      "Read-only investigation: Search across files within the workspace to locate files, code, or content — and look things up on the web when the answer is not in the workspace — then summarize the findings." +
      "For any question that requires searching or reading more than one or two files to answer, prefer using this tool instead of repeatedly performing search / read operations yourself. It will not modify any files.",
    tools: BASE_TOOLS,
    systemPrompt:
      "You are a read-only exploration sub-agent. Your goal is to locate the answer in as few steps as possible, not to scan the whole directory.\n" +
      "Strategy:\n" +
      "1) If a ZERAIX.md (project memory / map) exists at the working-directory root, read it first and use it to decide which files to look at, instead of blind searching.\n" +
      "2) Be precise: search_in_files supports regex / ignore_case / pattern (scope by filename, e.g. *.ts) and returns context lines around each hit — read that context first; you usually won't need to open the file. One precise search beats many broad substring searches.\n" +
      "3) Narrow first: use search_files (by filename) / list_directory to find candidates, then search content within that small set; only read_file the specific parts you need — don't dump whole files.\n" +
      "4) Converge: conclude once you have enough evidence. If you've searched six or seven times and are still diverging, you're probably searching too broadly — switch to a more precise regex / filename scope, or just answer; don't keep scanning the whole directory.\n" +
      "You cannot write files or run commands. Finish with a concise conclusion and list the most relevant path:line references (and any URL you relied on) as evidence.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Architecture / Implementation Planning: Investigate first, then provide a step-by-step implementation plan with trade-offs. Only plan, do not modify code.",
    tools: BASE_TOOLS,
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

// ── Parallel delegation: spawn / join ─────────────────────────────────────────────────────

/**
 * Delegations allowed to run at once. Each one is a full independent model loop against the same
 * provider, so this is a spend and rate-limit control rather than a CPU one: three concurrent sub-agents
 * are three concurrent streams of billed tokens.
 */
export const MAX_PARALLEL_SUBAGENTS = 3;

/** Hard cap on delegations per turn — a backstop against a model that keeps fanning out instead of concluding. */
export const MAX_SUBAGENTS_PER_TURN = 12;

/** How long a single `join_subagents` may suspend before returning what it has. Long enough for a real
 *  delegation (they routinely run minutes), short enough that one wedged sub-agent cannot eat the turn. */
export const JOIN_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const JOIN_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** What the scheduler carries per job: enough to render it, report it, and match a duplicate against it.
 *  Identical to the shape the completed-delegation guard matches on, deliberately — an in-flight twin and
 *  a finished twin are the same question asked twice, and must be recognised the same way. */
export type DelegationMeta = DelegationRef;

/**
 * Build the `spawn_subagents` declaration: start delegations and get their handles back immediately.
 *
 * The description works hard on one point, because it is the failure mode this whole mechanism exists to
 * prevent: the model must not treat a handle as something to check on. A model that has been handed an id
 * and no instructions will reach for the nearest status-shaped tool every round, turning a wait into a
 * poll loop that bills a full prompt per check. `join_subagents` blocks, so waiting is free — but only if
 * the model believes that, which is why it is stated here rather than left to be inferred.
 */
export function spawnSubagentsTool() {
  const menu = SUBAGENTS.map((a) => `- ${a.id}：${a.description}`).join("\n");
  return {
    type: "function" as const,
    function: {
      name: "spawn_subagents",
      description:
        "Start one or more sub-agent delegations that run CONCURRENTLY in the background, and return their ids straight away " +
        `(up to ${MAX_PARALLEL_SUBAGENTS} run at a time; the rest queue automatically). Use this instead of run_subagent when you have ` +
        "several independent subtasks, or when you want to keep working while a delegation runs. Available sub-agents: \n" +
        menu +
        "\nWhat to do next: KEEP WORKING. The delegations run while you do, and anything that finishes is appended to your " +
        "next tool result automatically — you do not have to ask for it, and nothing can be lost by not asking. This gap is " +
        "the entire benefit of spawning: go do the reads, edits and commands you were going to do anyway, and the results " +
        "will meet you there. " +
        "Only when you have genuinely run out of work that does not depend on these delegations should you call " +
        "join_subagents, which then SUSPENDS until they finish. Blocking is the last step, not the next one — while you are " +
        "suspended in it you cannot do anything else, so joining immediately after spawning throws away the concurrency you " +
        "just asked for. (If you want the finished ones without waiting, join_subagents with block=false returns instantly.) " +
        "IMPORTANT: never poll. There is no status tool and you must not invent one; repeating a call to 'check progress' " +
        "wastes a full request and tells you nothing that waiting once, or simply continuing, would not. " +
        "Each delegation starts from an empty context and cannot see this conversation, ask the user anything, or be steered " +
        "once started, so every task must be self-contained: all necessary context plus what the output should be. " +
        "Do not split one investigation into several narrow ones — a delegation that re-discovers the project from scratch " +
        "costs more than it saves. Spawn separate delegations only for genuinely independent subtasks.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            description:
              "The delegations to start, all at once. Independent subtasks only — if two entries would " +
              "investigate the same thing, make them one entry.",
            items: {
              type: "object",
              properties: {
                agent: {
                  type: "string",
                  enum: SUBAGENTS.map((a) => a.id),
                  description: "The sub-agent role to use.",
                },
                task: {
                  type: "string",
                  description:
                    "The complete, self-contained task description (necessary context included, and what the output should be).",
                },
              },
              required: ["agent", "task"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  };
}

/** One delegation `spawn_subagents` will start: the two fields the tool declares, after normalisation. */
export interface SpawnTaskEntry {
  agent: string;
  task: string;
}

/**
 * Why the arguments are normalised at all rather than checked against the declared shape.
 *
 * The tool used to test `Array.isArray(rawArgs.tasks)` and reject everything else with one line about the declared shape. That
 * rejection was the single most common delegation failure in practice, and almost never because the model misunderstood the
 * schema — it is a nested array of objects, which is the shape models get wrong in a handful of predictable, mechanical ways:
 * the array arrives JSON-encoded as a string (a whole class of provider does this to any non-scalar), a lone delegation arrives
 * as the object itself rather than a one-element array, or the entry keys come back as the synonyms the description uses in
 * prose (`prompt`, `role`) rather than the two it declares. Each one costs a full round trip to correct, and a model that fails
 * twice abandons the concurrent path for serial `run_subagent` calls, which is the worst outcome available: correct, and several
 * times slower than what it asked for.
 *
 * So the near-misses are read rather than refused. What is NOT accepted is an entry with no identifiable task text — that one is
 * genuinely ambiguous, and guessing at it would spend minutes of sub-agent time on a task nobody wrote.
 */

/** Keys a model plausibly uses for the two declared fields. Order matters: the declared name is checked first. */
const AGENT_KEYS = ["agent", "agent_id", "agentId", "role", "subagent", "sub_agent", "type", "name"];
const TASK_KEYS = [
  "task",
  "prompt",
  "description",
  "instructions",
  "instruction",
  "content",
  "goal",
  "query",
  "message",
];

/** Keys the batch itself arrives under. `tasks` is declared; the rest are what the prose in the description suggests. */
const BATCH_KEYS = ["tasks", "subagents", "sub_agents", "delegations", "agents", "jobs", "items"];

/**
 * Which of the entry's fields names the sub-agent.
 *
 * A real id wins over position in the alias list, because the loosest aliases are also the ambiguous ones: `name` is as often a
 * label for the delegation ("review architecture") as it is the role. Matching against the roster first means such an entry runs
 * on the role it did name elsewhere, and an entry that named no real role still reports the string the model wrote — which is
 * what the refusal has to quote back for the correction to make sense.
 */
const readAgent = (entry: Record<string, unknown>): string => {
  const candidates = AGENT_KEYS.map((key) => entry[key]).filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const known = candidates.find((v) => SUBAGENTS.some((a) => a.id === v.trim()));
  return (known ?? candidates[0] ?? "").trim();
};

const firstString = (entry: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

/** A JSON-encoded array or object, which is how several providers serialise any non-scalar argument. */
const decodeIfJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
};

const isEntryLike = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  firstString(value as Record<string, unknown>, TASK_KEYS) !== "";

/** Describes what arrived, so a rejected call tells the model about ITS payload rather than repeating the schema at it. */
function describeReceived(rawArgs: Record<string, unknown>): string {
  const keys = Object.keys(rawArgs);
  if (keys.length === 0) return "the call arrived with no arguments at all";
  const shape = (v: unknown): string =>
    Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
  return `received ${keys.map((k) => `${k}=${shape(rawArgs[k])}`).join(", ")}`;
}

/**
 * Read `spawn_subagents` arguments into runnable entries.
 *
 * Returns the entries it could make sense of, or an error naming what actually arrived. Never throws and never partially
 * rejects: an entry it cannot read is reported by the caller per-entry, which is where the sub-agent roster lives.
 */
export function normalizeSpawnTasks(
  rawArgs: Record<string, unknown>,
): { entries: SpawnTaskEntry[] } | { error: string } {
  let batch: unknown;
  for (const key of BATCH_KEYS) {
    if (rawArgs[key] !== undefined) {
      batch = decodeIfJson(rawArgs[key]);
      break;
    }
  }
  // A single delegation sent as the arguments themselves — {agent, task} with no wrapper — is unambiguous, so it runs.
  if (batch === undefined && isEntryLike(rawArgs)) batch = [rawArgs];

  let list: unknown[];
  if (Array.isArray(batch)) list = batch;
  else if (isEntryLike(batch)) list = [batch];
  // {"0": {...}, "1": {...}} — an array that lost its brackets somewhere in serialisation.
  else if (batch && typeof batch === "object" && Object.values(batch).every(isEntryLike))
    list = Object.values(batch);
  else list = [];

  const entries: SpawnTaskEntry[] = [];
  for (const raw of list) {
    const decoded = decodeIfJson(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
    const entry = decoded as Record<string, unknown>;
    const task = firstString(entry, TASK_KEYS);
    if (!task) continue;
    entries.push({ agent: readAgent(entry), task });
  }

  if (entries.length === 0) {
    return {
      error:
        `spawn_subagents needs tasks: a non-empty array of {agent, task} objects, e.g. ` +
        `{"tasks":[{"agent":"reviewer","task":"…the full self-contained brief…"}]}. ` +
        `Nothing runnable was found in this call — ${describeReceived(rawArgs)}. ` +
        `Pass the array itself, not a JSON string of it, and give every entry both fields. ` +
        `If you only have one delegation, call run_subagent instead.`,
    };
  }
  return { entries };
}

/** What `join_subagents` was asked for, after the same tolerant reading `spawn_subagents` gets. */
export interface JoinRequest {
  /** The ids to wait for, or null for "everything still outstanding". */
  ids: string[] | null;
  mode: "all" | "any";
  block: boolean;
  timeoutMs: number;
}

/** A number a provider may have delivered as a string — they differ on whether a numeric argument survives as one. */
const numeric = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * The delegation ids to join: an array, a JSON-encoded array, or a single id.
 *
 * Misreading this one does not fail loudly, which is why it is worth reading properly: an unrecognised `ids` becomes "join
 * everything", and under the default `block: true` that is the difference between waiting for the two delegations the model
 * named and waiting for every one it started.
 */
function readIds(raw: unknown): string[] | null {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith("[")) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        /* Not an encoded array: read it as the single id it looks like. */
      }
    }
  }
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!list) return null;
  const ids = list.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Read `join_subagents` arguments.
 *
 * `timeout_ms` is accepted alongside the declared `timeout_seconds` because both have been documented: the declaration says
 * seconds and the routed catalog said milliseconds, and a routed tool's schema is never on the wire — so the catalog was the
 * only signature the model could read, and the bound it asked for was silently dropped for the 10-minute default. The catalog
 * is corrected; the alias stays, since the unit is unambiguous from the name and refusing it would only cost a round trip.
 */
export function readJoinArgs(rawArgs: Record<string, unknown>): JoinRequest {
  const secs = numeric(rawArgs.timeout_seconds);
  const millis = numeric(rawArgs.timeout_ms);
  const requestedMs = secs != null && secs > 0 ? secs * 1000 : millis != null && millis > 0 ? millis : null;
  return {
    ids: readIds(rawArgs.ids),
    mode: rawArgs.mode === "any" ? "any" : "all",
    // Non-blocking collect: the model still has work in hand and wants what has already finished. Anything other than an
    // explicit `false` blocks, which is the documented default.
    block: rawArgs.block !== false && String(rawArgs.block ?? "").toLowerCase() !== "false",
    timeoutMs: requestedMs != null ? Math.min(requestedMs, JOIN_MAX_TIMEOUT_MS) : JOIN_DEFAULT_TIMEOUT_MS,
  };
}

/** Build the `join_subagents` declaration: the blocking collect. */
export function joinSubagentsTool() {
  return {
    type: "function" as const,
    function: {
      name: "join_subagents",
      description:
        "Collect delegations started by spawn_subagents. By default this SUSPENDS until the work is actually finished, so " +
        "use it only once you have nothing left to do that does not depend on the results — while suspended you cannot run " +
        "any other tool, so a join issued while you still had work to do wastes the concurrency you spawned for. " +
        "With block=false it returns instantly with whatever has finished so far, which is what to use when you do still " +
        "have work: take what is ready and carry on. Either way it is not a status check and must not be repeated to watch " +
        "progress — unfinished delegations are appended to your next tool result on their own. Each conclusion is returned " +
        "exactly once; results already delivered to you automatically are not repeated.",
      parameters: {
        type: "object",
        properties: {
          block: {
            type: "boolean",
            description:
              "true (default) = suspend until the delegations finish; use when you have nothing else to do. " +
              "false = return immediately with whatever has already finished; use when you still have work in hand.",
          },
          ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Delegation ids to wait for (as returned by spawn_subagents). Omit to wait for every delegation still outstanding.",
          },
          mode: {
            type: "string",
            enum: ["all", "any"],
            description:
              "all (default) = return when every named delegation has finished. any = return as soon as the first one " +
              "finishes, so you can start on the earliest result; the rest stay joinable.",
          },
          timeout_seconds: {
            type: "number",
            description:
              "Optional bound on the wait. On expiry you get whatever finished plus the ids still running, which remain " +
              "joinable. Leave unset unless you have a reason — the default already allows for a long delegation.",
          },
        },
        required: [],
      },
    },
  };
}

// ── Model-facing result formatting ────────────────────────────────────────────────────────

/** One delegation's conclusion, as the model sees it. */
function renderOutcome(id: string, meta: DelegationMeta, state: string, result: string): string {
  const head = state === "done" ? `${id} (${meta.agent}) finished` : `${id} (${meta.agent}) ${state}`;
  return `── ${head} ──\ntask: ${meta.task}\n\n${result}`;
}

/** The tool result for a spawn: the handles, plus what to do next (which is: keep working, then join once). */
export function formatSpawnResult(
  spawned: Array<{ id: string; agent: string; coalesced: boolean; refused?: string }>,
): string {
  const lines: string[] = [];
  const ok: string[] = [];
  for (const s of spawned) {
    if (s.refused) {
      lines.push(`✗ ${s.agent}: ${s.refused}`);
      continue;
    }
    ok.push(s.id);
    lines.push(
      s.coalesced
        ? `• ${s.id} (${s.agent}) — identical to a delegation already running, attached to that one instead of starting a second copy`
        : `• ${s.id} (${s.agent}) started`,
    );
  }
  if (ok.length === 0) return `No delegations started.\n${lines.join("\n")}`;
  return (
    `${ok.length} delegation(s) now running in the background:\n${lines.join("\n")}\n\n` +
    `Now go on with your own work — they run while you do, and each conclusion is appended to one of your tool results as ` +
    `soon as it lands, without you asking. Do NOT call join_subagents next if you still have anything to do: it suspends ` +
    `you until they finish, which would give back exactly the time you just spawned them to save.\n` +
    `When you have run out of independent work, call join_subagents (ids: ${JSON.stringify(ok)}) once and let it block. ` +
    `If you only want whatever has finished so far, add block=false and it returns immediately. Never call it repeatedly to check progress.`
  );
}

/** The tool result for a join. */
export function formatJoinResult(
  ready: Array<{ meta: DelegationMeta; id: string; state: string; result: string }>,
  pending: string[],
  unknown: string[],
  timedOut: boolean,
  blocked = true,
): string {
  const parts: string[] = [];
  if (ready.length > 0) {
    parts.push(ready.map((r) => renderOutcome(r.id, r.meta, r.state, r.result)).join("\n\n"));
  }
  if (unknown.length > 0) {
    parts.push(
      `No delegation exists with id(s): ${unknown.join(", ")}. Only ids returned by spawn_subagents are valid.`,
    );
  }
  if (pending.length > 0) {
    // The non-blocking reply deliberately does not end on "call join again". A model that has just been
    // handed an empty collect and a way to retry it will retry it, which is the poll loop rebuilt by hand
    // — so the instruction is to carry on, and the promise made is that the result will find it.
    parts.push(
      !blocked
        ? `Still running: ${pending.join(", ")}. Carry on with your own work — these will be appended to a later tool result on their own. Do not call join_subagents again to check; only block on them once you have nothing else left to do.`
        : timedOut
          ? `Still running after the timeout: ${pending.join(", ")}. They are unaffected and remain joinable — call join_subagents again for them when you want to wait further.`
          : `Still running: ${pending.join(", ")}. Call join_subagents for them when you need their results; it will block until they finish.`,
    );
  }
  if (parts.length === 0) {
    return blocked
      ? "No delegations were outstanding — nothing to wait for."
      : "Nothing has finished yet. Carry on with your own work; results are appended to a later tool result as they land.";
  }
  return parts.join("\n\n");
}

/**
 * The auto-delivery block appended to an unrelated tool result.
 *
 * Fenced and labelled because it is arriving somewhere the model did not ask for it: without a clear
 * boundary a conclusion pasted under, say, an edit_file result reads as part of that result.
 */
export function formatAutoDelivery(
  delivered: Array<{ meta: DelegationMeta; id: string; state: string; result: string }>,
): string {
  if (delivered.length === 0) return "";
  const body = delivered.map((d) => renderOutcome(d.id, d.meta, d.state, d.result)).join("\n\n");
  return (
    `\n\n[Delegations that finished while you were working — delivered automatically, no need to join them]\n${body}\n` +
    `[end of delegation results]`
  );
}

// ── Repeat-delegation guard ───────────────────────────────────────────────────────────────

/**
 * The identity of a delegation: who was asked, what for, and the tokens that say what it is about.
 * Both the completed-delegation guard and the in-flight duplicate check in the scheduler match on this.
 */
export interface DelegationRef {
  agent: string;
  task: string;
  subject: ReadonlySet<string>;
}

/**
 * A delegation already completed in the current turn, kept so an identical one can be answered from it.
 *
 * Measured (2026-07-29, turn ms5u17a5): six `explore` delegations, two of which asked the same question —
 * "find all files related to the MarketingBuilder module" — for 140,560 and 106,767 prompt tokens and 96s
 * of wall clock. The second produced the same answer as the first and re-read the same eight files.
 */
export interface PriorDelegation extends DelegationRef {
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

/** Whether two delegations are the same question: same role, and subject tokens overlapping past the threshold. */
export function isSameDelegation(a: DelegationRef, b: DelegationRef): boolean {
  if (a.agent !== b.agent || a.subject.size === 0 || b.subject.size === 0) return false;
  let shared = 0;
  for (const s of a.subject) if (b.subject.has(s)) shared++;
  const union = a.subject.size + b.subject.size - shared;
  return union > 0 && shared / union >= REPEAT_DELEGATION_MIN_OVERLAP;
}

/**
 * The earlier delegation this one repeats, or null.
 *
 * Scoped to the current turn by the caller, matching the existing MAX_SAME_TOOL_CALLS rule — across turns
 * the project has usually changed and re-asking is legitimate.
 *
 * Generic over the entry type so the same rule serves both users: the completed-delegation guard passes
 * `PriorDelegation` (and wants its `conclusion` back), while the scheduler's duplicate check passes bare
 * in-flight job metadata that has no conclusion yet.
 */
export function findRepeatDelegation<T extends DelegationRef>(
  agent: string,
  task: string,
  prior: readonly T[],
): T | null {
  const self: DelegationRef = { agent, task, subject: delegationSubject(task) };
  if (self.subject.size === 0) return null;
  for (const p of prior) if (isSameDelegation(self, p)) return p;
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
