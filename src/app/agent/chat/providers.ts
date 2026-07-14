/* Multi-provider support: all of the below use the OpenAI-compatible protocol (Authorization: Bearer + /chat/completions).
 * deepseek-v4-flash is taken from the caller's C++ constant as the default DeepSeek version. */
export type Provider = {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  WorkspaceId?: string; // required by qwen
  note?: string; // special notes about auth / endpoint
  custom?: boolean; // custom: endpoint and model name entered manually
};

/* Mainstream Chinese large models (all use the OpenAI-compatible protocol: Authorization: Bearer + chat/completions).
 * Endpoints / versions are best-practice defaults and may change as vendors update them; anything not listed can use "Custom". */
export const PROVIDERS: Provider[] = [
    {
    id: "openai",
    label: "OpenAI ChatGPT",
    endpoint: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano", "o4-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    endpoint: "https://api.anthropic.com/v1/chat/completions",
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
    note: "OpenAI-compatible endpoint; use an Anthropic console API key for the API Key (sk-ant-...).",
  },
  {
    id: "google",
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
    note: "OpenAI-compatible endpoint; use a Google AI Studio key for the API Key.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    // Coding endpoint - https://open.bigmodel.cn/api/coding/paas/v4
    // rather than the general endpoint - https://open.bigmodel.cn/api/paas/v4
    id: "zhipu",
    label: "Zhipu GLM",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    models: ["glm-4-plus", "glm-4-air", "glm-4-airx", "glm-4-flash", "glm-4-long", "glm-4v-plus"],
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    models: ["qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash", "qwen3.5-flash"],
  },
  {
    id: "doubao",
    label: "ByteDance Doubao (Volcano Ark)",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    models: ["doubao-1.5-pro-32k", "doubao-pro-32k", "doubao-pro-256k", "doubao-lite-32k"],
    note: "The model may need to be the Volcano Ark \"inference endpoint ID\" (ep-...); if you get an error, enter it via Custom.",
  },
  {
    id: "ernie",
    label: "Baidu ERNIE (Qianfan)",
    endpoint: "https://qianfan.baidubce.com/v2/chat/completions",
    models: ["ernie-4.0-8k", "ernie-4.0-turbo-8k", "ernie-3.5-8k", "ernie-speed-8k", "ernie-lite-8k"],
  },
  {
    id: "spark",
    label: "iFlytek Spark",
    endpoint: "https://spark-api-open.xf-yun.com/v1/chat/completions",
    models: ["4.0Ultra", "max-32k", "generalv3.5", "pro-128k", "lite"],
    note: "For the API Key, enter the console's HTTP service password (APIPassword).",
  },
  {
    id: "moonshot",
    label: "Kimi",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    endpoint: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    models: ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5g-chat"],
    note: "Some accounts require a GroupId; if it fails, switch to \"Custom\".",
  },
  {
    id: "local",
    label: "Local model (llama.cpp)",
    endpoint: "http://127.0.0.1:8080/v1/chat/completions",
    models: [],
    note: "Added automatically and selected as default once you start the local model in Settings; runs on-device, no API Key needed.",
  },

  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    endpoint: "",
    models: [],
    custom: true,
  },
];

// Default provider: OpenAI (falls back to the first item in the list if not found).
export const DEFAULT_PROVIDER = PROVIDERS.find((p) => p.id === "openai") ?? PROVIDERS[0];
