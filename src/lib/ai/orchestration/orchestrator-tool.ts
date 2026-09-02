/**
 * The orchestrator's spawn tool: the one place the main agent can reach the sub-agent machinery.
 *
 * The problem it solves: the orchestrator needs to delegate, and delegation means saying what the subtask
 * is and what it will take to do it. Both of those come from a model, so both are attacker-influenceable —
 * and the whole design of this subsystem rests on that being fine, because neither one decides anything.
 * `requestedTools` is a request. The broker answers it from the ceiling and the limits, and the answer is
 * frequently smaller than the ask.
 *
 * That gap is deliberately made visible. The result reports what was requested, what was granted, and what
 * was withheld, so the orchestrator can adapt — narrow the subtask, do the part it can, or tell the user
 * something is out of reach — rather than watching a sub-agent fail for reasons it cannot see. Hiding the
 * gap would not add safety; it would just make the orchestrator worse at working within it.
 *
 * ## What this module is careful not to do
 *
 * Three values that shape a grant are computed here from the host's context and never read from the tool
 * input: `generation`, `requesterId`, and `parentGrantId`. The spec's tool schema has no fields for them,
 * and it should not: a depth counter the model can set is a depth limit the model can opt out of, and an
 * identity the model can choose is an audit trail it can launder. The model gets to say what it wants and
 * why; everything about *who is asking and how deep* is the host's to state.
 */

import type { ToolDeclaration, ToolProvider } from "./capabilities";
import { ConcurrencyLimitError, type CapabilityBroker, type Grant } from "./capability-broker";
import {
  MaxTurnsExceededError,
  ToolUseViolationError,
  runAnonymousSubAgent,
  type ModelClient,
} from "./sub-agent-runner";

/** The declaration handed to the main agent. */
export const SPAWN_SUB_AGENT_TOOL: ToolDeclaration = {
  name: "spawn_sub_agent",
  description:
    "Create a temporary anonymous sub-agent to perform a subtask; must declare the tools it needs. " +
    "The tools you declare are a request, not a decision: the system grants a subset based on policy you " +
    "cannot see or influence, and the result tells you exactly which tools the sub-agent actually received. " +
    "Ask for the narrowest set the subtask genuinely needs — over-asking is silently trimmed, not rewarded.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The complete, self-contained subtask. The sub-agent cannot see this conversation and cannot ask " +
          "questions, so include the necessary context and say what the output should be.",
      },
      requestedTools: {
        type: "array",
        items: { type: "string" },
        description: "Names of the tools the subtask needs.",
      },
    },
    required: ["task", "requestedTools"],
  },
};

/**
 * The same declaration in the OpenAI-compatible shape `buildToolSet` composes.
 *
 * The description works hard on one line — when to use this *instead of* `run_subagent` — because the app
 * already declares three delegation tools with fixed roles, and a fourth with overlapping purpose is exactly
 * how a model ends up picking the wrong one. The rule given is narrow on purpose: the standard roles are the
 * default, and this exists only for the case they cannot express.
 */
export function spawnSubAgentTool() {
  return {
    type: "function" as const,
    function: {
      name: SPAWN_SUB_AGENT_TOOL.name,
      description:
        "Create a temporary anonymous sub-agent with a tool set assembled for this specific subtask. " +
        "PREFER run_subagent: its four roles (explore / plan / coder / reviewer) cover almost everything, " +
        "are better prompted, and need no permission negotiation. Use spawn_sub_agent ONLY when the subtask " +
        "needs a combination of tools that no standard role provides — otherwise pick a role. " +
        "The tools you declare here are a REQUEST, not a decision: policy you cannot see or influence trims " +
        "them, and the result reports exactly which tools the sub-agent actually received. Ask for the " +
        "narrowest set that does the job; over-asking is silently trimmed, never rewarded. " +
        "The sub-agent cannot see this conversation, cannot ask the user anything, and is discarded when it " +
        "finishes, so the task must be complete and self-contained.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The complete, self-contained subtask, including the context it needs and what the output should be.",
          },
          requestedTools: {
            type: "array",
            items: { type: "string" },
            description: "Names of the tools the subtask needs.",
          },
        },
        required: ["task", "requestedTools"],
      },
    },
  };
}

