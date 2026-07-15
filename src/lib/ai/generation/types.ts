/**
 * Generation capabilities — shared types.
 * Design: docs/generation-capabilities-design.md
 *
 * Generation engines are NOT models the user picks. They never appear in the model picker or in
 * settings; the chat model calls a tool, and the engine is derived from the configured API keys
 * (see selectEngine in ./registry).
 *
 * There are no generation parameters by design: prompt in, artifact out, vendor defaults for
 * everything else. The adapter layer exists anyway, because the vendors disagree on things a
 * parameter could never reconcile — where to POST, and how to read the answer back.
 */

export type CapabilityId = "image_generation" | "video_generation";

export interface GenerationModel {
  /** Wire id, sent as `model`. */
  id: string;
  label: string;
}

/** Typed failures. The renderer maps each `kind` onto localized copy — "the vendor refused this
 *  prompt" must not read like "you are offline". */
export type GenerationError =
  | { kind: "filtered"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "quota"; message: string }
  | { kind: "network"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "unsupported"; message: string }
  | { kind: "unknown"; message: string };

export interface GenerationArtifact {
  /** Local path once persisted. Vendor URLs are never relied on long-term (Zhipu's expire in 30 days). */
  path?: string;
  /** https: or data: URL — directly usable as an <img>/<video> src. */
  src: string;
  mime: string;
  /** The engine that actually served this. REQUIRED: selectEngine may fall back across vendors, and
   *  the chat card names the engine so a user chatting on DeepSeek can see their Zhipu key was spent. */
  servedBy: string;
}

export type AdapterResult =
  | { ok: true; artifacts: GenerationArtifact[] }
  | { ok: false; error: GenerationError };

export interface CapabilityAdapter {
  /** prompt + model → vendor request body. No further parameters, by design. */
  toRequest(prompt: string, model: GenerationModel): Record<string, unknown>;
  /** Vendor response → artifacts, or a typed failure. Receives the HTTP status because not every
   *  vendor signals failure the same way (Zhipu reports safety refusals in-band on HTTP 200). */
  fromResponse(json: unknown, status: number): AdapterResult;
}

export interface GenerationProvider {
  /** Reuses the chat providerId, so the API key is shared via apiKeyRefOf (agent.llm.keys.<id>). */
  id: string;
  label: string;
  capability: CapabilityId;
  /** Absent → inherit the chat Provider.baseUrl. Zhipu MUST override: its images live on the general
   *  base (/api/paas/v4) while chat uses the coding base — there is no coding image endpoint. */
  baseUrl?: string;
  path: string;
  /** Preference order; [0] is this vendor's default engine. */
  models: GenerationModel[];
  adapter: CapabilityAdapter;
}

export interface GenerationTask {
  id: string;
  capability: CapabilityId;
  status: "pending" | "running" | "succeeded" | "failed";
  providerId: string;
  modelId: string;
  prompt: string;
  artifacts: GenerationArtifact[];
  error?: GenerationError;
  createdAt: number;
  completedAt?: number;
  /** Set when regenerating, so the UI can offer a compare. */
  parentTaskId?: string;
}
