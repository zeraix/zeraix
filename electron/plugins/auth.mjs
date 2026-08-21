/**
 * When a plugin's OAuth grants are obtained, and what happens when they are missing.
 *
 * oauth.mjs knows how to run an authorization; store.mjs knows what is installed. Neither should know
 * WHEN to ask, because that is a product decision and it changes independently of both. It lives here:
 *
 *   1. On install completion, authorize every oauth provider the plugin declares, and record how it
 *      went. A plugin that finishes installing and then fails on first use with "not authorized" has
 *      spent the user's attention twice for one decision — the consent sheet is where they agreed to
 *      connect an account, so that is where the account gets connected.
 *   2. Before a capability that NEEDS a grant is used, check for one and run the flow again if it is
 *      absent. Install-time authorization is not guaranteed to stick: the user can decline, close the
 *      browser, lose the network, or revoke the grant from the provider's own console months later.
 *      Re-asking at the point of use is what keeps that recoverable without an uninstall.
 *
 * A capability bound to no provider — a skill file, which is all this build can install today — needs
 * nothing and must never trigger a browser window. That check is the reason step 2 is capability-
 * scoped rather than plugin-scoped.
 *
 * Nothing here throws at its callers. An authorization that fails is a state to report, not an
 * exception to propagate into an install that otherwise succeeded.
 */
import { authorize, credentialKey, credentialStatus, injectAuthHeader } from "./oauth.mjs";
import { authProvidersForCapability, getInstalled, oauthProviders, recordAuthAttempt } from "./store.mjs";

/**
 * Values behind `needs` — the client id/secret a `user_supplied` plugin asks the user to paste.
 *
 * There is no store for these yet, and inventing an empty one would surface as "no client id",
 * which reads as a broken plugin rather than a missing feature. Official plugins use `host`
 * credentials and never reach this.
 */
function resolveNeed(key) {
  throw new Error(
    `oauth: this plugin wants a credential you supply ("${key}"), and that flow is not built yet. ` +
      `Only plugins using this build's own credentials can connect right now.`,
  );
}

/** Whether a usable grant exists for one provider right now. Never opens anything. */
function granted(pluginId, providerId, oauth) {
  const status = credentialStatus(credentialKey(pluginId, providerId, oauth.mints));
  if (!status.authorized) return false;
  // An expired grant with a refresh token is fine — accessToken() renews it on the next call. One
  // without is spent, and re-running the flow is the only way back.
  if (status.expiresAt && status.expiresAt <= Date.now() && !status.canRefresh) return false;

  // An UPDATE that widens what the plugin asks for needs a new grant, and nothing else would notice.
  // The token keeps working, so there is no error to catch and no expiry to trip; the new calls just
  // return 403 with a message about scope, which reads as a broken plugin rather than a consent step
  // that was never taken. Compared against what this grant was requested with — see toRecord.
  //
  // A record written before that field existed reports null, and an unknown history is not evidence of
  // a narrow one: treated as sufficient, so an update cannot invalidate grants people already hold.
  if (Array.isArray(status.requestedScopes)) {
    const held = new Set(status.requestedScopes);
    if ((oauth.scopes ?? []).some((s) => !held.has(s))) return false;
  }
  return true;
}

/**
 * Run one provider's flow and record the outcome either way.
 *
 * @returns {Promise<{providerId: string, authorized: boolean, error: string|null}>}
 */
async function runOne(pluginId, { providerId, oauth }) {
  try {
    await authorize({ pluginId, providerId, oauth, resolveNeed });
    recordAuthAttempt(pluginId, providerId, null);
    return { providerId, authorized: true, error: null };
  } catch (e) {
    const error = e?.message ?? String(e);
    recordAuthAttempt(pluginId, providerId, error);
    return { providerId, authorized: false, error };
  }
}

/**
 * Authorize every oauth provider of a freshly installed plugin.
 *
 * Sequential, not parallel: two providers would mean two browser windows racing for the same user,
 * and whichever they answer second would be answering a prompt they have already forgotten the
 * reason for.
 *
 * @returns {Promise<{results: Array<{providerId: string, authorized: boolean, error: string|null}>}>}
 */
export async function authorizeAfterInstall(pluginId) {
  const results = [];
  for (const provider of oauthProviders(pluginId)) {
    if (granted(pluginId, provider.providerId, provider.oauth)) {
      // Reinstalling or updating a plugin whose grant is still good must not ask again — the token
      // outlives the install, and re-prompting would teach people to click through consent screens.
      recordAuthAttempt(pluginId, provider.providerId, null);
      results.push({ providerId: provider.providerId, authorized: true, error: null });
      continue;
    }
    results.push(await runOne(pluginId, provider));
  }
  return { results };
}

