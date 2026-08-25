/**
 * Test Model Adapter — a model that talks to nothing.
 *
 * Spec: docs/agent-runtime-loop.md §5.1. Required deliverable, not a test helper that happens to exist:
 * every scenario in §18 (doom loop, stop policy, tool failure and recovery, parallel tools, persistence
 * round-trip, reasoning override) is a statement about how the RUNTIME behaves given a particular sequence of
 * model outputs. Run against a live model those tests would assert on something non-deterministic and would
 * fail for reasons that have nothing to do with the code under test. Run against this, they are exact.
 *
 * It plays a script. Each entry is one Provider Turn's worth of output — text, reasoning, tool calls, or a
 * thrown error — and the adapter hands them out in order. What it records is as important as what it returns:
 * every request it was asked to shape is kept, so a test can assert on what the Runtime SENT (was recovery
 * issued at full effort? did the second turn carry the reduced one?) and not merely on what it did next.
 *
 * Two deliberate limits, so this cannot quietly become a fake provider:
 *
 *  - it does not implement transport. `chatRequest.ts` owns retries, streaming reassembly and usage logging,
 *    and a second implementation of any of that would be a second thing to keep correct. Tests drive the
 *    Runtime with `respond()` as the model call, not with a fake `fetch`.
 *  - it does not invent capabilities. The fixture states them, so a test that needs `supportsReasoning: false`
 *    says so out loud rather than relying on a model-name regex matching the way it hopes.
 */
import type { ThinkingConfig } from "@/lib/ai/thinking";
import type { ChatResponse, ToolCall, Usage } from "@/app/agent/chat/types";
import type { ModelAdapter, ModelCapabilities, NormalizedTurn } from "./modelAdapter";
import { normalizeChatResponse } from "./modelAdapter";

/** One scripted Provider Turn. A turn either produces output or fails; `error` and the rest are exclusive. */
export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  /** Shorthand: `{name, args}` pairs become well-formed ToolCalls with generated ids. */
  toolCalls?: Array<{ name: string; args?: unknown; id?: string }>;
  usage?: Usage;
  /** Makes this turn throw, for the provider-error branch of the Stop Policy (§11). */
  error?: string;
}

export interface ScriptedFixture {
  /** Reported verbatim. A test that wants a capability absent must say so here. */
  capabilities?: Partial<ModelCapabilities>;
  turns: ScriptedTurn[];
  /**
   * What to do once the script runs out.
   *
   * `"final"` (the default) returns a plain text turn, which ends any correctly-written loop. `"repeat"`
   * replays the last entry forever, which is how a doom-loop test keeps a misbehaving model misbehaving
   * without writing the same turn fifty times. `"throw"` fails loudly, and is what you want when running off
   * the end means the Runtime took a path the test did not expect.
   */
  onExhausted?: "final" | "repeat" | "throw";
}

/** What the adapter was asked to send, kept so tests can assert on requests and not only on outcomes. */
export interface RecordedRequest {
  /** 0-based index of the Provider Turn this request belongs to. */
  round: number;
  /** The reasoning config in force for that turn — the assertion target for §18 Test 3 and Test 8. */
  thinking: ThinkingConfig;
  /** The provider fields that config produced. */
  params: Record<string, unknown>;
}

export interface ScriptedAdapter extends ModelAdapter {
  /** Produce the next scripted turn. Throws when the fixture says the turn fails, or on exhaustion. */
  respond(cfg: ThinkingConfig): NormalizedTurn;
  /** Same, as a raw provider payload, for exercising `normalizeResponse` itself. */
  respondRaw(cfg: ThinkingConfig): ChatResponse;
  /** Every request so far, in order. */
  readonly requests: RecordedRequest[];
  /** How many turns have been served. */
  readonly round: number;
  /** Turns still unplayed; 0 means the next call hits `onExhausted`. */
  readonly remaining: number;
}

const DEFAULT_CAPS: ModelCapabilities = {
  supportsReasoning: true,
  supportsToolCalling: true,
  supportsParallelToolCalls: true,
  supportsStreaming: true,
  supportsStructuredOutput: false,
  supportsPerTurnReasoningEffort: true,
  supportsImages: false,
  contextWindow: 128_000,
};

/**
 * Deterministic ids.
 *
 * Counter-based rather than random because a fixture is compared against expected output: `Math.random` here
 * would make every assertion on a tool_call_id unstable, and pairing assistant.tool_calls with their results
 * is exactly what several of §18's tests check.
 */
function toToolCalls(spec: NonNullable<ScriptedTurn["toolCalls"]>, round: number): ToolCall[] {
  return spec.map((c, i) => ({
    id: c.id ?? `call_${round}_${i}`,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
  }));
}

