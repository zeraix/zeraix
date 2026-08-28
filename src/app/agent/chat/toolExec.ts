import { callTool, listTools } from "@/lib/ai/toolkit";
import { ROUTED_TOOLS, routedFailureHint, unknownToolResult } from "@/lib/ai/toolRouter";
import { countTokens } from "@/lib/ai/tokenizer";
import { isUsageLogEnabledSync, logToolCall } from "@/lib/ai/usageLog";
import type { ConsentDecision, ConsentRequest } from "@/lib/agent/runtimeBoundary";
import type { ConsentRequester } from "./ConsentPanel";
import { makeUnifiedDiff } from "./diffUtil";
import { pathProvenance, type CompactionState } from "./contextCompress";
import { toolNeedsConsent, toolStatusText } from "./constants";
import type { ApiMsg, RunCtx } from "./types";

/**
 * Explain a FAILED call to a tool the model never saw a schema for.
 *
 * A routed tool is called from a one-line catalog signature (see toolRouter.ts), so a rejected call is the one moment its full
 * parameter list is worth its tokens — the alternative is the model guessing again, and a guess costs a whole round trip at
 * 50-80K prompt tokens. Only on failure, and only for routed tools: a declared tool's schema is already in every request.
 *
 * Reached only on the error path, so the extra listTools() round trip is free in the case that matters. Covers the toolkit's
 * tools only: the routed renderer tools (browser / openBrowser / image_generation) never come through here, and their handlers
 * already answer with a description of what they wanted.
 */
async function explainToolFailure(name: string, content: string): Promise<string> {
  if (!ROUTED_TOOLS.has(name) && !content.startsWith("Unknown tool")) return content;
  try {
    const all = (await listTools("openai")) as Array<{ function?: { name?: string; parameters?: unknown } }>;
    const hit = all.find((t) => t.function?.name === name);
    if (!hit) return `${content}\n\n${unknownToolResult(name, all.flatMap((t) => (t.function?.name ? [t.function.name] : [])))}`;
    return ROUTED_TOOLS.has(name) ? content + routedFailureHint(name, hit.function?.parameters) : content;
  } catch {
    return content; // The hint is an optimisation; never let looking it up turn a tool error into a broken turn.
  }
}

// The pre-confirmation change preview: read the old content, compute the new content by the tool's semantics, and generate a diff with line numbers (returns null on failure).
async function buildPreviewDiff(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (name !== "edit_file" && name !== "write_file") return null;
  const p = String(args.path ?? "");
  if (!p) return null;
  try {
    const r = await callTool("read_file", { path: p });
    const before = r.ok ? r.content : "";
    let after = before;
    if (name === "write_file") {
      after = String(args.content ?? "");
    } else {
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      if (!oldStr || !before.includes(oldStr)) return null;
      if (args.replace_all) {
        after = before.split(oldStr).join(newStr);
      } else {
        const idx = before.indexOf(oldStr); // Replace the first literal occurrence, to avoid $ being treated as regex
        after = before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
      }
    }
    return makeUnifiedDiff(before, after);
  } catch {
    return null;
  }
}

export interface ToolExecDeps {
  t: (key: string, vars?: Record<string, string>) => string;
  /** The consent queue's raw six-argument call; hostConsent adapts the §13 shape onto it. */
  requestConsent: (
    convId: string | null,
    name: string,
    args: Record<string, unknown>,
    previewDiff: string | null,
    warning: string | null,
    requester: ConsentRequester | null,
  ) => Promise<ConsentDecision>;
  /**
   * The mutable pieces arrive as accessors rather than as refs, and are called at TOOL-CALL time, never
   * here — the same discipline chatRequest.ts follows, and for the same reason: handing a ref to a factory
   * that runs during render is exactly what react-hooks/refs warns about.
   */
  /** Tools the user answered "don't ask again" for, in this session. */
  allowedTools: () => Set<string>;
  /** Read to judge whether a mutation targets a file the model only knows from compressed history. */
  wireBuffer: () => ApiMsg[];
  compaction: () => CompactionState | null;
}

/**
 * The single path every tool call takes: consent, execution, the display bubble, and the usage log.
 *
 * Both the main agent and every sub-agent call through here, which is what makes it the one place a
 * delegation's actions are recorded and the one place the consent policy is applied.
 */
