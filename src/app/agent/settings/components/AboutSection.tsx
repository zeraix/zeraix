"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Github, Loader2, RefreshCw } from "lucide-react";
import { errorKey, mergeUpdaterState, updaterBridge, type UpdaterState } from "@/lib/updater";
import { APP_NAME, APP_VERSION, GITHUB_URL } from "@/constants/App";
import { type TFunc } from "@/lib/i18n";
import { PRIMARY_BTN } from "./styles";

/**
 * About section: app identity + update check + repository link.
 *
 * The version comes from the updater bridge (`app.getVersion()` in the packaged app) and falls back to the
 * build-time APP_VERSION in the browser / `next dev`. Unlike the silent background check in UpdateNotifier,
 * a check started here is one the user asked for, so it reports every outcome — including the errors the
 * background flow deliberately swallows (see updateErrorKey there).
 */
export function AboutSection({ t }: { t: TFunc }) {
  const [state, setState] = useState<UpdaterState | null>(null);
  // True only between clicking "Check" and the first state transition, so the spinner belongs to *this* check.
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const bridge = updaterBridge();
    if (!bridge) return; // browser / next dev: no updater at all
    const off = bridge.onState((s) => {
      // Merge, don't replace — `supported` describes the environment, and losing it would swap the
      // whole updates block for the "not supported here" note while a download is running. It also
      // keeps a found update visible across a later check, so pressing "Check for updates" cannot make
      // the Download button next to it disappear (see mergeUpdaterState).
      setState((prev) => mergeUpdaterState(prev, s));
      if (s.status !== "checking") setChecking(false);
    });
    let cancelled = false;
    void bridge.getState().then((s) => {
      // Merged, not assigned: this resolves asynchronously and could otherwise land after a pushed
      // transition and roll the panel back to the pre-check snapshot.
      if (!cancelled) setState((prev) => mergeUpdaterState(prev, s));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const version = state?.currentVersion || APP_VERSION;
  const supported = state?.supported ?? false;
  const status = state?.status ?? "idle";
  const busy = checking || status === "checking";

  const check = async () => {
    const bridge = updaterBridge();
    if (!bridge) return;
    setChecking(true);
    const res = await bridge.check();
    // A rejected check never transitions state, so clear the spinner here as well.
    if (!res.ok) setChecking(false);
  };

  // https URLs are handed to the system browser by the main process (setWindowOpenHandler); in a
  // plain browser this is an ordinary new tab.
  const openGithub = () => window.open(GITHUB_URL, "_blank", "noopener,noreferrer");

  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("about.title")}</h2>

      {/* Identity */}
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface-muted/50 px-4 py-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export: plain <img> avoids the optimizer entirely */}
        <img src="/logo.png" alt="" className="size-12 shrink-0 rounded-xl object-contain" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{APP_NAME}</p>
          <p className="mt-0.5 text-xs text-ink-subtle">{t("about.desc")}</p>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {version ? t("about.version", { version }) : "—"}
          </p>
        </div>
      </div>

      {/* Updates */}
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <RefreshCw className="size-4 text-ink-muted" />
        {t("about.updates")}
      </p>
      <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void check()}
            disabled={!supported || busy}
            className={PRIMARY_BTN}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {busy ? t("about.checking") : t("about.check")}
          </button>

          {/* An update the user can act on: consent to download, then choose when to restart. */}
          {status === "available" && (
            <button onClick={() => void updaterBridge()?.download()} className={PRIMARY_BTN}>
              <Download className="size-3.5" />
              {t("update.action.download")}
            </button>
          )}
          {status === "downloaded" && (
            <button onClick={() => void updaterBridge()?.install()} className={PRIMARY_BTN}>
              <RefreshCw className="size-3.5" />
              {t("update.action.installNow")}
            </button>
          )}
        </div>

        {/* Outcome of the last check. Nothing is shown while idle — there is nothing to report yet. */}
        {!supported ? (
          <p className="mt-2 text-[11px] text-ink-subtle">{t("about.unsupported")}</p>
        ) : status === "not-available" ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" /> {t("about.upToDate")}
          </p>
        ) : status === "available" ? (
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("update.available.body", { version: state?.version ?? "" })}
          </p>
        ) : status === "downloading" ? (
          <div className="mt-2">
            <p className="text-[11px] text-ink-subtle">
              {t("update.downloading.body", { percent: state?.percent ?? 0 })}
            </p>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${Math.max(2, state?.percent ?? 0)}%` }}
              />
            </div>
          </div>
        ) : status === "downloaded" ? (
          <p className="mt-2 text-[11px] text-ink-subtle">
            {t("update.ready.body", { version: state?.version ?? "" })} {t("update.later.hint")}
          </p>
        ) : status === "error" ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {t(errorKey(state?.error ?? null))}
          </p>
        ) : null}
      </div>

      {/* Links */}
      <p className="mb-2 mt-6 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <ExternalLink className="size-4 text-ink-muted" />
        {t("about.links")}
      </p>
      <div className="rounded-xl border border-line bg-surface-muted/50 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <Github className="size-4 text-ink-muted" />
              {t("about.github")}
            </p>
            <p className="mt-0.5 break-all text-[11px] text-ink-subtle">{t("about.githubDesc")}</p>
          </div>
          <button
            onClick={openGithub}
            className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
          >
            {t("about.open")}
          </button>
        </div>
      </div>
    </div>
  );
}
