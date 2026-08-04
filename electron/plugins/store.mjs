/**
 * Installed-plugin state and the install itself. See docs/plugin-marketplace-design.md §6.1, §6.2.
 *
 * This is the resolution half of "registered != active" (§6.2): the lockfile records what is
 * installed and enabled, and the router decides separately what enters a turn. Nothing here touches
 * the prompt.
 *
 * Phase 1 is text tier only (§9), and there is exactly ONE switch for that: IMPLEMENTED_PROVIDER_KINDS
 * in manifest.mjs, which today contains only `text`. Widening it is what turns phase 2 on. This
 * module deliberately does not keep a second gate of its own -- two gates for one policy is two
 * things that can disagree, and the redundant one is always the one nobody updates.
 *
 * What this module does add is the *explanation*: an entry we cannot install is refused whole, with
 * a reason that distinguishes "this app is too old for it" from "this plugin is broken". A partial
 * install that silently drops the useful half is worse than a clear no.
 *
 * Two invariants everything else leans on:
 *   - Bytes are verified before they land. Files are written to a temp directory, hashed, and only
 *     renamed into place once every hash matches. A failed install leaves nothing behind.
 *   - A version directory is never overwritten. Immutable versions (§5.3) are what make a pinned
 *     hash meaningful; reinstalling 1.2.3 re-verifies and reuses what is already there.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  IMPLEMENTED_CAPABILITY_TYPES,
  IMPLEMENTED_PROVIDER_KINDS,
  installableCapabilities,
} from "./manifest.mjs";
import { killListMatches } from "./feed.mjs";
import { lockFile, readJson, versionDir, writeJsonAtomic } from "./storage.mjs";

export const LOCKFILE_VERSION = 1;

let cache = null;

function emptyLock() {
  return { version: LOCKFILE_VERSION, plugins: {} };
}

function load() {
  if (cache) return cache;
  const raw = readJson(lockFile());
  // A lockfile from a newer client may mean fields we would drop on the next write. Start clean
  // rather than silently downgrading someone's installs.
  cache = raw && raw.version === LOCKFILE_VERSION && raw.plugins && typeof raw.plugins === "object" ? raw : emptyLock();
  return cache;
}

function persist() {
  writeJsonAtomic(lockFile(), load());
}

/** Drop the in-memory copy. Tests call this after repointing the root. */
export function resetCache() {
  cache = null;
}

export const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest("base64");

/* ------------------------------------------------------------------ reading */

/** Every installed plugin, newest install first. */
export function listInstalled() {
  return Object.values(load().plugins).sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
}

export function getInstalled(id) {
  return load().plugins[id] ?? null;
}

/**
 * Capabilities that should actually be offered right now: installed, enabled, not revoked.
 * This is what the router and the UI read -- never `manifest.capabilities`.
 */
export function activeCapabilities() {
  const out = [];
  for (const p of listInstalled()) {
    if (!p.enabled || p.revoked) continue;
    for (const c of p.capabilities) {
      if (c.revoked) continue;
      out.push({ ...c, pluginId: p.id, pluginVersion: p.version });
    }
  }
  return out;
}

/** Read an installed capability's content off disk, verifying it still matches its pinned hash. */
export function readCapabilityFile(id, capabilityId) {
  const p = getInstalled(id);
  if (!p) return { ok: false, content: null, error: `${id} is not installed` };
  const cap = p.capabilities.find((c) => c.id === capabilityId);
  if (!cap?.path) return { ok: false, content: null, error: `${id}:${capabilityId} has no content` };

  let buf;
  try {
    buf = fs.readFileSync(path.join(versionDir(id, p.version), cap.path));
  } catch (e) {
    return { ok: false, content: null, error: `cannot read ${cap.path}: ${e.message}` };
  }
  if (sha512(buf) !== cap.sha512) {
    // Verified at install, so a mismatch now means the file changed underneath us.
    return { ok: false, content: null, error: `${id}:${capabilityId} failed its hash check on read` };
  }
  return { ok: true, content: buf.toString("utf8"), error: null };
}

/* ------------------------------------------------------------------ install */

/**
 * Why nothing in this manifest is installable, in terms a user can act on.
 *
 * "No capabilities" is technically true and useless: it reads as "this plugin is empty" when the
 * real answer is almost always "your app is too old for it". Naming the missing runtime is the
 * difference between a user updating and a user filing a bug against the publisher.
 */
function explainUninstallable(manifest) {
  const kinds = new Set();
  const types = new Set();
  for (const cap of manifest.capabilities ?? []) {
    if (!IMPLEMENTED_CAPABILITY_TYPES.includes(cap.type)) {
      types.add(cap.type);
      continue;
    }
    for (const pid of cap.providers ?? []) {
      const kind = manifest.providers?.[pid]?.kind;
      if (kind && !IMPLEMENTED_PROVIDER_KINDS.includes(kind)) kinds.add(kind);
    }
  }
  if (kinds.size > 0) {
    return `needs a provider this version of the app cannot run yet (${[...kinds].join(", ")})`;
  }
  if (types.size > 0) {
    return `uses capability types this version of the app cannot install yet (${[...types].join(", ")})`;
  }
  return "has no capabilities this version of the app can install";
}

