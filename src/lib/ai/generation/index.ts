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
import type { AdapterResult, CapabilityId, GenerationError, GenerationArtifact } from "./types";
import type { SelectedEngine } from "./registry";
import { POLL_BUDGET_MS, clampPollInterval } from "./polling";

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
  /** Called while an async job is still running, so a caller can show elapsed time rather than a dead spinner. */
  onProgress?: (elapsedMs: number) => void;
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

  // An async job (video, on every vendor): the submit call returned a task id, not the work. Poll until it
  // settles. Images never reach this branch — no image adapter declares `poll`, and none returns `pending`.
  const settled = adapted.pending
    ? await pollUntilSettled(engine, adapted.pending.taskId, { signal, onProgress: opts.onProgress })
    : adapted;
  if (!settled.ok) return { ok: false, error: settled.error };

  const artifact = settled.artifacts?.[0];
  if (!artifact) return { ok: false, error: { kind: "unknown", message: "provider returned no artifact" } };

  return { ok: true, artifact, providerId: engine.provider.id, modelId: engine.model.id };
}

/**
 * Ask about a submitted job until it finishes, fails, or runs out of budget.
 *
 * Cancellation is checked on every tick as well as being handed to fetch, because the wait BETWEEN polls is
 * where nearly all of the elapsed time is: a signal that only reached fetch would leave a cancelled turn
 * sleeping for up to one interval before noticing.
 */
async function pollUntilSettled(
  engine: SelectedEngine,
  taskId: string,
  opts: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void },
): Promise<AdapterResult> {
  const poll = engine.provider.adapter.poll;
  if (!poll) {
    return {
      ok: false,
      error: { kind: "unsupported", message: "the provider accepted an async job but this engine cannot poll it" },
    };
  }
  const template = engine.pollUrl ?? "";
  if (!template) {
    return {
      ok: false,
      error: { kind: "unsupported", message: "this engine has no poll URL configured, so its job cannot be collected" },
    };
  }

  // The engine's own interval when it set one, clamped to the floor — see polling.ts. Resolved once, before
  // the loop: re-reading it per tick would let a mid-flight settings edit change the cadence of a job that is
  // already running, which is a surprise nobody asked for.
  const intervalMs = clampPollInterval(engine.pollIntervalMs);
  const startedAt = Date.now();
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, error: { kind: "timeout", message: "cancelled" } };
    const elapsed = Date.now() - startedAt;
    if (elapsed > POLL_BUDGET_MS) {
      return {
        ok: false,
        error: { kind: "timeout", message: `the job did not finish within ${Math.round(POLL_BUDGET_MS / 60_000)} minutes` },
      };
    }
    opts.onProgress?.(elapsed);
    await new Promise((r) => setTimeout(r, intervalMs));
    if (opts.signal?.aborted) return { ok: false, error: { kind: "timeout", message: "cancelled" } };

    let res: Response;
    try {
      res = await fetch(poll.url(taskId, template), {
        headers: { Authorization: `Bearer ${engine.apiKey}` },
        signal: opts.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      // A transient network blip must not discard a job that is still running on the vendor's side, so a
      // failed poll is retried within the budget rather than being treated as a failed generation.
      if (aborted) return { ok: false, error: { kind: "timeout", message: "cancelled" } };
      continue;
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      continue;
    }
    const result = withServedBy(poll.from(json, res.status), engine.model);
    if (!result.ok) return result;
    if (!result.pending) return result;
  }
}

/** GenerationError kind → locale key. The renderer owns all user-facing copy (11 locales);
 *  "the vendor refused this prompt" must not read like "you are offline". */
export function imageErrorKey(kind: GenerationError["kind"]): string {
  return `image.error.${kind}`;
}
