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
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Ban,
  Blocks,
  ChevronDown,
  Download,
  FileCode,
  Loader2,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";

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

/** Every action button is this wide, so a card's right rail is a column and not a ragged edge. */
const RAIL_BTN = "min-w-[104px] justify-center";
const GHOST_BTN =
  "flex shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition hover:bg-surface-muted disabled:opacity-50";

/** Tier badge styling. `host` is deliberately the loudest thing on the card. */
const TIER_STYLE: Record<PluginTier, string> = {
  text: "border-line-strong bg-surface-muted/60 text-ink-muted",
  sandboxed: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  host: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
};

/**
 * Identicon tints. A catalogue of same-shaped rows is hard to scan, so each plugin gets a stable
 * colour + monogram derived from its id — the eye finds "the teal one" long before it reads a name.
 * Fixed palette rather than a generated hue: these have to stay legible in both themes.
 */
const AVATAR_TINTS = [
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "bg-teal-500/10 text-teal-600 dark:text-teal-400",
];

/** Stable per-id tint. Any cheap hash will do; it only has to be deterministic across reloads. */
function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

/** Up to two initials from the display name — "Office Suite" → OS, "Git" → G. */
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function PluginAvatar({ id, name }: { id: string; name: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold tracking-tight",
        tintFor(id),
      )}
    >
      {monogram(name)}
    </div>
  );
}

