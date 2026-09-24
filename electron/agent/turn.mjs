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
 *
 * ## The orchestration is no longer duplicated by default (2026-09-21)
 *
 * `runWithModelInRuntime` hands the whole round cycle to the Rust runtime's `agent.run`, and the loop below it
 * is the fallback for when the runtime cannot serve it. Three things had to exist before that was possible,
 * and each is the answer to something this file does that a loop in Rust could not:
 *
 *  - **the host tool bridge** (`host.tool`), because most of an automation's catalog — MCP servers, plugins,
 *    the app's own tools — is implemented in Electron and always will be;
 *  - **the round gate** (`host.round`), because the Policy Guard aborts a node the moment a ceiling is
 *    crossed, and it can only do that if something asks it between rounds. Owning the loop used to be how
 *    this file provided that; the gate is how it provides it without owning the loop;
 *  - **message injection on that gate**, because the round budget does not merely stop a node — it withdraws
 *    the tools and asks for a final answer in the format originally requested.
 *
 * What stays here: the provider chain (one `agent.run` per model until one answers), the tool policy, the
 * refusal of interactive tools, and the NodeEvent timeline. Those are the automation's rules, not the loop's.
 */
import { runAgent, servedTools } from "../tools/rustRuntime.mjs";

/**
 * Whether a node's turn may run inside the Rust runtime. On unless explicitly turned off.
 *
 * The kill switch exists because this is the first path where the model loop itself moved out of JavaScript,
 * and a bad round there is a whole node's output rather than one tool call. Turning it off restores the loop
 * below, which is unchanged and still covered by its own tests.
 */
function runtimeLoopEnabled() {
  const raw = String(process.env.ZERAIX_RUST_AGENT_LOOP ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false");
}

/** Tools that require a human in the loop. Never offered to a headless run (see module header). */
export const INTERACTIVE_TOOLS = Object.freeze([
  "ask_user",
  "update_todos",
  "openBrowser",
  "browser",
  "image_generation",
  "run_subagent",
  // Setting up an MCP server means granting trust: it writes a third-party command into the app's
  // configuration, marks it approved, and runs it. That decision belongs to a human who was shown the
  // command line, and an unattended run has nobody to show it to -- so an automation cannot install
  // servers, only use the ones a user already approved (those still reach it through listTools).
  "mcp_discover",
  "mcp_connect",
]);

/**
 * Rounds allowed when a node does not say. `null` = unbounded.
 *
 * This was 12, as a safety net against a looping model. The net caught the wrong thing: a round cap fires on
 * the tally, so it ended the runs doing the most work and left a node reporting failure after paying for
 * every round it had. What stops a genuinely stuck agent is the tool policy and the model's own final answer,
 * neither of which counts rounds.
 *
 * A node that wants a ceiling still sets `maxRounds` explicitly, and the automation templates do.
 */
const DEFAULT_MAX_ROUNDS = null;

/**
 * Local models run on the user's own machine: no per-token cost, so the round and token ceilings that
 * exist to bound a *bill* don't apply. We lift them for local models — but a *finite* headroom, not
 * infinity: a stuck local model still appends to the message history every round, so an unbounded cap
 * is a memory/CPU runaway (it ate 6GB once). This is generous vs the 12-round default yet still bounded;
 * local tokens are reported as 0 so they never accrue against limits.maxTokens. Locality is decided by
 * the endpoint, matching the renderer's isLocalEndpoint.
 */
const LOCAL_MAX_ROUNDS = null;
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
 * @param {number|null} [opts.maxRounds]  Round ceiling for this node; null (the default) is unbounded.
 * @param {() => string} [opts.getWorkdir]  The workspace the runtime scopes its own file tools to. Injected
 *   like every other transport here, so this module keeps no `electron` import. Absent → the runtime path is
 *   skipped, because a run with the wrong workspace root is worse than a run on the loop below.
 * @param {() => string} [opts.getAssetDir]  The read-only media root, which travels with the workspace.
 * @param {(call:object)=>void} [opts.onModelCall]  One finished model request, for the usage log. Called only
 *   on the runtime path: on the loop below the transport logs it (electron/llm/proxy.mjs), and logging it
 *   here too would double every round in the totals.
 * @param {object} [opts.meta]                 Attribution passed through to the transport (see the
 *                                             usage log in electron/llm/proxy.mjs). Opaque here.
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
  meta,
  signal,
  getWorkdir,
  getAssetDir,
  onModelCall,
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
      model, messages: [...messages], tools, llmChat, runTool, toolPolicy, maxRounds, meta, signal, onEvent, usage,
      getWorkdir, getAssetDir, onModelCall,
    });
    if (attempt.ok) return { ...attempt, usage, modelUsed: model.label };
    lastError = attempt.error;
    if (attempt.fatal) return { ok: false, error: lastError, modelUsed: model.label };
    await onEvent({ type: "log", level: "warn", message: `model "${model.label}" failed (${lastError}); trying fallback` });
  }

  return { ok: false, error: lastError ?? "all models failed" };
}

