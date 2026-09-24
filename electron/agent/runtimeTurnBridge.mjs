/**
 * Routes a CHAT turn into the Rust runtime and back.
 *
 * The automation path reaches `agent.run` directly because it already lives in the main process. Chat does
 * not: the renderer is sandboxed and cannot reach the sidecar, so every part of a turn has to cross preload —
 * the tokens as they stream, each tool call as it starts and ends, every tool the runtime cannot run itself,
 * the between-rounds question, and the user's Stop. This module is the middle hop, in the shape
 * `subagentBridge.mjs` already uses for delegations.
 *
 * ## What the renderer still decides
 *
 * Every tool the runtime does NOT implement comes back to the window that started the turn, and nowhere else.
 * That is deliberate: the renderer's tool executor is where chat's consent prompts, tool rows, the browser
 * panel and the rest of its tool set live. Answering those here, in the main process, would give chat a second
 * tool policy — the drift this whole migration exists to remove.
 *
 * ## What the renderer does NOT decide
 *
 * The workspace. The caller of `initRuntimeTurnBridge` supplies it, from the same place the file tools read it,
 * and anything the renderer sends for `workdir` / `assetDir` is overwritten. The runtime scopes its own file
 * tools to that directory; letting the least-trusted process in the app choose it would make the renderer the
 * authority on what the agent may touch.
 *
 * ## On unless ZERAIX_RUST_CHAT_LOOP=off
 *
 * Checked here AND in preload, for the reason subagentBridge gives: the two gates fail differently. On by default
 * since 2026-09-23, after the cutover was verified in the packaged app and against a real provider. `page.tsx` hands
 * each turn to `runChatTurnInRuntime` (src/app/agent/chat/runtimeRound.ts) and keeps `runAgentLoop` as the
 * fallback, which also serves every turn a runtime cannot take (absent, or too old for `host_tools_only`). The
 * transport's share lives here — usage log entries below, retries and stream resets as events,
 * `X-Conversation-Id` as a provider header, known and learned refusals, the network route; the chat page does the
 * rest. See docs/rust-runtime-migration-request.md.
 */
import { ipcMain } from "electron";

import { runAgent } from "../tools/rustRuntime.mjs";

/**
 * How long a renderer-served tool may take. Long, because a tool may be waiting on the user — a consent
 * prompt, an `ask_user` question — and a person reading a dialog is not a stuck tool.
 */
const TOOL_TIMEOUT_MS = 30 * 60_000;

/**
 * How long the between-rounds question may take. Under the runtime's own 30 s gate timeout, so a slow renderer
 * gets a definite "no answer" from this side rather than racing the runtime's.
 */
const ROUND_TIMEOUT_MS = 25_000;

/** Whether chat turns may run in the runtime: yes, unless ZERAIX_RUST_CHAT_LOOP turns it off. See the header. */
export function chatLoopEnabled() {
  const raw = String(process.env.ZERAIX_RUST_CHAT_LOOP ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(raw);
}

/** runId -> { sender, controller }. One entry per turn in flight. */
const runs = new Map();
/** requestId -> { resolve, reject, timer, runId, sender } for a question the renderer is answering. */
const pending = new Map();
let seq = 0;

/**
 * Ask the window that owns `runId` something, and wait for its answer.
 *
 * Registered BEFORE the send: the renderer can answer in the same tick it receives, and an answer that
 * arrives before its entry exists is dropped — the registration race subagentBridge.mjs records as having
 * cost that migration four fixes.
 */
function askRenderer(runId, kind, body, timeoutMs) {
  const run = runs.get(runId);
  if (!run || run.sender.isDestroyed()) {
    return Promise.reject(new Error(`no window is running ${runId}`));
  }
  const requestId = `ar${++seq}`;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`the window did not answer the ${kind} request in time`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, runId, sender: run.sender });
  });
  run.sender.send("agent-run:request", { requestId, runId, kind, ...body });
  return answer;
}