/**
 * The gate a capability passes through before it runs: hold a grant, or get one now.
 *
 * Returns rather than throws, so a caller can put the reason in front of the user instead of a stack
 * trace. `ok: true` with no providers is the common case and costs nothing — it is a map lookup on a
 * capability that binds nothing.
 *
 * @returns {Promise<{ok: boolean, error: string|null, authorized: string[]}>}
 */
export async function ensureAuthorized(pluginId, capabilityId) {
  const installed = getInstalled(pluginId);
  if (!installed) return { ok: false, error: `${pluginId} is not installed`, authorized: [] };
  if (!installed.enabled) return { ok: false, error: `${pluginId} is disabled`, authorized: [] };
  if (installed.revoked) return { ok: false, error: `${pluginId} was revoked: ${installed.revoked.reason}`, authorized: [] };

  const needed = authProvidersForCapability(pluginId, capabilityId);
  if (needed === null) {
    return { ok: false, error: `${pluginId} has no installed capability "${capabilityId}"`, authorized: [] };
  }
  const authorized = [];
  for (const provider of needed) {
    if (granted(pluginId, provider.providerId, provider.oauth)) {
      authorized.push(provider.providerId);
      continue;
    }
    const result = await runOne(pluginId, provider);
    if (!result.authorized) {
      return {
        ok: false,
        error: `${pluginId}:${capabilityId} needs an authorized ${provider.providerId} — ${result.error}`,
        authorized,
      };
    }
    authorized.push(provider.providerId);
  }
  return { ok: true, error: null, authorized };
}

/**
 * Per-provider authorization state for the UI. Never the token, and never a call to the provider —
 * this is read on every render of the plugins page.
 *
 * `authorized` comes from the credential store and `lastError` from the install record, because they
 * answer different questions: whether a grant exists now, and why the last attempt to get one failed.
 */
export function authStatus(pluginId) {
  const installed = getInstalled(pluginId);
  if (!installed) return [];
  const attempts = installed.auth ?? {};
  return oauthProviders(pluginId).map(({ providerId, oauth, tier }) => {
    const status = credentialStatus(credentialKey(pluginId, providerId, oauth.mints));
    const attempt = attempts[providerId] ?? null;
    return {
      providerId,
      tier: tier ?? null,
      provider: oauth.known_provider ?? null,
      scopes: oauth.scopes ?? [],
      authorized: status.authorized === true,
      expiresAt: status.expiresAt ?? null,
      canRefresh: status.canRefresh === true,
      lastAttemptAt: attempt?.at ?? null,
      lastError: attempt?.error ?? null,
    };
  });
}

/**
 * Explicit re-authorization, from a click. One provider, or all of them when `providerId` is absent.
 */
export async function reauthorize(pluginId, providerId = null) {
  const providers = oauthProviders(pluginId).filter((p) => !providerId || p.providerId === providerId);
  if (providers.length === 0) {
    return { ok: false, error: `${pluginId} has no oauth provider${providerId ? ` "${providerId}"` : ""}`, results: [] };
  }
  const results = [];
  for (const provider of providers) results.push(await runOne(pluginId, provider));
  const failed = results.find((r) => !r.authorized);
  return { ok: !failed, error: failed?.error ?? null, results };
}

/**
 * Headers for a request an MCP server is about to make on a plugin's behalf.
 *
 * This is the last step of the install flow: once a plugin is connected, the agent's calls through
 * its MCP server must spend the grant already held rather than starting a second negotiation. The
 * plugin's own OAuth is the one source of truth for that account, and this is what lets a transport
 * read it without ever seeing a token — `injectAuthHeader` resolves, refreshes and returns, and the
 * value never leaves the main process or reaches the server's stored config.
 *
 * Deliberately does NOT authorize. A transport is built inside a connect, often at launch, and
 * opening a browser there would put a consent screen in front of someone who did not ask for one.
 * A missing grant is an error the caller reports; ensureAuthorized is where the flow gets re-run.
 */
export async function pluginAuthHeaders(headers, { pluginId, providerId }) {
  const installed = getInstalled(pluginId);
  if (!installed) throw new Error(`mcp: "${pluginId}" is not installed, so it has no credentials to use`);
  if (!installed.enabled) throw new Error(`mcp: "${pluginId}" is disabled`);
  if (installed.revoked) throw new Error(`mcp: "${pluginId}" was revoked: ${installed.revoked.reason}`);

  const provider = oauthProviders(pluginId).find((p) => p.providerId === providerId);
  if (!provider) throw new Error(`mcp: "${pluginId}" declares no oauth provider "${providerId}"`);
  if (!granted(pluginId, providerId, provider.oauth)) {
    throw new Error(`mcp: "${pluginId}" is not connected — open the plugins page and connect the account`);
  }
  return injectAuthHeader(headers, { pluginId, providerId, oauth: provider.oauth, resolveNeed });
}
