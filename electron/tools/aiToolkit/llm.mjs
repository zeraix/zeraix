/**
 * The helper model: the LLM config the renderer injects, and the bounded one-off calls tools make with it
 * (refine_question, and project memory's summaries). Split out of aiToolkit.mjs, which re-exports the public
 * part unchanged. This module OWNS LLM_CONFIG — only setLLMConfig assigns it.
 */

import { llmChat } from "../../llm/proxy.mjs";

/** The most one helper model call (refine_question) may take. A one-sentence rewrite; a minute is already generous. */
const HELPER_TIMEOUT_MS = 60_000;

// ── LLM config (for tools like refine_question that make a secondary model call) ──────────────────
// Tools are called by name by the model, and the call arguments should not (and do not) carry
// sensitive config like endpoint / apiKey. So, like WORKDIR, we keep a single copy centrally in the
// main process, injected by the renderer via IPC before a session starts.
let LLM_CONFIG = {
  endpoint: "", // OpenAI-compatible /chat/completions endpoint
  apiKey: "", // Auth key (kept in memory only, not persisted)
  model: "", // Model name
  headers: undefined, // Optional extra request headers
  body: undefined, // Extra request-body fields — the family's "thinking off" switch (see ToolLLMConfig.body)
  timeoutMs: HELPER_TIMEOUT_MS, // Hard bound on one helper request; tests shorten it
};

/**
 * Set the LLM config used by tools such as "question refinement" when they make a secondary model call.
 * The given fields are shallow-merged with the existing config (only the provided fields are overwritten).
 * Returns the merged config (with sensitive fields not echoed back).
 */
export function setLLMConfig(cfg = {}) {
  LLM_CONFIG = {
    endpoint: cfg.endpoint ?? LLM_CONFIG.endpoint,
    apiKey: cfg.apiKey ?? LLM_CONFIG.apiKey,
    model: cfg.model ?? LLM_CONFIG.model,
    headers: cfg.headers ?? LLM_CONFIG.headers,
    body: cfg.body ?? LLM_CONFIG.body,
    timeoutMs: cfg.timeoutMs ?? LLM_CONFIG.timeoutMs,
  };
  return getLLMConfig();
}

/** Read the current LLM config (apiKey only returns whether it is set, to avoid leaking it). */
export function getLLMConfig() {
  return {
    endpoint: LLM_CONFIG.endpoint,
    model: LLM_CONFIG.model,
    hasApiKey: !!LLM_CONFIG.apiKey,
    headers: LLM_CONFIG.headers,
  };
}

// ── Secondary LLM call ─────────────────────────────────────────────────────────
const REFINE_MAX_CHARS = 4000; // Truncation length for a single input field (question / context), to avoid feeding back too many tokens

/**
 * Run one non-streaming chat with the configured LLM and return the first candidate's text content.
 * Throws if the config is missing or the request fails; runTool wraps that into a tool error result.
 *
 * Bounded two ways, because an unbounded helper call is a hung turn: a hard timeout (LLM_CONFIG.timeoutMs), and the
 * caller's `signal`, which is the user's Stop. A tool call the renderer had already given up on used to leave this
 * request running in the main process for as long as the provider took — 328 s, once — with no way to reach it.
 * The config's `body` fields ride along on every request; that is where the family's "thinking off" switch is.
 */
export async function chatComplete(messages, { temperature = 0.2, maxTokens, signal } = {}) {
  const { endpoint, apiKey, model, headers } = LLM_CONFIG;
  if (!endpoint) throw new Error("LLM endpoint is not configured; call setLLMConfig first to inject the LLM config");
  if (!model) throw new Error("LLM model is not configured; call setLLMConfig first to inject the LLM config");

  const body = { model, messages, temperature, ...(LLM_CONFIG.body ?? {}) };
  if (maxTokens) body.max_tokens = maxTokens;

  const timeout = AbortSignal.timeout(LLM_CONFIG.timeoutMs);
  const res = await llmChat({ endpoint, apiKey, body, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (res?.aborted) {
    throw new Error(
      signal?.aborted
        ? "stopped by the user"
        : `the model gave no answer within ${Math.round(LLM_CONFIG.timeoutMs / 1000)} s; continue without it`,
    );
  }
  if (!res?.ok) {
    const detail = res?.error || (res?.data ? JSON.stringify(res.data).slice(0, 500) : "");
    throw new Error(`LLM request failed (status ${res?.status ?? "?"})${detail ? `: ${detail}` : ""}`);
  }
  const content = res.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM returned empty content");
  }
  return content.trim();
}

/**
 * The refine_question tool: one bounded helper call that rewrites a vague question into a searchable one.
 * Exported (rather than reachable only through runTool) so the request it builds can be tested against a
 * fake endpoint without a sidecar in the picture.
 */
export async function refineQuestion({ question, context } = {}, { signal } = {}) {
  const q = String(question ?? "").trim();
  if (!q) throw new Error("question must not be empty");
  const ctx = String(context ?? "").trim();

  const userParts = [`Original question:\n${q.slice(0, REFINE_MAX_CHARS)}`];
  if (ctx) userParts.push(`\nConversation context (only to understand intent, do not answer it directly):\n${ctx.slice(0, REFINE_MAX_CHARS)}`);

  const messages = [
    {
      role: "system",
      content:
        "You are a \"question refinement\" assistant. Rewrite the user's original question (optionally " +
        "using the provided conversation context) into a clear, specific, unambiguous, self-contained " +
        "question that is easy to search and answer. Requirements: preserve the user's original intent " +
        "and key constraints; fill in obviously missing references; remove pleasantries and redundancy; " +
        "use the same language as the original question. Output only the refined question itself, with " +
        "no explanation, prefix, or quotes.",
    },
    { role: "user", content: userParts.join("\n") },
  ];
  return await chatComplete(messages, { temperature: 0.2, maxTokens: 256, signal });
}

/**
 * The helper model as project memory takes it: whether one is configured, and the call to make with it.
 * Built afresh at each call so a config injected mid-session is seen by the very next call.
 */
export function projectMemoryLlm() {
  return { available: Boolean(LLM_CONFIG.endpoint && LLM_CONFIG.model), chat: chatComplete };
}
