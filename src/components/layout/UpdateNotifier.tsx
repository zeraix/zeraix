"use client";

/**
 * Auto-update prompt (docked bottom-right, above GlobalNotifications' stack).
 *
 * Flow: silent check on mount -> card only when there is something to say. The user consents to the
 * download (main sets autoDownload=false), then chooses when to restart. Nothing is shown while
 * idle/checking/not-available, so a normal launch is visually unchanged.
 *
 * Once the user clicks Download the card becomes *theirs*: it stays until they close it, through
 * progress, completion and even failure. Only the X (and "Install later") dismiss it. Before that
 * point a failed background check still stays silent — the user never asked, and on unsigned macOS
 * builds it fails every single time.
 *
 * Progress is optimistic on purpose: Windows/NSIS can take seconds to emit its first
 * `download-progress` event, and earlier builds looked frozen in that gap ("clicked Download,
 * nothing happened") even though the download was running. Clicking Download therefore switches
 * to the progress view immediately, with an indeterminate bar until a real percentage arrives.
 *
 * Mounted ungated in SafetyRootLayout: unlike GlobalNotifications this must reach guest users too,
 * since login is optional and everyone needs security updates.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { updaterBridge, errorKey, type UpdaterState } from "@/lib/updater";

/** Delay the first check so it never competes with app startup work. */
const INITIAL_CHECK_DELAY_MS = 8000;

const BTN_PRIMARY = "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90";
const BTN_GHOST = "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted";

export default function UpdateNotifier() {
  const t = useT();
  const [state, setState] = useState<UpdaterState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // The user clicked Download: from here on only they close this card.
  const [engaged, setEngaged] = useState(false);
  // Bridges the gap between the click and the first state push from the main process.
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const bridge = updaterBridge();
    if (!bridge) return; // browser / next dev: nothing to do

    const off = bridge.onState((s) => {
      // Merge rather than replace: `supported` / `currentVersion` describe the environment, not the
      // transition, so a push that omitted one must never turn this card off mid-download.
      setState((prev) => ({ ...prev, ...s }));
      // A newly found update re-opens a card the user dismissed earlier in this session.
      if (s.status === "available" || s.status === "downloaded") setDismissed(false);
      // Main is now driving the display; drop the optimistic flag.
      if (s.status !== "available") setStarting(false);
    });

    let cancelled = false;
    bridge.getState().then((s) => {
      if (cancelled) return;
      setState(s);
      // Only check when packaged; unpackaged reports supported:false and would error.
      if (s.supported) setTimeout(() => bridge.check(), INITIAL_CHECK_DELAY_MS);
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const onDownload = useCallback(() => {
    setEngaged(true);
    setStarting(true);
    void updaterBridge()?.download();
  }, []);
  const onInstall = useCallback(() => void updaterBridge()?.install(), []);
  const close = useCallback(() => setDismissed(true), []);

  if (!state?.supported || dismissed) return null;

  const status = state.status;
  const downloading = starting || status === "downloading";
  const failed = status === "error";
  // Before the user engages, only an actionable update is worth interrupting for. After, the card
  // owes them an outcome — including a failure — and must not disappear on its own.
  const visible = status === "available" || status === "downloaded" || downloading || (engaged && failed);
  if (!visible) return null;

  const version = state.version ?? "";
  // Real progress only once main reports it; until then the bar runs indeterminate.
  const percent = status === "downloading" ? state.percent : 0;
  const indeterminate = downloading && percent <= 0;

  const title = failed
    ? t("update.failed.title")
    : status === "downloaded"
      ? t("update.ready.title")
      : downloading
        ? t("update.downloading.title")
        : t("update.available.title");

  const body = failed
    ? t(errorKey(state.error))
    : status === "downloaded"
      ? t("update.ready.body", { version })
      : downloading
        ? indeterminate
          ? t("update.downloading.preparing")
          : t("update.downloading.body", { percent })
        : t("update.available.body", { version });

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      <div className="pointer-events-auto rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            {failed ? (
              <CircleAlert className="size-4 text-amber-500" />
            ) : downloading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : status === "downloaded" ? (
              <RefreshCw className="size-4 text-primary" />
            ) : (
              <Download className="size-4 text-primary" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>

            {downloading && (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                {indeterminate ? (
                  <div className="h-full w-1/3 rounded-full bg-primary animate-scan" />
                ) : (
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${Math.max(2, percent)}%` }}
                  />
                )}
              </div>
            )}

            {status === "downloaded" && (
              <>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={onInstall} className={BTN_PRIMARY}>
                    {t("update.action.installNow")}
                  </button>
                  {/* No install here: main keeps autoInstallOnAppQuit on, so the pending update is
                      applied on quit and the next launch is already the new version. */}
                  <button type="button" onClick={close} className={BTN_GHOST}>
                    {t("update.action.installLater")}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{t("update.later.hint")}</p>
              </>
            )}

            {failed && (
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={onDownload} className={BTN_PRIMARY}>
                  {t("update.action.retry")}
                </button>
                <button type="button" onClick={close} className={BTN_GHOST}>
                  {t("update.action.later")}
                </button>
              </div>
            )}

            {status === "available" && !downloading && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={onDownload}
                  className={cn(BTN_PRIMARY, "flex items-center gap-1")}
                >
                  <Download className="size-3" />
                  {t("update.action.download")}
                </button>
                <button type="button" onClick={close} className={BTN_GHOST}>
                  {t("update.action.later")}
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={close}
            aria-label={t("update.action.close")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Surfaces the errors the silent background flow hides; used by the Settings → About section. */
export function updateErrorKey(state: UpdaterState | null): string | null {
  return state?.status === "error" ? errorKey(state.error) : null;
}
