/**
 * `agent.run`: a whole agent turn inside the runtime, and everything the runtime asks the host while one runs.
 *
 * Split out of rustRuntime.mjs, which re-exports all of it — import from there. This module adds no process
 * management of its own: it rides on the core's transport (`request`, `notify`) and its dispatch tables
 * (`onEvent`, `onRequest`), and registers its handlers when it loads, as the core used to.
 */
import { ensureStarted, notify, onEvent, onRequest, request } from "./rustRuntimeCore.mjs";

/** Mints ids for runs whose caller brought none. Prefixed, so they can never collide with another module's. */
let callSeq = 0;

/**
 * Subscribers to a run's tokens as they arrive (`agent.delta`).
 *
 * Keyed by nothing: a listener receives every run's deltas and filters on `run_id` itself. One dispatch rather
 * than a registry, because a UI showing one conversation and a log recording all of them want different
 * subsets and neither is the natural owner of the map.
 */
const agentDeltaListeners = new Set();

/**
 * Listen to tokens from `agent.run`, as they are generated.
 *
 * Each payload is `{ run_id, content, reasoning }` carrying the INCREMENT since the last one — appending them
 * in order reconstructs the reply exactly once. The runtime flushes every delta before it answers the run, so a
 * listener never sees the finished text before the tokens that make it up.
 *
 * Returns an unsubscribe function.
 */
export function onAgentDelta(listener) {
  agentDeltaListeners.add(listener);
  return () => agentDeltaListeners.delete(listener);
}

onEvent("agent.delta", (params) => {
  for (const listener of agentDeltaListeners) {
    try {
      listener(params);
    } catch (e) {
      console.warn("[rust-runtime] an agent.delta listener threw:", e?.message ?? e);
    }
  }
});

/**
 * Answer the runtime's questions.
 *
 * `host.consent` and `host.ask` are REQUESTS, not events: the runtime is waiting, and a turn is blocked until
 * one of these returns. Both therefore have a safe default — deny, and no answers — so a host that has not
 * registered a handler still lets the run continue rather than stalling it until the runtime's timeout.
 *
 * Registering these is what makes `agent.run` usable by the app: without them a run can never take a gated
 * action and can never ask a question.
 */
let consentHandler = null;
let askHandler = null;

/** Decide whether one gated action may proceed. `req` is { capability, resource, call, agent, depth }. */
export function onConsentRequest(handler) {
  consentHandler = handler;
  return () => {
    if (consentHandler === handler) consentHandler = null;
  };
}

/** Put questions to the user. Receives the model's own `ask_user` arguments; returns whatever it answered. */
export function onAskRequest(handler) {
  askHandler = handler;
  return () => {
    if (askHandler === handler) askHandler = null;
  };
}

// `keepsHostAlive: false`: both of these can only arrive while an `agent.run` is in flight, and that call
// already holds the event loop open. Registering them as unprompted would mean a host that merely imported
// this module could never exit.
onRequest(
  "host.consent",
  async (params) => {
  if (!consentHandler) {
    // Denied rather than stalled. A runtime that cannot ask must not proceed as though it had asked, and a
    // host with no handler is exactly that case seen from the other side.
    console.warn("[rust-runtime] a consent request arrived with no handler registered; denying");
    return { approved: false };
  }
    return { approved: Boolean(await consentHandler(params)) };
  },
  { keepsHostAlive: false },
);

onRequest(
  "host.ask",
  async (params) => {
    // A run that brought its own rules answers for itself. `ask_user` is the one tool the runtime routes to a
    // method of its own rather than through `host.tool`, so without this lookup a run's tool policy would
    // apply to every tool EXCEPT the one that most obviously needs a person — an unattended automation would
    // receive an empty answer and read it as a real one, rather than being told the tool is unavailable.
    const perRun = runToolHandlers.get(String(params?.run_id ?? ""));
    if (perRun) return { answers: await perRun("ask_user", params ?? {}) };
    if (!askHandler) {
      console.warn("[rust-runtime] a question arrived with no handler registered; answering nothing");
      return { answers: [] };
    }
    return { answers: await askHandler(params) };
  },
  { keepsHostAlive: false },
);

