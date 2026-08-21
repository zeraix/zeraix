/**
 * Renderer-side types for the plugin marketplace. See docs/plugin-marketplace-design.md.
 *
 * These mirror what electron/ipc/pluginsIpc.mjs actually sends, which is deliberately less than the
 * manifest holds: provider entry points and command lines never cross the boundary, and neither do
 * the values behind `needs` -- the renderer sees only which keys a plugin will ask for.
 */

/** Capability types the model defines. `type` is widened to string so a newer feed cannot break parsing. */
export type CapabilityType =
  | "tool"
  | "skill"
  | "prompt"
  | "resource"
  | "subagent"
  | "model"
  | "workflow"
  | "memory"
  | "ui";

/** Trust tier of a provider (design doc §4.1). Determines how loud the consent sheet has to be. */
export type PluginTier = "text" | "sandboxed" | "host";

export interface CapabilitySummary {
  id: string;
  /** Widened past CapabilityType on purpose: an unknown type from a newer registry must still render. */
  type: CapabilityType | string;
  module: string | null;
  name: string | null;
}

export interface ProviderSummary {
  id: string;
  kind: string;
  tier: PluginTier | string;
  permissions: { network: string[]; filesystem: string[]; credentials: string[] };
  /** Values the user will be asked for at install. Prompts only — never the values themselves. */
  needs: { key: string; prompt: string; secret: boolean }[];
}

/** One row in the catalogue, as summarized by the main process. */
export interface CatalogueEntry {
  id: string;
  version: string;
  icon?: string | null;
  name: string;
  description: string;
  publisher: string;
  license: string | null;
  homepage: string | null;
  capabilities: CapabilitySummary[];
  providers: ProviderSummary[];
  warnings: string[];
}

/** Why a plugin stopped working, straight from the registry's kill-list (design doc §5.3). */
export interface Revocation {
  reason: string;
  at: string;
}

export interface InstalledCapability {
  id: string;
  type: CapabilityType | string;
  module: string | null;
  /** Providers this capability binds to, which is how a use is traced to the grant it needs. */
  providers?: string[];
  path: string | null;
  sha512: string | null;
  revoked: Revocation | null;
}

/**
 * One provider's authorization state. Never a token, and never anything that would let the renderer
 * reconstruct one — `authorized` and `expiresAt` say whether a grant exists and when it lapses.
 */
export interface ProviderAuthStatus {
  providerId: string;
  tier: PluginTier | string | null;
  /** The preset this grant is against ("google"), or null for a literal endpoint pair. */
  provider: string | null;
  scopes: string[];
  authorized: boolean;
  expiresAt: number | null;
  canRefresh: boolean;
  /** When the last attempt ran, and why it failed. Null error means it succeeded. */
  lastAttemptAt: string | null;
  lastError: string | null;
}

/** Outcome of one authorization attempt, as install and re-authorize both report it. */
export interface AuthAttempt {
  providerId: string;
  authorized: boolean;
  error: string | null;
}

export interface InstalledPlugin {
  id: string;
  version: string;
  name: string;
  description: string;
  publisher: string;
  installedAt: string;
  enabled: boolean;
  revoked: Revocation | null;
  capabilities: InstalledCapability[];
  /** Last authorization attempt per provider. Absent on records written before this shipped. */
  auth?: Record<string, { at: string; error: string | null }>;
}

export interface RefreshResult {
  entries: CatalogueEntry[];
  dropped: { at: string; reason: string }[];
  revoked: { id: string; capability: string | null; reason: string }[];
  /** True when neither feed could be fetched, so this is the last verified copy. Not an error state. */
  fromCache: boolean;
  errors: string[];
}

/** The `window.plugins` surface exposed by electron/preload.cjs. */
export interface PluginBridge {
  configure: (origin: string) => Promise<{ ok: boolean }>;
  installed: () => Promise<InstalledPlugin[]>;
  active: () => Promise<(InstalledCapability & { pluginId: string; pluginVersion: string })[]>;
  catalogue: () => Promise<{ entries: CatalogueEntry[]; dropped: { at: string; reason: string }[] }>;
  refresh: () => Promise<RefreshResult>;
  detail: (id: string) => Promise<{ catalogue: CatalogueEntry | null; installed: InstalledPlugin | null }>;
  /** `ok` is the install; a plugin can install and still come back with an unauthorized provider. */
  install: (id: string) => Promise<{ ok: boolean; error: string | null; auth?: AuthAttempt[] }>;
  authStatus: (id: string) => Promise<ProviderAuthStatus[]>;
  /** Re-run the flow. Omit providerId for every oauth provider the plugin declares. */
  authorize: (id: string, providerId?: string | null) => Promise<{ ok: boolean; error: string | null; results: AuthAttempt[] }>;
  uninstall: (id: string) => Promise<{ ok: boolean; error: string | null }>;
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error: string | null }>;
  read: (id: string, capabilityId: string) => Promise<{ ok: boolean; content: string | null; error: string | null }>;
  onChanged: (cb: (payload: { installed: InstalledPlugin[] }) => void) => () => void;
}

declare global {
  interface Window {
    plugins?: PluginBridge;
  }
}