/** One model's full multi-round attempt. `fatal` marks errors no fallback model could fix. */
async function runWithModel({ model, messages, tools, llmChat, runTool, toolPolicy, maxRounds, meta, signal, onEvent, usage, getWorkdir, getAssetDir, onModelCall }) {
  // Local models are uncapped (see LOCAL_MAX_ROUNDS): the round ceiling exists to bound spending.
  const local = isLocalModel(model);
  // `null` anywhere here means unbounded: a local model has no per-token cost, and the default is now
  // uncapped for everyone. An explicit per-node `maxRounds` is still honoured.
  const roundCap = local ? LOCAL_MAX_ROUNDS : maxRounds;

  // The runtime owns the cycle when it can. `null` means it could not take it — the runtime is off, absent,
  // or older than the two seams this needs — and nothing has run at that point, so the loop below picks it up
  // with no risk of a round happening twice.
  if (runtimeLoopEnabled() && getWorkdir) {
    const offloaded = await runWithModelInRuntime({
      model, messages, tools, runTool, toolPolicy, roundCap, signal, onEvent, usage, getWorkdir, getAssetDir,
      onModelCall, local,
    });
    if (offloaded) return offloaded;
  }

  for (let round = 1; roundCap === null || round <= roundCap; round++) {
    if (signal?.aborted) return { ok: false, error: "cancelled", fatal: true };

    // The last round is spent asking for an answer, not for more research. A model that used its
    // whole budget on tool calls has usually *gathered* what it needed and simply never stopped; the
    // old behaviour threw all of that away and failed the node, which for a fanned-out research step
    // means paying for ten searches and getting nothing. Withdrawing the tools removes the option it
    // keeps taking, so this is a forced answer, not a silent partial one.
    const finalRound = roundCap !== null && round === roundCap && tools.length > 0;
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
    // `meta` is attribution for the usage log only; the transport ignores it when logging is off.
    const res = await llmChat({
      endpoint: model.endpoint,
      apiKey: model.apiKey,
      body,
      signal,
      ...(meta ? { meta: { ...meta, round } } : {}),
    });
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
  //
  // Unreachable when `roundCap` is null, which is now the default: the loop above only exits through a final
  // answer, a cancellation or an error. Kept for the nodes that still set `maxRounds` themselves.
  return { ok: false, error: `agent did not finish within ${roundCap} rounds`, fatal: true };
}

/**
 * What the model is told when its round budget is spent. Injected by the round gate — see the module header.
 *
 * Verbatim from the loop below, which used to push it itself. One wording, so a node hitting its cap reads the
 * same whichever side ran the turn.
 */
const FINAL_ROUND_INSTRUCTION =
  "You have used your entire tool budget for this task. No further tool calls are possible. " +
  "Answer now, using only what you already have, in exactly the format originally requested. " +
  "If something could not be established, say so in that answer rather than asking for more time.";

/**
 * One model's full attempt, run inside the Rust runtime.
 *
 * Returns the same `{ok, text, rounds}` / `{ok:false, error, fatal?}` shape `runWithModel` returns, or **null**
 * meaning "the runtime could not take this turn". Null is only ever returned before the run starts, so the
 * caller's own loop can pick it up without any chance of a round having already happened — the same rule
 * `tryRunProcess` follows, and for the same reason.
 */
async function runWithModelInRuntime({
  model, messages, tools, runTool, toolPolicy, roundCap, signal, onEvent, usage, getWorkdir, getAssetDir,
  onModelCall, local,
}) {
  let workdir = "";
  try {
    workdir = String(getWorkdir() ?? "");
  } catch {
    /* no workspace to scope the run to; the loop below runs it instead */
  }
  if (!workdir) return null;
  // The media library. Absent is fine — that is a workspace with no second root — but a THROW is not
  // something to swallow into "no assets", so it is resolved the same guarded way the workspace is.
  let assetDir = "";
  try {
    assetDir = String(getAssetDir?.() ?? "");
  } catch {
    /* no media root configured */
  }

  // Rounds that have finished but whose cost the Policy Guard has not been told about yet.
  //
  // Reported from the GATE rather than as each round ends, because the guard's answer has to arrive before the
  // next paid model call and only the gate is a moment the runtime waits at. This is the one property the
  // loop below provides by awaiting `onEvent` mid-loop, and losing it would mean a node that breaks its
  // budget keeps spending until the round after the one that broke it.
  const unreported = [];
  let announcedFinalRound = false;
  // Which tools the runtime serves itself — see `onTool` below. A snapshot is right: the list is fixed at the
  // runtime's handshake and a turn does not outlive it.
  const runtimeTools = new Set(servedTools());

  // `usage` is the WHOLE turn's, across every model in the chain — so this attempt's numbers are added to
  // what earlier attempts already spent, never assigned over them. The runtime reports its own run
  // cumulatively, so the baseline is what makes the two add up rather than overwrite.
  const base = {
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.totalTokens,
  };
  const accumulate = (promptTokens, completionTokens) => {
    usage.promptTokens = base.prompt + promptTokens;
    usage.completionTokens = base.completion + completionTokens;
    usage.totalTokens = base.total + promptTokens + completionTokens;
  };

  const drainUsage = async () => {
    while (unreported.length) {
      const tokens = unreported.shift();
      // Local models report 0 to the guard so they never accrue against limits.maxTokens; their real totals
      // are still accumulated in `usage`.
      await onEvent({ type: "usage", tokens: local ? 0 : tokens, model: model.label });
    }
  };

  let result;
  try {
    result = await runAgent(
    {
      runId: `auto-${model.label ?? "model"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      workdir,
      assetDir,
      // What keeps a long node inside its model's window. `resolveChain` carries it from the persisted model
      // entry and leaves it null when the app does not know it, in which case the runtime compacts nothing —
      // which is what every automation node did before this.
      contextWindow: model.contextWindow ?? null,
      provider: {
        endpoint: model.endpoint,
        apiKey: model.apiKey,
        model: model.model,
        // The temperature this loop has always sent. Not a default worth losing on the way across: a
        // workflow step that quietly moved to the provider's own would produce different output for the
        // same input, and nothing would fail to say so.
        temperature: 0.2,
        // Non-streaming, matching `llmChat`: an automation has no window rendering tokens, and a stream would
        // only add a failure mode to a path with nobody watching it.
        stream: false,
      },
      messages,
      tools,
    },
    {
      signal,
      // Every tool, including the ones the runtime implements: `serves()` on the Rust side already decided
      // which calls reach here, and it only sends the ones it cannot run itself.
      toolHandler: (name, args) => runOneTool({ name, args, runTool, toolPolicy, onEvent }),
      roundGate: async ({ round, promptTokens, completionTokens, final }) => {
        // Asked once more after the final answer, in case the host wants another round. An automation node
        // never does: its answer is the answer, and the usage it cost is settled from the result below.
        if (final) return { proceed: true };
        accumulate(promptTokens, completionTokens);
        await drainUsage();
        // The guard aborts the node by signalling rather than by throwing, so this is where that lands.
        if (signal?.aborted) return { proceed: false, detail: "cancelled" };
        if (roundCap === null || roundCap === undefined) return { proceed: true };

        // `round` is 0-based and names the round about to start, so the last one allowed is `roundCap - 1`.
        if (round >= roundCap) {
          return { proceed: false, detail: `agent did not finish within ${roundCap} rounds` };
        }
        if (round === roundCap - 1 && tools.length > 0) {
          // The last round is spent asking for an answer, not for more research. A model that used its whole
          // budget on tool calls has usually gathered what it needed and simply never stopped; ending the node
          // there throws all of it away.
          if (!announcedFinalRound) {
            announcedFinalRound = true;
            await onEvent({
              type: "log",
              level: "warn",
              message: `round budget spent after ${roundCap - 1} rounds; asking for a final answer with no tools`,
            });
          }
          return {
            proceed: true,
            withdrawTools: true,
            inject: [{ role: "user", content: FINAL_ROUND_INSTRUCTION }],
          };
        }
        return { proceed: true };
      },
      // The timeline for tools the RUNTIME ran itself.
      //
      // Host-served tools come through `runOneTool`, which reports them. The runtime's own tools — list, read,
      // write, search, run a command — never reach the host, so without this a node that listed a directory
      // and read three files showed a timeline with no tool in it at all, and the usage log (which is built
      // from these same events) recorded none of them. Found running an automation end to end in the app; no
      // test caught it because every test used a host-served tool.
      //
      // Deciding by name against the runtime's own registry: that is exactly the rule `HostBridge::serves`
      // applies on the other side, so a tool is reported by one side and never by both. `ask_user` is the
      // registry-independent exception there and here.
      onTool: (e) => {
        if (!runtimeTools.has(e?.name) || e.name === "ask_user") return;
        if (e.phase === "start") {
          let args = {};
          try {
            args = e.arguments ? JSON.parse(e.arguments) : {};
          } catch {
            /* malformed arguments are reported by the runtime's own result */
          }
          void onEvent({ type: "tool:started", name: e.name, args: redactArgs(args) });
        } else if (e.phase === "end") {
          const content = String(e.content ?? "");
          void onEvent({
            type: "tool:finished",
            name: e.name,
            ms: Number(e.ms ?? 0),
            ok: e.ok !== false,
            chars: content.length,
            preview: clip(content, TOOL_PREVIEW_CHARS),
            ...(e.ok === false ? { error: clip(content, TOOL_PREVIEW_CHARS) } : {}),
          });
        }
      },
      onTurn: (e) => {
        if (e?.phase !== "end") return;
        const prompt = Number(e.prompt_tokens ?? 0);
        const completion = Number(e.completion_tokens ?? 0);
        unreported.push(prompt + completion);
        // The usage log. On the loop below every model call goes through `llmChat`, which logs it in the
        // proxy — "the ONE place every request goes through", as that file puts it. A run inside the
        // runtime does not go through it, so without this an automation's model calls simply stop
        // appearing in the log while its tool calls carry on.
        onModelCall?.({
          model: model.model,
          label: model.label,
          endpoint: model.endpoint,
          promptTokens: prompt,
          completionTokens: completion,
          cachedTokens: Number(e.cached_tokens ?? 0),
          estimated: Boolean(e.estimated),
          // The request alone: the round's `ms` also covers its tools, and would bill a slow tool to the model.
          ms: Number(e.model_ms ?? e.ms ?? 0),
          ok: true,
        });
      },
      // A request being retried, on the timeline. The loop below never retries (`llmChat` fails a node on the
      // first 503); the runtime does, and a node that spent a minute riding out its provider's 503s should say
      // so rather than look hung.
      onRetry: (e) => {
        void onEvent({
          type: "log",
          level: "warn",
          message: `model request failed (${e?.kind ?? "error"}); retrying in ${Math.round(Number(e?.delay_ms ?? 0) / 100) / 10}s (attempt ${Number(e?.attempt ?? 0) + 1}/${e?.attempts ?? "?"}): ${e?.message ?? ""}`,
        });
      },
    },
    );
  } catch (e) {
    // The run was dispatched and then something went wrong with the sidecar itself. Reported as this
    // attempt's failure rather than thrown: an exception escaping here would skip the usage accounting
    // below, so the Policy Guard would never hear about rounds that were already paid for.
    //
    // `fatal`, so the chain does not try another model. Tools may have run — that is the whole reason
    // `runAgent` does not hand back a null after dispatch — and re-running the node from the top would
    // repeat whatever they did.
    await drainUsage();
    return { ok: false, error: `the agent runtime failed mid-run: ${e?.message ?? e}`, fatal: true };
  }
  if (!result) return null;

  // The final round is never seen by a gate — there is no round after it to ask about — so its cost comes
  // from the result. Without this the last model call of every turn was spent but never counted.
  accumulate(Number(result.prompt_tokens ?? 0), Number(result.completion_tokens ?? 0));
  await drainUsage();
  // A request that failed for good never finished a round, so `onTurn` never saw it. The proxy logs the loop
  // below's failures; this is the same entry for a run the proxy never saw.
  if (result.stop_reason === "error") {
    onModelCall?.({
      model: model.model,
      label: model.label,
      endpoint: model.endpoint,
      promptTokens: 0,
      completionTokens: 0,
      ok: false,
      error: String(result.detail ?? "error"),
    });
  }

  const text = String(result.content ?? "").trim();
  const rounds = Number(result.rounds ?? 0);
  const detail = result.detail ? String(result.detail) : "";
  switch (String(result.stop_reason ?? "")) {
    case "completed":
      // An empty final answer is a failure, not a success with no output: a downstream node reading this
      // node's `text` would otherwise silently receive "".
      return text ? { ok: true, text, rounds } : { ok: false, error: "model returned an empty final message" };
    case "cancelled":
      return { ok: false, error: "cancelled", fatal: true };
    // Deliberately NOT fatal: a provider that refused is exactly what the model chain exists for, and the
    // loop below reports its own request failures the same way.
    case "error":
      return { ok: false, error: `LLM request failed${detail ? `: ${detail}` : ""}` };
    case "host-stopped":
      return { ok: false, error: detail || "the run was stopped", fatal: true };
    default:
      // doom-loop, context-limit, the timeouts. No other model would do better with the same conversation,
      // and reporting the partial text as an answer would present a run that was cut short as a finished one.
      return {
        ok: false,
        error: `the agent stopped after ${rounds} round(s): ${result.stop_reason}${detail ? ` — ${detail}` : ""}`,
        fatal: true,
      };
  }
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
  let args = {};
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    // Malformed arguments are the model's mistake; telling it beats aborting the run.
    const error = `arguments for "${name}" were not valid JSON`;
    const startedAt = Date.now();
    await onEvent({ type: "tool:started", name, args: {} });
    await onEvent({ type: "tool:finished", name, ms: Date.now() - startedAt, ok: false, error });
    return `Error: ${error}`;
  }
  return runOneTool({ name, args, runTool, toolPolicy, onEvent });
}

/**
 * Run one tool by name, under this workflow's rules, and report it to the timeline.
 *
 * Split out of `executeToolCall` so both directions share it. When the runtime owns the loop it hands over a
 * name and parsed arguments rather than a provider's tool call — but the refusals, the timeline events and
 * the wording of a failure are the automation's, not the loop's, and having two copies of them is how an
 * unattended run starts refusing different things depending on who is driving.
 *
 * Always returns the text the model reads. Nothing here throws.
 */
async function runOneTool({ name, args, runTool, toolPolicy, onEvent }) {
  const startedAt = Date.now();
  const finish = (patch) => onEvent({ type: "tool:finished", name, ms: Date.now() - startedAt, ...patch });

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
