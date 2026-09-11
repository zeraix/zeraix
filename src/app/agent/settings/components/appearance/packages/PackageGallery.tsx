"use client";

/**
 * Every skin package you can switch to: the built-in presets and the installed packages. The active
 * one is highlighted; a click applies it; installed packages can be removed from their menu.
 *
 * A package card previews with the package's own screenshot (`skin://<id>/<preview>`) when the
 * manifest names one, and with a card drawn from its tokens.css otherwise. Presets draw a swatch.
 */
import { useState } from "react";
import { Check, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { skinAPI, type SkinManifest } from "@/lib/electron/skinpkg";
import { DEFAULT_SKIN_ID, useSkin, type BuiltinSkin, packageErrorToast } from "@/components/theme/skinpkg";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PackagePreview, usePackageTokens } from "./PackagePreview";

const CARD = "flex w-full flex-col gap-2 rounded-xl border bg-surface p-2 text-left transition";

function PresetCard({ t, skin, on, busy, onPick }: { t: TFunc; skin: BuiltinSkin; on: boolean; busy: boolean; onPick: () => void }) {
  const [a, b, c] = skin.swatch;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={busy}
      onClick={onPick}
      className={cn(CARD, on ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-line-strong")}
    >
      {skin.id === DEFAULT_SKIN_ID ? (
        <PackagePreview t={t} />
      ) : (
        <div className="aspect-[16/10] w-full overflow-hidden rounded-lg border border-line" style={{ background: `linear-gradient(135deg, ${a} 0%, ${b} 55%, ${c} 100%)` }} aria-hidden>
          <div className="m-2 h-2 w-1/3 rounded-full" style={{ background: c, opacity: 0.9 }} />
          <div className="mx-2 h-1.5 w-1/2 rounded-full" style={{ background: b, opacity: 0.9 }} />
        </div>
      )}
      <span className="flex items-start justify-between gap-2 px-0.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{t(skin.nameKey)}</span>
          <span className="block truncate text-xs text-ink-subtle">{t(skin.descKey)}</span>
        </span>
        {on ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
      </span>
    </button>
  );
}

function PackageCard({ t, skin, on, busy, onPick, onRemove }: { t: TFunc; skin: SkinManifest; on: boolean; busy: boolean; onPick: () => void; onRemove: () => void }) {
  const tokens = usePackageTokens(skin.preview ? null : skin.id);
  const image = skin.preview ? `skin://${skin.id}/${skin.preview}` : null;
  return (
    <div className="group relative">
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={busy}
        onClick={onPick}
        className={cn(CARD, on ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-line-strong")}
      >
        <PackagePreview t={t} tokens={tokens ?? undefined} image={image} />
        <span className="flex items-start justify-between gap-2 px-0.5">
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-ink">{skin.name}</span>
              <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-px text-[0.625rem] font-medium tabular-nums text-ink-subtle">
                {t("skinpkg.version", { version: skin.version })}
              </span>
            </span>
            <span className="block truncate text-xs text-ink-subtle">{skin.description || (skin.author ? t("skinpkg.by", { author: skin.author }) : skin.id)}</span>
          </span>
          {on ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
        </span>
      </button>
      {/* A sibling of the card, not a child: a button inside the card's button is invalid HTML. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${t("appearance.more")}: ${skin.name}`}
            className="absolute right-3.5 top-3.5 grid size-6 place-items-center rounded-md bg-surface/90 text-ink-muted opacity-0 shadow-sm transition hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
            <Trash2 className="size-3.5" />
            {t("skinpkg.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function PackageGallery({ t }: { t: TFunc }) {
  const { currentSkinId, installedSkins, builtinSkins, applySkin, isApplying, isLoading, available } = useSkin();
  const [pending, setPending] = useState<string | null>(null);

  const pick = async (id: string) => {
    if (id === currentSkinId) return;
    setPending(id);
    const r = await applySkin(id);
    setPending(null);
    if (!r.ok) {
      const { title, detail } = packageErrorToast(t, { code: r.error.code, message: "", detail: r.error.detail });
      Toast.error(title, detail);
    }
  };

  const remove = async (skin: SkinManifest) => {
    const api = skinAPI();
    if (!api) return;
    // Fall back to the default first, so the app never points at a package that is mid-deletion.
    if (currentSkinId === skin.id) await applySkin(DEFAULT_SKIN_ID);
    const r = await api.delete(skin.id);
    if (r.ok) Toast.success(t("skinpkg.removed"), skin.name);
    else {
      const { title, detail } = packageErrorToast(t, r.error);
      Toast.error(title, detail);
    }
  };

  const busy = isApplying || pending !== null;
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t("skinpkg.presetsGroup")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {builtinSkins.map((s) => (
          <PresetCard key={s.id} t={t} skin={s} on={s.id === currentSkinId} busy={busy} onPick={() => void pick(s.id)} />
        ))}
      </div>
      {available ? (
        <>
          <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
            {t("skinpkg.installedGroup")}
            {isLoading ? <Loader2 className="size-3 animate-spin" /> : null}
            <span className="rounded-full bg-surface-muted px-1.5 py-px text-[10px] tabular-nums text-ink-subtle">{installedSkins.length}</span>
          </p>
          {installedSkins.length === 0 && !isLoading ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-3.5 text-xs text-ink-subtle">{t("skinpkg.empty")}</p>
          ) : (
            <div role="radiogroup" aria-label={t("skinpkg.installedGroup")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {installedSkins.map((s) => (
                <PackageCard key={s.id} t={t} skin={s} on={s.id === currentSkinId} busy={busy} onPick={() => void pick(s.id)} onRemove={() => void remove(s)} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
