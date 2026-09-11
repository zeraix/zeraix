"use client";

/**
 * The "import a skin package" entry point. One button: the main process shows a file picker
 * restricted to .skinpkg, hands the path to the Rust engine, and the result comes back either as
 * the installed manifest or as a structured error -- whose translated reason AND specific detail
 * ("disallowed file type: tools/run.exe") both reach the toast. A generic "install failed" is
 * exactly what this must never show.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { FileDown, Loader2, Upload } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isSkinPackagesAvailable, skinAPI } from "@/lib/electron/skinpkg";
import { useSkin, packageErrorToast } from "@/components/theme/skinpkg";
import { NOTE } from "../../pane";

const SECONDARY =
  "flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:opacity-60";

export function PackageImportActions({ t }: { t: TFunc }) {
  const { applySkin, available } = useSkin();
  const [busy, setBusy] = useState(false);
  if (!available) return null;

  const importPackage = async () => {
    const api = skinAPI();
    if (!api) return;
    setBusy(true);
    try {
      const r = await api.pick();
      if (r.canceled) return;
      if (r.ok && r.skin) {
        Toast.success(t("skinpkg.installed"), `${r.skin.name} ${t("skinpkg.version", { version: r.skin.version })}`);
        await applySkin(r.skin.id);
      } else {
        const { title, detail } = packageErrorToast(t, r.error);
        Toast.error(title, detail);
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    const api = skinAPI();
    if (!api) return;
    const r = await api.downloadTemplate();
    if (r.ok) Toast.success(t("skinpkg.templateSaved"), r.path);
    else if (!r.canceled) {
      const { title, detail } = packageErrorToast(t, r.error);
      Toast.error(title, detail);
    }
  };

  return (
    <>
      <button type="button" onClick={() => void downloadTemplate()} className={cn(SECONDARY, "border-transparent text-ink-muted")}>
        <FileDown className="size-3.5" />
        {t("skinpkg.template")}
      </button>
      <button type="button" onClick={() => void importPackage()} disabled={busy} className={cn(SECONDARY)}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {busy ? t("skinpkg.importing") : t("skinpkg.import")}
      </button>
    </>
  );
}

const noopSubscribe = () => () => {};

/** Says why packages cannot be installed here: the web build, or a desktop build whose addon did not load. */
export function PackageAvailabilityNote({ t }: { t: TFunc }) {
  // Server snapshot claims "desktop" so the web-only note never flashes into the desktop app on hydration.
  const desktop = useSyncExternalStore(noopSubscribe, isSkinPackagesAvailable, () => true);
  const [engine, setEngine] = useState<"unknown" | "ok" | "missing">("unknown");
  useEffect(() => {
    const api = skinAPI();
    if (!api) return;
    let alive = true;
    api
      .available()
      .then((r) => {
        if (alive) setEngine(r.available ? "ok" : "missing");
      })
      .catch(() => {
        if (alive) setEngine("missing");
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!desktop) return <p className={NOTE}>{t("skinpkg.unavailable")}</p>;
  if (engine === "missing") return <p className={NOTE}>{t("skinpkg.engineUnavailable")}</p>;
  return null;
}