/**
 * Run the tools the runtime does not implement.
 *
 * The runtime asks for a tool whenever the model calls one that is not in its own registry — an MCP server's,
 * a plugin's, or one of the app's own. Without this handler `agent.run` can only ever offer the model the
 * filesystem and process tools, which is not a catalog anyone would route a real conversation to.
 *
 * The handler receives `{ name, args }` and returns `{ ok, content }` — the same pair `tool.call` answers
 * with, so the app has one tool-result shape regardless of which direction the call came from.
 */
let hostToolHandler = null;

/**
 * Per-run overrides, keyed by run id.
 *
 * A run carries its own tool policy — an unattended automation refuses the tools that need a person, a chat
 * window offers them — and several runs are in flight at once. Routing on the id is what keeps one run's
 * refusal from applying to another's call; `runAgent` registers and removes the entry around the run.
 */
const runToolHandlers = new Map();

/**
 * Per-run round gates, keyed by run id. See `runAgent`'s `roundGate` option and `host.round`.
 *
 * Only the runs that asked for one have an entry. A run without a gate is never asked about, so an absent
 * entry means the runtime should not have asked — which is worth saying rather than silently allowing.
 */
const runRoundGates = new Map();

/** Serve host-implemented tools for runs inside the runtime. Returns an unsubscribe function. */
export function onHostTool(handler) {
  hostToolHandler = handler;
  return () => {
    if (hostToolHandler === handler) hostToolHandler = null;
  };
}

// `keepsHostAlive: false` for the reason the other two are: a host tool can only be asked for while an
// `agent.run` is in flight, and that outbound call already holds the event loop open.
onRequest(
  "host.tool",
  async (params) => {
    const name = String(params?.name ?? "");
    const handler = runToolHandlers.get(String(params?.run_id ?? "")) ?? hostToolHandler;
    if (!handler) {
      // A result, not a transport error. The model is mid-turn and can act on "that tool is not available
      // here"; it can do nothing with a protocol failure, and the run would lose the round either way.
      console.warn(`[rust-runtime] the runtime asked for ${name} with no host tool handler registered`);
      return { ok: false, content: `${name} is not available in this app. Continue without it.` };
    }
    const out = await handler(name, params?.args ?? {});
    // Normalised here rather than trusted: `runTool` has several shapes in the wild (a string, a bare
    // object, `{ ok, content }`), and the runtime's contract is exactly one of them.
    if (typeof out === "string") return { ok: true, content: out };
    return { ok: out?.ok !== false, content: String(out?.content ?? "") };
  },
  { keepsHostAlive: false },
);

/**
 * Answer "may another round start?" for a run that asked to be gated.
 *
 * The runtime fails CLOSED on anything it cannot get an answer to, so every path here ends in a definite
 * reply — including the paths where something is wrong. Returning nothing would stop a run that was fine.
 */
