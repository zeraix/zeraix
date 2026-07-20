import request from "./request";
import { getAuthToken } from "../actions/auth.actions";
import { useAuthStore } from "@/store/authStore";
import type { ApiResponse } from "@/types/index";

/** Direct API version prefix (defaults to v1). */
const VERSION = process.env.NEXT_PUBLIC_DIRECTAPIVERSION || "v1";
const v1 = (path: string) => `/${VERSION}${path}`;

/**
 * Mark a /v1 call as billable: the platform charges the wallet for it, so pull the new balance as soon as
 * the call settles. That keeps the balance shown in the UI in step with what was actually spent, request by
 * request, instead of only at the end of a turn.
 *
 * Throttled and de-duped inside the store, so a burst of calls costs at most one extra GET /me.
 * Free endpoints (models, api-key) are deliberately not wrapped.
 */
function billed<T>(call: Promise<T>): Promise<T> {
  return call.then((res) => {
    void useAuthStore.getState().refreshWallet();
    return res;
  });
}

// ── OpenAI error shape ────────────────────────────────────────────────────────────
export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code?: string | null;
    param?: string | null;
  };
}
/** Return value of /v1 endpoints: T on success, an OpenAI-shaped error on failure. */
export type OpenAIResult<T> = T | OpenAIError;

/** Type guard: whether a /v1 return value is an error body. */
export function isOpenAIError(res: unknown): res is OpenAIError {
  return !!res && typeof res === "object" && "error" in res;
}

// ── Chat Completions ───────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  /** A string, or OpenAI content parts (including image_url, which may be a URL / base64). */
  content: unknown;
  [k: string]: unknown;
}

export interface ChatCompletionRequest {
  /** Friendly id from GET /v1/models (e.g. qwen3.5-plus, claude-haiku-4.5), or a search pseudo-model sonar | sonar-pro | qwen-search. */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  /** Remaining fields (temperature, tools, …) are passed through as-is. */
  [k: string]: unknown;
}

/** OpenAI chat completion response (passed through, loosely typed). */
export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  [k: string]: unknown;
}

/**
 * Create a chat completion (non-streaming). Forces stream=false and returns the full JSON.
 * For streaming, use streamChatCompletion.
 */
export async function createChatCompletion(
  body: ChatCompletionRequest,
): Promise<OpenAIResult<ChatCompletionResponse>> {
  return billed(
    request<OpenAIResult<ChatCompletionResponse>>(v1("/chat/completions"), {
      method: "POST",
      body: JSON.stringify({ ...body, stream: false }),
    }),
  );
}

/**
 * Create a chat completion (streaming, SSE). Forces stream=true and returns the raw Response,
 * from which the caller reads the text/event-stream in response.body (terminated by `data: [DONE]`).
 * request() reads the entire response into text, which can't be used for SSE, so this fetches directly.
 */
