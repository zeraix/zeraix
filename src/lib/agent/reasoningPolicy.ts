/**
 * Reasoning policy — how hard the model thinks on this particular turn.
 *
 * Spec: docs/agent-runtime-loop.md §6 (all of it), §20 rules 3 and 4.
 *
 * This is the milestone that addresses §1's actual complaint. M0 confirmed the cause precisely (problem P2):
 * `thinkingParams(thinking, …)` is spread into every request body from a config captured once per render, so
 * a recovery turn, a routine "read the next file" follow-up and the final user-facing answer all reason
 * identically. There is no mechanism to vary it, because nothing downstream knew whether varying it would
 * work — which is what M1's capabilities are for.
 *
 * ── The three rules this module exists to keep ──────────────────────────────────────────────────────────────
 *
 * 1. **Do not simply disable reasoning** (§20 rule 3). Nothing here ever turns thinking off. The most it does
 *    is ask for a lower effort on the one phase where routine tool follow-ups live, and only when the
 *    provider has a knob for it.
 *
 * 2. **Never silently override the user** (§20 rule 4). The user's setting is a ceiling and an on/off switch,
 *    and neither the phase default nor the model's own request can breach it. If thinking is off, it stays
 *    off — no phase turns it on, no tool call turns it on.
 *
 * 3. **The model outranks the Runtime's default** (§6.2). When the model has asked for a specific effort, the
 *    phase default does not apply. This is the resolution to §20 rule 4's tension: the model deciding "this
 *    needs more thought" is the model deciding WHAT happens next, which is its job; the Runtime supplying a
 *    sane default when the model has not asked is the Runtime deciding HOW, which is its job.
 *
 * ── One ambiguity in the spec, and how it is resolved ───────────────────────────────────────────────────────
 *
 * §6.2 says the override lets the model "raise or lower its own effort". §20 rule 4 says the Runtime "may
 * never silently override an explicit user setting". Those pull in opposite directions when a model asks for
 * `high` and the user chose `low`.
 *
 * Resolved in the user's favour: the user's configured effort is a CEILING, so the model may lower freely and
 * may raise only up to it. A model can therefore always undo a Runtime reduction (asking for `high` when the
 * user chose `high` and the phase reduced it to `low` restores `high`), which is the case §6.2 is really
 * about, while a user who set `low` to control spend still gets `low`. Recorded as an interpretation in the
 * M4 report rather than left implicit, because it is a judgement call and not a reading of the text.
 */
import type { ThinkingConfig, ThinkingEffort } from "@/lib/ai/thinking";
import { clampEffort, type ModelCapabilities } from "./modelAdapter";
import { mayReduceEffort, type ExecutionPhase } from "./executionState";

/**
 * The effort the Runtime asks for on an `executing` round when nothing else has an opinion.
 *
 * `low` rather than off, because §20 rule 3 forbids disabling reasoning and because a tool-selection round
 * still involves a decision — which file, which command, is the last result what was expected. What it does
 * not involve is the planning or the diagnosis that the other phases carry.
 */
export const EXECUTING_DEFAULT_EFFORT: ThinkingEffort = "low";

/** The name the model calls to set its own effort for the next turn (§6.2). */
export const REASONING_TOOL_NAME = "set_reasoning_effort";

export interface ReasoningInput {
  /** The user's setting. The ceiling, and the on/off switch. Never modified. */
  user: ThinkingConfig;
  phase: ExecutionPhase;
  capabilities: ModelCapabilities;
  /**
   * What the model asked for via `set_reasoning_effort`, if anything, for THIS turn.
   *
   * One turn only. An override that persisted would quietly become a second user setting, and the model
   * would have no way to hand control back.
   */
  modelRequest?: ThinkingEffort | null;
}

export interface ReasoningDecision {
  /** The config to send. Always a complete config, never a patch. */
  config: ThinkingConfig;
  /** Why it is what it is — for the usage log (§19) and for explaining a surprising bill. */
  source: "user" | "phase-default" | "model-override";
}

/**
 * Decide the reasoning configuration for one Provider Turn.
 *
 * Reads in the order of authority: the user's off switch is absolute, then the model's request, then the
 * phase default, and everything that survives is clamped against the user's ceiling.
 */
