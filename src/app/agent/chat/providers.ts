/* Multi-provider support: all of the below speak the OpenAI-compatible protocol (Authorization: Bearer).
 * deepseek-v4-flash is taken from the caller's C++ constant as the default DeepSeek version. */
export type Provider = {
  id: string;
  label: string;
  /**
   * OpenAI-compatible BASE url — no operation path attached.
   *
   * Deliberately excludes /chat/completions: a provider is not only a chat endpoint. The same base
   * serves /chat/completions, /responses, /images/generations, /audio/speech, /embeddings … so the
   * caller appends whichever operation it needs (see providerChatEndpoint / apiFormatSuffix in
   * src/lib/ai/models.ts). Baking the chat path in here would make every other capability
   * un-derivable.
   *
   * This is also the value users paste into third-party agent apps as "Base URL".
   */
  baseUrl: string;
  /**
   * Override for providers whose chat operation is NOT at /chat/completions (MiniMax). When unset,
   * the path is derived from the model's apiFormat. Note that a non-standard path also means the
   * OpenAI SDK cannot be pointed at it — electron/llm/proxy.mjs falls back to rawFetch (it only
   * maps endpoint -> baseURL when the endpoint ends in /chat/completions).
   */
  chatPath?: string;
  /**
   * Chat models only. Generation engines (image/video) deliberately live OUT of this list and out of
   * the picker — they are engines, not conversational partners, and are resolved per capability from
   * src/lib/ai/generation/registry.ts. See docs/generation-capabilities-design.md.
   */
  models: string[];
  WorkspaceId?: string; // required by qwen
  note?: string; // special notes about auth / endpoint
  custom?: boolean; // custom: endpoint and model name entered manually
};

/* Mainstream Chinese large models (all use the OpenAI-compatible protocol: Authorization: Bearer).
 * Base URLs / versions are best-practice defaults and may change as vendors update them; anything not listed can use "Custom". */
export const PROVIDERS: Provider[] = [
    {
    id: "openai",
    label: "OpenAI ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano", "o4-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
    note: "OpenAI-compatible endpoint; use an Anthropic console API key for the API Key (sk-ant-...).",
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
    note: "OpenAI-compatible endpoint; use a Google AI Studio key for the API Key.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    // Coding base URL - https://open.bigmodel.cn/api/coding/paas/v4
    // rather than the general one - https://open.bigmodel.cn/api/paas/v4
    id: "zhipu",
    label: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: ["glm-5.2","glm-5.1","glm-5","glm-5-turbo"],
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash", "qwen3.5-flash"],
  },
  {
    id: "moonshot",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    // Non-standard: MiniMax exposes chat at /text/chatcompletion_v2, not /chat/completions.
    chatPath: "/text/chatcompletion_v2",
    models: ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5g-chat"],
    note: "Some accounts require a GroupId; if it fails, switch to \"Custom\".",
  },
  {
    id: "local",
    label: "Local model (llama.cpp)",
    // Placeholder port only: a running local model registers its own endpoint (with the real port
    // picked at launch, see electron/llm/localServer.mjs), which takes precedence over this.
    baseUrl: "http://127.0.0.1:8080/v1",
    models: [],
    note: "Added automatically and selected as default once you start the local model in Settings; runs on-device, no API Key needed.",
  },

  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    models: [],
    custom: true,
  },
];

// Default provider: OpenAI (falls back to the first item in the list if not found).
export const DEFAULT_PROVIDER = PROVIDERS.find((p) => p.id === "openai") ?? PROVIDERS[0];
