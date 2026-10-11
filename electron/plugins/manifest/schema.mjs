/**
 * Plugin manifest schema: the constants, endpoint presets, id/path/hash expressions and shape
 * predicates the validators share. Split out of manifest.mjs, which is still the public entry and
 * re-exports the public names from here; "the header" below means the header of manifest.mjs, where
 * the two modes and the unknown-versus-unimplemented split are explained.
 *
 * Imported by manifest.mjs, manifest/providers.mjs and manifest/binding.mjs. It imports nothing, so
 * none of them can form a cycle through it.
 */

/** Bumped only for a breaking change. Additive fields ship as optional and cost no bump. */
export const SCHEMA_VERSION = 1;

/** Every capability type the model defines (design doc §3.3). Reserved now, implemented over time. */
export const CAPABILITY_TYPES = [
  "tool",
  "skill",
  "prompt",
  "resource",
  "subagent",
  "model",
  "workflow",
  "memory",
  "ui",
];

/**
 * Implemented so far. Everything else validates but cannot be installed yet -- the same
 * "parses but cannot run yet" split IMPLEMENTED_RUNTIMES uses in automation/schema.mjs.
 * Phase 1 is text-tier only (design doc §9). Filtered by installableCapabilities(), not by
 * validateManifest(): see the header on why unimplemented is not a validation outcome.
 */
export const IMPLEMENTED_CAPABILITY_TYPES = ["skill", "prompt", "subagent", "tool"];

/**
 * Capability types that may be satisfied by static content (`path` + `sha512`) instead of a
 * provider. These are inert documents the app interprets: instructions, definitions, templates.
 *
 * `tool` and `model` are absent because they are only meaningful as something that runs. `ui` is
 * present because it ships as a bundle rather than a process -- but it *executes* in the renderer
 * once loaded, which is why §4.3 puts an iframe and a locked CSP around it and why it is not in
 * IMPLEMENTED_CAPABILITY_TYPES. Content does not mean harmless.
 */
export const CONTENT_CAPABILITY_TYPES = ["skill", "prompt", "subagent", "workflow", "memory", "resource", "ui"];

/**
 * Types needing a higher review bar than the tier alone implies (design doc §4.3): `ui` ships code
 * into the renderer, `model` receives every prompt routed to it. Not a schema error -- surfaced as a
 * warning so registry CI can gate on publisher identity.
 */
export const HIGH_BAR_CAPABILITY_TYPES = ["ui", "model"];

export const PROVIDER_KINDS = ["builtin", "mcp-stdio", "mcp-http", "http", "process", "text", "oauth"];
/**
 * `oauth` is here despite Phase 1 being text-only, and it costs nothing: no capability ever binds to
 * an oauth provider (NON_BINDABLE_KINDS), so installableCapabilities() never inspects one. Listing it
 * only suppresses the "not implemented yet" warning, which would be false once the host module ships.
 * What still gates a Gmail plugin from installing is its CONSUMER's kind -- `http` is not in this list.
 */
export const IMPLEMENTED_PROVIDER_KINDS = ["text", "oauth", "http"];

/** Trust tiers (design doc §4.1). Declared per provider in the reviewed manifest, enforced here. */
export const TIERS = ["text", "sandboxed", "host"];

/** Provider kinds that execute nothing. A `text` tier is only honest for these. */
export const NON_EXECUTING_KINDS = ["text"];
/** Provider kinds that run a local process and therefore need an artifact hash. */
export const LOCAL_CODE_KINDS = ["mcp-stdio", "process"];

/**
 * Kinds a capability may not bind to (oauth design §2).
 *
 * An oauth provider authorizes; it does not execute. A capability binds to the provider that makes
 * the call, and that provider names its authorizer through `auth`. Binding a tool straight to an
 * oauth provider would describe something that cannot answer it.
 *
 * Distinct from NON_EXECUTING_KINDS, which is about honest tiering: `text` executes nothing AND is
 * bindable (skills are static content). `oauth` is the inverse -- it drives a browser and a token
 * exchange, so it is emphatically not `text` tier, yet nothing may bind to it.
 */
export const NON_BINDABLE_KINDS = ["oauth"];

