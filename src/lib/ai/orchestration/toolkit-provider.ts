/**
 * The real `ToolProvider`: this app's actual tools, behind the orchestration seam.
 *
 * Declarations come from `listTools()` and execution from `callTool()` — both in `src/lib/ai/toolkit.ts`,
 * which forwards over IPC to `electron/tools/aiToolkit.mjs`. Nothing is redeclared or reimplemented here;
 * this module is a translation layer and a consent gate, and that is all it should ever be.
 *
 * ## Why there is a consent gate at all
 *
 * `callTool` does not ask anyone anything. In the main chat loop, consent is decided *before* the call:
 * `toolNeedsConsent(name, mode)` gates `SENSITIVE_TOOLS` and the user answers a prompt while watching.
 * A sub-agent driven by `sub-agent-runner.ts` bypasses that path entirely, so wrapping `callTool` naively
 * would hand sub-agents a strictly weaker posture than the agent the user is actually looking at: one "yes"
 * at grant time would authorise unlimited `run_command` invocations for the whole TTL, unattended.
 *
 * The broker and this gate answer different questions, and the system needs both:
 *
 *   - the broker asks **"may this agent ever run X"** — once, at grant time, from the ceiling and the
 *     approval path;
 *   - this gate asks **"do you want this specific X, now"** — per call, with the arguments visible.
 *
 * Grant-time approval bounds what is reachable. Per-call consent is what stops the twentieth `run_command`
 * from being authorised by a yes given to the first.
 *
 * ## Failing closed when no one is listening
 *
 * If no `confirm` callback is supplied, every tool that `needsConsent` covers is refused. A host that wants
 * unattended writes has to pass `confirm: async () => true`, which is one visible line in a review rather
 * than an absence nobody notices. This costs something real and it is worth naming: a sub-agent doing twenty
 * file writes will ask twenty times, and unlike the main agent, nobody is sitting there — so an autonomous
 * coder-style role may well need that explicit opt-out. That is a fine answer as long as it is chosen rather
 * than inherited.
 *
 * A refused call comes back as an error *result*, not an exception. The sub-agent reads "this was declined"
 * and can adapt — report back, try a read-only route, stop. Only the broker's refusals are fatal: a human
 * declining one action is not the same event as an agent reaching outside its grant.
 */

import {
  callTool as defaultCallTool,
  isToolkitAvailable,
  listTools as defaultListTools,
  type ToolResult,
  type ToolSchema,
} from "../toolkit";
import {
  isKnownTool,
  riskOf,
  type JsonSchema,
  type RiskLevel,
  type ToolCallContext,
  type ToolDeclaration,
  type ToolOutcome,
  type ToolProvider,
} from "./capabilities";

/** What a host is told when it is asked to confirm a call. */
export interface ConfirmRequest {
  name: string;
  input: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Which sub-agent is asking — worth showing, since the user did not start this call themselves. */
  agentId: string;
  grantId: string;
}

export interface ToolkitProviderOptions {
  /**
   * Per-call gate. Return false to decline.
   *
   * Omitted means "there is nobody to ask", which is treated as a refusal for every tool `needsConsent`
   * covers — see the header.
   */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /**
   * Which tools require per-call consent.
   *
   * A parameter rather than an import: the list lives in `src/app/agent/chat/constants.ts` as
   * `toolNeedsConsent(name, mode)`, and `lib/` importing from `app/` is the wrong direction. The host passes
   * the predicate it already uses for the main loop, so the two paths cannot drift.
   *
   * Defaults to "every tool classified medium or high", which is close to `SENSITIVE_TOOLS` and errs wider.
   */
  needsConsent?: (name: string) => boolean;
  /** Injectable for tests; defaults to the real toolkit bridge. */
  listTools?: () => Promise<ToolSchema[]>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Conservative default: anything that is not purely read-only asks first. */
function defaultNeedsConsent(name: string): boolean {
  const risk = riskOf(name);
  return risk === "medium" || risk === "high";
}

/**
 * Translate a toolkit declaration into the orchestration shape.
 *
 * The parameters object is passed through rather than re-validated. It is our own declaration from
 * `toolSchemas.mjs`, not remote data — and the filter below means MCP tools, whose schemas *do* come from
 * whatever server a user connected, never reach this function: their names are unclassified, so they are
 * dropped before translation.
 */
function toDeclaration(schema: ToolSchema): ToolDeclaration {
  return {
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters as unknown as JsonSchema,
  };
}

/**
 * Build a provider over this app's real tools.
 *
 * Declarations are read once and snapshotted. A grant cannot widen mid-run, so neither should the tool
 * descriptions behind it — and `listTools()` includes MCP tools, which appear and disappear as servers
 * connect during a conversation. A live lookup would let a sub-agent's world change underneath it partway
 * through a task, for reasons entirely outside that task.
 */
export async function createToolkitProvider(
  opts: ToolkitProviderOptions = {},
): Promise<ToolProvider> {
  const list = opts.listTools ?? (() => defaultListTools("raw"));
  const call = opts.callTool ?? defaultCallTool;
  const needsConsent = opts.needsConsent ?? defaultNeedsConsent;
  const confirm = opts.confirm;

  if (!opts.listTools && !opts.callTool && !isToolkitAvailable()) {
    throw new Error(
      "createToolkitProvider needs the Electron tool bridge (window.aiTools), which is unavailable here. " +
        "Pass listTools/callTool explicitly to run outside Electron.",
    );
  }

  const declarations = new Map<string, ToolDeclaration>();
  for (const schema of await list()) {
    // Unclassified names — MCP tools, and anything added to the toolkit without a risk level — are dropped.
    // The broker would refuse them as `unknown_tool` anyway; not declaring them keeps a sub-agent from
    // being tempted by a tool it can never be granted.
    if (!isKnownTool(schema.name)) continue;
    declarations.set(schema.name, toDeclaration(schema));
  }

  return {
    declarationFor(name: string): ToolDeclaration | undefined {
      return declarations.get(name);
    },

    async execute(
      name: string,
      input: Record<string, unknown>,
      context: ToolCallContext,
    ): Promise<ToolOutcome> {
      // Defence in depth behind verifyToolUse: by the time we are here the broker has already approved the
      // name, so this can only fire if the two have diverged — and an unclassified tool must not run either
      // way.
      const risk = riskOf(name);
      if (!risk) {
        throw new Error(`Tool "${name}" is not classified and cannot be executed.`);
      }

      if (needsConsent(name)) {
        if (!confirm) {
          return {
            content:
              `"${name}" needs per-call confirmation and this sub-agent has no way to ask — it is running ` +
              `unattended. The call was not made. Do the part of the task that does not need this tool, ` +
              `and report what you could not do; retrying will be refused identically.`,
            isError: true,
          };
        }
        const approved = await confirm({
          name,
          input,
          riskLevel: risk,
          agentId: context.agentId,
          grantId: context.grantId,
        });
        if (!approved) {
          return {
            content:
              `The user declined the "${name}" call. Do not retry it with the same arguments. Continue with ` +
              `what you can do without it, or stop and report that this step was declined.`,
            isError: true,
          };
        }
      }

      // `callTool` does not throw — it reports failure as { ok: false, content }. Both shapes become an
      // ordinary error result the model can read and recover from.
      const result = await call(name, input);
      return { content: result.content, isError: !result.ok };
    },
  };
}