/** Small pill. Metadata reads as discrete facts instead of one run-on grey sentence. */
function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted/50 px-2 py-0.5 text-[10px] font-medium text-ink-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

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

  const nothingShown =
    shownInstalled.length === 0 && shownAvailable.length === 0 && shownOrphans.length === 0;
  const filtering = query.trim().length > 0 || filter !== "all";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-8 py-6">
        <div className="mx-auto w-full max-w-4xl">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-foreground">{t("nav.plugins")}</h1>
              {/* The description is reference material, not a headline — cap it so it cannot push
                  the actual catalogue below the fold on a short window. */}
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t("plugins.desc")}</p>
            </div>
            {available ? (
              <button type="button" onClick={() => void onRefresh()} disabled={refreshing} className={PRIMARY_BTN}>
                {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t("plugins.refresh")}
              </button>
            ) : null}
          </div>

          {available && (catalogue.length > 0 || orphans.length > 0) ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
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
                      "rounded-md px-2.5 py-1 text-[11px] font-medium transition",
                      filter === k
                        ? "bg-surface text-ink shadow-sm"
                        : "text-ink-subtle hover:text-ink-muted",
                    )}
                  >
                    {t(`plugins.filter.${k}`)}
                  </button>
                ))}
              </div>
            </div>
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
              <EmptyState icon={<Blocks className="size-5" />} text={t("plugins.empty")} />
            ) : nothingShown ? (
              // Distinct from an empty catalogue: there ARE plugins, this search just found none.
              <EmptyState icon={<Search className="size-5" />} text={t("plugins.noResults")} />
            ) : (
              <div className="flex flex-col gap-6">
                {shownInstalled.length > 0 || shownOrphans.length > 0 ? (
                  <section>
                    <SectionHeader
                      title={t("plugins.filter.installed")}
                      count={shownInstalled.length + shownOrphans.length}
                    />
                    <ul className="flex flex-col gap-2.5">
                      {shownInstalled.map((entry) => {
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
                      {shownOrphans.map((record) => (
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
                  </section>
                ) : null}

                {shownAvailable.length > 0 ? (
                  <section>
                    <SectionHeader title={t("plugins.filter.available")} count={shownAvailable.length} />
                    <ul className="flex flex-col gap-2.5">
                      {shownAvailable.map((entry) => {
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
                    </ul>
                  </section>
                ) : null}
              </div>
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

  // An installed-but-disabled plugin is dimmed: still listed, visibly not in play.
  const muted = !!record && !record.enabled && !revoked;
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={cn(
        "group rounded-xl border border-line bg-surface p-4 transition hover:border-line-strong hover:bg-surface-hover/40",
        revoked && "border-red-500/30",
      )}
    >
      <div className="flex items-start gap-3.5">
        <div className={cn("transition", muted && "opacity-45")}>
          <PluginAvatar id={entry.id} name={entry.name} />
        </div>

        {/* The info column is the disclosure control. It is a sibling of the action rail, never a
            parent of it, so expanding can never swallow an Install or Remove click. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={t(expanded ? "plugins.hideDetails" : "plugins.showDetails")}
          className={cn("min-w-0 flex-1 text-left transition", muted && "opacity-60")}
        >
          {/* One title line: name carries the weight, everything beside it is a qualifier. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-semibold text-ink">{entry.name}</p>
            <span className={cn("rounded-md border px-1.5 py-px text-[10px] font-medium", TIER_STYLE[tier])}>
              {t(`plugins.tier.${tier}`)}
            </span>
            <span className="font-mono text-[10px] text-ink-subtle">v{record?.version ?? entry.version}</span>
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-ink-subtle transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">{entry.id}</p>
          {/* Clamped: descriptions run long, and one card must not push the next off screen. */}
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">{entry.description}</p>

          {/* What it adds + what it may touch, as discrete chips rather than one grey sentence. */}
          {counts.length > 0 || grants.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {counts.map((c) => (
                <Chip key={c.type}>{t(`plugins.adds.${c.type}`, { count: c.count })}</Chip>
              ))}
              {grants.map((g) => (
                <Chip key={g} className="border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-400">
                  <ShieldCheck className="size-2.5 shrink-0" />
                  {g}
                </Chip>
              ))}
            </div>
          ) : null}

          {revoked ? <RevokedNotice t={t} reason={revoked.reason} /> : null}
        </button>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {record ? (
            <>
              <ToggleSwitch on={record.enabled} disabled={!!revoked} onChange={onToggle} label={entry.name} />
              {outdated && !revoked ? (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={busy !== null}
                  className={cn(PRIMARY_BTN, RAIL_BTN)}
                >
                  {busy === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {t("plugins.update", { version: entry.version })}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onRemove}
                disabled={busy !== null}
                className={cn(GHOST_BTN, RAIL_BTN)}
              >
                {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                {t("plugins.remove")}
              </button>
            </>
          ) : (
            <button type="button" onClick={onInstall} disabled={busy !== null} className={cn(PRIMARY_BTN, RAIL_BTN)}>
              {busy === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {t("plugins.install")}
            </button>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 40 }}
            className="overflow-hidden"
          >
            <PluginDetails t={t} entry={entry} record={record} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

/**
 * The expanded half of a card: what the plugin adds, and — once installed — its files.
 *
 * Two sources, deliberately asymmetric. The catalogue knows every item's display name but no paths;
 * the installed record knows paths but carries no names. So they are merged by id: names come from
 * the catalogue where there is one, paths from disk. An uninstalled plugin therefore lists what it
 * would add and nothing else, because nothing of it exists locally yet — the renderer is never sent
 * entry points or command lines (design doc §4).
 *
 * Note the vocabulary: the word "capability" is the install path's model, not the user's, and must
 * not reach the screen (design doc §10). Everything here is "what it adds" and "files".
 */
function PluginDetails({
  t,
  entry,
  record,
}: {
  t: T;
  entry: CatalogueEntry | null;
  record: InstalledPlugin | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [file, setFile] = useState<{ loading: boolean; content: string | null; error: string | null }>({
    loading: false,
    content: null,
    error: null,
  });

  const pluginId = entry?.id ?? record?.id ?? "";
  /** id -> display name, so the file list can show "Writing commits" rather than `commits`. */
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of entry?.capabilities ?? []) if (c.name) m.set(c.id, c.name);
    return m;
  }, [entry]);

  /** Grouped by the author's `module`, which is exactly what it is for: "adds 3 tools and a skill". */
  const byModule = useMemo(() => {
    const items = entry?.capabilities ?? record?.capabilities.map((c) => ({ ...c, name: null })) ?? [];
    const groups = new Map<string, { id: string; type: string; name: string | null }[]>();
    for (const c of items) {
      const key = c.module ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: c.id, type: c.type, name: c.name ?? null });
    }
    return [...groups.entries()];
  }, [entry, record]);

  const files = record?.capabilities.filter((c) => c.path) ?? [];

  const openFile = useCallback(
    async (capId: string) => {
      if (open === capId) {
        setOpen(null);
        return;
      }
      setOpen(capId);
      setFile({ loading: true, content: null, error: null });
      const bridge = pluginBridge();
      if (!bridge) return setFile({ loading: false, content: null, error: t("plugins.readFailed") });
      try {
        // Re-verified against the pinned digest on the main-process side, so what renders here is
        // the reviewed bytes or nothing at all.
        const r = await bridge.read(pluginId, capId);
        setFile({ loading: false, content: r.content, error: r.ok ? null : r.error ?? t("plugins.readFailed") });
      } catch (e) {
        setFile({ loading: false, content: null, error: e instanceof Error ? e.message : t("plugins.readFailed") });
      }
    },
    [open, pluginId, t],
  );

  return (
    <div className="mt-3.5 space-y-3.5 border-t border-line pt-3.5">
      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          {t("plugins.detailAdds")}
        </h3>
        <div className="space-y-2">
          {byModule.map(([mod, items]) => (
            <div key={mod || "_"} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {mod ? <span className="font-mono text-[10px] text-ink-subtle">{mod}</span> : null}
              {items.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                  <span className="size-1 rounded-full bg-ink-subtle/40" />
                  {c.name ?? c.id}
                  <span className="text-[10px] text-ink-subtle">{t(`plugins.adds.${c.type}`, { count: 1 })}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          {t("plugins.detailFiles")}
        </h3>
        {files.length === 0 ? (
          <p className="text-[11px] text-ink-subtle">{t("plugins.filesAfterInstall")}</p>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line">
            {files.map((c) => (
              <li key={c.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => void openFile(c.id)}
                  aria-expanded={open === c.id}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-surface-hover/50"
                >
                  <FileCode className="size-3 shrink-0 text-ink-subtle" />
                  <span className="truncate font-mono text-[11px] text-ink-muted">{c.path}</span>
                  <span className="ml-auto shrink-0 truncate text-[10px] text-ink-subtle">
                    {names.get(c.id) ?? c.id}
                  </span>
                </button>
                {open === c.id ? (
                  <div className="border-t border-line bg-surface-muted/40 px-2.5 py-2">
                    {file.loading ? (
                      <Loader2 className="size-3.5 animate-spin text-ink-subtle" />
                    ) : file.error ? (
                      <p className="text-[11px] text-red-600 dark:text-red-400">{file.error}</p>
                    ) : (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-ink-muted">
                        {file.content}
                      </pre>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Section label + count. Quiet enough that it groups without competing with the cards. */
function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">{title}</h2>
      <span className="rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-ink-subtle">
        {count}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Centred placeholder — an empty catalogue and an empty search both land here. */
function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
        {icon}
      </span>
      <p className="max-w-sm text-xs text-ink-subtle">{text}</p>
    </div>
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
  const muted = !record.enabled && !record.revoked;
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={cn(
        "group rounded-xl border border-line bg-surface p-4 transition hover:border-line-strong hover:bg-surface-hover/40",
        record.revoked && "border-red-500/30",
      )}
    >
      <div className="flex items-start gap-3.5">
        <div className={cn("transition", muted && "opacity-45")}>
          <PluginAvatar id={record.id} name={record.name} />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={t(expanded ? "plugins.hideDetails" : "plugins.showDetails")}
          className={cn("min-w-0 flex-1 text-left transition", muted && "opacity-60")}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-semibold text-ink">{record.name}</p>
            <span className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-muted/60 px-1.5 py-px text-[10px] font-medium text-ink-muted">
              <PackageOpen className="size-2.5" />
              {t("plugins.unlisted")}
            </span>
            <span className="font-mono text-[10px] text-ink-subtle">v{record.version}</span>
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-ink-subtle transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">{record.id}</p>
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">{record.description}</p>
          {record.revoked ? <RevokedNotice t={t} reason={record.revoked.reason} /> : null}
        </button>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ToggleSwitch on={record.enabled} disabled={!!record.revoked} onChange={onToggle} label={record.name} />
          <button type="button" onClick={onRemove} disabled={busy !== null} className={cn(GHOST_BTN, RAIL_BTN)}>
            {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            {t("plugins.remove")}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 40 }}
            className="overflow-hidden"
          >
            {/* No catalogue entry exists for an unlisted plugin — files and ids only, no names. */}
            <PluginDetails t={t} entry={null} record={record} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