onRequest(
  "host.round",
  async (params) => {
    const gate = runRoundGates.get(String(params?.run_id ?? ""));
    if (!gate) {
      // The run did not ask for a gate, or it has already finished. Neither is a reason to stop it: only a
      // run that requested gating has a rule to apply, and there is none to consult here.
      return { proceed: true };
    }
    const last = params?.last;
    const decision = (await gate({
      round: Number(params?.round ?? 0),
      promptTokens: Number(params?.prompt_tokens ?? 0),
      completionTokens: Number(params?.completion_tokens ?? 0),
      // The last round was a final answer: the run completes unless the gate answers `resume`.
      final: Boolean(params?.final),
      // The round that just closed — what it said, what ran, what the loop detector noticed. Null before the
      // first round.
      last: last
        ? {
            contentEmpty: Boolean(last.content_empty),
            hasReasoning: Boolean(last.has_reasoning),
            calls: (last.calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args ?? {}, ok: c.ok !== false })),
            signals: (last.signals ?? []).map((g) => ({
              callId: g.call_id,
              name: g.name,
              signal: g.signal,
              repeat: Number(g.repeat ?? 0),
              failStreak: Number(g.fail_streak ?? 0),
              resourceHits: Number(g.resource_hits ?? 0),
            })),
          }
        : null,
    })) ?? {};
    return {
      proceed: decision.proceed !== false,
      detail: decision.detail ? String(decision.detail) : undefined,
      withdraw_tools: Boolean(decision.withdrawTools),
      // Appended to the conversation before the round. Provider-shaped messages, as everywhere else on
      // this path: the host already speaks that shape and translating twice is how the two drift.
      inject: Array.isArray(decision.inject) ? decision.inject : [],
      // Appended to the turn's latest tool result, joined with a blank line — where the chat page's nudges go.
      nudge: typeof decision.nudge === "string" && decision.nudge ? decision.nudge : undefined,
      resume: Boolean(decision.resume),
    };
  },
  { keepsHostAlive: false },
);

/**
 * Subscribers to a run's tool activity (`agent.tool`) and round boundaries (`agent.turn`).
 *
 * Sets rather than single handlers, for the reason `runtime.event` keeps one: a transcript, the usage log and
 * the sub-agent inspector all legitimately want these at once.
 */
const agentToolListeners = new Set();
const agentTurnListeners = new Set();

/**
 * Listen to a run's tool calls as they start and finish.
 *
 * Each payload is `{ run_id, phase: "start" | "end", id, name, ok?, ms? }`. Without this a UI can only show a
 * run's final text, which is the difference between watching an agent work and watching a spinner.
 */
export function onAgentTool(listener) {
  agentToolListeners.add(listener);
  return () => agentToolListeners.delete(listener);
}

/**
 * Listen to a run's round boundaries.
 *
 * `{ run_id, phase, round, effort?, tool_calls?, prompt_tokens?, completion_tokens?, ms? }`. The `end` phase
 * is where a caller accounts for what a round cost — the usage log and any spend guard read it from here,
 * because inside a run the host no longer issues the model requests itself.
 */
export function onAgentTurn(listener) {
  agentTurnListeners.add(listener);
  return () => agentTurnListeners.delete(listener);
}

const fanOut = (what, listeners) => (params) => {
  for (const listener of listeners) {
    try {
      listener(params);
    } catch (e) {
      console.warn(`[rust-runtime] an ${what} listener threw:`, e?.message ?? e);
    }
  }
};
onEvent("agent.tool", fanOut("agent.tool", agentToolListeners));
onEvent("agent.turn", fanOut("agent.turn", agentTurnListeners));

/**
 * Subscribers to a run's transport retries (`agent.retry`): `{ run_id, attempt, attempts, kind, delay_ms, message }`.
 *
 * "Told, never silent" — the rule `withRequestRetry` follows in the renderer. A retry nobody hears about turns a
 * failing network into an app that is merely slow. When one fires, the reply streamed so far is also being
 * discarded, and the next `agent.delta` carries `reset: true`.
 */
const agentRetryListeners = new Set();
export function onAgentRetry(listener) {
  agentRetryListeners.add(listener);
  return () => agentRetryListeners.delete(listener);
}
onEvent("agent.retry", fanOut("agent.retry", agentRetryListeners));

