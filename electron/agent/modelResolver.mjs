/**
 * Model resolution for headless (main-process) agent runs. See docs/automation-workflow-design.md §6.1.
 *
 * The chat UI resolves models in the renderer from localStorage (src/lib/ai/models.ts). Automation
 * has no renderer -- a `--background` launch never creates a window -- so it reads the same data from
 * its durable mirror in app.config `[llm]`, which the renderer writes on every settings change:
 *
 *   model_list        JSON array of AgentModel
 *   selected_model    id of the current default
 *   key_<ref>         API key; ref is the provider id, or the model id for custom models
 *
 * Endpoint policy, deliberately narrow: use the endpoint persisted on the model entry. The renderer
 * composes endpoints from a PROVIDERS table and normalizes official ones on load
 * (normalizeOfficialEndpoints), so a model the user has actually selected carries a usable endpoint.
 * Re-deriving it here would mean duplicating that table in the main process and letting the two
 * copies drift -- a wrong endpoint that "looks right" is worse than a clear error.
 *
 * §6.1 ownership split: this module owns provider fallback (walking `fallbackModels[]` until one
 * responds). Node-level `retry` belongs to the Execution Manager. Keeping them separate is what
 * stops a 3-attempt retry over 3 fallbacks from silently becoming 9 model calls.
 */
const OFFICIAL_PROVIDER_ID = "official";

/**
 * Injected reader for app.config's `[llm]` section.
 *
 * Not imported directly from ../appConfig.mjs on purpose: that module imports `electron`, and a
 * single such import anywhere in a dependency chain makes the whole chain unloadable by `npm test`
 * (the same constraint storage.mjs exists to satisfy -- see design doc §9.1). The wiring module
 * injects the real reader at startup; tests inject a fixture.
 */
let readLlmSection = () => ({});

/** Point the resolver at a config source. Called once at startup (see electron/agent/index.mjs). */
export function setLlmConfigReader(fn) {
  readLlmSection = typeof fn === "function" ? fn : () => ({});
}

function llmSection() {
  return readLlmSection() ?? {};
}

/** The persisted model list, or [] when nothing has been configured yet. */
export function listModels() {
  const raw = llmSection().model_list;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("[agent] app.config [llm].model_list is not valid JSON; treating as empty");
    return [];
  }
}

/** API key for a model entry: custom models key by model id, others by provider id. */
function apiKeyFor(model) {
  const ref = model.custom ? model.id : model.providerId;
  return llmSection()[`key_${ref}`] || "";
}

/**
 * Find a model entry by id, then by exact model string, then by label (case-insensitive).
 * Workflow definitions are hand-editable, so accepting the name a human would naturally write --
 * rather than only the internal `provider::model` id -- avoids a class of silent misconfiguration.
 */
export function findModel(spec) {
  if (!spec) return null;
  const models = listModels();
  const needle = String(spec).trim();
  const lower = needle.toLowerCase();
  return (
    models.find((m) => m.id === needle) ??
    models.find((m) => m.model === needle) ??
    models.find((m) => String(m.label ?? "").toLowerCase() === lower) ??
    null
  );
}

/** The user's currently selected model, used when a node names none. */
export function defaultModel() {
  const selected = llmSection().selected_model;
  return (selected && findModel(selected)) || listModels()[0] || null;
}

/**
 * Resolve one model spec into something callable.
 * @returns {{ok:true, config:{id,label,endpoint,apiKey,model,providerId}} | {ok:false, error:string}}
 */
export function resolveModel(spec) {
  const entry = spec ? findModel(spec) : defaultModel();
  if (!entry) {
    return {
      ok: false,
      error: spec
        ? `model "${spec}" is not configured (add it under Settings → Models)`
        : "no model configured (add one under Settings → Models)",
    };
  }

  const endpoint = String(entry.endpoint ?? "").trim();
  if (!endpoint) {
    // Only reachable for a catalog model the renderer has never normalized. Say what to do rather
    // than guessing an endpoint that may silently point at the wrong host.
    return {
      ok: false,
      error: `model "${entry.label ?? entry.id}" has no endpoint recorded; open the app's Models settings once so it is persisted`,
    };
  }

  const apiKey = apiKeyFor(entry);
  // Local models legitimately need no key; remote ones fail confusingly without one, so catch it here.
  if (!apiKey && !isLocalEndpoint(endpoint) && entry.providerId !== OFFICIAL_PROVIDER_ID) {
    return { ok: false, error: `no API key configured for "${entry.label ?? entry.id}"` };
  }

  return {
    ok: true,
    config: {
      id: entry.id,
      label: entry.label ?? entry.id,
      endpoint,
      apiKey,
      model: entry.model,
      providerId: entry.providerId,
    },
  };
}

/**
 * Price in USD per 1M tokens for a model, or null when none is configured.
 *
 * Read from app.config as `[llm] price_<modelId>`. Providers do not return a price with a response,
 * so without this a run accrues tokens but zero dollars and a `maxCostUsd` ceiling would silently
 * never bind. The Policy Guard says so explicitly rather than letting an inert ceiling look active.
 */
export function priceForModel(spec) {
  const entry = findModel(spec);
  if (!entry) return null;
  const raw = llmSection()[`price_${entry.id}`];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Loopback endpoints (the bundled llama-server) need no API key. */
export function isLocalEndpoint(endpoint) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(String(endpoint ?? ""));
}

/**
 * Resolve a node's primary model plus its fallbacks into an ordered list of callable configs.
 * Unresolvable entries are reported but do not abort: a typo in the third fallback should not stop
 * a run whose primary model is fine.
 * @returns {{ok:true, chain:object[], skipped:string[]} | {ok:false, error:string}}
 */
export function resolveChain({ model, fallbackModels = [] } = {}) {
  const chain = [];
  const skipped = [];

  for (const spec of [model, ...fallbackModels]) {
    if (spec == null && chain.length) continue; // only the primary may be omitted
    const res = resolveModel(spec);
    if (res.ok) chain.push(res.config);
    else skipped.push(`${spec ?? "(default)"}: ${res.error}`);
  }

  if (!chain.length) {
    return { ok: false, error: `no usable model: ${skipped.join("; ") || "none configured"}` };
  }
  return { ok: true, chain, skipped };
}
