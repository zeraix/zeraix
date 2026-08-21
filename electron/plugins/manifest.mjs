/**
 * Plugin manifest schema + validation. See docs/plugin-marketplace-design.md §3, §4, §7.
 *
 * This is a trust boundary, not a formality. A manifest decides what code runs, where it runs, and
 * what it may touch, so everything downstream -- the consent sheet, the sandbox tier, the write into
 * mcp/servers.json -- reads the *normalized* output of this module and never the raw JSON.
 *
 * Two modes, because the same document is read by two parties with opposite failure preferences:
 *
 *   registry (strict)  Registry CI, at review time. Anything a client would skip is an ERROR here:
 *                      publishing a capability no client can use is a mistake to catch in the PR,
 *                      not a silent no-op on the user's machine.
 *   client  (lenient)  The app, at install time. Unknown *features* are skipped with a reason and
 *                      the rest installs -- design doc §7, so a v1 client survives a v2 manifest.
 *
 * The asymmetry that matters: "skip what you don't understand" is right for features and WRONG for
 * restrictions. An unknown capability type is inert. An unknown *permission* key means the manifest
 * is asking for something this client cannot reason about, let alone enforce -- so an unrecognized
 * permission rejects the whole provider in both modes. Ignoring it would silently grant it.
 *
 * Forward compatibility (design doc §7):
 *   - unknown capability.type   -> skip that capability
 *   - unknown provider.kind     -> skip the provider and everything bound to it
 *   - unknown fields            -> preserved, ignored (warned in registry mode: usually a typo)
 *   - schemaVersion > ours      -> reject the manifest outright. The only hard reject, because we
 *                                  cannot know which of its rules we are failing to apply.
 *
 * UNKNOWN is not the same as UNIMPLEMENTED, and this module keeps them apart. Unknown means the
 * schema does not define it, so nothing can reason about it -- that is the skip above. Unimplemented
 * means the schema defines it and this build cannot run it yet, which is a property of the build and
 * not of the document: it changes per release and per platform. Folding it in here would make
 * validation results depend on build state and make registry CI disagree with clients for a reason
 * that is not the manifest's fault. So validation only warns, and `installableCapabilities()` is
 * what the installer filters with.
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
export const IMPLEMENTED_CAPABILITY_TYPES = ["skill", "prompt", "subagent"];

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
export const IMPLEMENTED_PROVIDER_KINDS = ["text", "oauth"];

/** Trust tiers (design doc §4.1). Declared per provider in the reviewed manifest, enforced here. */
export const TIERS = ["text", "sandboxed", "host"];

/** Provider kinds that execute nothing. A `text` tier is only honest for these. */
const NON_EXECUTING_KINDS = ["text"];
/** Provider kinds that run a local process and therefore need an artifact hash. */
const LOCAL_CODE_KINDS = ["mcp-stdio", "process"];

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
const NON_BINDABLE_KINDS = ["oauth"];

/**
 * Kinds that may carry `auth` (oauth design §5.1).
 *
 * Restricted to the two kinds whose egress the HOST performs, because that is the only arrangement in
 * which the token stays away from the plugin. An mcp-stdio or process provider opens its own sockets,
 * so authorizing its requests would mean handing it the token -- which is the thing this feature
 * exists to prevent. Lifting this needs the loopback token-broker, not a schema change.
 */
const AUTH_CONSUMER_KINDS = ["http", "mcp-http"];

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

/**
 * Does this look like somebody pasted a credential where a key NAME belongs?
 *
 * `need` / `secret_need` are references into `needs[]` -- the name `GOOGLE_CLIENT_SECRET`, never the
 * value. Confusing the two is the single easiest mistake to make here, and the consequence is a live
 * credential in a file headed for a public registry. The plain "must match [A-Z][A-Z0-9_]{0,63}"
 * rejection is technically sufficient and tells the author nothing about what they just did, so this
 * exists to say it. Deliberately loose: a false positive costs a clearer error on a wrong value that
 * was going to be rejected anyway.
 */
function looksLikeSecretValue(v) {
  if (typeof v !== "string") return false;
  // Vendor prefixes worth naming outright -- Google, GitHub, Slack, Stripe, OpenAI.
  if (/^(GOCSPX-|gh[pousr]_|xox[baprs]-|sk-|sk_live_|sk_test_|AIza)/.test(v)) return true;
  // Otherwise: long, mixed-case or punctuated. A key name is short, screaming snake case.
  return v.length >= 20 && /[a-z]/.test(v) && /[^A-Z0-9_]/.test(v);
}