export function createToolExec(deps: ToolExecDeps) {
  const { t, requestConsent, allowedTools, wireBuffer, compaction } = deps;

  // Execute a single tool call (including sensitive-operation confirmation), push a display bubble, and return the result text fed back to the model.
  // displayName is only for display (subagent calls carry an "agentId→" prefix).
  /**
   * Ask the user to approve a tool call — the host half of the §13 boundary's `requestConsent` (M2b).
   *
   * A thin adapter onto `useConsentQueue`, and thin on purpose: the queueing, the per-conversation ordering
   * and the "don't ask again" set are all behaviour worth keeping exactly as it is. What this adds is the
   * contract's argument shape, so that the caller does not have to know the queue's six-parameter signature.
   */
  const hostConsent = (convId: string | null, req: ConsentRequest): Promise<ConsentDecision> =>
    requestConsent(
      convId,
      req.name,
      req.args,
      req.previewDiff ?? null,
      req.warning ?? null,
      (req.requester ?? null) as ConsentRequester | null,
    );

  const execToolCall = async (
    ctx: RunCtx,
    name: string,
    args: Record<string, unknown>,
    displayName: string,
    // Usage-log attribution: "main" for the primary agent, "sub:<id>" when a sub-agent is acting.
    // Every tool call funnels through here, so this is the one place a delegation's actions are recorded.
    actor = "main",
    // Set when a brokered anonymous sub-agent is the caller. Two effects, both deliberate: the consent
    // panel names the agent and its task, and the "don't ask again" shortcut is bypassed (see below).
    requester: ConsentRequester | null = null,
    // Lets a caller learn whether the call succeeded. execToolCall folds failures into the returned text
    // for the model's benefit, which loses the distinction everywhere else — the orchestration audit log
    // needs it back.
    onResult?: (ok: boolean) => void,
  ): Promise<string> => {
    ctx.status(toolStatusText(name, args));
    // execToolCall only ever runs from inside the tool loop, long after the commit.
    const startedAt = Date.now();
    const log = (ok: boolean, result: string, blocked?: boolean) =>
      logToolCall({
        actor,
        name,
        args,
        ok,
        blocked,
        result,
        // What this step costs the conversation: a tool call spends no tokens itself, but its result
        // is carried into every later request, which is the number worth seeing per step. Estimated
        // with the same tokenizer the context bar falls back to, and only when logging is on -- a
        // tool result can be thousands of characters and tokenizing it otherwise is pure waste.
        resultTokens: isUsageLogEnabledSync() ? countTokens(result) : undefined,
        ms: Date.now() - startedAt,
        convId: ctx.convId,
        turnId: ctx.turnId,
      });
    // Consent policy lives in toolNeedsConsent (constants.ts) so the rules can grow in one place. Currently every sensitive
    // tool is confirmed. The "always" allowance still short-circuits repeat prompts.
    // A sub-agent's call always asks, even for a tool the user allowed with "don't ask again": that answer
    // was given about work the user had themselves requested and was watching. An autonomous delegation
    // deciding to write a file is a different question, and inheriting the earlier yes would silently make
    // sub-agents more powerful than the agent the user is actually looking at.
    if (toolNeedsConsent(name) && (requester !== null || !allowedTools().has(name))) {
      const previewDiff = await buildPreviewDiff(name, args);
      // §A1: warn when this mutation targets a file the model only "knows" from compressed history — its
      // latest read/write was folded into the summary and never re-verified at the tail. Pure lookup, no cost.
      const targetPath =
        typeof args.path === "string" ? args.path : typeof args.destination === "string" ? args.destination : "";
      const warning =
        targetPath && pathProvenance(wireBuffer(), compaction(), targetPath) === "digest-only"
          ? t("chat.provenanceWarning")
          : null;
      // Routed through the §13 contract shape rather than the raw six-argument call (M2b). `hostConsent` is
      // the same function the boundary hands the Runtime, so consent has one implementation whether it is
      // asked for from here or from a Runtime that no longer lives in this component.
      const decision = await hostConsent(ctx.convId, { name, args, previewDiff, warning, requester });
      if (decision === "always") allowedTools().add(name);
      if (decision === "no") {
        const denied = "The user rejected this operation.";
        ctx.push({ kind: "tool", name: displayName, args, ok: false, result: denied });
        // A refused call is logged too: "what did the agent try to do" is exactly the question the log
        // exists to answer, and a silent gap there reads as if it never asked.
        log(false, denied, true);
        onResult?.(false);
        return denied;
      }
    }
    // This run's signal goes with the call, so Stop reaches the work itself. Without it the loop only
    // noticed the abort at its next checkpoint — which for run_command is after the command exits or hits
    // its timeout, so stopping a one-minute build appeared to do nothing at all for a minute.
    const result = await callTool(name, args, ctx.signal);
    ctx.push({ kind: "tool", name: displayName, args, ok: result.ok, result: result.content });
    log(result.ok, result.content);
    onResult?.(result.ok);
    // The schema hint is model-facing only: the bubble above and the log entry keep the tool's own error, because a parameter
    // dump is what the model needs to retry and noise to everyone reading the timeline.
    return result.ok ? result.content : await explainToolFailure(name, result.content);
  };

  return { execToolCall, hostConsent };
}
