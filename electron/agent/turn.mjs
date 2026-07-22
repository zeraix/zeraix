/**
 * Headless agent turn loop (main process). See docs/automation-workflow-design.md §3.2.
 *
 * WHY THIS EXISTS RATHER THAN REUSING THE CHAT LOOP
 * The interactive loop lives in the renderer, inside ChatPage's `send` (src/app/agent/chat/page.tsx),
 * as a closure over React state. Automation runs in the main process with no window at all, so it
 * cannot call that code. This is a deliberate second implementation, with the drift risk accepted
 * and recorded in the design doc.
 *
 * It is also legitimately *different*, not merely a copy: an unattended 3am run has nobody to ask
 * and nobody to approve. Every interactive affordance the chat loop depends on -- `ask_user`, the
 * consent prompts in `toolNeedsConsent`, the browser panel, image generation -- is meaningless here.
 * A tool that would block on a human is refused rather than left to hang until the run times out.
 *
 * What IS shared: the tool registry and implementations (electron/tools/aiToolkit.mjs) and the LLM
 * transport (electron/llm/proxy.mjs). Only the orchestration is duplicated.
 */

/** Tools that require a human in the loop. Never offered to a headless run (see module header). */
export const INTERACTIVE_TOOLS = Object.freeze([
  "ask_user",
  "update_todos",
  "openBrowser",
  "browser",
  "image_generation",
  "run_subagent",
]);

/** Safety net so a looping model cannot spend a budget forever; also see limits.maxTokens (§4.1). */
const DEFAULT_MAX_ROUNDS = 12;

/**
 * Local models run on the user's own machine: no per-token cost, so the round and token ceilings that
 * exist to bound a *bill* don't apply. We lift them for local models — but a *finite* headroom, not
 * infinity: a stuck local model still appends to the message history every round, so an unbounded cap
 * is a memory/CPU runaway (it ate 6GB once). This is generous vs the 12-round default yet still bounded;
 * local tokens are reported as 0 so they never accrue against limits.maxTokens. Locality is decided by
 * the endpoint, matching the renderer's isLocalEndpoint.
 */
const LOCAL_MAX_ROUNDS = 50;
function isLocalModel(model) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(model?.endpoint ?? ""));
}

/**
 * Run one headless agent turn to completion.
 *
 * @param {object} opts
 * @param {string} opts.prompt                 User-role instruction for this node.
 * @param {string} [opts.system]               Optional system prompt.
 * @param {object[]} opts.chain                Ordered model configs from resolveChain().
 * @param {(req:object)=>Promise<object>} opts.llmChat   Transport (electron/llm/proxy.mjs llmChat).
 * @param {(format:string)=>Promise<object[]>} opts.listTools
 * @param {(name:string, args:object)=>Promise<object>} opts.runTool
 * @param {{allow?:string[], deny?:string[]}} [opts.toolPolicy]
 * @param {number} [opts.maxRounds]
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onEvent]  Progress sink (log / usage), mapped to NodeEvents.
 * @returns {Promise<{ok:true, text:string, rounds:number, modelUsed:string, usage:object}
 *                 | {ok:false, error:string, modelUsed?:string}>}
 */
export async function runAgentTurn({
  prompt,
  system,
  chain,
  llmChat,
  listTools,
  runTool,
  toolPolicy,
  maxRounds = DEFAULT_MAX_ROUNDS,
  signal,
  onEvent = () => {},
}) {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error("runAgentTurn requires a model chain");
  if (!prompt || !String(prompt).trim()) throw new Error("agent node requires a non-empty prompt");

  const tools = await buildToolList({ listTools, toolPolicy });
  const messages = [];
  if (system) messages.push({ role: "system", content: String(system) });
  messages.push({ role: "user", content: String(prompt) });

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError = null;

  // Provider fallback (§6.1): walk the chain until one model responds. Node-level retry is the
  // Execution Manager's job -- doing both here would multiply the attempt count.
  for (const model of chain) {
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    const attempt = await runWithModel({
      model, messages: [...messages], tools, llmChat, runTool, toolPolicy, maxRounds, signal, onEvent, usage,
    });
    if (attempt.ok) return { ...attempt, usage, modelUsed: model.label };
    lastError = attempt.error;
    if (attempt.fatal) return { ok: false, error: lastError, modelUsed: model.label };
    await onEvent({ type: "log", level: "warn", message: `model "${model.label}" failed (${lastError}); trying fallback` });
  }

  return { ok: false, error: lastError ?? "all models failed" };
}