/**
 * Run one whole agent turn inside the runtime.
 *
 * This is the call the migration was built toward: the Model → Tool → Result cycle runs in Rust, and the host
 * supplies only what genuinely lives in the app — the provider's address, the conversation, the tool
 * declarations, and answers to `host.tool` / `host.consent` / `host.ask`.
 *
 * `contextWindow` is the model's window in tokens. Supplying it lets the runtime compact a conversation that
 * no longer fits; omitting it sends the conversation as it stands. Note the runtime returns the transcript
 * VERBATIM either way — compaction changes what the model is sent, never what the caller gets back.
 *
 * `assetDir` is the read-only second root (the media library). It travels with `workdir` for the same reason
 * it does on `tool.call`: the runtime executes its own file tools inside the run, and without it those tools
 * simply cannot see the library — which is a capability the caller's own loop had.
 *
 * Returns the runtime's `AgentRunResult` (`{ stop_reason, content, rounds, tool_calls, messages, … }`), or
 * **null** when the runtime cannot serve the call at all. Null is only ever returned BEFORE the run starts —
 * a runtime that is off, absent or too old — so a caller that has its own loop can fall back without any risk
 * of having run the turn twice. After dispatch, every outcome is a result or a throw.
 *
 * Cancellation goes through `call.cancel` under `runId`, which is the same id every other kind of work is
 * stopped by: the user's Stop button does not need to know whether it is stopping a command, a delegation or
 * a whole turn.
 *
 * No IPC deadline. A turn legitimately runs for many minutes, and the runtime's own stop policy is the bound —
 * imposing a shorter one here would abandon a run that was working, and the host cannot tell what its tools
 * had already done by then.
 */
/**
 * Extra provider headers, reduced to ones HTTP can carry. The runtime sends them verbatim, and one bad name or
 * value fails the request it is on — every request of the run, since they all carry it. A header that could not
 * be sent is dropped here instead: losing a KV-cache hint costs a slower reply, not the turn.
 */