export interface SpawnSubAgentInput {
  task: string;
  requestedTools: string[];
}

export type SpawnStatus =
  /** The sub-agent ran and returned a conclusion. */
  | "completed"
  /** No grant was issued — currently only the concurrency limit does this. */
  | "rejected"
  /** The sub-agent tried to use a tool outside its grant and was terminated. */
  | "violation"
  /** The sub-agent errored or ran out of turns. */
  | "failed"
  /** The tool input was the wrong shape. Nothing was requested or spawned. */
  | "invalid_input";

export interface SpawnSubAgentResult {
  status: SpawnStatus;
  agentId: string | null;
  requestedTools: string[];
  grantedTools: string[];
  /** requested − granted. Stated rather than left to be inferred — see the header. */
  withheldTools: string[];
  output: string | null;
  error: string | null;
  /** True only when trying again later could plausibly succeed. See the note in `formatSpawnResult`. */
  retryable: boolean;
}

export interface OrchestratorContext {
  broker: CapabilityBroker;
  client: ModelClient;
  /** The host's real tools. Passed straight through to the runner; see RunOptions.tools. */
  tools: ToolProvider;
  /** The orchestrator's own id, recorded as `requesterId` on every grant it requests. */
  requesterId: string;
  /** The orchestrator's grant, when it has one; children chain to it in the call tree. */
  parentGrant?: Grant | null;
  maxTurns?: number | null;
  maxTokens?: number;
}

/**
 * Shape check only. Deliberately not a permission check — see the note below.
 *
 * `tools` is accepted as a spelling of `requestedTools`, and a JSON-encoded array as a spelling of an array. Neither loosens
 * anything that matters: the broker still decides what is granted, and a name that is not a real tool is withheld exactly as
 * before. What they avoid is a guaranteed wasted round trip — this tool is routed, so its schema is not on the wire and the
 * catalog signature is all the model has, and `tools` is the shorter name a model reaches for when writing from memory.
 */
function parseInput(input: unknown): SpawnSubAgentInput | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const task = raw.task;
  if (typeof task !== "string" || task.trim() === "") return null;

  let requestedTools = raw.requestedTools ?? raw.tools;
  if (typeof requestedTools === "string" && requestedTools.trim().startsWith("[")) {
    try {
      requestedTools = JSON.parse(requestedTools) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(requestedTools)) return null;
  if (!requestedTools.every((t) => typeof t === "string")) return null;
  return { task, requestedTools: requestedTools as string[] };
}

function withheld(requested: readonly string[], granted: readonly string[]): string[] {
  const have = new Set(granted);
  return [...new Set(requested)].filter((t) => !have.has(t));
}

/**
 * Build the handler for `spawn_sub_agent`.
 *
 * It never throws. Every outcome — including a sub-agent killed for reaching outside its grant — comes back
 * as a `SpawnSubAgentResult`, because all of them are conditions the orchestrator should reason about and
 * none of them are bugs in the orchestrator's own loop. The hard-termination guarantee lives in
 * `sub-agent-runner.ts` and is unaffected: by the time this catches `ToolUseViolationError`, that run is
 * already dead and the attempt is already in the audit log.
 */
