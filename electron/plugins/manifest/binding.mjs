/**
 * Capability binding for plugin manifests: how a capability is satisfied (static content, one
 * provider, or a `bind` list), the request template a callable http tool carries, and which provider
 * kinds a capability type may bind to. See docs/plugin-marketplace-design.md §3.4 and §7.
 *
 * Split out of manifest.mjs; validateManifest() is the only caller and these are not part of the
 * public surface. The note on `has` referred to below lives in manifest/schema.mjs. Imports the
 * schema module, never manifest.mjs, so there is no cycle.
 */
import {
  CONTENT_CAPABILITY_TYPES,
  HTTP_METHODS,
  NON_BINDABLE_KINDS,
  NON_EXECUTING_KINDS,
  REL_PATH_RE,
  SHA512_B64_RE,
  has,
  isNonEmptyString,
  isPlainObject,
} from "./schema.mjs";

/* ------------------------------------------------------------------ binding */

/**
 * Resolve how a capability is satisfied: static content, one provider, or an ordered `bind` list.
 *
 * `bind` is reserved (design doc §3.4, §7): the schema accepts it now so a future manifest is not a
 * breaking change, and this client reduces it to its first entry. Predicates are shape-checked only
 * -- evaluating `when` belongs to the runtime that knows the host.
 *
 * @returns {{ provider: string|null, bind: object[]|null, providers: string[] }|null}
 */
export function resolveBinding(at, c, providers, { strict, err, drop }) {
  const isContent = CONTENT_CAPABILITY_TYPES.includes(c.type);
  const hasContent = has(c, "path") || has(c, "sha512");
  const hasProvider = has(c, "provider");
  const hasBind = has(c, "bind");

  /**
   * A `bind` capability normalizes to BOTH `bind` (the resolved candidates) and `provider` (the
   * effective first one), so our own output re-enters this function with two of the three set.
   *
   * That is not an author declaring two ways. It is the normalized manifest coming back for the
   * re-validation parseIndex performs on every index entry, and counting it as ambiguity made
   * validate(normalize(x)) fail for every `bind` capability ever written -- see the note on `has`,
   * which is precisely the property this broke. The registry published such a plugin happily and
   * every client then dropped the entry, so the plugin vanished from the catalogue with the reason
   * recorded somewhere nobody reads.
   *
   * Accepted only when the two AGREE. A hand-written manifest that sets `provider` to something
   * other than its first bind candidate is still the genuine ambiguity this check exists to catch.
   */
  const isNormalizedBind =
    hasBind && hasProvider && Array.isArray(c.bind) && c.bind[0]?.provider === c.provider;
  /**
   * When both are present and agree, `bind` is the real declaration and `provider` is the summary
   * of it. This flag has to gate the DISPATCH below as well as the count: resolving such a
   * capability down the single-provider branch would return `bind: null` and a one-entry
   * `providers`, quietly deleting every fallback candidate on the client's re-validation pass.
   */
  const useProvider = hasProvider && !isNormalizedBind;

  const ways = [hasContent, useProvider, hasBind].filter(Boolean).length;
  if (ways === 0) {
    err(`${at}: must declare one of path+sha512, provider, or bind`);
    return null;
  }
  if (ways > 1) {
    err(`${at}: declare exactly one of path+sha512, provider, or bind`);
    return null;
  }

  if (hasContent) {
    if (!isContent) {
      err(`${at}: type "${c.type}" cannot be satisfied by static content`);
      return null;
    }
    if (!REL_PATH_RE.test(c.path ?? "")) {
      err(`${at}.path must be a relative path inside the bundle, without ".."`);
      return null;
    }
    if (!SHA512_B64_RE.test(c.sha512 ?? "")) {
      err(`${at}.sha512 is required with path and must be base64 sha512`);
      return null;
    }
    return { provider: null, bind: null, providers: [] };
  }

  if (useProvider) {
    if (!isNonEmptyString(c.provider)) {
      err(`${at}.provider must be a non-empty string`);
      return null;
    }
    if (!(c.provider in providers)) {
      // Either a typo, or the provider was dropped as unknown/unimplemented. Both mean this
      // capability cannot run; in client mode that is a skip, not a failed install.
      drop(at, `provider "${c.provider}" is not available`);
      return null;
    }
    if (!checkKindFit(at, c.type, providers[c.provider].kind, err)) return null;
    return { provider: c.provider, bind: null, providers: [c.provider] };
  }

  if (!Array.isArray(c.bind) || c.bind.length === 0) {
    err(`${at}.bind must be a non-empty array`);
    return null;
  }
  const candidates = [];
  let bad = false;
  c.bind.forEach((b, i) => {
    const bat = `${at}.bind[${i}]`;
    if (!isPlainObject(b)) {
      err(`${bat} must be an object`);
      bad = true;
      return;
    }
    if (!isNonEmptyString(b.provider)) {
      err(`${bat}.provider is required`);
      bad = true;
      return;
    }
    if (has(b, "when") && !isNonEmptyString(b.when)) {
      err(`${bat}.when must be a non-empty string when present`);
      bad = true;
      return;
    }
    if (!(b.provider in providers)) return; // dropped provider: this candidate is simply unavailable
    if (!checkKindFit(bat, c.type, providers[b.provider].kind, err)) {
      bad = true;
      return;
    }
    candidates.push({ provider: b.provider, when: b.when ?? null });
  });
  if (bad) return null;
  if (candidates.length === 0) {
    drop(at, "no provider in bind[] is available");
    return null;
  }
  if (strict && candidates.length < c.bind.length) {
    // In registry mode every listed candidate must be real; a typo'd fallback silently narrows the
    // matrix and nobody notices until the one host that needed it fails.
    err(`${at}.bind references a provider that is not declared`);
    return null;
  }
  return { provider: candidates[0].provider, bind: candidates, providers: candidates.map((b) => b.provider) };
}