/** One model's full multi-round attempt. `fatal` marks errors no fallback model could fix. */
async function runWithModel({ model, messages, tools, llmChat, runTool, toolPolicy, maxRounds, signal, onEvent, usage }) {
  // Local models are uncapped (see LOCAL_MAX_ROUNDS): the round ceiling exists to bound spending.
  const local = isLocalModel(model);
  const roundCap = local ? LOCAL_MAX_ROUNDS : maxRounds;
  for (let round = 1; round <= roundCap; round++) {
    if (signal?.aborted) return { ok: false, error: "cancelled", fatal: true };

    // The last round is spent asking for an answer, not for more research. A model that used its
    // whole budget on tool calls has usually *gathered* what it needed and simply never stopped; the
    // old behaviour threw all of that away and failed the node, which for a fanned-out research step
    // means paying for ten searches and getting nothing. Withdrawing the tools removes the option it
    // keeps taking, so this is a forced answer, not a silent partial one.
    const finalRound = round === roundCap && tools.length > 0;
    if (finalRound) {
      messages.push({
        role: "user",
        content:
          "You have used your entire tool budget for this task. No further tool calls are possible. " +
          "Answer now, using only what you already have, in exactly the format originally requested. " +
          "If something could not be established, say so in that answer rather than asking for more time.",
      });
      await onEvent({
        type: "log",
        level: "warn",
        message: `round budget spent after ${roundCap - 1} rounds; asking for a final answer with no tools`,
      });
    }

    const body = { model: model.model, messages, temperature: 0.2 };
    if (tools.length && !finalRound) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // Pass the signal so a "Stop" aborts the in-flight request itself, not just the gap between rounds
    // — a slow local model can hold one request open for a long time.
    const res = await llmChat({ endpoint: model.endpoint, apiKey: model.apiKey, body, signal });
    if (signal?.aborted) return { ok: false, error: "cancelled", fatal: true };
    if (!res?.ok) {
      const detail = res?.error || (res?.data ? JSON.stringify(res.data).slice(0, 300) : "");
      return { ok: false, error: `LLM request failed (status ${res?.status ?? "?"})${detail ? `: ${detail}` : ""}` };
    }

    accumulateUsage(usage, res.data?.usage);
    if (res.data?.usage) {
      // Awaited on purpose. onEvent applies backpressure, so the loop does not issue another paid
      // model call while the Policy Guard is still deciding whether this one broke the budget.
      // Local models report 0 tokens to the guard so they never accrue against limits.maxTokens —
      // their usage is free and uncounted (accumulateUsage above still keeps the real totals).
      await onEvent({ type: "usage", tokens: local ? 0 : res.data.usage.total_tokens ?? 0, model: model.label });
    }

    const choice = res.data?.choices?.[0];
    const message = choice?.message;
    if (!message) return { ok: false, error: "LLM returned no message" };

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = String(message.content ?? "").trim();
      // An empty final answer is a failure, not a success with no output: a downstream node reading
      // this node's `text` would otherwise silently receive "".
      if (!text) return { ok: false, error: "model returned an empty final message" };
      return { ok: true, text, rounds: round };
    }

    // The assistant turn must be echoed back verbatim before the tool results, or the next request
    // has tool messages with no matching tool_calls and providers reject it.
    messages.push(message);

    for (const call of calls) {
      if (signal?.aborted) return { ok: false, error: "cancelled", fatal: true };
      const result = await executeToolCall({ call, runTool, toolPolicy, onEvent });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Reached only when the model kept calling tools even in the round where none were offered. That
  // is a stuck agent, not a busy one, and reporting success on its last partial output would hide it.
  return { ok: false, error: `agent did not finish within ${roundCap} rounds`, fatal: true };
}

/** How much of a tool's result is kept for the timeline. Enough to recognise, not enough to re-host. */
const TOOL_PREVIEW_CHARS = 800;

/**
 * Tool arguments, safe to persist.
 *
 * These land in the event log verbatim, which is exactly where a key gets leaked by accident: the
 * model chose these values, so nothing upstream has vetted them. Same key-name test the approval
 * preview uses (executionManager.redact) — one rule, so a field redacted in one view is not printed
 * in plain text in the other.
 */
function redactArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = /key|token|secret|password|authorization/i.test(k) ? "[redacted]" : clip(v, 500);
  }
  return out;
}

