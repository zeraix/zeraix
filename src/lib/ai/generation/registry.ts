/**
 * Generation registry + engine selection.
 * Design: docs/generation-capabilities-design.md §2–3
 *
 * Adding a vendor is data, not code: one entry here plus an adapter. Only vendors verified against
 * live docs are listed — a wrong base URL is a runtime 404, whereas an absent entry just means
 * "this vendor cannot generate images", which fails safe.
 */
import { PROVIDERS } from "@/app/agent/chat/providers";
import { getApiKeyByRef } from "@/lib/ai/models";
import { geminiImageAdapter, openaiImageAdapter, qwenImageAdapter, zhipuImageAdapter } from "./adapters";
import type { CapabilityId, GenerationModel, GenerationProvider } from "./types";

/**
 * Order is a silent quality decision: selectEngine falls back down this list, so whichever vendor
 * sits first becomes the default for anyone holding several keys. Ranked best-first deliberately,
 * not alphabetically.
 */
export const GENERATION_REGISTRY: GenerationProvider[] = [
  {
    id: "zhipu",
    label: "Zhipu GLM",
    capability: "image_generation",
    // MUST override: chat is on the coding base (/api/coding/paas/v4), images only on the general
    // one. Verified — no coding image endpoint is documented.
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    path: "/images/generations",
    models: [
      { id: "glm-image", label: "GLM-Image" },
      { id: "cogview-4", label: "CogView-4" },
      { id: "cogview-3-flash", label: "CogView-3 Flash" },
    ],
    adapter: zhipuImageAdapter,
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    capability: "image_generation",
    // MUST override, and not merely for the path: DashScope has no OpenAI-compatible surface for
    // images, so this shares nothing with qwen's chat base (compatible-mode/v1).
    // The plain dashscope host authenticates on the API key alone — the documented
    // {WorkspaceId}.<region>.maas.aliyuncs.com form would require config we deliberately lack.
    baseUrl: "https://dashscope.aliyuncs.com/api/v1/services/aigc",
    path: "/multimodal-generation/generation",
    models: [
      { id: "wan2.7-image-pro", label: "Wan 2.7 Image Pro" },
      { id: "qwen-image-2.0-pro", label: "Qwen-Image 2.0 Pro" },
    ],
    adapter: qwenImageAdapter,
  },
  {
    id: "google",
    label: "Google Gemini",
    capability: "image_generation",
    // Same base as chat: the OpenAI-compat layer serves /images/generations.
    path: "/images/generations",
    models: [
      { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      { id: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image" },
    ],
    adapter: geminiImageAdapter,
  },
  {
    id: "openai",
    label: "OpenAI",
    capability: "image_generation",
    path: "/images/generations",
    models: [{ id: "gpt-image-1", label: "GPT Image 1" }],
    adapter: openaiImageAdapter,
  },
];

/** Full endpoint for a generation provider: its own base, else the vendor's chat base. */
export function generationEndpoint(p: GenerationProvider): string {
  const chat = PROVIDERS.find((c) => c.id === p.id);
  const base = (p.baseUrl ?? chat?.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}${p.path}`;
}

export interface SelectedEngine {
  provider: GenerationProvider;
  model: GenerationModel;
  endpoint: string;
  apiKey: string;
}

/**
 * Pick the engine for a capability. This is the entire "configuration" system.
 *
 * 1. The vendor the user is already chatting with — same key, no surprise.
 * 2. Otherwise any vendor they hold a key for, in registry order.
 *
 * Returns null when no keyed vendor can do it; the tool then reports `unsupported` and the
 * assistant explains in its own words — no dialog, no settings deep-link.
 *
 * Note step 2 can cross vendors: chatting on DeepSeek (no image support) spends the user's Zhipu
 * key. That is the accepted cost of zero configuration, and why GenerationArtifact.servedBy is
 * required and always shown on the chat card.
 */
export function selectEngine(capability: CapabilityId, chatProviderId?: string): SelectedEngine | null {
  const usable = (p: GenerationProvider) =>
    p.capability === capability && p.models.length > 0 && !!getApiKeyByRef(p.id) && !!generationEndpoint(p);

  const pick = (p: GenerationProvider): SelectedEngine => ({
    provider: p,
    model: p.models[0],
    endpoint: generationEndpoint(p),
    apiKey: getApiKeyByRef(p.id),
  });

  const own = chatProviderId
    ? GENERATION_REGISTRY.find((p) => p.id === chatProviderId && usable(p))
    : undefined;
  if (own) return pick(own);

  const any = GENERATION_REGISTRY.find(usable);
  return any ? pick(any) : null;
}

/** Whether any keyed vendor can serve this capability (for cheap UI/tool gating). */
export function capabilityAvailable(capability: CapabilityId): boolean {
  return selectEngine(capability) !== null;
}
