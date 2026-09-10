"use client";

/**
 * The skins you can switch to: Default, the four seasons, and everything installed (store skins and your own).
 * Your own skins can be edited and exported; any installed skin can be removed.
 */
import { useTheme } from "next-themes";
import { Check, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { skinsBridge } from "@/lib/electron/skins";
import { useAppearance } from "@/components/theme/ThemeProvider";
import { ACCENTS } from "@/components/theme/theme-config";
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_PREVIEW,
  NO_SKIN,
  findSkin,
  removeInstalledSkin,
  useInstalledSkins,
  type Skin,
} from "@/components/theme/skins";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SkinPreview } from "./SkinPreview";
import { skinError } from "./skinErrors";

export const skinLabel = (t: TFunc, s: Skin) => (s.nameKey ? t(s.nameKey) : (s.name ?? s.id));
export const skinBlurb = (t: TFunc, s: Skin) => (s.descKey ? t(s.descKey) : (s.description ?? ""));

export function SkinGallery({ t, onEdit }: { t: TFunc; onEdit: (skin: Skin) => void }) {
  const { appearance, setAppearance } = useAppearance();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const installed = useInstalledSkins();
  const activeId = findSkin(appearance.skin, installed)?.id ?? NO_SKIN;
  const accent = ACCENTS.find((a) => a.key === appearance.accent) ?? ACCENTS[0];

  // The Default card previews the base palette with the accent actually chosen, not a fixed graphite.
  const defaultCard: Skin = {
    ...DEFAULT_SKIN_PREVIEW,
    light: { ...DEFAULT_SKIN_PREVIEW.light, primary: accent.swatch },
    dark: { ...DEFAULT_SKIN_PREVIEW.dark, primary: accent.swatchDark },
  };
  const skins = [defaultCard, ...BUILTIN_SKINS, ...installed];

  const remove = async (s: Skin) => {
    // Fall back to Default first, so the app never points at a skin that is mid-deletion.
    if (activeId === s.id) setAppearance({ skin: NO_SKIN });
    const r = await removeInstalledSkin(s.id);
    if (!r.ok) Toast.error(skinError(t, r.code));
  };

  const exportSkin = async (s: Skin) => {
    const r = await skinsBridge()?.exportFile(s.id);
    if (!r) return;
    if (r.ok) Toast.success(t("appearance.exported"), r.path);
    else if (!r.canceled) Toast.error(skinError(t, r.code));
  };

  return (
    <div role="radiogroup" aria-label={t("appearance.skins")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {skins.map((s) => {
        const on = s.id === activeId;
        const own = s.origin === "custom";
        return (
          <div key={s.id} className="group relative">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAppearance({ skin: s.id })}
              className={cn(
                "flex w-full flex-col gap-2 rounded-xl border bg-surface p-2 text-left transition",
                on ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-line-strong",
              )}
            >
              <SkinPreview skin={s} dark={dark} />
              <span className="flex items-start justify-between gap-2 px-0.5">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-ink">{skinLabel(t, s)}</span>
                    {own ? (
                      <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-px text-[0.625rem] font-medium text-ink-subtle">
                        {t("appearance.custom")}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-ink-subtle">{skinBlurb(t, s)}</span>
                </span>
                {on ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
              </span>
            </button>

            {/* A sibling of the card, not a child: a button inside the card's button is invalid HTML. */}
            {!s.builtin ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${t("appearance.more")}: ${skinLabel(t, s)}`}
                    className="absolute right-3.5 top-3.5 grid size-6 place-items-center rounded-md bg-surface/90 text-ink-muted opacity-0 shadow-sm transition hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-36">
                  {own ? (
                    <>
                      <DropdownMenuItem onClick={() => onEdit(s)}>
                        <Pencil className="size-3.5" />
                        {t("appearance.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void exportSkin(s)}>
                        <Download className="size-3.5" />
                        {t("appearance.export")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  <DropdownMenuItem onClick={() => void remove(s)} className="text-destructive focus:text-destructive">
                    <Trash2 className="size-3.5" />
                    {t("appearance.remove")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