export async function streamChatCompletion(
  body: ChatCompletionRequest,
  init?: { signal?: AbortSignal },
): Promise<Response> {
  const token = getAuthToken();
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return fetch(`${base}${v1("/chat/completions")}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: init?.signal,
  });
}

// ── Models ─────────────────────────────────────────────────────────────────────
export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  /** Non-standard capability hint. */
  type?: "chat" | "search" | "image" | "video";
}
export interface ModelList {
  object: string;
  data: Model[];
}

/** List available models (chat/vision, web-search, image, video). */
export async function listModels(): Promise<OpenAIResult<ModelList>> {
  return request<OpenAIResult<ModelList>>(v1("/models"), { method: "GET" });
}

/** Retrieve a single model. */
export async function retrieveModel(id: string): Promise<OpenAIResult<Model>> {
  return request<OpenAIResult<Model>>(v1(`/models/${encodeURIComponent(id)}`), { method: "GET" });
}

// ── Images ─────────────────────────────────────────────────────────────────────
export interface ImageInputsBase {
  /** Friendly image id (e.g. flux-pro, seedream, nano-banana, gemini-web); auto-routed if omitted. */
  model?: string;
  size?: "0.5K" | "1K" | "2K" | "4K";
  aspect_ratio?: string;
  quality_tier?: "fast" | "balanced" | "best" | "branding" | "upscale";
  /** Reference images (≤4), URL or base64 data URL. */
  reference_images?: string[];
  recraft_options?: {
    rgb_palette?: [number, number, number][];
    background_rgb?: [number, number, number];
  };
  font_inputs?: { font_url?: string; text?: string }[];
}

export interface ImageGenerationsRequest extends ImageInputsBase {
  prompt: string;
  /** Compatibility field; only one image is actually returned. */
  n?: number;
}

export interface ImageEditsRequest extends ImageInputsBase {
  prompt: string;
  /** The image being edited/upscaled — URL or base64 data URL. */
  image: string;
  /** Inpainting mask — URL or base64 data URL. */
  mask?: string;
  operation?: "edit" | "upscale";
  strength?: number;
}

export interface ImageResponse {
  created?: number;
  /** The image model that actually served this request. */
  model?: string;
  data?: { url: string }[];
  warnings?: string[];
}

/** Text-to-image. Returns a persistent OSS CDN URL. */
export async function generateImages(
  body: ImageGenerationsRequest,
): Promise<OpenAIResult<ImageResponse>> {
  return billed(
    request<OpenAIResult<ImageResponse>>(v1("/images/generations"), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

/** Image edit (operation: edit) or upscale. */
export async function editImage(body: ImageEditsRequest): Promise<OpenAIResult<ImageResponse>> {
  return billed(
    request<OpenAIResult<ImageResponse>>(v1("/images/edits"), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

// ── Videos (async tasks) ─────────────────────────────────────────────────────────────
export interface VideoCreateRequest {
  operation: "text-to-video" | "image-to-video" | "reference-to-video" | "video-edit";
  prompt?: string;
  /** Friendly video id (e.g. happyhorse, seedance, veo); auto-routed if omitted. */
  model?: string;
  /** image-to-video first frame — URL or base64 data URL. */
  first_frame_image?: string;
  /** Optional last frame — URL or base64 data URL. */
  last_frame_image?: string;
  /** URL or base64 data URL. */
  reference_images?: string[];
  /** video-edit source — must be an already-hosted URL. */
  video_url?: string;
  resolution?: string;
  ratio?: string;
  /** Seconds (aligned to the model's discrete tiers). */
  duration?: number;
  audio_setting?: "auto" | "origin";
  generate_audio?: boolean;
  seed?: number;
}

export interface VideoTask {
  id: string;
  object: string;
  status: "queued" | "submitted" | "generating" | "finalizing" | "succeeded" | "failed";
  model: string;
  operation: string;
  prompt: string;
  /** Quoted price, held as a pre-charge at creation (only returned by POST). */
  estimated_cost_cny?: number;
  /** Persistent CDN URL on success. */
  video_url?: string | null;
  /** Failure reason (present on failure; the charge is automatically refunded). */
  error?: string | null;
  warnings?: string[];
  created?: number;
  /** Present in the terminal state. */
  completed?: number;
}

/** Submit a video generation task (async, returns taskId immediately; then poll getVideoTask). */
export async function createVideo(body: VideoCreateRequest): Promise<OpenAIResult<VideoTask>> {
  return billed(
    request<OpenAIResult<VideoTask>>(v1("/videos"), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Query a video task (only tasks under your own key; others' tasks return 404).
 * Billed-adjacent rather than billable: the charge is held at creation and refunded on failure, so each
 * poll is the moment the balance can change — refresh alongside it.
 */
export async function getVideoTask(taskId: string): Promise<OpenAIResult<VideoTask>> {
  return billed(
    request<OpenAIResult<VideoTask>>(v1(`/videos/${encodeURIComponent(taskId)}`), {
      method: "GET",
    }),
  );
}

// ── API Key management (JWT auth, platform { success, data } envelope) ──────────────────────────────
export interface ApiKeyInfo {
  /** Key identifier (used for list management). */
  id?: string;
  /** Name/note (if provided by the backend). */
  name?: string;
  /** Plaintext key (decrypted); null if never created. */
  key: string | null;
  keyPrefix: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}
export interface RegeneratedKey {
  key: string;
}

/** Get the current user's official API key list (decrypted) and metadata. */
export async function getApiKey(): Promise<ApiResponse<ApiKeyInfo[]>> {
  return request<ApiResponse<ApiKeyInfo[]>>("/me/api-key", { method: "GET" });
}

/**
 * Rotate (regenerate) the API key — the old key is invalidated immediately and the new key is returned.
 * If the backend uses the /me/api-keys/regenerate sub-path, change the path here.
 */
export async function regenerateApiKey(): Promise<ApiResponse<RegeneratedKey>> {
  return request<ApiResponse<RegeneratedKey>>("/me/api-key/regenerate", { method: "POST" });
}
