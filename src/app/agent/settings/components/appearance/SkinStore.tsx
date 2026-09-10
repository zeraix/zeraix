"use client";

/**
 * The skin store: the catalog to install from, plus the ways to bring your own -- create one in the editor, import a
 * file, or download the template to build one by hand. Creating and importing need the desktop app's skin store; the
 * web build still lists and installs catalog skins.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Download, FileDown, Loader2, Plus, RefreshCw, Upload } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isSkinStoreAvailable, skinsBridge } from "@/lib/electron/skins";
import { useAppearance } from "@/components/theme/ThemeProvider";
import {
  downloadSkin,
  fetchSkinCatalog,
  findSkin,
  installStoreSkin,
  useInstalledSkins,
  type Skin,
} from "@/components/theme/skins";
import { NOTE } from "../pane";
import { SkinPreview } from "./SkinPreview";
import { skinError } from "./skinErrors";

const noopSubscribe = () => () => {};
// Server snapshot claims "available" so the desktop-only note never flashes into the desktop app on hydration.
const useDesktop = () => useSyncExternalStore(noopSubscribe, isSkinStoreAvailable, () => true);

const SECONDARY =
  "flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted";

export function SkinStoreActions({ t, onCreate }: { t: TFunc; onCreate: () => void }) {
  const { setAppearance } = useAppearance();
  if (!useDesktop()) return null;

  const importSkin = async () => {
    const r = await skinsBridge()?.importFile();
    if (!r) return;
    if (r.ok) {
      Toast.success(t("appearance.imported"), r.skin.name);
      setAppearance({ skin: r.skin.id });
    } else if (!r.canceled) Toast.error(skinError(t, r.code));
  };

  const template = async () => {
    const r = await skinsBridge()?.downloadTemplate();
    if (!r) return;
    if (r.ok) Toast.success(t("appearance.templateSaved"), r.path);
    else if (!r.canceled) Toast.error(skinError(t, r.code));
  };

  return (
    <>
      <button type="button" onClick={template} className={cn(SECONDARY, "border-transparent text-ink-muted")}>
        <FileDown className="size-3.5" />
        {t("appearance.template")}
      </button>
      <button type="button" onClick={importSkin} className={SECONDARY}>
        <Upload className="size-3.5" />
        {t("appearance.import")}
      </button>
      <button
        type="button"
        onClick={onCreate}
        className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105"
      >
        <Plus className="size-3.5" />
        {t("appearance.create")}
      </button>
    </>
  );
}

export function SkinStoreList({ t }: { t: TFunc }) {
  const { appearance, setAppearance } = useAppearance();
  const { resolvedTheme } = useTheme();
  const installed = useInstalledSkins();
  const desktop = useDesktop();
  const activeId = findSkin(appearance.skin, installed)?.id;

  const [catalog, setCatalog] = useState<Skin[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSkinCatalog()
      .then((list) => {
        if (alive) setCatalog(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const install = async (id: string, update = false) => {
    setBusy(id);
    try {
      const skin = await downloadSkin(id);
      const r = await installStoreSkin(skin);
      if (r.ok) Toast.success(t(update ? "appearance.updatedToast" : "appearance.installedToast"), skin.name);
      else Toast.error(skinError(t, r.code));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {!desktop ? <p className={NOTE}>{t("appearance.storeDesktopOnly")}</p> : null}
      {failed ? (
        <div className={cn(NOTE, "flex items-center justify-between gap-3")}>
          <span>{t("appearance.storeError")}</span>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setCatalog(null);
              setAttempt((n) => n + 1);
            }}
            className={SECONDARY}
          >
            {t("appearance.storeRetry")}
          </button>
        </div>
      ) : catalog === null ? (
        <div className={cn(NOTE, "flex items-center gap-2")}>
          <Loader2 className="size-3.5 animate-spin" />
          {t("appearance.storeLoading")}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {catalog.map((s) => {
            const mine = installed.find((i) => i.id === s.id);
            const have = !!mine;
            // A store skin installed from an older catalog keeps its old pieces until it is reinstalled.
            const outdated = mine?.origin === "store" && mine.version !== s.version;
            const on = activeId === s.id;
            return (
              <li key={s.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
                <SkinPreview skin={s} dark={resolvedTheme === "dark"} className="w-28 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate">{s.name}</span>
                    {s.decor?.motion ? (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[0.625rem] font-medium text-ink-muted">
                        {t("appearance.animated")}
                      </span>
                    ) : null}
                  </p>
                  {s.description ? <p className="line-clamp-2 text-xs text-ink-subtle">{s.description}</p> : null}
                  {s.author ? <p className="mt-0.5 truncate text-xs text-ink-subtle">{s.author}</p> : null}
                </div>
                {outdated ? (
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => void install(s.id, true)}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105 disabled:opacity-60"
                  >
                    {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    {t("appearance.update")}
                  </button>
                ) : on ? (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-ink">{t("appearance.active")}</span>
                ) : have ? (
                  <button type="button" onClick={() => setAppearance({ skin: s.id })} className={SECONDARY}>
                    {t("appearance.apply")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => void install(s.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105 disabled:opacity-60"
                  >
                    {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    {t("appearance.install")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