/** Fail every question still open for a run, so nothing waits on a turn that has ended. */
function settleRun(runId, why) {
  for (const [requestId, entry] of pending) {
    if (entry.runId !== runId) continue;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(new Error(why));
  }
}

/**
 * Wire the bridge up. Safe to call with the flag off: it registers handlers and starts nothing.
 *
 * `getWorkdir` / `getAssetDir` are injected rather than imported so this module carries no dependency on the
 * tool toolkit, and so a test can drive it without loading one. `logUsage` likewise: it is the usage-log store's
 * `appendEntry`, which needs `electron`.
 */
export function initRuntimeTurnBridge({ getWorkdir, getAssetDir, logUsage } = {}) {
  ipcMain.handle("agent-run:start", async (e, { runId, params, gated } = {}) => {
    // Null, not an error: it means "not served here", and the renderer runs the turn on its own loop.
    if (!chatLoopEnabled()) return null;
    if (!runId || typeof runId !== "string") throw new Error("agent-run:start needs a runId");
    if (runs.has(runId)) throw new Error(`run ${runId} is already in flight`);

    const sender = e.sender;
    const controller = new AbortController();
    runs.set(runId, { sender, controller });
    // A window that closes mid-turn stops its turn. Nobody is left to answer its tools or read its tokens,
    // and a run left going would spend money on an answer with nowhere to arrive.
    //
    // Its outstanding questions are failed HERE, not left for the `finally` below. That `finally` cannot run
    // until the runtime returns, and the runtime was waiting on exactly those questions — each side waiting
    // on the other until the runtime's own three-minute host timeout broke the tie. Failing them now lets the
    // runtime see a failed tool and a cancelled run at once.
    const onGone = () => {
      controller.abort();
      settleRun(runId, "the window that started this turn was closed");
    };
    sender.once?.("destroyed", onGone);

    // Events are one-way and best-effort: a window gone by the time a token arrives simply misses it.
    const forward = (kind) => (payload) => {
      if (!sender.isDestroyed()) sender.send("agent-run:event", { runId, kind, payload });
    };

    // The usage log, one entry per model call — written HERE because nothing else can. On the renderer's own
    // loop a chat request is logged either by the renderer (`selfLogged`) or by the main-process proxy; a turn
    // run inside the runtime passes through neither, so without this chat's model calls would simply stop
    // appearing in the log. Same entry shape as `logModelCall` in src/lib/ai/usageLog.ts, so the viewer reads
    // both paths alike; attribution comes from the renderer, which is the side that knows the conversation.
    const meta = params?.meta ?? {};
    const provider = params?.provider ?? {};
    const logCall = (fields) => {
      try {
        logUsage?.({
          kind: "model",
          source: meta.source ?? "chat",
          actor: meta.actor ?? "main",
          convId: meta.convId,
          turnId: meta.turnId,
          provider: meta.provider,
          model: provider.model,
          endpoint: hostOf(provider.endpoint),
          stream: provider.stream !== false,
          ...fields,
        });
      } catch {
        /* logging must never take down a turn */
      }
    };
    const onRound = (payload) => {
      forward("turn")(payload);
      if (payload?.phase !== "end") return;
      const prompt = Number(payload.prompt_tokens ?? 0);
      const completion = Number(payload.completion_tokens ?? 0);
      logCall({
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        cachedTokens: Number(payload.cached_tokens ?? 0),
        estimated: Boolean(payload.estimated),
        // The request alone; the round's `ms` also covers the tools it ran.
        ms: Number(payload.model_ms ?? payload.ms ?? 0),
        ok: true,
      });
    };

    try {
      const result = await runAgent(
        {
          ...(params ?? {}),
          // The route, like the workspace, is decided here and whatever the renderer sent is replaced.
          provider: { ...provider, proxy: await resolveRoute(sender, provider.endpoint) },
          runId,
          // Overwritten, never trusted — see the header.
          workdir: getWorkdir?.() ?? null,
          assetDir: getAssetDir?.() ?? null,
        },
        {
          signal: controller.signal,
          onDelta: forward("delta"),
          onTool: forward("tool"),
          onTurn: onRound,
          onRetry: forward("retry"),
          toolHandler: (name, args) => askRenderer(runId, "tool", { name, args }, TOOL_TIMEOUT_MS),
          // Only when the renderer asked for it: a gate costs a round trip per round, and one nobody answers
          // stops the run at the first round.
          roundGate: gated ? (info) => askRenderer(runId, "round", info, ROUND_TIMEOUT_MS) : undefined,
        },
      );
      // A request that never came back has no round to log it under, but "the model was called and it failed"
      // is exactly what someone reading the log at 3am needs — the reason `requestChat` logs its failures too.
      if (result?.stop_reason === "error") logCall({ ok: false, error: String(result.detail ?? "error") });
      return result;
    } finally {
      runs.delete(runId);
      sender.removeListener?.("destroyed", onGone);
      settleRun(runId, "the run ended before this was answered");
    }
  });

  // One-way, like subagent:reply: it settles a promise created by a different call.
  ipcMain.on("agent-run:reply", (e, { requestId, result, error } = {}) => {
    const entry = pending.get(requestId);
    if (!entry) return; // already timed out, or the run ended
    // Only the window that owns the run may answer for it. Without this any renderer could feed a tool
    // result into another window's turn — and a tool result is text the model acts on.
    if (entry.sender !== e.sender) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(String(error)));
    else entry.resolve(result);
  });

  ipcMain.on("agent-run:cancel", (e, { runId } = {}) => {
    const run = runs.get(runId);
    // Same ownership rule: one window cannot stop another's turn.
    if (!run || run.sender !== e.sender) return;
    run.controller.abort();
    // Nothing outstanding for a stopped run will be read; failing it now is what lets the runtime finish
    // promptly rather than when each question times out.
    settleRun(runId, "the turn was stopped");
  });
}

