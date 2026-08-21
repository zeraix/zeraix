/**
 * Running a `tool` capability bound to an `http` provider. See docs/plugin-marketplace-design.md §4.
 *
 * This is the half the marketplace was missing: a manifest could describe an API call, and nothing
 * could make one. Everything it does is decided by the INSTALLED manifest — the request template, the
 * origin, the permitted hosts — and nothing by the model, which supplies values and nothing else.
 *
 * The three things a tool call must not be able to do, and where each is stopped:
 *
 *   1. Reach an origin the user did not consent to. The provider's `url` is the only base, the
 *      template is refused at validation if it carries a scheme or authority, and the resolved URL is
 *      re-checked against `permissions.network` here — after resolution, because a path like
 *      `/../..` is only revealed as an origin change once resolved.
 *   2. Spend a credential it was not granted. The Authorization header is set here from the plugin's
 *      own grant and cannot be named by the manifest; a tool whose provider declares no `auth` sends
 *      no credential at all.
 *   3. Return unbounded data into the conversation. A response is capped, and the cap is reported
 *      rather than silently truncating into what reads like a complete answer.
 */
import { ensureAuthorized } from "./auth.mjs";
import { getInstalled } from "./store.mjs";
import { injectAuthHeader } from "./oauth.mjs";

/** A tool result is going into a prompt. Past this size it is costing more than it tells anyone. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** An API call that has not answered in this long is not going to help the turn it belongs to. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * Substitute `{name}` placeholders from the model's arguments.
 *
 * `encode` is the whole security story of this function: a path segment is percent-encoded, so a
 * value containing `/` or `..` becomes one literal segment rather than a traversal, and a query value
 * cannot smuggle in another parameter. The template decides structure; an argument is only ever data.
 */
function interpolate(template, args, { encode, seen }) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
    if (!(name in args) || args[name] === null || args[name] === undefined) return whole === template ? "" : "";
    seen?.add(name);
    const value = typeof args[name] === "object" ? JSON.stringify(args[name]) : String(args[name]);
    return encode ? encodeURIComponent(value) : value;
  });
}

/** Whether `host` is covered by one `permissions.network` entry. `*.example.com` matches a subdomain. */
function hostAllowed(host, patterns) {
  return patterns.some((raw) => {
    const p = String(raw).trim().toLowerCase();
    if (!p) return false;
    if (p === "*") return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      return host === p.slice(2) || host.endsWith(suffix);
    }
    return host === p;
  });
}

/**
 * Resolve a capability to the exact request it will make, without making it.
 *
 * Separate from `callTool` so the check and the call cannot disagree, and so a test (or a future
 * consent prompt) can see the URL a tool is about to hit.
 */
