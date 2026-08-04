"use client";

/**
 * Plugins page (/agent/plugins). Browse the Zeraix registry, install, enable, remove.
 * See docs/plugin-marketplace-design.md.
 *
 * Three things drive the layout:
 *  - **Install is a click, never the agent.** Browsing is safe for the model to reach; putting code
 *    on the machine is not (design doc §2.3). So this page is the only install path there is.
 *  - **Revocation must explain itself.** A plugin the registry has withdrawn shows the reason inline
 *    and cannot be switched back on -- "it just disabled itself" is not an acceptable experience,
 *    and the toggle must not be able to override a kill-list. The main process refuses the re-enable
 *    too; the disabled switch is the affordance, not the enforcement.
 *  - **A registry outage is not an error.** The catalogue rendered here is the last verified copy,
 *    so the page opens instantly offline and says so rather than showing a failure.
 *
 * The word "capability" never appears on screen (design doc §10): the uniform model is for the
 * install path, lockfile and revocation, not for the user. All copy is i18n (the plugins.* keys).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Ban, Download, Loader2, PackageOpen, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { ToggleSwitch } from "@/app/agent/settings/components/ToggleSwitch";
import {
  capabilityCounts,
  collectPermissions,
  configurePlugins,
  highestTier,
  installState,
  isPluginsAvailable,
  pluginBridge,
} from "@/lib/plugins/bridge";
import type { CatalogueEntry, InstalledPlugin, PluginTier } from "@/lib/plugins/types";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Busy = { id: string; action: "install" | "remove" } | null;

const PRIMARY_BTN =
  "flex shrink-0 items-center gap-1 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50";

/** Tier badge styling. `host` is deliberately the loudest thing on the card. */
const TIER_STYLE: Record<PluginTier, string> = {
  text: "border-line-strong bg-surface-muted/60 text-ink-muted",
  sandboxed: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  host: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
};

