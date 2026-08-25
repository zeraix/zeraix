/**
 * The chat page's model-request layer.
 *
 * Everything between "here are the messages" and "here is the reply": choosing a transport (main-process
 * proxy vs. direct fetch), reassembling SSE deltas back into a complete response, accumulating token usage,
 * writing the usage log, and the three retry fallbacks — a provider that rejects the thinking parameter, one
 * that rejects replayed thinking blocks, and one that rejects images.
 *
 * A factory rather than a hook: it uses no React state of its own, it just closes over the values the page
 * already has. The page calls it on every render, so the returned functions always see current config —
 * exactly what the inline closures used to do.
 */
import { chatViaProxy, chatStreamViaProxy, isLlmProxyAvailable, isLlmStreamAvailable } from "@/lib/ai/llm";
import { isLocalEndpoint } from "@/lib/ai/localModel";
import { markVisionUnsupported, OFFICIAL_PROVIDER_ID, type ResolvedModel } from "@/lib/ai/models";
import {
  isReasoningContentError,
  isThinkingParamError,
  thinkingParams,
  type ThinkingConfig,
} from "@/lib/ai/thinking";
import { countMessagesTokens, countMessageTokens } from "@/lib/ai/tokenizer";
import { buildLogMeta, logModelCall } from "@/lib/ai/usageLog";
import type { TFunc } from "@/lib/i18n";
import { useAuthStore } from "@/store/authStore";
import type { ApiMsg, ChatResponse, RequestLog } from "./types";
import { hostOfEndpoint, isVisionRejection, stripAllImagesForText, stripReasoningContent } from "./wireHelpers";

/** This round's running token total (every request of every tool round and subagent adds to it). */
export type TurnUsage = {
  prompt: number;
  completion: number;
  total: number;
  cached: number;
  estimated: boolean;
};