export function planRequest(pluginId, capabilityId, args = {}) {
  const installed = getInstalled(pluginId);
  if (!installed) return { ok: false, error: `${pluginId} is not installed` };
  if (!installed.enabled) return { ok: false, error: `${pluginId} is disabled` };
  if (installed.revoked) return { ok: false, error: `${pluginId} was revoked: ${installed.revoked.reason}` };

  const cap = installed.capabilities?.find((c) => c.id === capabilityId);
  if (!cap) return { ok: false, error: `${pluginId} has no installed capability "${capabilityId}"` };
  if (cap.revoked) return { ok: false, error: `${pluginId}:${capabilityId} was revoked: ${cap.revoked.reason}` };
  if (cap.type !== "tool" || !cap.request) return { ok: false, error: `${pluginId}:${capabilityId} is not a callable tool` };

  const providerId = (cap.providers ?? []).find((pid) => installed.providers?.[pid]?.kind === "http");
  const provider = providerId ? installed.providers[providerId] : null;
  if (!provider) return { ok: false, error: `${pluginId}:${capabilityId} has no http provider to call` };

  const used = new Set();
  let url;
  try {
    // Relative to the provider's url, so a template can only ever move within that origin's path.
    url = new URL(interpolate(cap.request.path, args, { encode: true, seen: used }), provider.url);
  } catch (e) {
    return { ok: false, error: `${capabilityId}: could not build a URL (${e.message})` };
  }

  const base = new URL(provider.url);
  if (url.origin !== base.origin) {
    // Only reachable through a resolved traversal; the template check catches the literal forms.
    return { ok: false, error: `${capabilityId}: request would leave ${base.origin}` };
  }
  if (url.protocol !== "https:") return { ok: false, error: `${capabilityId}: refusing a non-https call` };

  const allowed = provider.permissions?.network ?? [];
  if (!hostAllowed(url.hostname, allowed)) {
    // The consent sheet listed these hosts; a call outside them is one the user never agreed to.
    return { ok: false, error: `${capabilityId}: ${url.hostname} is not in this plugin's permitted hosts (${allowed.join(", ") || "none"})` };
  }

  for (const [key, template] of Object.entries(cap.request.query ?? {})) {
    const value = interpolate(template, args, { encode: false, seen: used });
    // An unfilled optional parameter is absent, not empty: `?q=` is a different query from no `q`.
    if (value !== "" && !/^\{[A-Za-z0-9_]+\}$/.test(value)) url.searchParams.set(key, value);
  }

  let body = null;
  if (cap.request.body !== null && cap.request.body !== undefined) {
    if (typeof cap.request.body === "string") {
      const name = /^\{([A-Za-z0-9_]+)\}$/.exec(cap.request.body)?.[1];
      // `body: "{resource}"` means "send this argument as the JSON body" — the common shape for an
      // API whose payload the caller supplies whole.
      if (name) body = name in args ? args[name] : null;
      else body = interpolate(cap.request.body, args, { encode: false, seen: used });
      if (name) used.add(name);
    } else {
      body = JSON.parse(interpolate(JSON.stringify(cap.request.body), args, { encode: false, seen: used }));
    }
  }

  return {
    ok: true,
    error: null,
    plan: { method: cap.request.method, url: url.href, body, providerId, auth: provider.auth ?? null, unused: Object.keys(args).filter((k) => !used.has(k)) },
  };
}

/**
 * Make the call and return what the model should see.
 *
 * Errors come back as text rather than exceptions: a 404 from Gmail is information the model can act
 * on, and turning it into a thrown error would lose the body that says which id was wrong.
 */
export async function callTool(pluginId, capabilityId, args = {}, { fetchImpl } = {}) {
  const planned = planRequest(pluginId, capabilityId, args);
  if (!planned.ok) return { ok: false, content: planned.error };
  const { method, url, body, auth } = planned.plan;

  let headers = { accept: "application/json" };
  if (auth) {
    // Before use, not at install: a grant can lapse between the two, and this is the point where
    // re-asking is worth the interruption because the user is waiting on this exact call.
    const gate = await ensureAuthorized(pluginId, capabilityId);
    if (!gate.ok) return { ok: false, content: gate.error };
    const installed = getInstalled(pluginId);
    headers = await injectAuthHeader(headers, {
      pluginId,
      providerId: auth,
      oauth: installed.providers[auth].oauth,
      resolveNeed: (key) => {
        throw new Error(`oauth: "${key}" must be supplied by the user, which is not built yet`);
      },
    });
  }

  const hasBody = body !== null && body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody) headers["content-type"] = "application/json";

  let res;
  try {
    res = await (fetchImpl ?? fetch)(url, {
      method,
      headers,
      body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, content: `${capabilityId}: ${e?.name === "TimeoutError" ? `no response in ${CALL_TIMEOUT_MS / 1000}s` : e?.message ?? String(e)}` };
  }

  const raw = await res.text();
  const text = raw.length > MAX_RESPONSE_BYTES
    ? `${raw.slice(0, MAX_RESPONSE_BYTES)}\n\n[truncated: response was ${raw.length} bytes, limit ${MAX_RESPONSE_BYTES}]`
    : raw;

  if (!res.ok) {
    // The body is the useful half of an API error — it names the field, the id, or the missing scope.
    return { ok: false, content: `HTTP ${res.status} ${res.statusText} from ${capabilityId}\n${text}` };
  }
  return { ok: true, content: text || "(empty response)" };
}
