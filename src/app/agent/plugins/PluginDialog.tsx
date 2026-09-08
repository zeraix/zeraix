"use client";

/**
 * Plugin details modal.
 *
 * Clicking a card opens this rather than expanding the card in place: the catalogue is a grid now,
 * and an accordion inside a grid cell either reflows its whole row or leaves its neighbours holding
 * blank space. A dialog also gives the long-form facts — every permission, every file, the account
 * state — room the card deliberately does not have.
 *
 * It renders from the live catalogue/installed state rather than a snapshot taken at open time, so
 * installing or removing from in here updates the dialog instead of leaving it stale.
 */

import { ExternalLink, Download, Loader2, PackageOpen, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { collectPermissions, highestTier } from "@/lib/plugins/bridge";
import type { CatalogueEntry, InstalledPlugin, ProviderAuthStatus } from "@/lib/plugins/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleSwitch } from "@/app/agent/settings/components/ToggleSwitch";
import { PluginDetails } from "./PluginDetails";
import {
  AccountNotice,
  Chip,
  GHOST_BTN,
  MetaLine,
  PRIMARY_BTN,
  PluginAvatar,
  RevokedNotice,
  TIER_STYLE,
  openExternal,
  type CardAction,
  type T,
} from "./ui";

/** One labelled group of grants. Renders nothing when the plugin asks for nothing of that kind. */
function Grants({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">{label}</span>
      {values.map((v) => (
        <Chip key={v} className="border-warning/25 bg-warning/5 font-mono text-warning-ink">
          {v}
        </Chip>
      ))}
    </div>
  );
}

export function PluginDialog({
  t,
  entry,
  record,
  outdated,
  busy,
  auth,
  onClose,
  onInstall,
  onRemove,
  onToggle,
  onConnect,
}: {
  t: T;
  entry: CatalogueEntry | null;
  record: InstalledPlugin | null;
  outdated: boolean;
  busy: CardAction | null;
  auth: ProviderAuthStatus[];
  onClose: () => void;
  onInstall: () => void;
  onRemove: () => void;
  onToggle: (next: boolean) => void;
  onConnect: () => void;
}) {
  const open = !!(entry || record);
  // Either source can be missing: an uninstalled catalogue entry has no record, an unlisted install
  // has no entry. Everything below reads whichever one is there.
  const name = entry?.name ?? record?.name ?? "";
  const id = entry?.id ?? record?.id ?? "";
  const version = record?.version ?? entry?.version ?? "";
  const revoked = record?.revoked ?? null;
  const permissions = entry ? collectPermissions(entry) : null;
  const grants = permissions
    ? permissions.network.length + permissions.filesystem.length + permissions.credentials.length
    : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl">
        {open ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3">
                <PluginAvatar id={id} name={name} icon={entry?.icon ?? null} />
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                    <span className="truncate">{name}</span>
                    {entry ? (
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-px text-[10px] font-medium",
                          TIER_STYLE[highestTier(entry)],
                        )}
                      >
                        {t(`plugins.tier.${highestTier(entry)}`)}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 rounded-md border border-line-strong bg-surface-muted/60 px-1.5 py-px text-[10px] font-medium text-ink-muted">
                        <PackageOpen className="size-2.5" />
                        {t("plugins.unlisted")}
                      </span>
                    )}
                    <span className="font-mono text-[11px] font-normal text-ink-subtle">v{version}</span>
                  </DialogTitle>
                  <MetaLine
                    t={t}
                    id={id}
                    publisher={entry?.publisher ?? record?.publisher ?? ""}
                    license={entry?.license}
                  />
                </div>
              </div>
              <DialogDescription className="mt-2 text-xs leading-relaxed">
                {entry?.description ?? record?.description}
              </DialogDescription>
            </DialogHeader>

            {revoked ? <RevokedNotice t={t} reason={revoked.reason} /> : null}
            {record && !revoked ? (
              <AccountNotice t={t} status={auth} busy={busy === "connect"} onConnect={onConnect} />
            ) : null}

            {/* What the plugin may reach, spelled out. The card only has room for the raw values. */}
            {grants > 0 && permissions ? (
              <section className="space-y-1.5 rounded-lg border border-line bg-surface-muted/40 px-3 py-2.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                  {t("plugins.detailAccess")}
                </h3>
                <Grants label={t("plugins.perm.network")} values={permissions.network} />
                <Grants label={t("plugins.perm.filesystem")} values={permissions.filesystem} />
                <Grants label={t("plugins.perm.credentials")} values={permissions.credentials} />
              </section>
            ) : null}

            <PluginDetails t={t} entry={entry} record={record} />

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {record ? (
                <ToggleSwitch on={record.enabled} disabled={!!revoked} onChange={onToggle} label={name} />
              ) : null}
              {entry?.homepage ? (
                <button
                  type="button"
                  onClick={() => openExternal(entry.homepage!)}
                  className={cn(GHOST_BTN, "border-transparent bg-transparent text-ink-subtle")}
                >
                  <ExternalLink className="size-3" />
                  {t("plugins.homepage")}
                </button>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                {record ? (
                  <>
                    {entry && outdated && !revoked ? (
                      <button type="button" onClick={onInstall} disabled={busy !== null} className={PRIMARY_BTN}>
                        {busy === "install" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        {t("plugins.update", { version: entry.version })}
                      </button>
                    ) : null}
                    <button type="button" onClick={onRemove} disabled={busy !== null} className={GHOST_BTN}>
                      {busy === "remove" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                      {t("plugins.remove")}
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={onInstall} disabled={busy !== null} className={PRIMARY_BTN}>
                    {busy === "install" ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                    {t("plugins.install")}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
