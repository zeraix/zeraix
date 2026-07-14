/**
 * LLM request proxy (main process) — everything goes through the official `openai` SDK.
 *
 * The renderer is restricted by the browser's same-origin policy (CORS); the main process is a
 * Node environment and is unconstrained. Here the OpenAI SDK is used to uniformly issue
 * OpenAI-compatible requests via baseURL + apiKey (with built-in error structure / retries).
 * It only forwards; it does not persist the Key.
 *
 * The SDK automatically appends `/chat/completions` to the baseURL, so baseURL = the endpoint
 * with that suffix removed; a few non-standard paths (such as MiniMax's
 * /v1/text/chatcompletion_v2) fall back to raw fetch.
 */
import OpenAI from "openai";

const CHAT_PATH = "/chat/completions";

/** Endpoint → SDK baseURL; returns null when it doesn't end with /chat/completions (falls back to rawFetch). */
function deriveBaseURL(endpoint) {
  return endpoint.endsWith(CHAT_PATH) ? endpoint.slice(0, -CHAT_PATH.length) : null;
}

/** Raw forwarding: for endpoints with non-standard paths that the SDK cannot map. */
async function rawFetch({ endpoint, apiKey, body, headers }) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(headers ?? {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) return { ok: false, status: res.status, error: (text || "").slice(0, 2000), data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  }
}

/** IPC can only pass structured-cloneable objects: a JSON round-trip strips non-cloneable fields the SDK may attach. */
function plain(v) {
  try {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

/**
 * Streaming forwarding (SSE): the same two paths as llmChat (SDK / rawFetch), but emits
 * incrementally with stream:true.
 * onChunk(chunkObj) is a per-chunk callback (already plain-ified, structured-cloneable for IPC
 * push); signal supports aborting.
 * Returns { ok, status, usage?, error? } (usage taken from the final chunk's include_usage).
 */
export async function llmChatStream(req, onChunk, signal) {
  const { endpoint, apiKey, body, headers } = req ?? {};
  if (!endpoint) return { ok: false, status: 0, error: "missing endpoint" };
  const streamBody = { ...(body ?? {}), stream: true, stream_options: { include_usage: true } };

  const baseURL = deriveBaseURL(endpoint);
  if (!baseURL) return rawFetchStream({ endpoint, apiKey, body: streamBody, headers }, onChunk, signal);

  try {
    const client = new OpenAI({ apiKey: apiKey || "MISSING", baseURL, defaultHeaders: headers, maxRetries: 1 });
    const stream = await client.chat.completions.create(streamBody, { signal });
    let usage;
    for await (const chunk of stream) {
      const p = plain(chunk);
      if (!p) continue;
      if (p.usage) usage = p.usage;
      onChunk(p);
    }
    return { ok: true, status: 200, usage };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, error: "aborted", aborted: true };
    const status = typeof e?.status === "number" ? e.status : 0;
    return { ok: false, status, error: e?.message ?? String(e), data: plain(e?.error) };
  }
}

/** Raw streaming forwarding: for non-standard endpoints, use fetch to read text/event-stream, parsing `data:` lines and calling back per chunk. */
async function rawFetchStream({ endpoint, apiKey, body, headers }, onChunk, signal) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(headers ?? {}),
      },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: (text || "").slice(0, 2000) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage;
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
          const obj = JSON.parse(payload);
          if (obj.usage) usage = obj.usage;
          onChunk(obj);
        } catch {
          /* skip unparseable fragments */
        }
      }
    }
    return { ok: true, status: res.status, usage };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, error: "aborted", aborted: true };
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  }
}

export async function llmChat(req) {
  const { endpoint, apiKey, body, headers } = req ?? {};
  if (!endpoint) return { ok: false, status: 0, error: "missing endpoint" };

  const baseURL = deriveBaseURL(endpoint);
  if (!baseURL) return rawFetch(req); // fall back for non-standard endpoints

  try {
    const client = new OpenAI({
      apiKey: apiKey || "MISSING", // leaving it empty throws at construction; the placeholder lets the request return 401 naturally
      baseURL,
      defaultHeaders: headers,
      maxRetries: 1,
    });
    const completion = await client.chat.completions.create(body ?? {});
    return { ok: true, status: 200, data: plain(completion) };
  } catch (e) {
    // OpenAI.APIError carries status / error; other errors such as network failures have status=0.
    const status = typeof e?.status === "number" ? e.status : 0;
    return { ok: false, status, error: e?.message ?? String(e), data: plain(e?.error) };
  }
}