function requestHeaders(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

export async function runAgent(
  { runId, workdir, assetDir, provider, messages, tools, contextWindow, summarizerModel, parallelTools, replayReasoning, hostToolsOnly, thinking } = {},
  { onDelta, onTool, onTurn, onRetry, toolHandler, roundGate, signal } = {},
) {
  const s = await ensureStarted();
  if (!s || !s.features.has("agent.stream")) return null;
  // Without the bridge the runtime can only offer the model its own registry, so a run would silently lose
  // every MCP, plugin and app tool. Declining is honest; running a crippled turn is not.
  if (!s.features.has("agent.host_tools")) {
    console.warn(
      "[rust-runtime] this runtime predates the host tool bridge; the turn stays on the caller's own loop. " +
        "Rebuild it with `npm run build:runtime`.",
    );
    return null;
  }
  // A caller that needs every tool handed back (a chat window: its consent prompts live on that path) must not be
  // served by a runtime too old to know the option — it would ignore it and run file tools itself, past the
  // prompt. Declined before anything runs, so the caller's own loop takes the turn.
  if (hostToolsOnly && !s.features.has("agent.round_context")) {
    console.warn(
      "[rust-runtime] this runtime predates host_tools_only; the turn stays on the caller's own loop. " +
        "Rebuild it with `npm run build:runtime`.",
    );
    return null;
  }
  if (signal?.aborted) return null; // nothing has run yet: let the caller decide, as it always could
  // The protocol's `workdir` is a required string, so a missing one is a request the runtime would refuse to
  // parse. Declining here instead keeps that a caller's fallback rather than a mid-turn protocol error.
  if (!workdir) {
    console.warn("[rust-runtime] agent.run needs a workspace; the turn stays on the caller's own loop");
    return null;
  }

  const id = runId || `a${++callSeq}`;
  const onAbort = () => notify(s, "call.cancel", { call_id: id });
  signal?.addEventListener("abort", onAbort, { once: true });
  // Subscribed for this run only, and filtered on its id: the event streams carry every run's activity.
  const mine = (fn) => (params) => {
    if (params?.run_id === id) fn(params);
  };
  const unsubscribe = [
    onDelta && onAgentDelta(mine(onDelta)),
    onTool && onAgentTool(mine(onTool)),
    onTurn && onAgentTurn(mine(onTurn)),
    onRetry && onAgentRetry(mine(onRetry)),
  ].filter(Boolean);
  // Registered BEFORE the request goes out. The runtime can ask for a tool in the same round trip, and a
  // handler installed after the send would miss it — the registration race this migration has already paid
  // for several times over (see subagentBridge.mjs).
  if (toolHandler) runToolHandlers.set(id, toolHandler);
  if (roundGate) runRoundGates.set(id, roundGate);

  try {
    return await request(
      s,
      "agent.run",
      {
        run_id: id,
        workdir,
        asset_dir: assetDir || null,
        provider: {
          endpoint: provider?.endpoint ?? "",
          api_key: provider?.apiKey ?? "",
          model: provider?.model ?? "",
          thinking_params: provider?.thinkingParams ?? {},
          // The same fields for each effort a round may be issued at. The loop economises routine rounds, and how
          // a lower effort is spelled is the host's knowledge, family by family, as `thinkingParams` is.
          thinking_by_effort:
            provider?.thinkingByEffort && typeof provider.thinkingByEffort === "object" ? provider.thinkingByEffort : {},
          stream: provider?.stream !== false,
          supports_per_turn_reasoning_effort: Boolean(provider?.supportsPerTurnReasoningEffort),
          // Omitted rather than defaulted when the caller has no opinion: see ProviderConfig::temperature.
          temperature: typeof provider?.temperature === "number" ? provider.temperature : null,
          // `X-Conversation-Id` for a local llama-server, which restores a conversation's KV cache by it. The
          // runtime never sends it on the summariser's requests.
          headers: requestHeaders(provider?.headers),
          // What the app already knows this model refuses, so a known refusal costs no failed request. The
          // run reports back what it learned in `learned`.
          known: provider?.known && typeof provider.known === "object" ? provider.known : {},
          // "direct" or a proxy URL, when the caller resolved one; absent, the runtime's environment decides.
          proxy: typeof provider?.proxy === "string" && provider.proxy ? provider.proxy : null,
        },
        messages: messages ?? [],
        tools: tools ?? [],
        // Declaring the window turns context management on inside the runtime: the conversation is kept
        // within it by eliding tool output, then summarising the older part, then truncating. Omitted when
        // the caller does not know the window — a guessed one compacts conversations that would have fitted.
        context_window: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null,
        summarizer_model: summarizerModel || null,
        round_gate: Boolean(roundGate),
        // Tools that may run side by side when the model asks for several in a row; only consecutive ones are
        // batched. Named by the host, which is the side that knows which of its tools touch nothing.
        parallel_tools: Array.isArray(parallelTools) ? parallelTools.filter((n) => typeof n === "string") : [],
        // Send each round's thinking back within the turn — the host's reasoning-replay policy, applied inside.
        replay_reasoning: Boolean(replayReasoning),
        // Every tool call to the host, the runtime's own tools and `ask_user` included — for a caller whose tool
        // path carries consent, display and logging it must keep (a chat window).
        host_tools_only: Boolean(hostToolsOnly),
        // The user's switch and ceiling for the loop's per-round effort. Absent, the runtime assumes on at medium.
        thinking:
          thinking && typeof thinking === "object"
            ? { enabled: Boolean(thinking.enabled), effort: String(thinking.effort ?? "medium") }
            : null,
      },
      0,
    );
  } catch (e) {
    // The same split `tryRunProcess` makes, and for the same reason. `notSent` means the write itself failed,
    // so no round ran, no tool ran, and handing the turn back to the caller's loop costs nothing. Anything
    // else happened AFTER dispatch — tools may have run — and must surface as a failure rather than as a
    // second attempt at work that may already have taken effect.
    if (e?.notSent) {
      console.warn(`[rust-runtime] agent.run was not dispatched; the caller's own loop runs it: ${e?.message ?? e}`);
      return null;
    }
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    for (const off of unsubscribe) off();
    runToolHandlers.delete(id);
    runRoundGates.delete(id);
  }
}
