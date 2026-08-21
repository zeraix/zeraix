/**
 * The Electron-facing edge of the plugin subsystem: the one module here that imports `electron`.
 *
 * Everything else takes its root from storage.mjs, so the rest stays loadable (and testable) in a
 * plain Node process. Keep it that way -- adding an `electron` import to store.mjs, feed.mjs or
 * registryClient.mjs would make that module, and everything importing it, impossible to cover with
 * `npm test`.
 */
import { app, safeStorage, shell } from "electron";
import path from "node:path";

import { setPluginRoot } from "./storage.mjs";
import { feedFile, readJson } from "./storage.mjs";
import { parseKillList } from "./feed.mjs";
import { applyKillList } from "./store.mjs";
import { configureOAuthHost } from "./oauth.mjs";
import { configureRegistry, isRegistryConfigured, refreshRegistry } from "./registryClient.mjs";

/** Top-level under userData, alongside mcp/ -- plugins are app-wide, not scoped to one agent. */
export function defaultPluginDir() {
  return path.join(app.getPath("userData"), "plugins");
}

/** Delay before the first refresh, so it never competes with startup work. Mirrors the updater. */
const FIRST_REFRESH_DELAY_MS = 20_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timers = null;

/**
 * Configure the root and enforce the last known kill-list.
 *
 * Revocation is applied from the CACHED feed, synchronously, before any capability can be offered.
 * Waiting for the network would leave a window on every launch in which a plugin we have already
 * pulled is still live -- and that window is exactly when a revoked plugin does its damage. The
 * network refresh that follows can only ever revoke more (feed.mjs refuses an older sequence).
 */
export function initPlugins() {
  setPluginRoot(defaultPluginDir());

  // The two host capabilities oauth.mjs deliberately does not import for itself, so that module (and
  // everything importing it) stays loadable in a plain Node process for `npm test`. Wired here
  // because this is the one file in the subsystem that owns the `electron` import.
  //
  // Safe at this point and not before: initPlugins() is called from app.whenReady(), and safeStorage
  // has no key until then — asking earlier returns a false `isEncryptionAvailable()`, which would
  // silently write every token to disk in plaintext rather than failing.
  configureOAuthHost({
    openExternal: (url) => shell.openExternal(url),
    secretBox: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
      decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
    },
  });

  const cached = readJson(feedFile("killlist"));
  if (cached) {
    const parsed = parseKillList(cached);
    if (parsed.ok) {
      const { revoked } = applyKillList(parsed.entries);
      if (revoked.length > 0) {
        console.log(`[plugins] enforced ${revoked.length} revocation(s) from the cached kill-list`);
      }
    } else {
      // A cached feed that no longer parses means our own writer or the format changed. Loud,
      // because the fallback is "no revocations enforced".
      console.error(`[plugins] cached kill-list is unusable: ${parsed.error}`);
    }
  }
}

/**
 * Point the client at the registry and start refreshing.
 *
 * The origin comes from the renderer, which is where NEXT_PUBLIC_API_BASE_URL is baked at build
 * time -- the same arrangement the LLM proxy uses for its endpoint. Since the feeds are no longer
 * signed (§5.1), that origin IS the trust anchor: whatever it serves over https is what the
 * catalogue says. Two things still hold independently of it -- feed.mjs refuses a rolled-back
 * sequence, and store.mjs verifies every artifact against the hash the index pins.
 */
export function configurePluginRegistry(origin) {
  const configured = configureRegistry({ origin });
  if (!configured || timers) return configured;

  const first = setTimeout(() => void refreshRegistry(), FIRST_REFRESH_DELAY_MS);
  const repeat = setInterval(() => void refreshRegistry(), REFRESH_INTERVAL_MS);
  // unref so a pending timer never holds the process open at quit.
  first.unref?.();
  repeat.unref?.();
  timers = { first, repeat };
  return configured;
}

export function pluginsReady() {
  return isRegistryConfigured();
}

export function shutdownPlugins() {
  if (!timers) return;
  clearTimeout(timers.first);
  clearInterval(timers.repeat);
  timers = null;
}
