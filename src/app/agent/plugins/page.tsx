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
 * The catalogue is a grid, not a column: a plugin card is short and wide-format screens were showing
 * four of them at a time. Cards, chips and the details panel live in ./PluginCard and ./ui.
 *
 * The word "capability" never appears on screen (design doc §10): the uniform model is for the
 * install path, lockfile and revocation, not for the user. All copy is i18n (the plugins.* keys).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Blocks, Loader2, RefreshCw, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import CustomScrollbar, { PAGE_SCROLLBAR } from "@/components/CustomScrollbar";
import { configurePlugins, installState, isPluginsAvailable, pluginBridge } from "@/lib/plugins/bridge";
import type { CatalogueEntry, InstalledPlugin, ProviderAuthStatus } from "@/lib/plugins/types";
import { OrphanCard, PluginCard } from "./PluginCard";
import { PluginDialog } from "./PluginDialog";
import { EmptyState, PRIMARY_BTN, SectionHeader, type Busy } from "./ui";

/** Card grid. Three across on a wide window, and never one across above a phone. */
const GRID = "grid grid-cols-1 items-start gap-2.5 md:grid-cols-2 2xl:grid-cols-3";

export default function AgentPluginsPage() {
  const t = useT();
  const available = isPluginsAvailable();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "installed" | "available">("all");
  /** The plugin whose dialog is open, by id. An id rather than the row itself, so the dialog keeps
   *  rendering from live state — install or remove from inside it and it updates instead of going
   *  stale, and a removed orphan closes it because neither source has that id any more. */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** Per-plugin grant state. Kept beside `installed` rather than inside it: the tokens live in a
   *  separate store in the main process, and folding them together here would imply they move as
   *  one. A grant can lapse with nothing about the install changing. */
  const [auth, setAuth] = useState<Record<string, ProviderAuthStatus[]>>({});

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

  /**
   * Follow the grants of whatever is installed.
   *
   * Re-reads on every change to the installed set, which is also what an install broadcasts once it
   * has finished authorizing — so the card shows the account state without the page polling for it.
   */
  useEffect(() => {
    const bridge = pluginBridge();
    if (!bridge || installed.length === 0) return;
    let active = true;
    void Promise.all(installed.map(async (p) => [p.id, await bridge.authStatus(p.id)] as const)).then((rows) => {
      if (active) setAuth(Object.fromEntries(rows.filter(([, list]) => list.length > 0)));
    });
    return () => {
      active = false;
    };
  }, [installed]);

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
        if (!r.ok) {
          setError(r.error ?? t("plugins.error.install"));
        } else {
          setInstalled(await bridge.installed());
          // The install succeeded; connecting the account may not have. Say so here rather than
          // letting the first use be where the user finds out.
          const failed = (r.auth ?? []).find((a) => !a.authorized);
          if (failed) setError(t("plugins.auth.installFailed", { error: failed.error ?? "" }));
        }
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

  /** Re-run authorization from a click: the recovery path when install-time consent did not stick. */
  const onConnect = useCallback(async (id: string) => {
    const bridge = pluginBridge();
    if (!bridge) return;
    setBusy({ id, action: "connect" });
    setError(null);
    try {
      const r = await bridge.authorize(id);
      if (!r.ok) setError(r.error ?? null);
      const next = await bridge.authStatus(id);
      setAuth((prev) => ({ ...prev, [id]: next }));
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

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);

  /**
   * Search across the fields a user would actually type: display name, id (so `zeraix/git` works),
   * publisher and description. Case-insensitive substring — a catalogue this size does not need
   * anything cleverer, and fuzzy matching would surface confusing near-misses.
   */
  const matches = useCallback(
    (fields: (string | null | undefined)[]) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return fields.some((f) => (f ?? "").toLowerCase().includes(q));
    },
    [query],
  );

  /** Installed first: what you already have is what you are most likely looking for. */
  const shownInstalled = useMemo(
    () =>
      filter === "available"
        ? []
        : catalogue.filter(
            (e) => installedIds.has(e.id) && matches([e.name, e.id, e.publisher, e.description]),
          ),
    [catalogue, installedIds, filter, matches],
  );
  const shownAvailable = useMemo(
    () =>
      filter === "installed"
        ? []
        : catalogue.filter(
            (e) => !installedIds.has(e.id) && matches([e.name, e.id, e.publisher, e.description]),
          ),
    [catalogue, installedIds, filter, matches],
  );
  const shownOrphans = useMemo(
    () =>
      filter === "available"
        ? []
        : orphans.filter((r) => matches([r.name, r.id, r.publisher, r.description])),
    [orphans, filter, matches],
  );

  /**
   * Counts on the filter tabs. Deliberately of the whole catalogue rather than the current search:
   * they are there to answer "how much is there, and how much of it do I have" at a glance, and a
   * number that shrank as you typed would answer neither.
   */
  const totals = useMemo(
    () => ({
      installed: installed.length,
      available: catalogue.filter((e) => !installedIds.has(e.id)).length,
      all: catalogue.length + orphans.length,
    }),
    [catalogue, installed, installedIds, orphans],
  );

  const nothingShown =
    shownInstalled.length === 0 && shownAvailable.length === 0 && shownOrphans.length === 0;

  const cardProps = (entry: CatalogueEntry) => {
    const state = installState(entry, installed);
    return {
      t,
      entry,
      record: state.record,
      outdated: state.outdated,
      busy: busy?.id === entry.id ? busy.action : null,
      auth: auth[entry.id] ?? [],
      onOpen: () => setDetailId(entry.id),
      onInstall: () => void onInstall(entry.id),
      onRemove: () => void onRemove(entry.id),
      onToggle: (next: boolean) => void onToggle(entry.id, next),
    };
  };

  /** The dialog's two sources, looked up fresh on every render. Either may be absent. */
  const detailEntry = useMemo(() => catalogue.find((e) => e.id === detailId) ?? null, [catalogue, detailId]);
  const detailRecord = useMemo(() => installed.find((p) => p.id === detailId) ?? null, [installed, detailId]);

  return (
    <div className="flex h-full flex-col">
      {/* Header. Title and controls share one row so the catalogue starts as high up as it can. */}
      <div className="border-b border-line px-8 py-4">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">{t("nav.plugins")}</h1>
            {/* The description is reference material, not a headline — clamped so it cannot push
                the actual catalogue below the fold on a short window. */}
            <p className="mt-0.5 line-clamp-1 max-w-2xl text-xs text-muted-foreground">{t("plugins.desc")}</p>
          </div>

          {available ? (
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              {catalogue.length > 0 || orphans.length > 0 ? (
                <>
                  <div className="relative w-48 min-w-[9rem] flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-subtle" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("plugins.search")}
                      aria-label={t("plugins.search")}
                      className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-xs text-ink outline-none transition placeholder:text-ink-subtle focus:border-primary/50"
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-muted/40 p-0.5">
                    {(["all", "installed", "available"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setFilter(k)}
                        aria-pressed={filter === k}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                          filter === k ? "bg-surface text-ink shadow-sm" : "text-ink-subtle hover:text-ink-muted",
                        )}
                      >
                        {t(`plugins.filter.${k}`)}
                        <span className="tabular-nums opacity-60">{totals[k]}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <button type="button" onClick={() => void onRefresh()} disabled={refreshing} className={PRIMARY_BTN}>
                {refreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {t("plugins.refresh")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <CustomScrollbar className="min-h-0 flex-1" viewportClassName="px-8 py-5" config={PAGE_SCROLLBAR}>
        <div className="mx-auto w-full max-w-[1400px]">
          {!available ? (
            <p className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5 text-xs text-ink-subtle">
              {t("plugins.unsupported")}
            </p>
          ) : (
            <>
              {offline ? <p className="mb-3 text-[11px] text-ink-subtle">{t("plugins.offline")}</p> : null}

              {error ? (
                <p className="mb-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger-ink">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" />
                  <span className="break-words">{error}</span>
                </p>
              ) : null}

              {catalogue.length === 0 && orphans.length === 0 ? (
                <EmptyState icon={<Blocks className="size-5" />} text={t("plugins.empty")} />
              ) : nothingShown ? (
                // Distinct from an empty catalogue: there ARE plugins, this search just found none.
                <EmptyState icon={<Search className="size-5" />} text={t("plugins.noResults")} />
              ) : (
                <div className="flex flex-col gap-5">
                  {shownInstalled.length > 0 || shownOrphans.length > 0 ? (
                    <section>
                      <SectionHeader
                        title={t("plugins.filter.installed")}
                        count={shownInstalled.length + shownOrphans.length}
                      />
                      <ul className={GRID}>
                        {shownInstalled.map((entry) => (
                          <PluginCard key={entry.id} {...cardProps(entry)} />
                        ))}
                        {shownOrphans.map((record) => (
                          <OrphanCard
                            key={record.id}
                            t={t}
                            record={record}
                            busy={busy?.id === record.id ? busy.action : null}
                            onOpen={() => setDetailId(record.id)}
                            onRemove={() => void onRemove(record.id)}
                            onToggle={(next) => void onToggle(record.id, next)}
                          />
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {shownAvailable.length > 0 ? (
                    <section>
                      <SectionHeader title={t("plugins.filter.available")} count={shownAvailable.length} />
                      <ul className={GRID}>
                        {shownAvailable.map((entry) => (
                          <PluginCard key={entry.id} {...cardProps(entry)} />
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </CustomScrollbar>

      {/* Details live in a dialog rather than in the card: the grid has no room for a file list, and
          an accordion in a grid cell reflows its whole row. */}
      <PluginDialog
        t={t}
        entry={detailEntry}
        record={detailRecord}
        outdated={!!detailEntry && !!detailRecord && detailEntry.version !== detailRecord.version}
        busy={busy?.id === detailId ? busy.action : null}
        auth={detailId ? auth[detailId] ?? [] : []}
        onClose={() => setDetailId(null)}
        onInstall={() => detailId && void onInstall(detailId)}
        onRemove={() => detailId && void onRemove(detailId)}
        onToggle={(next) => detailId && void onToggle(detailId, next)}
        onConnect={() => detailId && void onConnect(detailId)}
      />
    </div>
  );
}