export function createSpawnSubAgentHandler(
  ctx: OrchestratorContext,
): (input: unknown) => Promise<SpawnSubAgentResult> {
  const { broker, client, tools, requesterId } = ctx;

  return async function handleSpawnSubAgent(input: unknown): Promise<SpawnSubAgentResult> {
    const parsed = parseInput(input);
    if (!parsed) {
      return {
        status: "invalid_input",
        agentId: null,
        requestedTools: [],
        grantedTools: [],
        withheldTools: [],
        output: null,
        error:
          "spawn_sub_agent requires a non-empty string `task` and an array of tool-name strings " +
          "`requestedTools`. Nothing was spawned.",
        retryable: false,
      };
    }

    const { task, requestedTools } = parsed;
    const parentGrant = ctx.parentGrant ?? null;

    // Computed here, never read from `input` — see the header.
    const generation = (parentGrant?.generation ?? 0) + 1;

    let grant: Grant;
    try {
      grant = await broker.requestGrant({
        requestedTools,
        taskDescription: task,
        requesterId,
        parentGrantId: parentGrant?.grantId ?? null,
        generation,
      });
    } catch (e) {
      const retryable = e instanceof ConcurrencyLimitError;
      return {
        status: "rejected",
        agentId: null,
        requestedTools,
        grantedTools: [],
        withheldTools: [...new Set(requestedTools)],
        output: null,
        error: e instanceof Error ? e.message : String(e),
        retryable,
      };
    }

    const grantedTools = [...grant.tools];
    const base = {
      agentId: grant.agentId,
      requestedTools,
      grantedTools,
      withheldTools: withheld(requestedTools, grantedTools),
    };

    try {
      const output = await runAnonymousSubAgent(grant, task, broker, {
        client,
        tools,
        maxTurns: ctx.maxTurns,
        maxTokens: ctx.maxTokens,
      });
      return { ...base, status: "completed", output, error: null, retryable: false };
    } catch (e) {
      if (e instanceof ToolUseViolationError) {
        return {
          ...base,
          status: "violation",
          output: null,
          error:
            `The sub-agent attempted to use "${e.toolName}", which was not in its grant, and was ` +
            `terminated at that point. Any work it had done is not reported.`,
          retryable: false,
        };
      }
      const detail =
        e instanceof MaxTurnsExceededError
          ? `The sub-agent did not finish within its turn limit (${e.turns}).`
          : `The sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
      return { ...base, status: "failed", output: null, error: detail, retryable: false };
    } finally {
      // Reclaimed the moment the task ends rather than at TTL, on every path including the failures above:
      // a grant nobody is using still occupies a concurrency slot and is still a live capability.
      await broker.revoke(grant.grantId, "completed");
    }
  };
}

/**
 * Render a result as the `tool_result` text the main agent reads.
 *
 * The withheld-tools line is the load-bearing part. Everything else is reporting; that line is what lets the
 * orchestrator plan around a boundary instead of repeatedly walking into it.
 *
 * The violation case deliberately does not suggest retrying. Re-spawning changes nothing about what the
 * ceiling permits — only a human editing the config does — and an orchestrator that reads "terminated" as
 * "try again" turns one refused attempt into a loop of them.
 */
export function formatSpawnResult(r: SpawnSubAgentResult): string {
  const lines: string[] = [];

  switch (r.status) {
    case "completed":
      lines.push(`Sub-agent ${r.agentId} completed.`);
      break;
    case "rejected":
      lines.push(`No sub-agent was created. ${r.error ?? ""}`.trim());
      break;
    case "violation":
      lines.push(`Sub-agent ${r.agentId} was terminated. ${r.error ?? ""}`.trim());
      break;
    case "failed":
      lines.push(`Sub-agent ${r.agentId} did not complete. ${r.error ?? ""}`.trim());
      break;
    case "invalid_input":
      return r.error ?? "spawn_sub_agent received invalid input.";
  }

  if (r.status !== "rejected") {
    lines.push(
      `Tools granted: ${r.grantedTools.length > 0 ? r.grantedTools.join(", ") : "(none)"}`,
    );
  }
  if (r.withheldTools.length > 0) {
    lines.push(
      `Tools requested but NOT granted: ${r.withheldTools.join(", ")}. ` +
        `This is a policy limit, not a transient failure — asking again will produce the same result. ` +
        `Plan around it or tell the user what cannot be done.`,
    );
  }
  if (r.retryable) {
    lines.push("This was a capacity limit; retrying once a running sub-agent finishes may succeed.");
  }
  if (r.status === "violation") {
    lines.push("Do not re-spawn this subtask unchanged — its permissions will be identical.");
  }
  if (r.output) {
    lines.push("", "Result:", r.output);
  }
  return lines.join("\n");
}
