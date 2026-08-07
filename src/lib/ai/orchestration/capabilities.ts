/**
 * Capability classification: which tools exist, and how much damage each one can do.
 *
 * This is the one fact about the tool surface that lives nowhere else. Names, descriptions and JSON schemas
 * are already declared in `electron/tools/toolSchemas.mjs`; the implementations are in `aiToolkit.mjs`. What
 * neither of those records is *risk* — and risk is what `capability-broker.ts` routes on when it decides
 * whether a grant can be issued by set intersection alone or needs a human to answer for it.
 *
 * So this module deliberately does not copy declarations or implementations across. It classifies, and it
 * defines the seam (`ToolProvider`) through which the host supplies the other two. Duplicating a schema here
 * would create exactly the second source of truth this file exists to prevent, and would cross the
 * renderer/main-process boundary the rest of `src/` keeps (see the note at `contextCompress.ts:76`).
 *
 * The two halves are kept honest by a test rather than by an import: `test/orchestration.test.mjs` reads
 * `toolSchemas.mjs` directly and asserts the name sets match exactly. A tool added there without a risk
 * level here fails CI, which is the enforcement that actually matters — an unclassified tool would otherwise
 * be treated as unknown and silently denied, or worse, classified by accident.
 */

/** JSON Schema subset used by tool declarations. Kept typed so the key interfaces have no `any`. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * How much damage a tool can do if it runs when it should not have.
 *
 * The line that matters is `high`: those tools reach outside the process in ways dropping a grant cannot
 * undo — a deleted file stays deleted, a shell command stays run. The broker routes them through a separate
 * approval path for that reason, so this is a security control, not a label.
 */
export type RiskLevel = "low" | "medium" | "high";

/**
 * Every native tool, classified.
 *
 * Frozen and complete: an unlisted name is `unknown_tool` to the broker and can never be granted, so the
 * failure mode of forgetting an entry is denial rather than accidental permission. The drift test makes
 * forgetting fail loudly anyway.
 */
const RISK: ReadonlyArray<readonly [string, RiskLevel]> = [
  // ── Read-only. No state changes anywhere. ──────────────────────────────────────────────
  ["read_file", "low"],
  ["file_info", "low"],
  ["list_directory", "low"],
  ["search_files", "low"],
  ["search_in_files", "low"],
  ["refine_question", "low"],
  ["mcp_tools", "low"],
  ["mcp_discover", "low"],

  // ── Mutating but recoverable, or outbound but observable. ──────────────────────────────
  ["write_file", "medium"],
  ["edit_file", "medium"],
  ["append_file", "medium"],
  ["create_directory", "medium"],
  ["copy_file", "medium"],
  ["move_file", "medium"],
  ["remember_project", "medium"],
  ["init_command", "medium"],
  ["web_search", "medium"],
  ["fetch_url", "medium"],
  /**
   * `check_project` runs the project's own build and test scripts.
   *
   * Medium on its own merits: the command is fixed and project-defined rather than chosen by the caller,
   * and `subagents.ts` already trusts it enough to include in the read-only `reviewer` role, which cannot
   * write anything.
   *
   * ⚠️ KNOWN ESCALATION — medium + medium can add up to high. That reasoning holds for `check_project` in
   * isolation and stops holding the moment a single grant also carries a write tool. A sub-agent holding
   * `write_file` and `check_project` together can write its own build or test script and then call
   * `check_project` to execute it — which is functionally `run_command`, obtained without ever reaching the
   * high-risk approval path. The ceiling permits that pair, because `CODER_TOOLS` contains both.
   *
   * This is documented and recorded rather than blocked. Blocking it properly means evaluating combinations
   * rather than individual tools, which is a different and much larger design, and pretending a single-tool
   * risk level captures a multi-tool capability would be worse than saying plainly that it does not. What
   * exists today: `ESCALATION_PAIRS` below names the combination, and the broker writes it onto the
   * `grant_issued` audit record so a grant that carries it is reviewable after the fact.
   *
   * The fixed roles are unaffected — `reviewer` has no write tool — so this is reachable only where a
   * dynamic sub-agent requests both at once.
   */
  ["check_project", "medium"],

  // ── Irreversible, host-level, or arbitrary execution. ──────────────────────────────────
  ["delete_file", "high"],
  ["run_command", "high"],
  ["stop_service", "high"],
  /** Launches the host's default application for a path — escapes the sandbox to the host GUI. */
  ["open_path", "high"],
  /**
   * Connects an MCP server, making its tools available for the rest of the conversation.
   *
   * A tool that grants tools is the one thing that must never be auto-approved, so it is classified `high`
   * even though the current ceiling already excludes it. The classification table describes the risk profile
   * of everything in the system, not only what today's ceiling happens to reach: if someone later widens the
   * ceiling and takes this in with it, the approval requirement is already in place rather than being
   * something that had to be remembered at the same moment.
   */
  ["mcp_connect", "high"],
] as const;

