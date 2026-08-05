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

export const PROVIDER_KINDS = ["builtin", "mcp-stdio", "mcp-http", "http", "process", "text"];
export const IMPLEMENTED_PROVIDER_KINDS = ["text"];

/** Trust tiers (design doc §4.1). Declared per provider in the reviewed manifest, enforced here. */
export const TIERS = ["text", "sandboxed", "host"];

/** Provider kinds that execute nothing. A `text` tier is only honest for these. */
const NON_EXECUTING_KINDS = ["text"];
/** Provider kinds that run a local process and therefore need an artifact hash. */
const LOCAL_CODE_KINDS = ["mcp-stdio", "process"];

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
      const normalized = validateProvider(at, p, { err, warn, drop });
      if (normalized) providers[pid] = normalized;
    }
  }

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

function validateProvider(at, p, { err, warn, drop }) {
  if (!PROVIDER_KINDS.includes(p.kind)) {
    drop(at, `unknown provider kind "${p.kind}"`);
    return null;
  }
  if (!TIERS.includes(p.tier)) {
    err(`${at}.tier must be one of ${TIERS.join("|")}`);
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
        if (!ENV_KEY_RE.test(n.key ?? "")) err(`${nat}.key must match [A-Z][A-Z0-9_]{0,63}`);
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
  };
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
  const executes = !NON_EXECUTING_KINDS.includes(kind);
  if (!executes && !CONTENT_CAPABILITY_TYPES.includes(type)) {
    err(`${at}: type "${type}" needs an executing provider, but "${kind}" executes nothing`);
    return false;
  }
  return true;
}