/**
 * Build a scripted adapter from a fixture.
 *
 * `reasoningParams` returns the config as plain fields rather than delegating to the real family table: this
 * adapter answers for a model that does not exist, so running it through a table keyed on real model names
 * would report whatever family the fake id happened to match. Tests assert on the config that reached the
 * turn, which this makes directly visible.
 */
export function createScriptedAdapter(fixture: ScriptedFixture, id = "test-model"): ScriptedAdapter {
  const caps: ModelCapabilities = { ...DEFAULT_CAPS, ...(fixture.capabilities ?? {}) };
  const onExhausted = fixture.onExhausted ?? "final";
  const requests: RecordedRequest[] = [];
  let round = 0;

  const nextTurn = (): ScriptedTurn => {
    if (round < fixture.turns.length) return fixture.turns[round];
    if (onExhausted === "throw") {
      throw new Error(
        `[test-model] script exhausted after ${fixture.turns.length} turn(s); the Runtime asked for turn ${round + 1}`,
      );
    }
    if (onExhausted === "repeat" && fixture.turns.length > 0) return fixture.turns[fixture.turns.length - 1];
    return { content: "Done." };
  };

  const adapter: ScriptedAdapter = {
    id,
    capabilities: () => caps,
    // Recorded, not computed: what a test needs to know is which effort the Runtime chose for this turn.
    reasoningParams: (cfg) => (cfg.enabled ? { reasoning_effort: cfg.effort } : { reasoning_effort: "none" }),
    normalizeResponse: normalizeChatResponse,

    respondRaw(cfg) {
      const turn = nextTurn();
      requests.push({ round, thinking: { ...cfg }, params: adapter.reasoningParams(cfg) });
      round++;
      if (turn.error) throw new Error(turn.error);
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: turn.content ?? null,
              ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
              ...(turn.toolCalls?.length ? { tool_calls: toToolCalls(turn.toolCalls, round - 1) } : {}),
            },
          },
        ],
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
    },

    respond(cfg) {
      return normalizeChatResponse(adapter.respondRaw(cfg));
    },

    get requests() {
      return requests;
    },
    get round() {
      return round;
    },
    get remaining() {
      return Math.max(0, fixture.turns.length - round);
    },
  };
  return adapter;
}

/**
 * Fixtures for the §18 scenarios that M1 can already express.
 *
 * Kept beside the adapter rather than inside a test file because later milestones run the same sequences
 * through the real Runtime — the scenario is the shared thing, and duplicating these into each milestone's
 * test would let them drift apart while still both claiming to be "Test 4".
 */
export const FIXTURES = {
  /** §18 Test 1 — one tool, then a final answer. */
  singleTool: {
    turns: [
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { content: "The file defines two exports." },
    ],
  } satisfies ScriptedFixture,

  /** §18 Test 2 — plan, three tools, then a verified answer. */
  multiStep: {
    turns: [
      { reasoning: "Plan: read, edit, verify.", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "a.ts", old_string: "x", new_string: "y" } }] },
      { toolCalls: [{ name: "run_command", args: { cmd: "npm test" } }] },
      { content: "Edited and the suite passes." },
    ],
  } satisfies ScriptedFixture,

  /** §18 Test 3 — a failure, then recovery. The failure comes from the TOOL, so the turn itself succeeds. */
  toolFailure: {
    turns: [
      { toolCalls: [{ name: "edit_file", args: { path: "missing.ts" } }] },
      { toolCalls: [{ name: "list_directory", args: { path: "." } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "real.ts" } }] },
      { content: "Fixed — the path was wrong." },
    ],
  } satisfies ScriptedFixture,

  /** §18 Test 4 — the same call forever. `repeat` is what makes it a loop rather than a long script. */
  doomLoop: {
    turns: [{ toolCalls: [{ name: "search_files", args: { query: "handler" } }] }],
    onExhausted: "repeat",
  } satisfies ScriptedFixture,

  /** §18 Test 5 — three independent reads issued in one turn. */
  parallelTools: {
    turns: [
      {
        toolCalls: [
          { name: "read_file", args: { path: "a.ts" } },
          { name: "read_file", args: { path: "b.ts" } },
          { name: "read_file", args: { path: "c.ts" } },
        ],
      },
      { content: "All three read." },
    ],
  } satisfies ScriptedFixture,

  /** §18 Test 8 — the model asking for a different effort for its next turn. */
  reasoningOverride: {
    turns: [
      { toolCalls: [{ name: "set_reasoning_effort", args: { effort: "low" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { content: "Read it." },
    ],
  } satisfies ScriptedFixture,

  /** A provider that fails outright, for the `error` stop reason (§11). */
  providerError: {
    turns: [{ error: "503 upstream unavailable" }],
  } satisfies ScriptedFixture,
};
