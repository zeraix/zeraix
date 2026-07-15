/**
 * Generation orchestrator: select → request → adapt. Vendor-agnostic.
 * Design: docs/generation-capabilities-design.md §4.3
 *
 * Persistence (download-on-receipt) is deliberately NOT here — it needs the workspace/filesystem
 * bridge and belongs to the caller. Until it runs, `artifact.src` is a vendor URL that expires
 * (Zhipu: 30 days) or an inline base64 payload that must never reach the message store.
 */
import { withServedBy } from "./adapters";
import { selectEngine } from "./registry";
import type { CapabilityId, GenerationError, GenerationArtifact } from "./types";

export * from "./types";
export { GENERATION_REGISTRY, selectEngine, capabilityAvailable, generationEndpoint } from "./registry";

export type GenerateResult =
  | { ok: true; artifact: GenerationArtifact; providerId: string; modelId: string }
  | { ok: false; error: GenerationError };

/**
 * Run one generation. Never throws — every failure is a typed GenerationError, so the tool layer
 * can hand the model something it can explain to the user.
 */
export async function generate(opts: {
  capability: CapabilityId;
  prompt: string;
  /** The provider of the chat model in use; preferred, so the user's own vendor serves the request. */
  chatProviderId?: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const { capability, prompt, chatProviderId, signal } = opts;

  const engine = selectEngine(capability, chatProviderId);
  if (!engine) {
    return {
      ok: false,
      error: {
        kind: "unsupported",
        message: "no configured provider can generate images; add an API key for Zhipu, Gemini, or OpenAI",
      },
    };
  }

  const body = engine.provider.adapter.toRequest(prompt, engine.model);

  let res: Response;
  try {
    res = await fetch(engine.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      error: { kind: aborted ? "timeout" : "network", message: String((e as Error)?.message ?? e) },
    };
  }

  // Parse before checking status: several vendors put the useful message in the error body, and
  // Zhipu signals a refusal with HTTP 200 — so the adapter needs both the body and the status.
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: { kind: "unknown", message: `HTTP ${res.status}: unreadable response` } };
  }

  const adapted = withServedBy(engine.provider.adapter.fromResponse(json, res.status), engine.model);
  if (!adapted.ok) return { ok: false, error: adapted.error };

  const artifact = adapted.artifacts[0];
  if (!artifact) return { ok: false, error: { kind: "unknown", message: "provider returned no image" } };

  return { ok: true, artifact, providerId: engine.provider.id, modelId: engine.model.id };
}

/** GenerationError kind → locale key. The renderer owns all user-facing copy (11 locales);
 *  "the vendor refused this prompt" must not read like "you are offline". */
export function imageErrorKey(kind: GenerationError["kind"]): string {
  return `image.error.${kind}`;
}