/**
 * How this window's own requests to `endpoint` would travel: `"direct"`, a proxy URL, or null for "let the
 * runtime's environment decide".
 *
 * On the renderer's loop a cloud request leaves from Chromium, which follows the OS proxy settings and PAC
 * scripts. The runtime's HTTP client can read neither, so without this a user who reaches their provider through
 * a system proxy — the usual way to reach an overseas provider from mainland China — would find chat stopped
 * connecting on the day it moved to the runtime. Asking the window's own session gives the exact answer its
 * fetch would have used.
 */
async function resolveRoute(sender, endpoint) {
  try {
    const pac = await sender.session?.resolveProxy?.(String(endpoint ?? ""));
    return routeFromChromium(pac);
  } catch {
    return null;
  }
}

/**
 * Chromium's PAC-style answer (`"PROXY host:port; DIRECT"`) as the runtime's route. Only the first choice is
 * taken — Chromium would fall back along the list, the runtime has one route per run.
 *
 * SOCKS is resolved the way Chromium itself resolves it: `SOCKS5` hands the host name to the proxy (socks5h), and
 * `SOCKS` / `SOCKS4` resolve locally (socks4). Anything unrecognised is null, and the runtime's environment decides.
 */
export function routeFromChromium(pac) {
  const first = String(pac ?? "").split(";")[0].trim();
  const [scheme, hostPort] = first.split(/\s+/);
  if (!hostPort && scheme?.toUpperCase() !== "DIRECT") return null;
  switch (scheme?.toUpperCase()) {
    case "DIRECT":
      return "direct";
    case "PROXY":
      return `http://${hostPort}`;
    case "HTTPS":
      return `https://${hostPort}`;
    case "SOCKS5":
      return `socks5h://${hostPort}`;
    case "SOCKS":
    case "SOCKS4":
      return `socks4://${hostPort}`;
    default:
      return null;
  }
}

/** Host only: a full endpoint can carry a key in its query string on some gateways (see llm/proxy.mjs). */
function hostOf(endpoint) {
  try {
    return new URL(String(endpoint)).host;
  } catch {
    return undefined;
  }
}