/**
 * Install one catalogue entry.
 *
 * @param {{manifest: object, dist: {baseUrl: string}}} entry from parseIndex
 * @param {{ fetchFile: (url: string) => Promise<Buffer> }} io injected so this stays testable and so
 *   the network policy lives in one place (registryClient.mjs) rather than in the install path.
 * @returns {Promise<{ok: boolean, installed: object|null, error: string|null}>}
 */
export async function installPlugin(entry, { fetchFile }) {
  const fail = (error) => ({ ok: false, installed: null, error });
  const { manifest, dist } = entry ?? {};
  if (!manifest?.id || !dist?.baseUrl) return fail("entry must carry a validated manifest and a dist");

  const usable = installableCapabilities(manifest);
  if (usable.length === 0) return fail(`${manifest.id} ${explainUninstallable(manifest)}`);

  const existing = load().plugins[manifest.id];
  if (existing && existing.version === manifest.version && !existing.revoked) {
    return { ok: true, installed: existing, error: null }; // idempotent: same immutable version
  }

  const target = versionDir(manifest.id, manifest.version);
  const staging = `${target}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const capabilities = [];
  try {
    for (const cap of usable) {
      if (!cap.path) {
        capabilities.push({ id: cap.id, type: cap.type, module: cap.module ?? null, path: null, sha512: null, revoked: null });
        continue;
      }
      const url = new URL(cap.path, dist.baseUrl);
      if (!url.href.startsWith(dist.baseUrl)) {
        // The manifest validator already rejects ".." in paths; this catches anything that survives
        // URL resolution and would fetch from outside the plugin's own prefix.
        throw new Error(`${cap.id}: path escapes the plugin's dist prefix`);
      }
      const buf = await fetchFile(url.href);
      const got = sha512(buf);
      if (got !== cap.sha512) {
        throw new Error(`${cap.id}: hash mismatch (expected ${cap.sha512.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
      }
      const dest = path.join(staging, cap.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      capabilities.push({ id: cap.id, type: cap.type, module: cap.module ?? null, path: cap.path, sha512: cap.sha512, revoked: null });
    }

    // Everything verified: publish the directory in one move.
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return fail(`install of ${manifest.id} failed: ${e.message}`);
  }

  const record = {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    installedAt: new Date().toISOString(),
    enabled: true,
    revoked: null,
    capabilities,
  };

  // Replacing an older version: drop its directory once the new one is live.
  if (existing && existing.version !== manifest.version) {
    fs.rmSync(versionDir(manifest.id, existing.version), { recursive: true, force: true });
  }

  load().plugins[manifest.id] = record;
  persist();
  return { ok: true, installed: record, error: null };
}

export function uninstallPlugin(id) {
  const lock = load();
  const existing = lock.plugins[id];
  if (!existing) return { ok: false, error: `${id} is not installed` };
  fs.rmSync(versionDir(id, existing.version), { recursive: true, force: true });
  delete lock.plugins[id];
  persist();
  return { ok: true, error: null };
}

/**
 * Enable or disable an installed plugin.
 *
 * A revoked plugin cannot be re-enabled: the kill-list is not a suggestion, and letting the toggle
 * override it would make revocation depend on the user not clicking the switch.
 */
export function setEnabled(id, enabled) {
  const existing = load().plugins[id];
  if (!existing) return { ok: false, error: `${id} is not installed` };
  if (enabled && existing.revoked) return { ok: false, error: `${id} was revoked: ${existing.revoked.reason}` };
  existing.enabled = enabled === true;
  persist();
  return { ok: true, error: null };
}

/* ------------------------------------------------------------------ revocation */

/**
 * Apply a parsed kill-list to everything installed.
 *
 * Revocation is recorded, not deleted: the user is told what happened and why, their data stays
 * put, and a plugin revoked at capability granularity keeps the rest of itself working.
 *
 * Idempotent -- it runs on every launch and after every feed refresh, so it must be safe to repeat.
 *
 * @returns {{revoked: Array<{id: string, capability: string|null, reason: string}>}}
 */
export function applyKillList(entries) {
  const changed = [];
  const at = new Date().toISOString();

  for (const plugin of Object.values(load().plugins)) {
    const hits = killListMatches(entries, plugin);
    const whole = hits.filter((h) => h.capability === null);
    const perCapability = hits.filter((h) => h.capability !== null);

    if (whole.length > 0 && !plugin.revoked) {
      plugin.revoked = { reason: whole[0].reason, at };
      plugin.enabled = false;
      changed.push({ id: plugin.id, capability: null, reason: whole[0].reason });
    }
    for (const hit of perCapability) {
      const cap = plugin.capabilities.find((c) => c.id === hit.capability);
      if (cap && !cap.revoked) {
        cap.revoked = { reason: hit.reason, at };
        changed.push({ id: plugin.id, capability: cap.id, reason: hit.reason });
      }
    }
  }

  if (changed.length > 0) persist();
  return { revoked: changed };
}
