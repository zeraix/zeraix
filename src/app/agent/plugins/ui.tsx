"use client";

/**
 * Shared presentation for the plugins page (/agent/plugins).
 *
 * Split out of page.tsx so the page file stays about data flow and the cards stay about layout.
 * Everything here is dumb: no bridge calls, no state that outlives a render.
 */

import type React from "react";
import { Ban, KeyRound, LinkIcon, Loader2, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PluginTier, ProviderAuthStatus } from "@/lib/plugins/types";

/** The registry's homepage links are ordinary http(s) URLs; the shell decides where they open. */
export const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

export type T = (key: string, vars?: Record<string, string | number>) => string;
export type CardAction = "install" | "remove" | "connect";
export type Busy = { id: string; action: CardAction } | null;

export const PRIMARY_BTN =
  "flex shrink-0 items-center gap-1 rounded-lg bg-gradient-to-br from-primary to-primary/85 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:brightness-105 disabled:opacity-50";

/** Every action button is this wide, so a card's footer is a row of columns and not a ragged edge. */
export const RAIL_BTN = "min-w-[88px] justify-center";
export const GHOST_BTN =
  "flex shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:bg-surface-muted disabled:opacity-50";

/** Shared card shell: two or three of these sit side by side, so the padding is tight on purpose. */
export const CARD =
  "group flex flex-col rounded-xl border border-line bg-surface p-3 transition hover:border-line-strong hover:bg-surface-hover/40";

/** Tier badge styling. `host` is deliberately the loudest thing on the card. */
export const TIER_STYLE: Record<PluginTier, string> = {
  text: "border-line-strong bg-surface-muted/60 text-ink-muted",
  sandboxed: "border-warning/30 bg-warning/10 text-warning-ink",
  host: "border-danger/30 bg-danger/10 text-danger-ink",
};

/**
 * Identicon tints. A catalogue of same-shaped rows is hard to scan, so each plugin gets a stable
 * colour + monogram derived from its id — the eye finds "the teal one" long before it reads a name.
 * Fixed palette rather than a generated hue: these have to stay legible in both themes.
 */
const AVATAR_TINTS = [
  "bg-tint-2/10 text-tint-2-ink",
  "bg-tint-1/10 text-tint-1-ink",
  "bg-tint-4/10 text-tint-4-ink",
  "bg-tint-3/10 text-tint-3-ink",
  "bg-tint-5/10 text-tint-5-ink",
  "bg-tint-6/10 text-tint-6-ink",
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

export function PluginAvatar({ id, name, icon }: { id: string; name: string; icon: string | null }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold tracking-tight",
        tintFor(id),
      )}
    >
      {icon ? <img src={icon} alt={name} className="size-full rounded-lg" /> : monogram(name)}
    </div>
  );
}

/** Small pill. Metadata reads as discrete facts instead of one run-on grey sentence. */
export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted/50 px-1.5 py-px text-[10px] font-medium text-ink-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The line under a plugin's name: id, who published it, what licence it carries.
 *
 * All three were previously either hidden or only in the expanded panel, which made two plugins from
 * different publishers look identical until you opened them. Separators are rendered, not `·`-joined
 * strings, so a missing licence does not leave a dangling dot.
 */
export function MetaLine({
  t,
  id,
  publisher,
  license,
}: {
  t: T;
  id: string;
  publisher: string;
  license?: string | null;
}) {
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-ink-subtle">
      <span className="truncate font-mono">{id}</span>
      {publisher ? (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{t("plugins.by", { publisher })}</span>
        </>
      ) : null}
      {license ? (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{license}</span>
        </>
      ) : null}
    </div>
  );
}

/** Reason-first banner. A withdrawn plugin explains itself before anything else on the card. */
export function RevokedNotice({ t, reason }: { t: T; reason: string }) {
  return (
    <p className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11px] text-danger-ink">
      <Ban className="mt-px size-3 shrink-0" />
      <span className="break-words">
        <span className="font-semibold">{t("plugins.revoked")}</span> {reason}
      </span>
    </p>
  );
}

/**
 * Account state for a plugin that authorizes against something.
 *
 * Shown only when there is something to say: a plugin with no oauth provider renders nothing, which
 * is every plugin in the catalogue but one. The disconnected case carries the reason the last attempt
 * failed, because "not connected" alone sends people to the wrong place — a declined consent screen
 * and a build with no credentials need opposite responses.
 */
export function AccountNotice({
  t,
  status,
  busy,
  onConnect,
}: {
  t: T;
  status: ProviderAuthStatus[];
  busy: boolean;
  onConnect: () => void;
}) {
  if (status.length === 0) return null;
  const disconnected = status.filter((p) => !p.authorized);

  if (disconnected.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-success-ink">
        <ShieldCheck className="size-3 shrink-0" />
        {t("plugins.auth.connected", { provider: status.map((p) => p.provider ?? p.providerId).join(", ") })}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5">
      <p className="flex items-start gap-2 text-[11px] text-warning-ink">
        <KeyRound className="mt-px size-3 shrink-0" />
        <span className="break-words">
          <span className="font-semibold">{t("plugins.auth.disconnected")}</span>{" "}
          {t("plugins.auth.disconnectedHint")}
          {disconnected[0].lastError ? (
            <span className="mt-1 block text-ink-muted">{disconnected[0].lastError}</span>
          ) : null}
        </span>
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className={cn(GHOST_BTN, "mt-1.5 border-warning/40 text-warning-ink")}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <LinkIcon className="size-3" />}
        {t("plugins.auth.connect")}
      </button>
    </div>
  );
}

/** Section label + count. Quiet enough that it groups without competing with the cards. */
export function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">{title}</h2>
      <span className="rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-ink-subtle">
        {count}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Centred placeholder — an empty catalogue and an empty search both land here. */
export function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
        {icon}
      </span>
      <p className="max-w-sm text-xs text-ink-subtle">{text}</p>
    </div>
  );
}