export const TOOL_RISK: ReadonlyMap<string, RiskLevel> = readonlyView(new Map(RISK));

/**
 * A genuinely read-only view over a Map: the mutators do not exist on it, rather than being hidden by a type.
 *
 * A `Map` exported under a `ReadonlyMap` annotation still has `set` and `delete` at runtime, so one line of
 * `TOOL_RISK.set("run_command", "low")` — from a compromised dependency, an eval'd string, anything with
 * code execution — would reclassify a high-risk tool so it skips the approval path entirely, with the broker
 * faithfully enforcing a table that had been rewritten underneath it. Hiding mutators from the type-checker
 * protects against mistakes; removing them protects against attacks, and this subsystem's premise is that
 * the attacker may already be inside.
 */
function readonlyView<V>(source: Map<string, V>): ReadonlyMap<string, V> {
  const view = Object.freeze({
    get size() {
      return source.size;
    },
    get: (key: string) => source.get(key),
    has: (key: string) => source.has(key),
    keys: () => source.keys(),
    values: () => source.values(),
    entries: () => source.entries(),
    forEach: (cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown) =>
      source.forEach((v, k) => cb.call(thisArg, v, k, view)),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  }) as ReadonlyMap<string, V>;
  return view;
}

/** Every classified tool name. */
export const ALL_TOOL_NAMES: readonly string[] = Object.freeze(RISK.map(([name]) => name));

export function isKnownTool(name: string): boolean {
  return TOOL_RISK.has(name);
}

/** Undefined for an unclassified tool. Callers treating "unknown" as anything but "deny" have a bug. */
export function riskOf(name: string): RiskLevel | undefined {
  return TOOL_RISK.get(name);
}

/** True if the tool exists and is classified `high`. Unknown names are not high — they are nothing. */
export function isHighRisk(name: string): boolean {
  return TOOL_RISK.get(name) === "high";
}

// ── Known escalating combinations ─────────────────────────────────────────────────────────

/**
 * Tool pairs whose combined capability exceeds either member's individual risk level.
 *
 * Deliberately a short hand-written list, not an analysis engine. Recording a known combination costs
 * nothing and keeps the fact reviewable; deriving combinations in general would mean modelling what each
 * tool can cause other tools to do, which is a different project. The value of this list is that it is
 * honest about being incomplete — it names what we know, so what we know does not quietly evaporate into a
 * refactor.
 *
 * Nothing here blocks a grant. The broker records these onto the audit trail and issues the grant anyway.
 */
export interface EscalationPair {
  tools: readonly [string, string];
  /** What the combination amounts to, in terms of a tool that *is* gated. */
  equivalentTo: string;
  note: string;
}

export const ESCALATION_PAIRS: readonly EscalationPair[] = Object.freeze([
  Object.freeze({
    tools: ["write_file", "check_project"] as const,
    equivalentTo: "run_command",
    note:
      "A sub-agent holding both can write its own build or test script and then run it via check_project, " +
      "obtaining arbitrary command execution without passing through the high-risk approval path.",
  }),
  Object.freeze({
    tools: ["edit_file", "check_project"] as const,
    equivalentTo: "run_command",
    note:
      "Same escalation as write_file + check_project: an existing build or test script can be edited into " +
      "an arbitrary command and then executed via check_project.",
  }),
]);

/**
 * Which known escalations a tool set actually gains from.
 *
 * A pair is only reported when the set holds both members *and does not already hold the tool the pair is
 * equivalent to*. That second condition matters more than it looks: `CODER_TOOLS` contains `write_file`,
 * `check_project` and `run_command`, so the write-then-check route grants the coder role nothing it was not
 * openly given — flagging it would be noise, and a log full of noise is a log nobody reads. What the flag is
 * for is the grant that reaches command execution *without* being seen to ask for it.
 */
