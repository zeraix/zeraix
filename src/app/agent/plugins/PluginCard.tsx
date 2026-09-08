"use client";

/**
 * One plugin, as a card in the catalogue grid.
 *
 * The cards sit two or three abreast, so everything here is tuned for a narrow column: the name row
 * wraps rather than truncating its badges away, the description is clamped to two lines, and the
 * actions live in a footer row instead of a right rail (a rail would eat a third of the width).
 *
 * The whole card is activatable and opens the details dialog. It stays a <div role="button"> rather
 * than a real <button> because it already contains buttons and a switch, and nesting interactive
 * elements is invalid HTML that breaks keyboard navigation; the action row stops propagation so
 * installing or toggling never also opens the dialog.
 *
 * OrphanCard is the same card for an installed plugin the registry no longer lists — same shape, no
 * catalogue-only affordances.
 */

import { Download, KeyRound, Loader2, PackageOpen, ShieldCheck, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { capabilityCounts, collectPermissions, highestTier } from "@/lib/plugins/bridge";
import type { CatalogueEntry, InstalledPlugin, ProviderAuthStatus } from "@/lib/plugins/types";
import { ToggleSwitch } from "@/app/agent/settings/components/ToggleSwitch";
import {
  CARD,
  Chip,
  GHOST_BTN,
  MetaLine,
  PRIMARY_BTN,
  PluginAvatar,
  RAIL_BTN,
  RevokedNotice,
  TIER_STYLE,
  type CardAction,
  type T,
} from "./ui";

/** Card-level activation: click, Enter or Space, exactly as a native button behaves. */
function openProps(onOpen: () => void, label: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: onOpen,
    onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
  } as const;
}

