"use client";

/**
 * Auto-update prompt (docked bottom-right, above GlobalNotifications' stack).
 *
 * Flow: silent check on mount -> card only when there is something to say. The user consents to the
 * download (main sets autoDownload=false), then chooses when to restart. Nothing is shown while
 * idle/checking/not-available, so a normal launch is visually unchanged.
 *
 * Mounted ungated in SafetyRootLayout: unlike GlobalNotifications this must reach guest users too,
 * since login is optional and everyone needs security updates.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { updaterBridge, errorKey, type UpdaterState } from "@/lib/updater";

/** Delay the first check so it never competes with app startup work. */
const INITIAL_CHECK_DELAY_MS = 8000;

export default function UpdateNotifier() {
  const t = useT();
  const [state, setState] = useState<UpdaterState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const bridge = updaterBridge();
    if (!bridge) return; // browser / next dev: nothing to do

    const off = bridge.onState((s) => {
      setState(s);
      // A newly found update re-opens a card the user dismissed earlier in this session.
      if (s.status === "available" || s.status === "downloaded") setDismissed(false);
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

  const onDownload = useCallback(() => void updaterBridge()?.download(), []);
  const onInstall = useCallback(() => void updaterBridge()?.install(), []);

  if (!state?.supported || dismissed) return null;
  // Silent states: nothing worth interrupting for.
  if (state.status === "idle" || state.status === "checking" || state.status === "not-available") return null;
  // Errors from a background check are not the user's problem — they never asked. Staying quiet
  // here is deliberate: a failed check must not nag, least of all on unsigned macOS builds where
  // it fails every single time.
  if (state.status === "error") return null;

  const version = state.version ?? "";

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      <div className="pointer-events-auto rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            {state.status === "downloading" ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : state.status === "downloaded" ? (
              <RefreshCw className="size-4 text-primary" />
            ) : (
              <Download className="size-4 text-primary" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {state.status === "downloaded"
                ? t("update.ready.title")
                : state.status === "downloading"
                  ? t("update.downloading.title")
                  : t("update.available.title")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {state.status === "downloaded"
                ? t("update.ready.body", { version })
                : state.status === "downloading"
                  ? t("update.downloading.body", { percent: state.percent })
                  : t("update.available.body", { version })}
            </p>

            {state.status === "downloading" ? (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${Math.max(2, state.percent)}%` }}
                />
              </div>
            ) : null}

            {state.status !== "downloading" ? (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={state.status === "downloaded" ? onInstall : onDownload}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium",
                    "bg-primary text-primary-foreground hover:opacity-90",
                  )}
                >
                  {state.status === "downloaded" ? t("update.action.restart") : t("update.action.download")}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  {t("update.action.later")}
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label={t("update.action.later")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** For a future Settings "Check for updates" button: surfaces the errors the silent flow hides. */
export function updateErrorKey(state: UpdaterState | null): string | null {
  return state?.status === "error" ? errorKey(state.error) : null;
}
