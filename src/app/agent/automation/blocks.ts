/**
 * Shared vocabulary for the workflow editors AND the AI workflow generator.
 *
 * `STEP_TYPES` is the single source of truth for what a step *is*: its runtime, its human face (icon,
 * label), what it "creates", its default config, and its declarative advanced fields. Everything that
 * needs to know the set of step types reads it here:
 *   - Simple mode renders Add-step buttons and Advanced fields from it.
 *   - The AI generator (generate.ts) describes the catalog to the model from it.
 * Adding a new step type — a future "dialogue generator", say — is one entry here, and both the editor
 * and the assistant learn about it at once. That is the scalability seam the redesign is built around.
 *
 * The two editors still translate between the engine's wire format (runtime names, `run://` / `var://`
 * refs, the fixed output keys each runtime publishes) and human labels; those helpers live here too so
 * Simple and Professional stay in lockstep.
 */
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows";

/** One editable knob behind a step's "Advanced" disclosure. Declarative so new fields need no new UI. */
export interface AdvancedField {
  /** Config key it reads/writes on `node.config`. */
  key: string;
  /** `model` renders a picker of configured models (stores the model id); others render an input. */
  type: "text" | "number" | "model";
  labelKey: string;
  /** Literal placeholder, or an i18n key for one (e.g. the localized "Default model"). */
  placeholder?: string;
  placeholderKey?: string;
  hintKey?: string;
  min?: number;
  /** Hidden when the step's chosen model is local — its ceiling doesn't apply there (see turn.mjs). */
  localExempt?: boolean;
}

export interface StepType {
  runtime: string;
  emoji: string;
  kindKey: string;
  /** i18n key for the "Add a …" button. */
  addLabelKey: string;
  /** The primary instruction field — what the block's big editable area writes. */
  instructionField: "prompt" | "command";
  instructionLabelKey: string;
  /** Output values this runtime publishes, in offer order (first = what the step "creates"). */
  outputs: string[];
  /** Short description used to teach the AI generator what this step does. */
  descriptionKey: string;
  advancedFields: AdvancedField[];
}

/**
 * The catalog. Runtimes the *visual* editor can create; the engine supports more (python, browser, …)
 * but those stay JSON-tab only until they earn a block. Each `outputs[0]` is the exact key the runtime
 * emits (agent.mjs → text, shell.mjs → stdout), so a ref built from it always resolves.
 */
export const STEP_TYPES: StepType[] = [
  {
    runtime: "agent",
    emoji: "🤖",
    kindKey: "auto.simple.kind.agent",
    addLabelKey: "auto.simple.addAgent",
    instructionField: "prompt",
    instructionLabelKey: "auto.simple.instructionLabel",
    outputs: ["text", "model", "rounds"],
    descriptionKey: "auto.simple.desc.agent",
    advancedFields: [
      { key: "model", type: "model", labelKey: "auto.simple.model" },
      {
        key: "maxRounds",
        type: "number",
        labelKey: "auto.simple.maxRounds",
        hintKey: "auto.simple.maxRoundsHint",
        placeholder: "12",
        min: 1,
        localExempt: true,
      },
    ],
  },
  {
    runtime: "shell",
    emoji: "⌨️",
    kindKey: "auto.simple.kind.shell",
    addLabelKey: "auto.simple.addShell",
    instructionField: "command",
    instructionLabelKey: "auto.simple.commandLabel",
    outputs: ["stdout", "stderr", "exitCode"],
    descriptionKey: "auto.simple.desc.shell",
    advancedFields: [],
  },
];

export function getStepType(runtime: string): StepType | undefined {
  return STEP_TYPES.find((s) => s.runtime === runtime);
}

/** Legacy-shaped views onto the registry, kept so existing call sites need no change. */
export const RUNTIME_META: Record<string, { emoji: string; kindKey: string }> = Object.fromEntries(
  STEP_TYPES.map((s) => [s.runtime, { emoji: s.emoji, kindKey: s.kindKey }]),
);
export const OUTPUT_KEYS: Record<string, string[]> = Object.fromEntries(
  STEP_TYPES.map((s) => [s.runtime, s.outputs]),
);
export const KNOWN_KEYS = new Set(STEP_TYPES.flatMap((s) => s.outputs));

/** The value a step "creates" — its primary output key (Reply text / Output). */
export function primaryOutputKey(runtime: string): string {
  return getStepType(runtime)?.outputs[0] ?? "text";
}

/** Default config for a freshly added step, translated by the caller's `t`. */
export function defaultConfig(runtime: string, t: (k: string) => string): Record<string, unknown> {
  const type = getStepType(runtime);
  if (!type) return {};
  return type.instructionField === "command"
    ? { command: "echo hello" }
    : { prompt: t("auto.simple.newPrompt") };
}

/** Decode an input ref into the fields a picker edits. Empty / unrecognised reads as an unset step. */
export function parseRef(ref = ""): { node: string; key: string; varKey: string } {
  const run = /^run:\/\/([^/]*)\/(.*)$/.exec(ref);
  if (run) return { node: run[1] ?? "", key: run[2] ?? "", varKey: "" };
  if (ref.startsWith("var://")) return { node: "", key: "", varKey: ref.slice(6) };
  return { node: "", key: "", varKey: "" };
}

/**
 * Best-effort execution order of a definition's nodes. v1 runs a single chain, so visual order *is*
 * run order. Follow the edge chain from the unique root; anything unreachable (a hand-edited branch)
 * is appended in declaration order so no node vanishes from the Simple view.
 */
export function linearize(def: WorkflowDefinition): WorkflowNode[] {
  const nodes = def.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const e of def.edges ?? []) {
    if (!next.has(e.from)) next.set(e.from, e.to);
    hasIncoming.add(e.to);
  }
  const root = nodes.find((n) => !hasIncoming.has(n.id)) ?? nodes[0];
  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = root?.id;
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    ordered.push(byId.get(cur)!);
    cur = next.get(cur);
  }
  for (const n of nodes) if (!seen.has(n.id)) ordered.push(n);
  return ordered;
}

/** Vertical layout gap, matching the canvas so a Simple edit doesn't scramble the Professional view. */
const AUTO_GAP = 110;

/**
 * Rebuild a definition from an ordered node list, wiring the nodes into a straight chain. Simple mode
 * enforces the single-chain invariant by construction, and repositions nodes top-to-bottom so a switch
 * to Professional shows the same order rather than stale coordinates.
 */
export function fromOrder(base: WorkflowDefinition, ordered: WorkflowNode[]): WorkflowDefinition {
  return {
    ...base,
    nodes: ordered.map((n, i) => ({ ...n, position: { x: 40, y: i * AUTO_GAP } })),
    edges: ordered.slice(1).map((n, i) => ({ from: ordered[i].id, to: n.id })),
  };
}

/**
 * A plain-text description of the step catalog for the AI generator's system prompt. Built from the
 * registry so a new step type teaches the model automatically. `t` localizes the descriptions.
 */
export function stepCatalogText(t: (k: string) => string): string {
  return STEP_TYPES.map((s) => {
    const fields = s.advancedFields.map((f) => f.key).join(", ") || "none";
    return `- runtime "${s.runtime}" (${t(s.kindKey)}): ${t(s.descriptionKey)} Instruction field: config.${s.instructionField}. Produces output keys: ${s.outputs.join(", ")}. Optional config: ${fields}.`;
  }).join("\n");
}
