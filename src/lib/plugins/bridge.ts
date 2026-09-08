/**
 * Renderer bridge to the plugin marketplace (main-process side: electron/ipc/pluginsIpc.mjs).
 *
 * The renderer drives intent only. Rollback refusal, hash checking and revocation all happen on the
 * far side of this boundary, so nothing here can be tricked into installing unverified bytes -- the
 * worst it can do is ask.
 *
 * Availability: Electron only. In `next dev` or a browser there is no window.plugins, and every
 * surface must degrade to "not supported here" rather than erroring, the same way the MCP and
 * updater panels already do.
 */
import type { CatalogueEntry, InstalledPlugin, PluginBridge, PluginTier, RefreshResult } from "./types";

export function pluginBridge(): PluginBridge | null {
  return typeof window !== "undefined" && window.plugins ? window.plugins : null;
}

export function isPluginsAvailable(): boolean {
  return pluginBridge() !== null;
}

/**
 * Point the main process at the registry.
 *
 * The origin comes from here because NEXT_PUBLIC_API_BASE_URL is baked into the renderer bundle at
 * build time -- the same arrangement the LLM proxy uses for its endpoint. It is the mirror of the
 * registry repo, and since the feeds carry no signature it is also what the catalogue is trusted
 * against. Idempotent, so calling it from a component that remounts costs nothing.
 */
/**
 * Where the feeds come from when nothing overrides it.
 *
 * The registry repo itself: the client appends /plugins/{index,killlist}.json, which resolves to
 * dist/plugins/*.json on main — the files CI rebuilds and commits.
 *
 * This used to fall back to NEXT_PUBLIC_API_BASE_URL, where design doc §5.2 says the feeds are to be
 * MIRRORED (GitHub is unreliable from mainland China, and the API origin is already a hard dependency
 * of a working app). The mirror is not deployed: that host answers 404 for /plugins/index.json, so
 * the fallback made every checkout without a private .env.local show an empty marketplace — and the
 * only machines that worked were the ones with an untracked override. A default has to be a value
 * that WORKS; an aspiration belongs in the doc, not in the code path.
 *
 * When the mirror ships, point this at it (or set NEXT_PUBLIC_PLUGIN_ORIGIN per build) — that is the
 * change §5.2 is waiting for, and the cn edition needs it.
 */
export const DEFAULT_PLUGIN_ORIGIN = "https://raw.githubusercontent.com/zeraix/registry/main/dist";

export async function configurePlugins(): Promise<boolean> {
  const bridge = pluginBridge();
  if (!bridge) return false;
  // NEXT_PUBLIC_PLUGIN_ORIGIN points the marketplace at a different host from the rest of the API —
  // a local stand-in registry, or the mirror once it exists. The plugin feeds and auth/wallet/LLM
  // share one origin in production, so overriding NEXT_PUBLIC_API_BASE_URL to reach a local registry
  // would take sign-in and the model proxy down with it; this variable exists so it does not have to.
  const origin = process.env.NEXT_PUBLIC_PLUGIN_ORIGIN || DEFAULT_PLUGIN_ORIGIN;
  const result = await bridge.configure(origin);
  return result.ok;
}

/** Tier of the loudest provider a plugin ships, which is what the consent copy keys off. */
export function highestTier(entry: CatalogueEntry): PluginTier {
  const order: PluginTier[] = ["text", "sandboxed", "host"];
  return entry.providers.reduce<PluginTier>((worst, p) => {
    const i = order.indexOf(p.tier as PluginTier);
    return i > order.indexOf(worst) ? (p.tier as PluginTier) : worst;
  }, "text");
}

/** Every permission a plugin asks for, flattened across its providers for the consent sheet. */
export function collectPermissions(entry: CatalogueEntry) {
  const network = new Set<string>();
  const filesystem = new Set<string>();
  const credentials = new Set<string>();
  for (const p of entry.providers) {
    p.permissions.network.forEach((v) => network.add(v));
    p.permissions.filesystem.forEach((v) => filesystem.add(v));
    p.permissions.credentials.forEach((v) => credentials.add(v));
  }
  return { network: [...network], filesystem: [...filesystem], credentials: [...credentials] };
}

/** Capability counts by type, for the "adds 2 tools and a skill" line. */
export function capabilityCounts(entry: CatalogueEntry): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of entry.capabilities) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}

/**
 * Whether a catalogue entry is already installed, and whether the installed copy is behind.
 *
 * Version comparison is a plain string equality rather than semver ordering: the index carries one
 * version per plugin id (the builder enforces that), so "different" always means "the registry moved
 * on", and there is no ordering question to get wrong.
 */
export function installState(entry: CatalogueEntry, installed: InstalledPlugin[]) {
  const match = installed.find((p) => p.id === entry.id);
  if (!match) return { installed: false, outdated: false, record: null } as const;
  return { installed: true, outdated: match.version !== entry.version, record: match } as const;
}

/**
 * What a refresh should tell the user.
 *
 * "A registry outage is not an error" holds only while there is a catalogue to fall back on: the page
 * shows the last verified copy and a quiet line saying so. With an EMPTY catalogue there is nothing
 * to fall back on, and staying quiet is how a misconfigured origin becomes a blank page that a
 * Refresh button never fixes — the main process composes a precise diagnosis ("this origin serves no
 * plugin registry (HTTP 404 …) — check NEXT_PUBLIC_PLUGIN_ORIGIN") and the renderer used to discard
 * it, because a failed fetch always reports fromCache.
 *
 * So: errors are shown whenever they left the user with nothing, and the offline note is only for
 * the case it describes — a real cached list, being shown instead of a fresh one.
 */
export function refreshFeedback(r: Pick<RefreshResult, "entries" | "fromCache" | "errors">): {
  error: string | null;
  offline: boolean;
} {
  const empty = r.entries.length === 0;
  const failed = r.errors.length > 0;
  return {
    error: failed && (empty || !r.fromCache) ? r.errors.join("; ") : null,
    offline: r.fromCache && !empty,
  };
}