export default function AgentPluginsPage() {
  const t = useT();
  const available = isPluginsAvailable();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let active = true;
    // Read the cached catalogue first so the page paints before any network happens.
    void configurePlugins().then(async () => {
      const bridge = pluginBridge();
      if (!bridge || !active) return;
      const [cat, inst] = await Promise.all([bridge.catalogue(), bridge.installed()]);
      if (!active) return;
      setCatalogue(cat.entries);
      setInstalled(inst);
    });
    // Installed state also changes in the main process — a launch-time revocation lands here
    // without the page having asked for anything.
    const off = pluginBridge()?.onChanged(({ installed: next }) => setInstalled(next));
    return () => {
      active = false;
      off?.();
    };
  }, [available]);

  const onRefresh = useCallback(async () => {
    const bridge = pluginBridge();
    if (!bridge) return;
    setRefreshing(true);
    setError(null);
    try {
      const r = await bridge.refresh();
      setCatalogue(r.entries);
      setOffline(r.fromCache);
      setInstalled(await bridge.installed());
      // Feed problems are worth showing: a signature that stopped verifying is not the same thing
      // as being offline, and only one of those is routine.
      if (r.errors.length > 0 && !r.fromCache) setError(r.errors.join("; "));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onInstall = useCallback(
    async (id: string) => {
      const bridge = pluginBridge();
      if (!bridge) return;
      setBusy({ id, action: "install" });
      setError(null);
      try {
        const r = await bridge.install(id);
        if (!r.ok) setError(r.error ?? t("plugins.error.install"));
        else setInstalled(await bridge.installed());
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const onRemove = useCallback(async (id: string) => {
    const bridge = pluginBridge();
    if (!bridge) return;
    setBusy({ id, action: "remove" });
    try {
      await bridge.uninstall(id);
      setInstalled(await bridge.installed());
    } finally {
      setBusy(null);
    }
  }, []);

  const onToggle = useCallback(async (id: string, enabled: boolean) => {
    const bridge = pluginBridge();
    if (!bridge) return;
    const r = await bridge.setEnabled(id, enabled);
    if (!r.ok) setError(r.error ?? null);
    setInstalled(await bridge.installed());
  }, []);

  /** Anything installed but no longer in the catalogue still gets a card — it must stay removable. */
  const orphans = useMemo(() => {
    const listed = new Set(catalogue.map((e) => e.id));
    return installed.filter((p) => !listed.has(p.id));
  }, [catalogue, installed]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-8 py-6">
        <div className="mx-auto flex w-full max-w-4xl items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t("nav.plugins")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("plugins.desc")}</p>
          </div>
          {available ? (
            <button type="button" onClick={() => void onRefresh()} disabled={refreshing} className={PRIMARY_BTN}>
              {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t("plugins.refresh")}
            </button>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <CustomScrollbar className="min-h-0 flex-1" viewportClassName="px-8 py-6" config={PAGE_SCROLLBAR}>
        <div className="mx-auto w-full max-w-4xl">
          {!available ? (
            <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
              {t("plugins.unsupported")}
            </p>
          ) : (
          <>
            {offline ? <p className="mb-4 text-[11px] text-ink-subtle">{t("plugins.offline")}</p> : null}

            {error ? (
              <p className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span className="break-words">{error}</span>
              </p>
            ) : null}

            {catalogue.length === 0 && orphans.length === 0 ? (
              <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
                {t("plugins.empty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {catalogue.map((entry) => {
                  const state = installState(entry, installed);
                  return (
                    <PluginCard
                      key={entry.id}
                      t={t}
                      entry={entry}
                      record={state.record}
                      outdated={state.outdated}
                      busy={busy?.id === entry.id ? busy.action : null}
                      onInstall={() => void onInstall(entry.id)}
                      onRemove={() => void onRemove(entry.id)}
                      onToggle={(next) => void onToggle(entry.id, next)}
                    />
                  );
                })}
                {orphans.map((record) => (
                  <OrphanCard
                    key={record.id}
                    t={t}
                    record={record}
                    busy={busy?.id === record.id ? busy.action : null}
                    onRemove={() => void onRemove(record.id)}
                    onToggle={(next) => void onToggle(record.id, next)}
                  />
                ))}
              </ul>
            )}
          </>
          )}
        </div>
      </CustomScrollbar>
    </div>
  );
}

/** Reason-first banner. A withdrawn plugin explains itself before anything else on the card. */
function RevokedNotice({ t, reason }: { t: T; reason: string }) {
  return (
    <p className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
      <Ban className="mt-px size-3 shrink-0" />
      <span className="break-words">
        <span className="font-semibold">{t("plugins.revoked")}</span> {reason}
      </span>
    </p>
  );
}

function PluginCard({
  t,
  entry,
  record,
  outdated,
  busy,
  onInstall,
  onRemove,
  onToggle,
}: {
  t: T;
  entry: CatalogueEntry;
  record: InstalledPlugin | null;
  outdated: boolean;
  busy: "install" | "remove" | null;
  onInstall: () => void;
  onRemove: () => void;
  onToggle: (next: boolean) => void;
}) {
  const tier = highestTier(entry);
  const permissions = collectPermissions(entry);
  const counts = capabilityCounts(entry);
  const revoked = record?.revoked ?? null;
  const grants = [...permissions.network, ...permissions.filesystem, ...permissions.credentials];

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-ink">{entry.name}</p>
            <span className={cn("rounded-md border px-1.5 py-px text-[10px] font-medium", TIER_STYLE[tier])}>
              {t(`plugins.tier.${tier}`)}
            </span>
            {record ? <span className="text-[11px] text-ink-subtle">v{record.version}</span> : null}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">{entry.id}</p>
          <p className="mt-1.5 text-xs text-ink-muted">{entry.description}</p>

          {/* "2 tools · 1 skill" — grouped by what it does, never by the type discriminator. */}
          <p className="mt-2 text-[11px] text-ink-subtle">
            {counts.map((c) => t(`plugins.adds.${c.type}`, { count: c.count })).join(" · ")}
          </p>

          {grants.length > 0 ? (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-subtle">
              <ShieldCheck className="mt-px size-3 shrink-0" />
              <span className="break-words">{grants.join(", ")}</span>
            </p>
          ) : null}

          {revoked ? <RevokedNotice t={t} reason={revoked.reason} /> : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {record ? (
            <>
              <ToggleSwitch on={record.enabled} disabled={!!revoked} onChange={onToggle} label={entry.name} />
              {outdated && !revoked ? (
                <button type="button" onClick={onInstall} disabled={busy !== null} className={PRIMARY_BTN}>
                  {busy === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {t("plugins.update", { version: entry.version })}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onRemove}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted disabled:opacity-50"
              >
                {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                {t("plugins.remove")}
              </button>
            </>
          ) : (
            <button type="button" onClick={onInstall} disabled={busy !== null} className={PRIMARY_BTN}>
              {busy === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {t("plugins.install")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Installed but no longer in the catalogue -- the registry stopped listing it, or the feed is a
 * cached copy from before it existed. It keeps working; it just cannot be updated, and it has to
 * stay removable, which is why it is shown rather than hidden.
 */
function OrphanCard({
  t,
  record,
  busy,
  onRemove,
  onToggle,
}: {
  t: T;
  record: InstalledPlugin;
  busy: "install" | "remove" | null;
  onRemove: () => void;
  onToggle: (next: boolean) => void;
}) {
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-ink">{record.name}</p>
            <span className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-muted/60 px-1.5 py-px text-[10px] text-ink-muted">
              <PackageOpen className="size-2.5" />
              {t("plugins.unlisted")}
            </span>
            <span className="text-[11px] text-ink-subtle">v{record.version}</span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">{record.id}</p>
          <p className="mt-1.5 text-xs text-ink-muted">{record.description}</p>
          {record.revoked ? <RevokedNotice t={t} reason={record.revoked.reason} /> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ToggleSwitch on={record.enabled} disabled={!!record.revoked} onChange={onToggle} label={record.name} />
          <button
            type="button"
            onClick={onRemove}
            disabled={busy !== null}
            className="flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-muted disabled:opacity-50"
          >
            {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            {t("plugins.remove")}
          </button>
        </div>
      </div>
    </li>
  );
}