export function createChatRequest(cfg: {
  activeModel: ResolvedModel | null;
  endpoint: string;
  modelName: string;
  apiKey: string;
  isLocalModel: boolean;
  thinking: ThinkingConfig;
  /**
   * True once the in-app proxy has been probed. Cloud requests take the proxy until it flips and a direct
   * renderer fetch afterwards — which is deliberate (a fetch can be aborted mid-flight; the proxy is one IPC
   * and cannot), and is why sendChatOnce writes its own usage-log entry: those requests never reach the
   * main-process hook. It is false forever in the browser, where the direct fetch is the only transport.
   */
  proxyReady: boolean;
  /**
   * The mutable pieces arrive as accessors rather than as refs, and are called at REQUEST time, never here.
   * The distinction is load-bearing: send() replaces turnUsage wholesale at the start of every round, so a
   * factory that captured the object would keep billing an old round. (It also keeps the page from handing a
   * ref to a function that runs during render.)
   */
  turnUsage: () => TurnUsage;
  /** Models that rejected the thinking switch outright — skipped on later turns, so the fallback costs one request per model. */
  thinkingUnsupported: () => Set<string>;
  /** Models that rejected a REPLAYED thinking block; the replay is retired for them. */
  reasoningContextUnsupported: () => Set<string>;
  t: TFunc;
}) {
  const {
    activeModel,
    endpoint,
    modelName,
    apiKey,
    isLocalModel,
    thinking,
    proxyReady,
    turnUsage,
    thinkingUnsupported,
    reasoningContextUnsupported,
    t,
  } = cfg;

  /**
   * A single request (non-streaming, OpenAI-compatible).
   * Under Electron it is forwarded via the main-process proxy (bypassing CORS); in the browser it falls back to a direct fetch (which may be blocked by CORS).
   *
   * Wrapped by requestChat below, which owns the retry-without-images fallback — this function just sends
   * what it is given.
   */
  const sendChatOnce = async (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    // Passing onDelta requests "streaming": callbacks the accumulated content/reasoning chunk by chunk, for real-time display.
    // Downstream still treats it as a "non-streaming complete response" — this function reassembles the SSE deltas back into a complete ChatResponse before returning.
    onDelta?: (d: { content: string; reasoning: string }) => void,
    // Usage-log attribution (who is spending these tokens). Undefined while logging is off, and the
    // proxy is what actually writes the entry — see src/lib/ai/usageLog.ts.
    log?: RequestLog,
    // Reasoning configuration for THIS request, overriding the session setting.
    //
    // The Agent Runtime's reasoning policy varies effort by execution phase (docs/agent-runtime-loop.md §6):
    // a routine tool follow-up may be economised, a recovery round may not. That is a per-request decision,
    // so it cannot come from the factory's captured config. Omitted → the session setting, which is what
    // every caller that has no phase to reason about (the goal evaluator, sub-agents) gets.
    reasoning?: ThinkingConfig,
  ): Promise<ChatResponse> => {
    const body = {
      model: modelName,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      // Thinking mode. The spelling is per-family, and switching it OFF is an argument in its own right on
      // every family that reasons by default — see thinkingParams. Skipped for a model already known to
      // reject it, so the fallback below costs one request per model rather than one per turn.
      ...(thinkingUnsupported().has(modelName)
        ? {}
        : thinkingParams(reasoning ?? thinking, { local: isLocalModel, model: modelName })),
    };
    const wantStream = !!onDelta;
    const actor = log?.actor ?? "main";
    const startedAt = Date.now();
    // selfLogged: this function records the invocation below, whichever transport it ends up using.
    // It must, because the branch further down sends cloud requests with a direct fetch that never
    // reaches the main-process proxy where the other hook lives.
    const meta = buildLogMeta({
      source: "chat",
      actor,
      convId: log?.convId,
      turnId: log?.turnId,
      provider: activeModel?.providerId,
      selfLogged: true,
    });

    // Streaming increment accumulator: reassemble the OpenAI SSE deltas back into a complete message (content / reasoning_content / tool_calls).
    const accum = {
      content: "",
      reasoning: "",
      toolCalls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
      usage: undefined as ChatResponse["usage"],
    };
    const handleChunk = (raw: unknown) => {
      const chunk = raw as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: ChatResponse["usage"];
      };
      if (chunk.usage) accum.usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) accum.content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) accum.reasoning += r;
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let cur = accum.toolCalls[idx];
        if (!cur) {
          cur = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          accum.toolCalls[idx] = cur;
        }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      }
      onDelta?.({ content: accum.content, reasoning: accum.reasoning });
    };
    const assemble = (): ChatResponse => {
      const calls = accum.toolCalls.filter(Boolean);
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: accum.content || null,
              ...(calls.length ? { tool_calls: calls } : {}),
              ...(accum.reasoning ? { reasoning_content: accum.reasoning } : {}),
            },
          },
        ],
        usage: accum.usage,
      };
    };
    // Local llama-server failures are cryptic (raw llama.cpp text). For local endpoints, map the known template / tool-call
    // failures to an actionable message; everything else keeps the raw "HTTP <status> — <text>" form.
    const localErr = (status: number, raw?: string): string => {
      const base = `HTTP ${status}${raw ? ` — ${raw.slice(0, 300)}` : ""}`;
      if (!isLocalEndpoint(endpoint)) return base;
      const r = (raw || "").toLowerCase();
      if (r.includes("generate parser") || r.includes("raise_exception") || r.includes("chat template") || r.includes("system message must be"))
        return t("chat.localTemplateError");
      if (r.includes("peg-native") || r.includes("unparsed") || r.includes("tool call") || r.includes("tool_call"))
        return t("chat.localToolCallError");
      return base;
    };
    const streamErr = (res: { ok: boolean; status: number; error?: string }): ChatResponse | never => {
      if (!res.ok) {
        if (signal?.aborted) return assemble(); // Aborted: return the accumulated part (the caller then exits on aborted and will not use it)
        throw new Error(localErr(res.status, res.error));
      }
      return assemble();
    };

    // Tell llama-server which conversation this request belongs to, so its disk tier can restore that conversation's own KV by id
    // (T1) instead of re-prefilling, and can spill the tip back under the same id when the turn ends. Local only: it means nothing
    // to a cloud provider, and a non-standard header on a strict endpoint is a needless risk.
    //
    // A sub-agent sends its OWN id, never the parent's: the server keeps one conversation per slot, so the parent's id would
    // route the sub-agent onto the parent's slot and overwrite the KV resident there — and, because the ids matched, without
    // spilling it first. Its prefix is not lost by using a different id; the server's borrow is scored on shared tokens, not
    // on the id, so a sub-agent still links the system prompt already resident in a sibling slot or a seed.
    const wireConvId = log?.subConvId ?? log?.convId;
    const localHeaders =
      wireConvId && isLocalEndpoint(endpoint) ? { "X-Conversation-Id": wireConvId } : undefined;

    // Three transports, in order: local llama-server always via the proxy; a cloud endpoint via the proxy only
    // until the probe lands; otherwise a direct fetch from the renderer.
    let data: ChatResponse;
    // Local llama-server (127.0.0.1): forced through the main-process proxy (a Node environment, with no render-layer cross-origin (CORS) restriction).
    if (isLlmProxyAvailable() && isLocalEndpoint(endpoint)) {
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(
          await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body, headers: localHeaders, meta }, handleChunk, signal),
        );
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim() || "local", body, headers: localHeaders, meta });
        if (!res.ok) {
          throw new Error(localErr(res.status, res.error));
        }
        data = res.data as ChatResponse;
      }
    } else if (isLlmProxyAvailable() && !proxyReady) {
      // The isLlmProxyAvailable() guard is what keeps the browser out of this branch. Without it, a build with no
      // preload bridge (proxyReady is false there and stays false) came here and chatViaProxy threw
      // "LLM proxy is only available inside the Electron app" — so the direct fetch below, which exists precisely
      // as the browser's transport, was unreachable. Inside Electron nothing changes: pre-probe still proxies,
      // post-probe still fetches.
      // The proxy is a single IPC and cannot abort an in-flight network request; instead the caller checks signal.aborted after the await to exit.
      if (wantStream && isLlmStreamAvailable()) {
        data = streamErr(await chatStreamViaProxy({ endpoint, apiKey: apiKey.trim(), body, meta }, handleChunk, signal));
      } else {
        const res = await chatViaProxy({ endpoint, apiKey: apiKey.trim(), body, meta });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${res.error ? ` — ${res.error.slice(0, 300)}` : ""}`);
        }
        data = res.data as ChatResponse;
      }
    } else {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
          ...(wantStream ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify(wantStream ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
      }
      if (wantStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              handleChunk(JSON.parse(payload));
            } catch {
              /* Skip an unparseable chunk */
            }
          }
        }
        data = assemble();
      } else {
        data = (await res.json()) as ChatResponse;
      }
    }

    // Accumulate this round's token usage (including every request of tool rounds and subagents).
    // Prefer the provider-returned usage (exact); when missing, estimate with tiktoken and mark it estimated.
    const u = data.usage;
    // Read once, here: the round this request belongs to is the one that was open when it returned.
    const turn = turnUsage();
    // The same numbers go to the usage log below, so it reports exactly what the context bar reports.
    let logged: { prompt: number; completion: number; total: number; cached: number; estimated: boolean };
    if (u) {
      const p = u.prompt_tokens ?? 0;
      const c = u.completion_tokens ?? 0;
      turn.prompt += p;
      turn.completion += c;
      turn.total += u.total_tokens ?? p + c;
      // Input tokens served from the prefix cache: the field differs by provider (DeepSeek uses prompt_cache_hit_tokens,
      // OpenAI-compatible uses prompt_tokens_details.cached_tokens); accumulate whichever is present, for the UI to show the cache effect.
      const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      turn.cached += cached;
      logged = { prompt: p, completion: c, total: u.total_tokens ?? p + c, cached, estimated: false };
    } else {
      const p = countMessagesTokens(messages);
      const c = countMessageTokens(data.choices?.[0]?.message);
      turn.prompt += p;
      turn.completion += c;
      turn.total += p + c;
      turn.estimated = true;
      logged = { prompt: p, completion: c, total: p + c, cached: 0, estimated: true };
    }

    // Usage log entry for this invocation. Written here rather than in the proxy because a cloud model
    // in the desktop app is fetched straight from the renderer (see the transport branch above), so the
    // proxy sees only local endpoints; the request carries selfLogged so it is never counted twice.
    logModelCall({
      actor,
      model: modelName,
      provider: activeModel?.providerId,
      endpoint: hostOfEndpoint(endpoint),
      promptTokens: logged.prompt,
      completionTokens: logged.completion,
      totalTokens: logged.total,
      cachedTokens: logged.cached,
      estimated: logged.estimated,
      stream: wantStream,
      ms: Date.now() - startedAt,
      // An abort returns whatever streamed in before the stop, which is a cancelled call, not a clean one.
      ok: !signal?.aborted,
      error: signal?.aborted ? "cancelled" : undefined,
      convId: log?.convId,
      turnId: log?.turnId,
    });

    // Official direct-connection models are billed by the platform per request, so the balance moves with
    // every step of a tool loop — not just at the end of the turn. Refresh as each step lands so the
    // sidebar tracks spending live. Throttled and de-duped inside the store, and a no-op for guests,
    // local models and BYO-key providers, which never touch the platform wallet.
    if (activeModel?.providerId === OFFICIAL_PROVIDER_ID) {
      void useAuthStore.getState().refreshWallet();
    }
    return data;
  };

  /**
   * One request, with a fail-safe for models that cannot accept images.
   *
   * Image capability is no longer predicted before sending (see modelAcceptsImages): a wrong prediction
   * used to delete the user's image and tell the model "1 image(s) omitted", which reads to the user as
   * "the AI can't see my picture" with nothing indicating the app removed it. Images now always go out,
   * and this is what makes that safe — if a request carrying images fails, it is retried once with the
   * images stripped. Succeeding on the retry is the proof the images were the problem, so the model is
   * marked visionUnsupported and later turns strip up front, costing one extra request once per model.
   *
   * Retrying on ANY failure rather than pattern-matching the error text is deliberate: providers word
   * this rejection every possible way ("unknown variant `image_url`", "invalid_image_url", "does not
   * support image input", a bare 400), and a signature that misses one puts us back to a hard failure on
   * a picture the user can see on screen. The cost of guessing wrong here is one request that was
   * already failing.
   *
   * The MARKING is the opposite — narrow (isVisionRejection), because its cost is not one request but every
   * later turn: the model is remembered as text-only and the user's images are stripped before sending. A
   * broad retry paired with a broad verdict is what turned transient failures into permanently image-blind
   * models, curable only by deleting and re-adding the model.
   */
  const requestChat = async (
    messages: ApiMsg[],
    tools?: unknown[],
    signal?: AbortSignal,
    onDelta?: (d: { content: string; reasoning: string }) => void,
    log?: RequestLog,
    /** Per-request reasoning, from the Runtime's phase policy. Omitted → the session setting. */
    reasoning?: ThinkingConfig,
  ): Promise<ChatResponse> => {
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    // A request that never returned has no usage to report, but "the model was called and it failed"
    // is precisely what someone reading the log at 3am needs to see. sendChatOnce logs only the calls
    // that come back, so the throwing ones are recorded here.
    const startedAt = Date.now();
    const logFailure = (e: unknown) =>
      logModelCall({
        actor: log?.actor ?? "main",
        model: modelName,
        provider: activeModel?.providerId,
        endpoint: hostOfEndpoint(endpoint),
        ms: Date.now() - startedAt,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        convId: log?.convId,
        turnId: log?.turnId,
      });
    try {
      return await sendChatOnce(messages, tools, signal, onDelta, log, reasoning);
    } catch (e) {
      // The provider rejected the thinking switch itself (a 400 naming the field): retire it for this
      // model and send the same request again. Checked first because it is the one failure that is
      // certainly ours rather than the message's, and unlike the image path it is matched narrowly —
      // wrongly retrying here would silently ignore the user's setting instead of merely resending.
      if (!signal?.aborted && isThinkingParamError(e) && !thinkingUnsupported().has(modelName)) {
        logFailure(e);
        console.warn(`[thinking] ${modelName} rejected the thinking parameter; sending without it`, e);
        thinkingUnsupported().add(modelName);
        try {
          return await sendChatOnce(messages, tools, signal, onDelta, log, reasoning);
        } catch (retryErr) {
          logFailure(retryErr);
          throw retryErr;
        }
      }
      // The provider rejected a REPLAYED thinking block — only reachable with the "send thinking as context" setting on,
      // since nothing else puts reasoning_content in a remote request. Retire the replay for this model and resend the
      // same messages without it, so one strict provider costs a retry rather than making the setting unusable.
      if (
        !signal?.aborted &&
        isReasoningContentError(e) &&
        messages.some((m) => m.role === "assistant" && m.reasoning_content) &&
        !reasoningContextUnsupported().has(modelName)
      ) {
        logFailure(e);
        console.warn(`[thinking] ${modelName} rejected replayed thinking blocks; sending without them`, e);
        reasoningContextUnsupported().add(modelName);
        try {
          return await sendChatOnce(stripReasoningContent(messages), tools, signal, onDelta, log, reasoning);
        } catch (retryErr) {
          logFailure(retryErr);
          throw retryErr;
        }
      }
      // No images to blame, or the user cancelled: this failure is genuine, surface it unchanged.
      if (!hasImages || signal?.aborted) {
        logFailure(e);
        throw e;
      }
      logFailure(e); // the first attempt failed on its own terms, whatever the retry goes on to do
      const stripped = stripAllImagesForText(messages);
      // The retry is logged as its own invocation: it is a second request that the provider bills for.
      let data: ChatResponse;
      try {
        data = await sendChatOnce(stripped, tools, signal, onDelta, log, reasoning); // throws the retry's own error if it also fails
      } catch (retryErr) {
        logFailure(retryErr);
        throw retryErr;
      }
      // The retry succeeded, but that alone does NOT mean the model is image-blind: images are the bulk of
      // the request, so a rate limit, a timeout, an oversized body or a context overflow all "recover" the
      // same way. Only a failure that actually reads as an image rejection is allowed to brand the model —
      // anything else stays a one-off, because the verdict silently strips the user's pictures from every
      // later turn and reads to them as "the AI cannot see images".
      if (activeModel?.id && isVisionRejection(e)) {
        console.warn(`[vision] ${modelName} rejected image input; images will be stripped for it`, e);
        markVisionUnsupported(activeModel.id);
      } else {
        console.warn(
          `[vision] a request carrying images failed and succeeded without them, but the error does not read ` +
            `as an image rejection — ${modelName} keeps image support`,
          e,
        );
      }
      return data;
    }
  };
  // Only requestChat is handed out: sendChatOnce is the un-retried inner call, and a caller reaching for it
  // would be opting out of the image / thinking fallbacks without meaning to.
  return { requestChat };
}