const KNOWN_OAUTH_FIELDS = new Set([
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

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((s) => isNonEmptyString(s));

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
const has = (obj, key) => obj?.[key] !== undefined && obj?.[key] !== null;

/** `publisher/name`, both lowercase and boring: these end up in paths, ids and URLs. */
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/;
/** Capability and provider ids are referenced from config and tool calls; keep them identifier-ish. */
const LOCAL_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** semver.org's official expression. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** sha512, base64 -- the same encoding latest.yml uses, so one hashing path serves app and plugins. */
const SHA512_B64_RE = /^[A-Za-z0-9+/]{86}==$/;
/** Hostname or a single leading wildcard label. No scheme, no port, no path: this is an allowlist. */
const HOST_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
/** Relative artifact path inside the plugin bundle. No absolute paths, no traversal. */
const REL_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

const KNOWN_TOP_LEVEL = new Set([
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

const KNOWN_PROVIDER_FIELDS = new Set([
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

const KNOWN_CAPABILITY_FIELDS = new Set([
  "type",
  "id",
  "name",
  "description",
  "module",
  "provider",
  "bind",
  "path",
  "sha512",
  "providers", // emitted by normalization
]);

/* ------------------------------------------------------------------ helpers */

/** Split `publisher/name`. Returns null when the id is malformed. */
export function parsePluginId(id) {
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) return null;
  const [publisher, name] = id.split("/");
  if (!SEGMENT_RE.test(publisher) || !SEGMENT_RE.test(name)) return null;
  return { publisher, name };
}

/** Whether this client can read a manifest at all. The one condition that rejects everything. */
export function isSupportedSchemaVersion(v) {
  return Number.isInteger(v) && v >= 1 && v <= SCHEMA_VERSION;
}

/** Fully-qualified capability id as the router and UI use it: `publisher/plugin:capability`. */
export function qualifiedCapabilityId(pluginId, capabilityId) {
  return `${pluginId}:${capabilityId}`;
}

/**
 * Which capabilities of a *validated* manifest this build can actually install.
 *
 * Separate from validation on purpose (see the header): a manifest is valid or not regardless of
 * which phase of the roadmap we are in, and the answer here changes every time a phase lands. The
 * consent sheet should show what will be installed, so it reads this rather than
 * `manifest.capabilities`.
 *
 * A capability with a `bind` list needs only ONE runnable candidate, not all of them — that is the
 * point of a fallback chain.
 *
 * @param {object} manifest normalized output of validateManifest
 */
export function installableCapabilities(manifest) {
  const providers = manifest?.providers ?? {};
  return (manifest?.capabilities ?? []).filter((c) => {
    if (!IMPLEMENTED_CAPABILITY_TYPES.includes(c.type)) return false;
    const bound = c.providers ?? [];
    if (bound.length === 0) return true; // static content
    return bound.some((pid) => IMPLEMENTED_PROVIDER_KINDS.includes(providers[pid]?.kind));
  });
}

/* ------------------------------------------------------------------ validation */

/**
 * Validate and normalize a plugin manifest.
 *
 * @param {any} raw
 * @param {{ mode?: "client"|"registry" }} [options]
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   skipped: Array<{ at: string, reason: string }>,
 *   manifest: object|null,
 * }}
 *   `manifest` is the normalized document with skipped items removed, so a caller cannot reach an
 *   item that failed validation by accident. It is null whenever `ok` is false. Every problem is
 *   reported, not just the first: a hand-written manifest with three mistakes should cost one
 *   review round, not three.
 */
export function validateManifest(raw, { mode = "client" } = {}) {
  const strict = mode === "registry";
  const errors = [];
  const warnings = [];
  const skipped = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);
  /** Skip in client mode, hard error in registry mode -- the whole point of the two modes. */
  const drop = (at, reason) => {
    if (strict) err(`${at}: ${reason}`);
    else skipped.push({ at, reason });
  };
  const fail = () => ({ ok: false, errors, warnings, skipped, manifest: null });

  if (!isPlainObject(raw)) return { ok: false, errors: ["manifest must be an object"], warnings, skipped, manifest: null };

  /* -------------------------------------------------------------- identity */

  if (!isSupportedSchemaVersion(raw.schemaVersion)) {
    // The only hard reject. A newer major may have changed what an existing field means, so
    // partial acceptance is not safe -- we cannot know which rules we are failing to apply.
    err(
      Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION
        ? `schemaVersion ${raw.schemaVersion} is newer than this client supports (${SCHEMA_VERSION}); update the app`
        : `schemaVersion must be an integer 1..${SCHEMA_VERSION}`,
    );
    return fail();
  }

  const parsedId = parsePluginId(raw.id);
  if (!parsedId) err('id must be "publisher/name", lowercase [a-z0-9-], 1..40 chars each');

  if (!isNonEmptyString(raw.version) || !SEMVER_RE.test(raw.version)) {
    err("version must be a semver string (e.g. 1.2.3)");
  }
  if (!isNonEmptyString(raw.name)) err("name is required");
  if (!isNonEmptyString(raw.description)) err("description is required");

  // Legal hygiene is a publish-time concern; an already-installed plugin missing it is not a reason
  // to break the user's install.
  if (!isNonEmptyString(raw.license)) {
    if (strict) err("license is required");
    else warn("license is missing");
  }
  if (has(raw, "homepage") && !isNonEmptyString(raw.homepage)) err("homepage must be a non-empty string when present");

  // Reserved for a future paid tier (design doc §1 non-goals). Shape-checked so it cannot become
  // a junk drawer, but nothing reads it.
  if (has(raw, "pricing") && !isPlainObject(raw.pricing)) err("pricing must be an object when present");

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warn(`unknown top-level field "${key}" (preserved, ignored)`);
  }

  /* -------------------------------------------------------------- providers */

  const providers = {};
  if ("providers" in raw && !isPlainObject(raw.providers)) {
    err("providers must be an object");
  } else {
    for (const [pid, p] of Object.entries(raw.providers ?? {})) {
      const at = `providers.${pid}`;
      if (!LOCAL_ID_RE.test(pid)) {
        err(`${at}: provider id must match [A-Za-z0-9_][A-Za-z0-9_-]{0,63}`);
        continue;
      }
      if (!isPlainObject(p)) {
        err(`${at} must be an object`);
        continue;
      }
      const normalized = validateProvider(at, p, { strict, err, warn, drop });
      if (normalized) providers[pid] = normalized;
    }
  }

  // Cross-provider `auth` links, once every provider is known. Deliberately a second pass:
  // validateProvider sees one entry at a time and cannot tell a dangling reference from one whose
  // target is simply declared later in the object.
  const authorizersInUse = validateAuthLinks(providers, { err });

  /* ------------------------------------------------------------ capabilities */

  const capabilities = [];
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) {
    err("capabilities must be a non-empty array");
  } else {
    const seen = new Set();
    raw.capabilities.forEach((c, i) => {
      const at = `capabilities[${i}]`;
      if (!isPlainObject(c)) return err(`${at} must be an object`);

      if (!CAPABILITY_TYPES.includes(c.type)) {
        // Inert if we ignore it -- exactly the case §7 says to skip rather than fail.
        return drop(at, `unknown capability type "${c.type}"`);
      }
      if (!LOCAL_ID_RE.test(c.id ?? "")) return err(`${at}.id must match [A-Za-z0-9_][A-Za-z0-9_-]{0,63}`);
      if (seen.has(c.id)) return err(`${at}.id "${c.id}" is duplicated`);
      seen.add(c.id);

      if (has(c, "module") && !isNonEmptyString(c.module)) return err(`${at}.module must be a non-empty string`);
      if (has(c, "name") && !isNonEmptyString(c.name)) return err(`${at}.name must be a non-empty string`);

      for (const key of Object.keys(c)) {
        if (!KNOWN_CAPABILITY_FIELDS.has(key)) warn(`${at}: unknown field "${key}" (preserved, ignored)`);
      }
      if (HIGH_BAR_CAPABILITY_TYPES.includes(c.type)) {
        warn(`${at}: type "${c.type}" requires elevated review (design doc §4.3)`);
      }

      const bound = resolveBinding(at, c, providers, { strict, err, drop });
      if (!bound) return;

      if (!IMPLEMENTED_CAPABILITY_TYPES.includes(c.type)) {
        // Publishable, not yet installable. Reserving the type is the point, so neither mode
        // rejects it; installableCapabilities() is what keeps it out of an install.
        warn(`${at}: capability type "${c.type}" is not implemented yet`);
      }

      capabilities.push({ ...c, ...bound });
    });
  }

  if (errors.length === 0 && capabilities.length === 0) {
    err("no installable capabilities remain after validation");
  }
  if (errors.length > 0) return fail();

  // Providers nothing binds to are dead weight in a consent sheet that lists permissions per
  // provider -- the user would be asked to approve network access nothing uses.
  const used = new Set(capabilities.flatMap((c) => c.providers ?? []));
  for (const pid of Object.keys(providers)) {
    // An oauth provider is never bound to -- that is its definition (NON_BINDABLE_KINDS), so the
    // ordinary "dead weight" warning would fire on every correct one. It earns its place by being
    // referenced through `auth`; being referenced by nothing is the real dead-weight case.
    if (providers[pid].kind === "oauth") {
      if (!authorizersInUse.has(pid)) warn(`providers.${pid} is an authorizer no provider references via "auth"`);
      continue;
    }
    if (!used.has(pid)) warn(`providers.${pid} is declared but no capability binds to it`);
  }

  return {
    ok: true,
    errors,
    warnings,
    skipped,
    manifest: {
      schemaVersion: raw.schemaVersion,
      id: raw.id,
      version: raw.version,
      name: raw.name.trim(),
      description: raw.description.trim(),
      license: isNonEmptyString(raw.license) ? raw.license.trim() : null,
      homepage: isNonEmptyString(raw.homepage) ? raw.homepage.trim() : null,
      publisher: parsedId.publisher,
      providers,
      capabilities,
    },
  };
}

/* ------------------------------------------------------------------ provider */

function validateProvider(at, p, { strict, err, warn, drop }) {
  if (!PROVIDER_KINDS.includes(p.kind)) {
    drop(at, `unknown provider kind "${p.kind}"`);
    return null;
  }
  if (!TIERS.includes(p.tier)) {
    err(`${at}.tier must be one of ${TIERS.join("|")}`);
    return null;
  }

  // The tier is not the author's choice for this kind. Driving the system browser and writing the OS
  // keychain are host capabilities by definition, so a sandboxed oauth provider is a manifest
  // describing something that cannot run -- caught here rather than at first use, months later, on
  // one user's machine. An error in BOTH modes: this is a tier claim, and §7.1's "skip what you do
  // not understand" is for features, never for the lines that decide where code runs.
  if (p.kind === "oauth" && p.tier !== "host") {
    err(`${at}: kind "oauth" drives the system browser and OS keychain, so tier must be "host"`);
    return null;
  }

  // Tier/kind coherence. A manifest must not be able to describe a process as `text` and slip past
  // the sandbox, nor claim a tier for something that executes nothing.
  const executes = !NON_EXECUTING_KINDS.includes(p.kind);
  if (!executes && p.tier !== "text") {
    err(`${at}: kind "${p.kind}" executes nothing, so tier must be "text"`);
    return null;
  }
  if (executes && p.tier === "text") {
    err(`${at}: kind "${p.kind}" executes code, so tier "text" is not permitted`);
    return null;
  }

  if (LOCAL_CODE_KINDS.includes(p.kind)) {
    if (!isNonEmptyString(p.entry) && !isNonEmptyString(p.command)) {
      err(`${at}: kind "${p.kind}" requires entry or command`);
    } else if (isNonEmptyString(p.entry) && !REL_PATH_RE.test(p.entry)) {
      err(`${at}.entry must be a relative path inside the bundle, without ".."`);
    }
    if (!SHA512_B64_RE.test(p.sha512 ?? "")) {
      // Content addressing is what makes an immutable version meaningful (design doc §5.3).
      err(`${at}.sha512 is required for kind "${p.kind}" and must be base64 sha512`);
    }
    if (has(p, "args") && !isStringArray(p.args)) err(`${at}.args must be an array of strings`);
  }

  if ((p.kind === "mcp-http" || p.kind === "http") && !isNonEmptyString(p.url)) {
    err(`${at}: kind "${p.kind}" requires url`);
  }

  /* ---------------------------------------------------------------- oauth */

  let oauth = null;
  if (p.kind === "oauth") {
    if (!has(p, "oauth")) {
      err(`${at}: kind "oauth" requires an "oauth" block`);
      return null;
    }
    // The keys `client.need` / `client.secret_need` point INTO needs[], so the check needs both. Read
    // from the raw array (needs is parsed further down) -- a typo here otherwise surfaces as a 401
    // months later, on the one install that used it.
    const needKeys = new Set((Array.isArray(p.needs) ? p.needs : []).map((n) => n?.key).filter(Boolean));
    oauth = validateOAuth(`${at}.oauth`, p.oauth, { strict, err, warn, needKeys });
    if (!oauth) return null;
    if (has(p, "auth")) {
      // An authorizer that names an authorizer is either a typo or a chain nothing implements.
      err(`${at}: kind "oauth" is the authorizer; it cannot itself declare "auth"`);
      return null;
    }
  } else if (has(p, "oauth")) {
    err(`${at}: "oauth" is only meaningful on kind "oauth" (kind here is "${p.kind}")`);
    return null;
  }

  let auth = null;
  if (has(p, "auth")) {
    if (!isNonEmptyString(p.auth) || !LOCAL_ID_RE.test(p.auth)) {
      err(`${at}.auth must be the id of an "oauth" provider in this manifest`);
      return null;
    }
    if (!AUTH_CONSUMER_KINDS.includes(p.kind)) {
      // See AUTH_CONSUMER_KINDS: the isolation only holds where the host performs the request.
      err(
        `${at}: kind "${p.kind}" cannot use "auth" — the host cannot inject a token into a provider ` +
          `that opens its own connections, and handing it the token defeats the purpose. ` +
          `Only ${AUTH_CONSUMER_KINDS.join(", ")} may declare it`,
      );
      return null;
    }
    auth = p.auth;
  }

  for (const key of Object.keys(p)) {
    if (!KNOWN_PROVIDER_FIELDS.has(key)) warn(`${at}: unknown field "${key}" (preserved, ignored)`);
  }

  const permissions = validatePermissions(at, p.permissions, { err });
  if (permissions === null) return null; // unrecognized restriction -- reject, never ignore

  if (p.tier === "host" && (permissions.network.length || permissions.filesystem.length)) {
    // Honest labelling: on the host tier nothing is actually confined, so a permission list there
    // documents intent rather than a boundary. Say so, or the consent sheet overpromises.
    warn(`${at}: tier "host" cannot enforce permissions; they are advisory (design doc §4.2)`);
  }

  const needs = [];
  if (has(p, "needs")) {
    if (!Array.isArray(p.needs)) {
      err(`${at}.needs must be an array`);
    } else {
      p.needs.forEach((n, i) => {
        const nat = `${at}.needs[${i}]`;
        if (!isPlainObject(n)) return err(`${nat} must be an object`);
        // Same trap as client.secret_need: `key` NAMES the slot the user fills at install time. A
        // credential pasted here would be published verbatim, so the rejection says so.
        if (!ENV_KEY_RE.test(n.key ?? "")) err(keyRefError(`${nat}.key`, n.key, `${nat}.key must match [A-Z][A-Z0-9_]{0,63}`));
        if (!isNonEmptyString(n.prompt)) err(`${nat}.prompt is required`);
        if (has(n, "secret") && typeof n.secret !== "boolean") err(`${nat}.secret must be a boolean`);
        needs.push({ key: n.key, prompt: n.prompt, secret: n.secret === true });
      });
    }
  }

  if (!IMPLEMENTED_PROVIDER_KINDS.includes(p.kind)) {
    warn(`${at}: provider kind "${p.kind}" is not implemented yet`);
  }

  return {
    kind: p.kind,
    tier: p.tier,
    runtime: isNonEmptyString(p.runtime) ? p.runtime : null,
    entry: isNonEmptyString(p.entry) ? p.entry : null,
    command: isNonEmptyString(p.command) ? p.command : null,
    args: isStringArray(p.args) ? [...p.args] : [],
    url: isNonEmptyString(p.url) ? p.url : null,
    sha512: isNonEmptyString(p.sha512) ? p.sha512 : null,
    permissions,
    needs,
    oauth,
    auth,
  };
}

/**
 * Validate an `oauth` block (oauth design §3).
 *
 * Returns the normalized block, or null to reject the provider. Normalization resolves nothing: the
 * preset stays a preset rather than being expanded into its URLs, so the endpoints the host opens are
 * always read from OAUTH_PRESETS at use time and never from a document that travelled through the
 * registry. Expanding here would put an editable copy of the authorization URL in the index, which is
 * exactly what §3.1 refuses.
 */
/**
 * The rejection for a bad key reference -- pointed when it looks like the credential itself.
 *
 * `plain` is passed in rather than composed here so each call site keeps the wording it already had:
 * this function exists to ADD the secret case, not to reword every ordinary typo.
 */
function keyRefError(at, value, plain = `${at} must be a needs[] key matching [A-Z][A-Z0-9_]{0,63}`) {
  return looksLikeSecretValue(value)
    ? `${at} looks like a SECRET VALUE, not a key name. This field names a needs[] entry (e.g. ` +
        `"GOOGLE_CLIENT_SECRET"); the value belongs in that entry at install time, never in the ` +
        `manifest — a published manifest is world-readable. Treat the pasted value as disclosed and rotate it`
    : plain;
}

function validateOAuth(at, o, { strict, err, warn, needKeys = new Set() }) {
  if (!isPlainObject(o)) {
    err(`${at} must be an object`);
    return null;
  }
  for (const key of Object.keys(o)) {
    if (!KNOWN_OAUTH_FIELDS.has(key)) warn(`${at}: unknown field "${key}" (preserved, ignored)`);
  }

  let bad = false;

  /* endpoints: a preset, or a literal pair -- never both, never neither */
  const preset = has(o, "known_provider") ? o.known_provider : null;
  const literal = has(o, "authorize_url") || has(o, "token_url");
  if (preset && (has(o, "refresh_url") || has(o, "refresh_grant_type"))) {
    // Overriding a preset's refresh endpoint is the exfiltration case with none of the sideloading
    // caveats: the manifest keeps a trusted `known_provider` while redirecting where the client secret
    // and refresh token are posted. There is no legitimate reason to do it.
    err(`${at}: refresh_url/refresh_grant_type belong to the provider preset and cannot be overridden`);
    bad = true;
  }
  if (preset && literal) {
    err(`${at}: declare either known_provider or authorize_url+token_url, not both`);
    bad = true;
  } else if (preset) {
    if (!Object.prototype.hasOwnProperty.call(OAUTH_PRESETS, preset)) {
      err(`${at}.known_provider must be one of ${Object.keys(OAUTH_PRESETS).join(", ")}`);
      bad = true;
    }
  } else if (literal) {
    for (const key of ["authorize_url", "token_url"]) {
      if (!isAcceptableOAuthEndpoint(o[key])) {
        err(`${at}.${key} must be an https URL (or http on loopback) without embedded credentials`);
        bad = true;
      }
    }
    // Optional: providers that refresh somewhere other than where they issued (Figma). Held to the
    // same bar as the other two, and refused for publication with them -- see below for why this one
    // is if anything the more dangerous of the three.
    if (has(o, "refresh_url") && !isAcceptableOAuthEndpoint(o.refresh_url)) {
      err(`${at}.refresh_url must be an https URL (or http on loopback) without embedded credentials`);
      bad = true;
    }
    if (has(o, "refresh_grant_type") && typeof o.refresh_grant_type !== "boolean") {
      err(`${at}.refresh_grant_type must be a boolean (false = the body carries refresh_token alone)`);
      bad = true;
    }
    if (strict) {
      // §3.1: the host is about to open the user's browser at a URL this document chose, in the one
      // flow designed to make them type a password. A look-alike domain delivered by the trusted app
      // beats any phishing link. Reserved in the schema so Phase 4 needs no bump; refused at review
      // until per-publisher identity exists to hold accountable.
      err(
        `${at}: literal endpoints are not accepted for publication — the token/refresh endpoint receives ` +
          `the client secret and refresh token, so a manifest naming it can redirect credentials. ` +
          `Use known_provider ` +
          `(${Object.keys(OAUTH_PRESETS).join(", ")}). See oauth design §3.1`,
      );
      bad = true;
    } else {
      warn(`${at}: literal endpoints bypass the preset allowlist; only a sideloaded manifest should have these`);
    }
  } else {
    err(`${at}: requires known_provider, or authorize_url + token_url`);
    bad = true;
  }

  /* scopes: shown verbatim in the consent sheet, so they must be real strings */
  if (!isStringArray(o.scopes) || o.scopes.length === 0) {
    err(`${at}.scopes must be a non-empty array of strings`);
    bad = true;
  }

  /* client */
  const c = o.client;
  if (!isPlainObject(c)) {
    err(`${at}.client must be an object`);
    bad = true;
  } else if (c.type === "host") {
    // Credentials come from the BUILD -- the same arrangement as the preset URLs, and the same one
    // electron/services/google-defaults.json already uses for sign-in. The manifest names no id, no
    // secret and no needs[] entry, which is what removes every credential mistake this shape can make:
    // there is nothing in a published document to paste a secret into, and nothing for a user to fill.
    for (const field of ["id", "need", "secret_need", "secret", "client_secret"]) {
      if (has(c, field)) {
        err(`${at}.client: type "host" takes no ${field} — the build supplies the credentials`);
        bad = true;
      }
    }
    if (!preset) {
      // We can only bundle credentials for providers this build knows by name. A literal endpoint pair
      // has no key to look them up under.
      err(`${at}.client: type "host" requires known_provider — the build has no credentials for a literal endpoint`);
      bad = true;
    }
  } else if (c.type === "public") {
    if (!isNonEmptyString(c.id)) {
      err(`${at}.client.id is required for type "public"`);
      bad = true;
    }
    if (has(c, "secret") || has(c, "client_secret")) {
      // A registry manifest is world-readable. An embedded secret is a disclosed secret, and saying
      // so at review time is the only moment it is still recoverable.
      err(`${at}.client must not embed a secret — a published manifest is public; use secret_need`);
      bad = true;
    }
    // A public client may STILL need a client_secret at the token endpoint. Google requires one for
    // Desktop-app clients even under PKCE -- the RFC says otherwise, and the provider wins. Dropping
    // this field (which normalization used to do) turns into "client_secret is missing." at the
    // exchange, after the user has already consented, which is the worst possible place to learn it.
    if (has(c, "secret_need") && !ENV_KEY_RE.test(c.secret_need)) {
      err(keyRefError(`${at}.client.secret_need`, c.secret_need));
      bad = true;
    }
  } else if (c.type === "user_supplied") {
    if (!ENV_KEY_RE.test(c.need ?? "")) {
      err(keyRefError(`${at}.client.need`, c.need));
      bad = true;
    }
    if (has(c, "secret_need") && !ENV_KEY_RE.test(c.secret_need)) {
      err(keyRefError(`${at}.client.secret_need`, c.secret_need));
      bad = true;
    }
  } else {
    err(`${at}.client.type must be "host", "public" or "user_supplied"`);
    bad = true;
  }

  /* every needs[] key the client block points at must actually be declared */
  if (isPlainObject(c)) {
    for (const [field, key] of [["need", c.need], ["secret_need", c.secret_need]]) {
      if (key && ENV_KEY_RE.test(key) && !needKeys.has(key)) {
        err(`${at}.client.${field} is "${key}", but no needs[] entry declares that key`);
        bad = true;
      }
    }
  }

  /* redirect */
  const r = o.redirect;
  if (!isPlainObject(r) || !OAUTH_REDIRECT_METHODS.includes(r.method)) {
    err(`${at}.redirect.method must be one of ${OAUTH_REDIRECT_METHODS.join("|")}`);
    bad = true;
  } else if (has(r, "port") || has(r, "scheme") || has(r, "uri")) {
    // The port is ephemeral and the scheme belongs to the app (§3.3). A manifest that picks either is
    // claiming something it does not own: a fixed port is squattable by any local process, and a
    // scheme like `slack://` is an OS-level handler for a vendor this plugin is not.
    err(`${at}.redirect: port/scheme/uri are chosen by the host, not the manifest (oauth design §3.3)`);
    bad = true;
  }

  /* mints: the credential id consumers must declare */
  if (!LOCAL_ID_RE.test(o.mints ?? "")) {
    err(`${at}.mints must be a credential id matching [A-Za-z0-9_][A-Za-z0-9_-]{0,63}`);
    bad = true;
  }

  /* pkce: required by default, waivable only where the PROVIDER has no PKCE */
  const profile = preset ? OAUTH_PRESETS[preset] : null;
  const providerPkce = profile?.pkce ?? "required";
  if (has(o, "pkce") && o.pkce !== true) {
    // Not the author's call to make. GitHub's OAuth Apps and Slack genuinely have no PKCE, so an
    // absolute rule would make them undeclarable; but "this provider lacks it" is a fact about the
    // provider, recorded in OAUTH_PRESETS, not something a manifest gets to assert about Google.
    if (providerPkce !== "unsupported") {
      err(`${at}.pkce cannot be disabled — S256 is required unless the provider has no PKCE at all`);
      bad = true;
    }
  }
  if (providerPkce === "unsupported" && isPlainObject(c) && c.type === "public") {
    // "host" is deliberately absent: it carries a client secret, so it is a confidential client and
    // GitHub/Slack are declarable with it.
    // No verifier AND no client authentication: an intercepted loopback callback is then a complete
    // takeover, with nothing in the exchange that an interceptor lacks. Such a provider needs a
    // confidential client -- user_supplied with a secret today, a broker once that exists.
    err(
      `${at}: provider "${preset}" has no PKCE, so a "public" client is not safe here — ` +
        `use a client with a secret (see the backend-integration doc)`,
    );
    bad = true;
  }
  if (profile && profile.verified === false) {
    // Say it once, at review time, rather than letting a user meet it at the consent screen.
    warn(`${at}: preset "${preset}" has not been verified end to end; run scripts/oauth-probe.mjs against it`);
  }

  if (bad) return null;
  return {
    known_provider: preset ?? null,
    authorize_url: preset ? null : o.authorize_url,
    token_url: preset ? null : o.token_url,
    refresh_url: preset || !has(o, "refresh_url") ? null : o.refresh_url,
    refresh_grant_type: preset || !has(o, "refresh_grant_type") ? null : o.refresh_grant_type,
    scopes: [...o.scopes],
    client: {
      type: c.type,
      id: c.type === "public" ? c.id : null, // host: resolved at run time, never stored in the manifest
      need: c.type === "user_supplied" ? c.need : null,
      // Carried for both types -- see the note above on Google's Desktop clients.
      secret_need: has(c, "secret_need") ? c.secret_need : null,
    },
    redirect: { method: r.method },
    mints: o.mints,
    pkce: true,
  };
}

/**
 * Check every `auth` edge once all providers are known (oauth design §4).
 *
 * @returns {Set<string>} ids of oauth providers something actually references, so the caller can tell
 *   an authorizer doing its job from one nothing uses.
 */
function validateAuthLinks(providers, { err }) {
  const inUse = new Set();
  for (const [pid, p] of Object.entries(providers)) {
    if (!p.auth) continue;
    const target = providers[p.auth];
    const at = `providers.${pid}`;
    if (!target) {
      // Not a drop: a consumer whose authorizer vanished cannot be authorized, and installing it
      // anyway produces a provider that 401s on every call with nothing on screen explaining why.
      err(`${at}.auth references "${p.auth}", which is not a declared provider`);
      continue;
    }
    if (target.kind !== "oauth") {
      err(`${at}.auth must reference a provider of kind "oauth" ("${p.auth}" is "${target.kind}")`);
      continue;
    }
    // The consent sheet lists what a provider may read. A consumer that never declares the credential
    // it is about to be handed would be granted it silently, which is the one thing §4.2 exists to stop.
    if (!p.permissions.credentials.includes(target.oauth.mints)) {
      err(
        `${at}: uses authorizer "${p.auth}" but does not declare its credential — ` +
          `add "${target.oauth.mints}" to ${at}.permissions.credentials`,
      );
      continue;
    }
    inUse.add(p.auth);
  }
  return inUse;
}

/**
 * Validate the permission block.
 *
 * Returns null -- meaning "reject this provider" -- for any key we do not recognize. This is the
 * inverse of the skip-unknown rule and it is deliberate: an unrecognized *feature* is inert, an
 * unrecognized *restriction* is a request we cannot evaluate or enforce. Ignoring it would grant it.
 */
function validatePermissions(at, perms, { err }) {
  const empty = { network: [], filesystem: [], credentials: [] };
  if (perms === undefined || perms === null) return empty;
  if (!isPlainObject(perms)) {
    err(`${at}.permissions must be an object`);
    return null;
  }

  const unknown = Object.keys(perms).filter((k) => !PERMISSION_KEYS.includes(k));
  if (unknown.length) {
    err(
      `${at}.permissions: unrecognized permission ${unknown.map((k) => `"${k}"`).join(", ")} — ` +
        `this client cannot enforce it, so the provider is rejected rather than granted it`,
    );
    return null;
  }

  let bad = false;
  const list = (key, check, hint) => {
    const v = perms[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      err(`${at}.permissions.${key} must be an array`);
      bad = true;
      return [];
    }
    v.forEach((entry, i) => {
      if (!isNonEmptyString(entry) || !check(entry)) {
        err(`${at}.permissions.${key}[${i}] ${hint}`);
        bad = true;
      }
    });
    return [...v];
  };

  const network = list("network", (h) => HOST_RE.test(h), "must be a hostname, optionally with a leading *. label");
  const filesystem = list(
    "filesystem",
    (path) => FS_TOKENS.some((t) => path === t || path.startsWith(`${t}/`)),
    `must start with one of ${FS_TOKENS.join(", ")} — raw absolute paths are not grantable`,
  );
  const credentials = list("credentials", (c) => LOCAL_ID_RE.test(c), "must be a credential id");

  return bad ? null : { network, filesystem, credentials };
}

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
function resolveBinding(at, c, providers, { strict, err, drop }) {
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