function clip(value, max) {
  if (typeof value !== "string") return value;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Execute one tool call, converting every failure into a message the model can read and recover from.
 *
 * Emits a `tool:started` / `tool:finished` pair around every call, including the ones that are
 * refused. A run that spends four minutes searching used to produce one line reading `tool:
 * web_search` — true, and useless for answering the only question anyone actually asks of a timeline,
 * which is *what did it search for and what came back*. Started is emitted before the call rather
 * than folded into one event afterwards, so a slow fetch shows what it is waiting on while it waits.
 */
async function executeToolCall({ call, runTool, toolPolicy, onEvent }) {
  const name = call.function?.name ?? "";
  const startedAt = Date.now();
  const finish = (patch) => onEvent({ type: "tool:finished", name, ms: Date.now() - startedAt, ...patch });

  let args = {};
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    // Malformed arguments are the model's mistake; telling it beats aborting the run.
    const error = `arguments for "${name}" were not valid JSON`;
    await onEvent({ type: "tool:started", name, args: {} });
    await finish({ ok: false, error });
    return `Error: ${error}`;
  }

  await onEvent({ type: "tool:started", name, args: redactArgs(args) });

  // A refusal is a timeline event too. A tool policy that quietly blocks the one tool a step needed
  // otherwise shows up only as a strange final answer, with nothing on screen naming the cause.
  if (INTERACTIVE_TOOLS.includes(name)) {
    const error = `"${name}" needs a human and is unavailable in an automated run`;
    await finish({ ok: false, blocked: true, error });
    return `Error: ${error}. Continue without it.`;
  }
  if (!isToolAllowed(name, toolPolicy)) {
    const error = `"${name}" is not permitted by this workflow's tool policy`;
    await finish({ ok: false, blocked: true, error });
    return `Error: ${error}.`;
  }

  try {
    const out = await runTool(name, args);
    const content = String(typeof out === "string" ? out : (out?.content ?? JSON.stringify(out ?? null)));
    // `chars` alongside the clipped preview, so a truncated result reads as truncated rather than as
    // a tool that returned very little.
    await finish({ ok: true, chars: content.length, preview: clip(content, TOOL_PREVIEW_CHARS) });
    return content;
  } catch (e) {
    const error = e?.message || String(e);
    await finish({ ok: false, error });
    return `Error: ${error}`;
  }
}

/** Tool list for the request: the shared registry, minus interactive tools, minus policy denials. */
async function buildToolList({ listTools, toolPolicy }) {
  let all = [];
  try {
    all = (await listTools("openai")) ?? [];
  } catch (e) {
    console.warn("[agent] failed to list tools; running without them:", e?.message || e);
    return [];
  }
  return all.filter((t) => {
    const name = t?.function?.name ?? t?.name;
    if (!name || INTERACTIVE_TOOLS.includes(name)) return false;
    return isToolAllowed(name, toolPolicy);
  });
}

/** deny wins over allow; an absent allow-list means "everything not denied". */
export function isToolAllowed(name, policy) {
  if (!policy) return true;
  if (policy.deny?.includes(name)) return false;
  if (policy.allow?.length) return policy.allow.includes(name);
  return true;
}

function accumulateUsage(usage, u) {
  if (!u) return;
  usage.promptTokens += u.prompt_tokens ?? 0;
  usage.completionTokens += u.completion_tokens ?? 0;
  usage.totalTokens += u.total_tokens ?? 0;
}
