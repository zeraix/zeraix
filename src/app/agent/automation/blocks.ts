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

/* ------------------------------------------------------------------- schedules */

/**
 * The schedules Simple mode can express, and the cron each one compiles to.
 *
 * Deliberately a short list. The point is that a user who wants "every morning at 9" never types
 * cron syntax, not that every cron shape gets a UI -- anything outside this set stays readable and
 * editable in the Professional JSON tab, and `readSchedule` reports it as `custom` rather than
 * silently rewriting it into the nearest preset.
 *
 * `electron/automation/cron.mjs` is the authority on what an expression *means*; this only builds the
 * handful it also knows how to read back. The two cannot drift silently: schema.mjs parses every
 * expression with that module at save time, so anything generated here that it disagrees with is
 * rejected in the editor rather than becoming a schedule that never fires.
 */
export type SchedulePreset = "manual" | "daily" | "weekdays" | "hourly" | "everyMinutes" | "custom";

/** Minute intervals offered for `everyMinutes`. Divisors of 60, so the fires stay evenly spaced. */
export const MINUTE_CHOICES = [5, 10, 15, 30] as const;

export interface ScheduleValue {
  preset: SchedulePreset;
  /** "HH:MM", for the presets that fire at a fixed time. */
  time: string;
  /** Interval for `everyMinutes`. */
  minutes: number;
  /** What to do about fires missed while the app was closed (§12.2). Ignored when preset is manual. */
  missedRunPolicy: "skip" | "run-once-on-launch" | "backfill";
  /** The raw expression, when the schedule is one this editor cannot draw. */
  expression?: string;
}

export const DEFAULT_SCHEDULE: ScheduleValue = {
  preset: "manual",
  time: "09:00",
  minutes: 15,
  // `skip` is the safe default for anything with side effects (§12.2): a workflow that sends email
  // must not fire four times because the laptop was shut for four days.
  missedRunPolicy: "skip",
};

const clampTime = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m) return { h: 9, min: 0 };
  return { h: Math.min(23, Math.max(0, Number(m[1]))), min: Math.min(59, Math.max(0, Number(m[2]))) };
};

/** Compile a picker value into a cron expression, or null for `manual` (which has no schedule). */
export function scheduleToCron(value: ScheduleValue): string | null {
  const { h, min } = clampTime(value.time);
  switch (value.preset) {
    case "daily":
      return `${min} ${h} * * *`;
    case "weekdays":
      return `${min} ${h} * * 1-5`;
    case "hourly":
      return `${min} * * * *`;
    case "everyMinutes":
      return `*/${value.minutes} * * * *`;
    case "custom":
      return value.expression ?? null;
    default:
      return null;
  }
}

/**
 * Read a definition's triggers back into picker state.
 *
 * Anything this cannot round-trip exactly -- a hand-written expression, a file-watch or deeplink
 * trigger, several triggers at once -- comes back as `custom` carrying the raw text. Guessing at the
 * nearest preset would silently rewrite a schedule the user deliberately hand-tuned the moment they
 * opened Simple mode.
 */
export function readSchedule(def: WorkflowDefinition): ScheduleValue {
  const triggers = def.triggers ?? [];
  const cron = triggers.filter((t) => t.type === "cron");
  const nonManual = triggers.filter((t) => t.type !== "manual");

  if (cron.length === 0) {
    // A non-cron automatic trigger (file-watch, deeplink) is still "not manual" and must not be
    // reported as manual, or Simple mode would offer to overwrite it with a schedule.
    if (nonManual.length > 0) return { ...DEFAULT_SCHEDULE, preset: "custom" };
    return { ...DEFAULT_SCHEDULE };
  }
  if (cron.length > 1 || nonManual.length > cron.length) return { ...DEFAULT_SCHEDULE, preset: "custom" };

  const expression = String(cron[0].config?.expression ?? "");
  const policy = (cron[0].missedRunPolicy as ScheduleValue["missedRunPolicy"]) ?? DEFAULT_SCHEDULE.missedRunPolicy;
  const base = { ...DEFAULT_SCHEDULE, missedRunPolicy: policy, expression };

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, preset: "custom" };
  const [minute, hour, dom, month, dow] = parts;
  const everyDate = dom === "*" && month === "*";
  const hhmm = (h: string, m: string) => `${String(Number(h)).padStart(2, "0")}:${String(Number(m)).padStart(2, "0")}`;
  const isNum = (s: string) => /^\d{1,2}$/.test(s);

  if (everyDate && isNum(minute) && isNum(hour) && dow === "*") {
    return { ...base, preset: "daily", time: hhmm(hour, minute) };
  }
  if (everyDate && isNum(minute) && isNum(hour) && dow === "1-5") {
    return { ...base, preset: "weekdays", time: hhmm(hour, minute) };
  }
  if (everyDate && isNum(minute) && hour === "*" && dow === "*") {
    return { ...base, preset: "hourly", time: hhmm("0", minute) };
  }
  const step = /^\*\/(\d{1,2})$/.exec(minute);
  if (everyDate && step && hour === "*" && dow === "*" && MINUTE_CHOICES.includes(Number(step[1]) as never)) {
    return { ...base, preset: "everyMinutes", minutes: Number(step[1]) };
  }
  return { ...base, preset: "custom" };
}

/**
 * Write a picker value back onto a definition's triggers.
 *
 * Every workflow keeps a manual trigger regardless of schedule: "run it now to see if it works" is
 * how anyone checks a schedule they just set, and removing the Run button when a cron is added would
 * make a scheduled workflow untestable until its next fire.
 */
export function applySchedule(def: WorkflowDefinition, value: ScheduleValue): WorkflowDefinition {
  const manual = (def.triggers ?? []).find((t) => t.type === "manual") ?? { id: "manual", type: "manual", config: {} };
  if (value.preset === "custom") return def; // not ours to rewrite — see readSchedule
  const expression = scheduleToCron(value);
  if (!expression) return { ...def, triggers: [manual] };
  return {
    ...def,
    triggers: [
      manual,
      { id: "schedule", type: "cron", config: { expression }, missedRunPolicy: value.missedRunPolicy },
    ],
  };
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
