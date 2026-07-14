/**
 * 大模型请求代理（主进程）—— 统一走官方 `openai` SDK。
 *
 * 渲染层受浏览器同源策略（CORS）限制，主进程是 Node 环境、不受约束。这里用 OpenAI SDK
 * 以 baseURL + apiKey 的方式统一发起 OpenAI 兼容请求（自带错误结构 / 重试）。
 * 仅做转发，不持久化 Key。
 *
 * SDK 会自动在 baseURL 后追加 `/chat/completions`，故 baseURL = 端点去掉该后缀；
 * 少数非标准路径（如 MiniMax 的 /v1/text/chatcompletion_v2）回退原始 fetch。
 */
import OpenAI from "openai";

const CHAT_PATH = "/chat/completions";

/** 端点 → SDK 的 baseURL；非 /chat/completions 结尾返回 null（走 rawFetch 回退）。 */
function deriveBaseURL(endpoint) {
  return endpoint.endsWith(CHAT_PATH) ? endpoint.slice(0, -CHAT_PATH.length) : null;
}

/** 原始转发：用于路径非标准、SDK 无法映射的端点。 */
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

/** IPC 只能传可结构化克隆的对象：JSON round-trip 去掉 SDK 可能附带的不可克隆字段。 */
function plain(v) {
  try {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

/**
 * 流式转发（SSE）：与 llmChat 相同的两条路径（SDK / rawFetch），但以 stream:true 增量产出。
 * onChunk(chunkObj) 逐块回调（已 plain 化，可结构化克隆经 IPC 推送）；signal 支持中断。
 * 返回 { ok, status, usage?, error? }（usage 取自末块 include_usage）。
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

/** 原始流式转发：非标准端点用 fetch 读取 text/event-stream，解析 `data:` 行逐块回调。 */
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
          /* 跳过不可解析的分片 */
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
  if (!baseURL) return rawFetch(req); // 非标准端点回退

  try {
    const client = new OpenAI({
      apiKey: apiKey || "MISSING", // 留空会在构造时抛错；占位让请求自然返回 401
      baseURL,
      defaultHeaders: headers,
      maxRetries: 1,
    });
    const completion = await client.chat.completions.create(body ?? {});
    return { ok: true, status: 200, data: plain(completion) };
  } catch (e) {
    // OpenAI.APIError 带 status / error；网络等其它错误 status=0。
    const status = typeof e?.status === "number" ? e.status : 0;
    return { ok: false, status, error: e?.message ?? String(e), data: plain(e?.error) };
  }
}