/** A tool cannot come from a provider that executes nothing, and content types cannot come from one that does. */
/**
 * A tool's request template: how the model's arguments become one HTTP call.
 *
 * Only meaningful for `type: "tool"` bound to an executing http provider. The shape is deliberately
 * small — method, path, query, body — because everything it does NOT allow is a thing a manifest
 * cannot make the host do: no arbitrary headers (the Authorization header is the host's to set, and
 * letting a manifest add its own is how a token reaches a second destination), no absolute URL (the
 * provider's `url` is the only origin, so `permissions.network` cannot be sidestepped by a path), and
 * no scheme, host or port anywhere in the template.
 *
 * `{name}` placeholders interpolate arguments. They are substituted at call time by the executor,
 * which percent-encodes every value — the template says WHERE a value goes, never what it is.
 *
 * @returns the normalized request, `null` when the capability needs none, or `false` on error.
 */
export function validateRequest(at, c, providers, bound, { err, warn }) {
  const kinds = (bound.providers ?? []).map((pid) => providers[pid]?.kind);
  const needsRequest = c.type === "tool" && kinds.includes("http");

  if (!needsRequest) {
    if (has(c, "request")) warn(`${at}: "request" is only meaningful for a tool on an http provider`);
    if (has(c, "input_schema") && c.type !== "tool") warn(`${at}: "input_schema" is only meaningful for a tool`);
    return null;
  }

  if (!has(c, "request")) {
    // NOT an error. `zeraix/gmail-send` and every other tool published before this field existed are
    // valid manifests, and versions are immutable (§5.3) — rejecting them now would retroactively
    // un-publish work that passed review. Same posture as an unimplemented type: publishable, not
    // installable, and installableCapabilities() is what keeps it out of an install.
    warn(`${at}: a tool on an http provider needs a "request" to be callable; this one cannot run yet`);
    return null;
  }
  if (!isPlainObject(c.request)) {
    err(`${at}.request must be an object ({ method, path })`);
    return false;
  }
  const method = String(c.request.method ?? "").toUpperCase();
  if (!HTTP_METHODS.includes(method)) {
    err(`${at}.request.method must be one of ${HTTP_METHODS.join("|")}`);
    return false;
  }
  const path = c.request.path;
  if (!isNonEmptyString(path) || !path.startsWith("/")) {
    err(`${at}.request.path must be a path beginning with "/" — the provider's url is the only origin`);
    return false;
  }
  if (/^\/\//.test(path) || /[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.split("?")[0])) {
    // "//host/x" is protocol-relative and "https://host" is absolute; both would leave the origin the
    // user consented to while still looking like a path.
    err(`${at}.request.path must not contain a scheme or authority`);
    return false;
  }
  if (has(c.request, "query") && !isPlainObject(c.request.query)) {
    err(`${at}.request.query must be an object of name -> value template`);
    return false;
  }
  if (has(c.request, "body") && !isNonEmptyString(c.request.body) && !isPlainObject(c.request.body)) {
    err(`${at}.request.body must be a "{placeholder}" or an object template`);
    return false;
  }
  for (const field of ["headers", "url", "origin", "host"]) {
    if (has(c.request, field)) {
      err(`${at}.request.${field} is not permitted — the host owns the origin and the Authorization header`);
      return false;
    }
  }
  if (has(c, "input_schema") && !isPlainObject(c.input_schema)) {
    err(`${at}.input_schema must be a JSON Schema object`);
    return false;
  }
  if (!isNonEmptyString(c.description)) {
    // The description IS the interface: a tool the model cannot tell apart from its siblings is one
    // it calls wrongly, and with 79 of them on one API that stops being a nicety. Required only for a
    // capability that declares a request, so this cannot reject anything published earlier.
    err(`${at}: a callable tool requires a description — it is what the model selects on`);
    return false;
  }
  return {
    method,
    path,
    query: isPlainObject(c.request.query) ? { ...c.request.query } : {},
    body: has(c.request, "body") ? c.request.body : null,
  };
}

function checkKindFit(at, type, kind, err) {
  if (NON_BINDABLE_KINDS.includes(kind)) {
    // The whole point of the split (oauth design §2): bind to the provider that makes the call, and
    // let it name this one through `auth`. Suggesting the fix here because the wrong shape is the
    // obvious one to reach for first.
    err(
      `${at}: kind "${kind}" authorizes but executes nothing, so no capability may bind to it — ` +
        `bind to the http/mcp-http provider and give that provider "auth": "<this provider>"`,
    );
    return false;
  }
  const executes = !NON_EXECUTING_KINDS.includes(kind);
  if (!executes && !CONTENT_CAPABILITY_TYPES.includes(type)) {
    err(`${at}: type "${type}" needs an executing provider, but "${kind}" executes nothing`);
    return false;
  }
  return true;
}