export function resolveReasoning(input: ReasoningInput): ReasoningDecision {
  const { user, phase, capabilities, modelRequest } = input;

  // Thinking off is not a starting point to negotiate from. No phase and no model request reopens it, and
  // the config is returned untouched so nothing downstream can mistake it for a reduced-effort request.
  if (!user.enabled) return { config: user, source: "user" };

  // A model that cannot vary effort per request gets the user's setting, whatever the phase thinks. Sending
  // a reduced effort to a provider with no per-request knob would either be ignored or rejected, and §6.2
  // requires the absence of the knob to degrade silently.
  if (!capabilities.supportsPerTurnReasoningEffort) return { config: user, source: "user" };

  // The model asked. §6.2: its decision outranks the Runtime's default. Still clamped — see the header for
  // why the user's setting is a ceiling rather than merely a starting value.
  if (modelRequest) {
    return { config: clampEffort(user, modelRequest), source: "model-override" };
  }

  // The Runtime's own default, which exists only for the phase where it is safe. §6.3's table reduces to
  // this: `executing` may be economised on, everything else keeps the user's effort because correctness
  // matters more there than tokens do.
  if (mayReduceEffort(phase)) {
    return { config: clampEffort(user, EXECUTING_DEFAULT_EFFORT), source: "phase-default" };
  }

  return { config: user, source: "user" };
}

/**
 * The `set_reasoning_effort` declaration, or null when the provider has no per-request knob.
 *
 * Returning null rather than throwing is the whole of §6.2's "must degrade silently": a provider without the
 * capability simply never sees the tool, the model never learns it exists, and nothing errors.
 *
 * Declared here rather than in the app's tool table because the capability that gates it lives here. The
 * description is written to be actionable — a tool whose description does not say WHEN to call it gets
 * called at random or never.
 */
export function reasoningToolDeclaration(capabilities: ModelCapabilities): Record<string, unknown> | null {
  if (!capabilities.supportsReasoning || !capabilities.supportsPerTurnReasoningEffort) return null;
  return {
    type: "function",
    function: {
      name: REASONING_TOOL_NAME,
      description:
        "Set how hard you will think on your NEXT turn only. Call this when the work ahead is unusually " +
        "hard and deserves more deliberation, or when the next few steps are mechanical and do not. It " +
        "applies to one turn and then lapses, so set it again if you still want it. Your request cannot " +
        "exceed the effort the user has configured, and it cannot turn thinking on when the user has " +
        "turned it off — in those cases the call is accepted and has no effect.",
      parameters: {
        type: "object",
        properties: {
          effort: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "How much deliberation the next turn should get.",
          },
        },
        required: ["effort"],
      },
    },
  };
}

/**
 * Read a `set_reasoning_effort` call's argument.
 *
 * Returns null for anything unrecognised rather than throwing or defaulting: a malformed request from the
 * model must fall back to the Runtime's own policy, not break the turn and not silently mean "high".
 */
export function parseReasoningRequest(args: unknown): ThinkingEffort | null {
  if (!args || typeof args !== "object") return null;
  const effort = (args as Record<string, unknown>).effort;
  return effort === "low" || effort === "medium" || effort === "high" ? effort : null;
}

/**
 * The result text handed back for a `set_reasoning_effort` call.
 *
 * It reports what will ACTUALLY happen rather than echoing the request, because the request can be clamped
 * and a model told "effort set to high" when it was capped at low would plan around a budget it does not
 * have. Saying so plainly is also the only way the model can learn the ceiling exists.
 */
export function describeReasoningResult(requested: ThinkingEffort | null, decision: ReasoningDecision): string {
  if (!requested) {
    return "No change: pass `effort` as one of low, medium or high.";
  }
  if (!decision.config.enabled) {
    return "No change: the user has thinking turned off for this session, so effort cannot be set. Continue without it.";
  }
  if (decision.config.effort !== requested) {
    return (
      `Requested ${requested}, applied ${decision.config.effort}: the user's configured effort is the ceiling ` +
      "and your request cannot exceed it. Plan for the applied value."
    );
  }
  return `Next turn will use ${decision.config.effort} effort. This applies to one turn, then lapses.`;
}
