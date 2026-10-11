/**
 * Provider validation for plugin manifests: the provider entry itself, its `oauth` block, the `auth`
 * links between providers, and the permission block. See docs/plugin-marketplace-design.md §4 and
 * the oauth design.
 *
 * Split out of manifest.mjs, whose header explains the two modes and why an unknown permission
 * rejects instead of skipping. validateManifest() is the only caller; these are not part of the
 * public surface. Imports the schema module, never manifest.mjs, so there is no cycle.
 */
import {
  AUTH_CONSUMER_KINDS,
  ENV_KEY_RE,
  FS_TOKENS,
  HOST_RE,
  IMPLEMENTED_PROVIDER_KINDS,
  KNOWN_OAUTH_FIELDS,
  KNOWN_PROVIDER_FIELDS,
  LOCAL_CODE_KINDS,
  LOCAL_ID_RE,
  NON_EXECUTING_KINDS,
  OAUTH_PRESETS,
  OAUTH_REDIRECT_METHODS,
  PERMISSION_KEYS,
  PROVIDER_KINDS,
  REL_PATH_RE,
  SHA512_B64_RE,
  TIERS,
  has,
  isAcceptableOAuthEndpoint,
  isNonEmptyString,
  isPlainObject,
  isStringArray,
} from "./schema.mjs";

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

/* ------------------------------------------------------------------ provider */

export function validateProvider(at, p, { strict, err, warn, drop }) {
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
export function validateAuthLinks(providers, { err }) {
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
