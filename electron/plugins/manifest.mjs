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

/*
 * Layout. This file is the public entry and the only one importers should name; it keeps the public
 * helpers and validateManifest(). The rest lives in manifest/, whose parts import the schema module and never
 * this file, so there is no cycle:
 *   manifest/schema.mjs     constants, OAuth presets, id/path/hash expressions, shape predicates
 *   manifest/providers.mjs  providers, oauth blocks, auth links, permissions
 *   manifest/binding.mjs    capability binding, http request templates, kind fit
 */
import {
  CAPABILITY_TYPES,
  HIGH_BAR_CAPABILITY_TYPES,
  IMPLEMENTED_CAPABILITY_TYPES,
  IMPLEMENTED_PROVIDER_KINDS,
  KNOWN_CAPABILITY_FIELDS,
  KNOWN_TOP_LEVEL,
  LOCAL_ID_RE,
  PLUGIN_ID_RE,
  SCHEMA_VERSION,
  SEGMENT_RE,
  SEMVER_RE,
  has,
  isNonEmptyString,
  isPlainObject,
} from "./manifest/schema.mjs";
import { validateAuthLinks, validateProvider } from "./manifest/providers.mjs";
import { resolveBinding, validateRequest } from "./manifest/binding.mjs";

export {
  SCHEMA_VERSION,
  CAPABILITY_TYPES,
  IMPLEMENTED_CAPABILITY_TYPES,
  CONTENT_CAPABILITY_TYPES,
  HIGH_BAR_CAPABILITY_TYPES,
  PROVIDER_KINDS,
  IMPLEMENTED_PROVIDER_KINDS,
  TIERS,
  OAUTH_PRESETS,
  OAUTH_PROFILE_DEFAULTS,
  OAUTH_REDIRECT_METHODS,
  isAcceptableOAuthEndpoint,
  PERMISSION_KEYS,
  FS_TOKENS,
  RESERVED_PUBLISHERS,
} from "./manifest/schema.mjs";

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
    if (!bound.some((pid) => IMPLEMENTED_PROVIDER_KINDS.includes(providers[pid]?.kind))) return false;
    // A tool is only callable once it says what call it makes. Published tools predating `request`
    // stay in the catalogue and out of the install, which is the same treatment a reserved type gets.
    if (c.type === "tool" && bound.some((pid) => providers[pid]?.kind === "http") && !c.request) return false;
    return true;
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

      // A tool on an http provider must say what it accepts and what call that becomes. Without both
      // there is nothing to advertise to the model and nothing to send, and the capability would
      // install as an entry that can never run.
      const request = validateRequest(at, c, providers, bound, { err, warn });
      if (request === false) return;

      if (!IMPLEMENTED_CAPABILITY_TYPES.includes(c.type)) {
        // Publishable, not yet installable. Reserving the type is the point, so neither mode
        // rejects it; installableCapabilities() is what keeps it out of an install.
        warn(`${at}: capability type "${c.type}" is not implemented yet`);
      }

      capabilities.push({ ...c, ...bound, ...(request ? { request } : {}) });
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