/**
 * Kinds that may carry `auth` (oauth design §5.1).
 *
 * Restricted to the two kinds whose egress the HOST performs, because that is the only arrangement in
 * which the token stays away from the plugin. An mcp-stdio or process provider opens its own sockets,
 * so authorizing its requests would mean handing it the token -- which is the thing this feature
 * exists to prevent. Lifting this needs the loopback token-broker, not a schema change.
 */
export const AUTH_CONSUMER_KINDS = ["http", "mcp-http"];

/**
 * Endpoint presets, keyed by `oauth.known_provider` (oauth design §3.1).
 *
 * These live in the host rather than the manifest for two reasons. A publisher cannot edit them, so a
 * manifest cannot aim the browser at a look-alike login page -- the flow whose entire purpose is to
 * get the user to type a password is not one where a hand-typed URL should be trusted. And when a
 * vendor moves an endpoint it is an app update, not a re-publish of every plugin that used it.
 */
export const OAUTH_PRESETS = {
  // VERIFIED end to end against the live provider (2026-08-20).
  google: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    refresh_url: null, // same endpoint, distinguished by grant_type
    refresh_grant_type: true,
    scope_separator: " ",
    // Google issues a refresh token ONLY with these, and re-consent is needed to get one again.
    // Sending them to a provider that does not know them is at best noise and at worst a 400, which
    // is exactly why they live here rather than in buildAuthorizeUrl.
    extra_authorize_params: { access_type: "offline", prompt: "consent" },
    token_auth: "post",
    pkce: "required",
    refresh: "static", // the refresh token is stable; a refresh response omits it
    verified: true,
  },

  // UNVERIFIED. The shape is right; the values below are from documentation, not from a round trip we
  // have made. Provider details drift (GitHub changed its scope delimiter; Figma moved to Basic auth),
  // and being wrong here fails at consent or at the exchange, in front of a user. Run
  // scripts/oauth-probe.mjs against each before flipping `verified`, and fix the value HERE -- this
  // table is the only place any of it is encoded.
  github: {
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    refresh_url: null,
    refresh_grant_type: true,
    scope_separator: " ",
    extra_authorize_params: {},
    token_auth: "post",
    pkce: "unsupported", // OAuth Apps have no PKCE; this forces a confidential client -- see §3.4
    refresh: "none", // classic OAuth App tokens do not expire and carry no refresh token
    verified: false,
  },
  slack: {
    authorize_url: "https://slack.com/oauth/v2/authorize",
    token_url: "https://slack.com/api/oauth.v2.access",
    refresh_url: null,
    refresh_grant_type: true,
    scope_separator: ",",
    extra_authorize_params: {},
    token_auth: "post",
    pkce: "unsupported",
    refresh: "rotating", // only when token rotation is enabled on the app
    verified: false,
  },
  figma: {
    // Values below read from developers.figma.com/docs/rest-api/oauth-apps on 2026-08-20. `verified`
    // still means a round trip we have made, which this is not.
    authorize_url: "https://www.figma.com/oauth",
    token_url: "https://api.figma.com/v1/oauth/token",
    // A SEPARATE endpoint, not the token endpoint with a different grant_type. Assuming otherwise
    // would have posted the refresh to the wrong URL -- and only failed 90 days after authorization.
    refresh_url: "https://api.figma.com/v1/oauth/refresh",
    refresh_grant_type: false, // the body carries refresh_token and nothing else
    scope_separator: " ",
    extra_authorize_params: {},
    token_auth: "basic", // client_id:client_secret, base64, in the Authorization header
    pkce: "supported", // optional per the docs, S256 only; we always send it
    refresh: "static", // the refresh response returns access_token/token_type/expires_in only
    verified: false,
  },
  microsoft: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    refresh_url: null,
    refresh_grant_type: true,
    scope_separator: " ",
    extra_authorize_params: {},
    token_auth: "post",
    pkce: "required",
    refresh: "rotating",
    verified: false,
  },
};

/** Defaults for a literal (non-preset) endpoint pair: the RFC's answers, not any vendor's. */
export const OAUTH_PROFILE_DEFAULTS = {
  refresh_url: null, // null = refresh at token_url, the RFC 6749 arrangement
  refresh_grant_type: true,
  scope_separator: " ",
  extra_authorize_params: {},
  token_auth: "post",
  pkce: "required",
  refresh: "static",
  verified: false,
};

