/**
 * Plugin IPC: renderer window.plugins.* -> the main-process registry client and install store.
 *
 * The renderer drives *intent*; it never performs the trust-critical steps. Signature verification,
 * rollback refusal, hash checking and revocation all happen behind these handlers, so a compromised
 * or merely buggy renderer cannot install unverified bytes -- it can only ask.
 *
 * One rule inherited straight from the design doc (§2.3): there is no agent-callable install. Search
 * and detail are safe for the model to reach; `plugins:install` is invoked from a click. A prompt
 * injection in a page the agent reads must not be able to put code on the user's machine.
 */
import { BrowserWindow, ipcMain } from "electron";

import { configurePluginRegistry } from "../plugins/paths.mjs";
import { cachedCatalogue, fetchPluginFile, refreshRegistry } from "../plugins/registryClient.mjs";
import {
  activeCapabilities,
  getInstalled,
  installPlugin,
  listInstalled,
  readCapabilityFile,
  setEnabled,
  uninstallPlugin,
} from "../plugins/store.mjs";

/** Installed state changed: every window re-reads rather than trying to patch its own copy. */
function broadcast() {
  const payload = { installed: listInstalled() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("plugins:changed", payload);
  }
}

export function registerPlugins() {
  // The renderer reports the API origin it was built against (see paths.configurePluginRegistry for
  // why that is safe). Idempotent: repeated calls from remounts do not restart the refresh timers.
  ipcMain.handle("plugins:configure", (_e, origin) => ({ ok: configurePluginRegistry(origin) !== null }));

  ipcMain.handle("plugins:installed", () => listInstalled());
  ipcMain.handle("plugins:active", () => activeCapabilities());

  /** The catalogue as of the last verified feed -- no network, so opening the page is instant. */
  ipcMain.handle("plugins:catalogue", () => {
    const { entries, dropped } = cachedCatalogue();
    return { entries: entries.map(summarize), dropped };
  });

  /** Explicit refresh. Never throws: an unreachable registry is a normal state, not an error page. */
  ipcMain.handle("plugins:refresh", async () => {
    const r = await refreshRegistry();
    if (r.revoked.length > 0) broadcast();
    return { entries: r.catalogue.map(summarize), dropped: r.dropped, revoked: r.revoked, fromCache: r.fromCache, errors: r.errors };
  });

  ipcMain.handle("plugins:install", async (_e, id) => {
    const entry = cachedCatalogue().entries.find((x) => x.manifest.id === id);
    // Only ever install from the verified catalogue: taking a manifest from the renderer would let
    // it choose its own hashes, which is the same as having none.
    if (!entry) return { ok: false, error: `${id} is not in the verified catalogue` };

    const r = await installPlugin(entry, { fetchFile: fetchPluginFile });
    if (r.ok) broadcast();
    return { ok: r.ok, error: r.error };
  });

  ipcMain.handle("plugins:uninstall", (_e, id) => {
    const r = uninstallPlugin(id);
    if (r.ok) broadcast();
    return r;
  });

  ipcMain.handle("plugins:set-enabled", (_e, { id, enabled }) => {
    const r = setEnabled(id, enabled);
    if (r.ok) broadcast();
    return r;
  });

  /** Read one installed capability's content, re-verified against its pinned hash. */
  ipcMain.handle("plugins:read", (_e, { id, capabilityId }) => readCapabilityFile(id, capabilityId));

  ipcMain.handle("plugins:detail", (_e, id) => {
    const entry = cachedCatalogue().entries.find((x) => x.manifest.id === id);
    return { catalogue: entry ? summarize(entry) : null, installed: getInstalled(id) };
  });
}

/**
 * What the UI needs to render a catalogue row and a consent sheet.
 *
 * Providers are summarized rather than passed through: `needs` carries prompts for values the user
 * will type, and there is no reason for the renderer to see entry points or command lines.
 */
function summarize({ manifest, warnings }) {
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    license: manifest.license,
    homepage: manifest.homepage,
    capabilities: manifest.capabilities.map((c) => ({
      id: c.id,
      type: c.type,
      module: c.module ?? null,
      name: c.name ?? null,
    })),
    providers: Object.entries(manifest.providers).map(([id, p]) => ({
      id,
      kind: p.kind,
      tier: p.tier,
      permissions: p.permissions,
      needs: p.needs.map((n) => ({ key: n.key, prompt: n.prompt, secret: n.secret })),
    })),
    warnings,
  };
}