/** Anything interactive inside the card lives in here, so acting never also opens the dialog. */
function Actions({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function PluginCard({
  t,
  entry,
  record,
  outdated,
  busy,
  auth,
  onOpen,
  onInstall,
  onRemove,
  onToggle,
}: {
  t: T;
  entry: CatalogueEntry;
  record: InstalledPlugin | null;
  outdated: boolean;
  busy: CardAction | null;
  auth: ProviderAuthStatus[];
  onOpen: () => void;
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
  /** Account state as one chip. The full explanation and the Connect button are in the dialog, but a
   *  plugin that cannot act until you authorize it has to say so where you are looking. */
  const account = record && !revoked && auth.length > 0 ? auth.every((a) => a.authorized) : null;

  return (
    <li
      {...openProps(onOpen, t("plugins.detailOpen", { name: entry.name }))}
      className={cn(CARD, "cursor-pointer", revoked && "border-danger/30")}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("transition", muted && "opacity-45")}>
          <PluginAvatar id={entry.id} name={entry.name} icon={entry.icon ?? null} />
        </div>

        <div className={cn("min-w-0 flex-1 transition", muted && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <p className="truncate text-sm font-semibold text-ink">{entry.name}</p>
            <span className={cn("rounded-md border px-1.5 py-px text-[10px] font-medium", TIER_STYLE[tier])}>
              {t(`plugins.tier.${tier}`)}
            </span>
            <span className="font-mono text-[10px] text-ink-subtle">v{record?.version ?? entry.version}</span>
          </div>
          <MetaLine t={t} id={entry.id} publisher={entry.publisher} license={entry.license} />
        </div>

        {record ? (
          <Actions>
            <ToggleSwitch on={record.enabled} disabled={!!revoked} onChange={onToggle} label={entry.name} />
          </Actions>
        ) : null}
      </div>

      {/* Clamped: descriptions run long, and one card must not push the next off screen. */}
      <p className={cn("mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted", muted && "opacity-60")}>
        {entry.description}
      </p>

      {/* What it adds + what it may touch, as discrete chips rather than one grey sentence. */}
      {counts.length > 0 || grants.length > 0 || account !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {counts.map((c) => (
            <Chip key={c.type}>{t(`plugins.adds.${c.type}`, { count: c.count })}</Chip>
          ))}
          {grants.map((g) => (
            <Chip key={g} className="border-warning/25 bg-warning/5 text-warning-ink">
              <ShieldCheck className="size-2.5 shrink-0" />
              {g}
            </Chip>
          ))}
          {account === false ? (
            <Chip className="border-warning/40 bg-warning/10 text-warning-ink">
              <KeyRound className="size-2.5 shrink-0" />
              {t("plugins.auth.disconnected")}
            </Chip>
          ) : null}
          {account === true ? (
            <Chip className="border-success/30 bg-success/10 text-success-ink">
              <ShieldCheck className="size-2.5 shrink-0" />
              {t("plugins.auth.connected", { provider: auth.map((a) => a.provider ?? a.providerId).join(", ") })}
            </Chip>
          ) : null}
        </div>
      ) : null}

      {revoked ? <RevokedNotice t={t} reason={revoked.reason} /> : null}

      <Actions className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        {record ? (
          <>
            {outdated && !revoked ? (
              <button type="button" onClick={onInstall} disabled={busy !== null} className={cn(PRIMARY_BTN, RAIL_BTN)}>
                {busy === "install" ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                {t("plugins.update", { version: entry.version })}
              </button>
            ) : null}
            <button type="button" onClick={onRemove} disabled={busy !== null} className={cn(GHOST_BTN, RAIL_BTN)}>
              {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              {t("plugins.remove")}
            </button>
          </>
        ) : (
          <button type="button" onClick={onInstall} disabled={busy !== null} className={cn(PRIMARY_BTN, RAIL_BTN)}>
            {busy === "install" ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
            {t("plugins.install")}
          </button>
        )}
      </Actions>
    </li>
  );
}

/**
 * Installed but no longer in the catalogue -- the registry stopped listing it, or the feed is a
 * cached copy from before it existed. It keeps working; it just cannot be updated, and it has to
 * stay removable, which is why it is shown rather than hidden.
 */
export function OrphanCard({
  t,
  record,
  busy,
  onOpen,
  onRemove,
  onToggle,
}: {
  t: T;
  record: InstalledPlugin;
  busy: CardAction | null;
  onOpen: () => void;
  onRemove: () => void;
  onToggle: (next: boolean) => void;
}) {
  const muted = !record.enabled && !record.revoked;

  return (
    <li
      {...openProps(onOpen, t("plugins.detailOpen", { name: record.name }))}
      className={cn(CARD, "cursor-pointer", record.revoked && "border-danger/30")}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("transition", muted && "opacity-45")}>
          {/* An orphan is an installed record with no catalogue entry behind it, so there is no icon to show. */}
          <PluginAvatar id={record.id} name={record.name} icon={null} />
        </div>
        <div className={cn("min-w-0 flex-1 transition", muted && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <p className="truncate text-sm font-semibold text-ink">{record.name}</p>
            <span className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-muted/60 px-1.5 py-px text-[10px] font-medium text-ink-muted">
              <PackageOpen className="size-2.5" />
              {t("plugins.unlisted")}
            </span>
            <span className="font-mono text-[10px] text-ink-subtle">v{record.version}</span>
          </div>
          <MetaLine t={t} id={record.id} publisher={record.publisher} />
        </div>
        <Actions>
          <ToggleSwitch on={record.enabled} disabled={!!record.revoked} onChange={onToggle} label={record.name} />
        </Actions>
      </div>

      <p className={cn("mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted", muted && "opacity-60")}>
        {record.description}
      </p>
      {record.revoked ? <RevokedNotice t={t} reason={record.revoked.reason} /> : null}

      <Actions className="mt-2.5 flex items-center justify-end">
        <button type="button" onClick={onRemove} disabled={busy !== null} className={cn(GHOST_BTN, RAIL_BTN)}>
          {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
          {t("plugins.remove")}
        </button>
      </Actions>
    </li>
  );
}