/** Redirect strategies (oauth design §3.3). The custom scheme is the APP's; a manifest only opts in. */
export const OAUTH_REDIRECT_METHODS = ["loopback", "custom_scheme"];

/**
 * An acceptable OAuth endpoint: https, or plaintext to loopback.
 *
 * The https rule exists so an authorization code and a client secret never cross a network in the
 * clear. Loopback crosses no network -- the packets do not leave the machine -- so the exemption is
 * principled rather than a convenience, and it is what a local mock identity provider needs to be
 * testable at all. It widens nothing in practice: literal endpoints are refused for publication
 * (§3.1), so this is only reachable on a sideloaded manifest, where the author already has the
 * machine. Embedded credentials (`user:pass@`) are refused either way -- those are never legitimate
 * in an authorization URL.
 *
 * Exported so the runtime and the validator cannot drift into disagreeing about the same string.
 */
export function isAcceptableOAuthEndpoint(value) {
  if (!isNonEmptyString(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
}

export const KNOWN_OAUTH_FIELDS = new Set([
  "known_provider",
  "authorize_url",
  "token_url",
  "refresh_url",
  "refresh_grant_type",
  "scopes",
  "client",
  "redirect",
  "mints",
  "pkce",
]);

/** The only permission keys this client understands. Unknown keys reject the provider -- see header. */
export const PERMISSION_KEYS = ["network", "filesystem", "credentials"];

/**
 * Filesystem grants are tokens, never raw paths: a manifest must not be able to ask for `/` or
 * `C:\`. The token is resolved per-install against the sandbox mapping.
 */
export const FS_TOKENS = ["$WORKSPACE", "$HOME", "$TMP", "$PLUGIN"];

/** Namespaces a third-party publisher may not claim. Ownership itself is checked by registry CI. */
export const RESERVED_PUBLISHERS = ["zeraix", "official", "system", "admin"];

/* ------------------------------------------------------------------ shapes */

export const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
export const isStringArray = (v) => Array.isArray(v) && v.every((s) => isNonEmptyString(s));

/**
 * "Present" means present and not null.
 *
 * This is what makes validation IDEMPOTENT, which is load-bearing rather than tidy: normalization
 * writes `null` for absent optionals, the registry publishes normalized manifests in the index, and
 * the client re-validates every one of them on the way in (parseIndex) precisely so it does not have
 * to trust that the registry validated correctly. If validate(normalize(x)) could fail, that
 * defence-in-depth would reject the registry's own output. Treating null as absent -- the ordinary
 * JSON convention -- also means a hand-written `"homepage": null` behaves the way anyone expects.
 */
export const has = (obj, key) => obj?.[key] !== undefined && obj?.[key] !== null;

/** `publisher/name`, both lowercase and boring: these end up in paths, ids and URLs. */
export const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/;
/** Capability and provider ids are referenced from config and tool calls; keep them identifier-ish. */
export const LOCAL_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** semver.org's official expression. */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** sha512, base64 -- the same encoding latest.yml uses, so one hashing path serves app and plugins. */
export const SHA512_B64_RE = /^[A-Za-z0-9+/]{86}==$/;
/** Hostname or a single leading wildcard label. No scheme, no port, no path: this is an allowlist. */
export const HOST_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
/** Relative artifact path inside the plugin bundle. No absolute paths, no traversal. */
export const REL_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

export const KNOWN_TOP_LEVEL = new Set([
  "schemaVersion",
  "id",
  "version",
  "name",
  "description",
  "license",
  "homepage",
  "providers",
  "capabilities",
  "pricing",
  "publisher", // emitted by normalization
]);

/** Methods a manifest may declare. TRACE/CONNECT are absent: nothing an API client needs. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

export const KNOWN_PROVIDER_FIELDS = new Set([
  "kind",
  "tier",
  "runtime",
  "entry",
  "command",
  "args",
  "url",
  "sha512",
  "permissions",
  "needs",
  "oauth", // the authorizer's own block (kind "oauth")
  "auth",  // a consumer naming its authorizer
]);

export const KNOWN_CAPABILITY_FIELDS = new Set([
  "type",
  "id",
  "name",
  "description",
  "module",
  "provider",
  "bind",
  "path",
  "sha512",
  "input_schema", // a tool's parameters, as the model sees them
  "request",      // how those parameters become an HTTP call
  "providers", // emitted by normalization
]);