export function findEscalations(tools: readonly string[]): EscalationPair[] {
  const held = new Set(tools);
  return ESCALATION_PAIRS.filter(
    (p) => p.tools.every((t) => held.has(t)) && !held.has(p.equivalentTo),
  );
}

// ── Declarations and execution: supplied by the host ──────────────────────────────────────

/** What a tool result looks like coming back from an implementation. */
export interface ToolOutcome {
  /**
   * Text fed back to the model as a tool result. UNTRUSTED — file contents, fetched pages and message
   * bodies arrive here, and any of them can contain instructions. It reaches the model; it never reaches
   * the broker.
   */
  content: string;
  isError?: boolean;
}

/** A tool as declared to a model: the shape both the Anthropic and OpenAI adapters build from. */
export interface ToolDeclaration {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Which sub-agent a tool call belongs to. Passed to the provider so a host can attribute or gate it. */
export interface ToolCallContext {
  agentId: string;
  grantId: string;
}

/**
 * The seam between this subsystem and the host's real tools.
 *
 * The host already owns declarations (`toolSchemas.mjs`) and execution (`aiToolkit.mjs`); this interface is
 * how they are handed in without either being copied. A provider cannot widen anything: `verifyToolUse` runs
 * against the grant before the provider is consulted, so a provider only ever implements a capability the
 * broker has already granted. It is the *implementation* of a permission, never the source of one.
 */
export interface ToolProvider {
  declarationFor(name: string): ToolDeclaration | undefined;
  execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolOutcome>;
}

/**
 * Build the declarations for a set of tool names.
 *
 * Names with no declaration are dropped rather than thrown on. The input is normally `grant.tools`, which
 * the broker already intersected against the ceiling, so a missing declaration means something upstream is
 * out of step — and the safe response to that is to hand the model *fewer* tools, not to crash a running
 * sub-agent. Dropping fails closed; throwing would fail loudly inside someone else's loop.
 *
 * This is not a security boundary and must not be mistaken for one. It shapes a request; the model can still
 * emit a call naming a tool that was never in this array. The boundary is `broker.verifyToolUse`, re-checked
 * immediately before every execution.
 */
export function toAnthropicToolSchema(
  names: readonly string[],
  provider: ToolProvider,
): ToolDeclaration[] {
  const out: ToolDeclaration[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    const decl = provider.declarationFor(name);
    if (!decl) continue;
    seen.add(name);
    out.push(decl);
  }
  return out;
}

// ── Mock provider ─────────────────────────────────────────────────────────────────────────

/** Required arguments the mock enforces, so a tool can fail for a realistic reason. */
const MOCK_REQUIRED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_string", "new_string"],
  append_file: ["path", "content"],
  delete_file: ["path"],
  copy_file: ["source", "destination"],
  move_file: ["source", "destination"],
  create_directory: ["path"],
  file_info: ["path"],
  search_files: ["pattern"],
  search_in_files: ["pattern"],
  run_command: ["command"],
  open_path: ["path"],
  fetch_url: ["url"],
  web_search: ["query"],
});

/**
 * A stand-in provider for tests and for running this subsystem without the Electron host.
 *
 * It echoes rather than acting — a test suite whose purpose is to provoke over-privilege attempts should not
 * be one keystroke away from actually running the shell command it is pretending to run. It does validate
 * required arguments, because the runner's handling of a *failing* tool differs meaningfully from its
 * handling of a *refused* one, and that difference needs something real to exercise it.
 */
export const MOCK_TOOL_PROVIDER: ToolProvider = Object.freeze({
  declarationFor(name: string): ToolDeclaration | undefined {
    if (!isKnownTool(name)) return undefined;
    const required = MOCK_REQUIRED[name] ?? [];
    const properties: Record<string, JsonSchemaProperty> = {};
    for (const key of required) properties[key] = { type: "string" };
    return {
      name,
      description: `[mock] ${name}`,
      input_schema: { type: "object", properties, required: [...required] },
    };
  },
  async execute(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    // The context argument is accepted by the interface and ignored here: the mock has nobody to attribute
    // a call to and nothing to gate it with.
    if (!isKnownTool(name)) throw new Error(`No implementation for tool "${name}".`);
    for (const key of MOCK_REQUIRED[name] ?? []) {
      if (typeof input[key] !== "string" || input[key] === "") {
        throw new Error(`${name} requires a "${key}" argument.`);
      }
    }
    return { content: `[mock ${name}] ${JSON.stringify(input)}` };
  },
});
