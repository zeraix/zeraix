/**
 * Renderer-layer wrapper for accessing the "main-process LLM proxy".
 *
 * The proxy runs in the Electron main process (see electron/llm/proxy.mjs) and is exposed via preload as `window.llm`.
 * Forwarding OpenAI-compatible requests through it bypasses browser CORS and keeps the API key out of the renderer's network panel.
 * Only available in Electron; in browser / Web deployments `isLlmProxyAvailable()` is false (should fall back to a direct fetch).
 */

export interface LlmChatRequest {
  endpoint: string;
  apiKey: string;
  /** OpenAI-compatible request body (model / messages / tools / tool_choice ...). */
  body: unknown;
  /** Extra request headers (needed by a few vendors, e.g. GroupId). */
  headers?: Record<string, string>;
}

export interface LlmChatResult {
  ok: boolean;
  status: number;
  /** Parsed response JSON (OpenAI-compatible ChatResponse). */
  data?: unknown;
  /** Raw text / error message when something goes wrong. */
  error?: string;
}

declare global {
  interface Window {
    llm?: {
      chat(req: LlmChatRequest): Promise<LlmChatResult>;
      chatStream(id: string, req: LlmChatRequest): Promise<LlmChatResult>;
      onChatChunk(cb: (payload: { id: string; chunk: unknown }) => void): () => void;
      abortChatStream(id: string): void;
    };
  }
}

/** Whether the current environment provides the main-process proxy (Electron only). */
export function isLlmProxyAvailable(): boolean {
  return typeof window !== "undefined" && !!window.llm;
}

/** Whether the main process supports streaming (older preload versions may only expose chat). */
export function isLlmStreamAvailable(): boolean {
  return isLlmProxyAvailable() && typeof window.llm!.chatStream === "function";
}

/** Issue a single chat request through the main-process proxy. */
export function chatViaProxy(req: LlmChatRequest): Promise<LlmChatResult> {
  if (!isLlmProxyAvailable()) {
    throw new Error("LLM proxy is only available inside the Electron app");
  }
  return window.llm!.chat(req);
}

let streamSeq = 0;

/**
 * Issue a single "streaming" chat request through the main-process proxy: onChunk fires per chunk (OpenAI-compatible SSE chunk objects),
 * and the Promise resolves when the stream ends (same shape as the chatViaProxy result, with usage taken from the last chunk). A signal abort is relayed to the main process via the abort channel.
 */
export async function chatStreamViaProxy(
  req: LlmChatRequest,
  onChunk: (chunk: unknown) => void,
  signal?: AbortSignal,
): Promise<LlmChatResult> {
  if (!isLlmStreamAvailable()) {
    throw new Error("LLM streaming is only available inside the Electron app");
  }
  const id = `llm-${streamSeq++}`;
  const off = window.llm!.onChatChunk((p) => {
    if (p.id === id) onChunk(p.chunk);
  });
  const onAbort = () => window.llm!.abortChatStream(id);
  if (signal) {
    if (signal.aborted) window.llm!.abortChatStream(id);
    else signal.addEventListener("abort", onAbort);
  }
  try {
    return await window.llm!.chatStream(id, req);
  } finally {
    off();
    signal?.removeEventListener("abort", onAbort);
  }
}
